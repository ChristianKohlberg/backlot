import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

interface Json {
  envId: string;
  envs: Array<{ id: string; lease?: { id: string } }>;
  lease: { id: string; hygiene: string; expiresAt: number };
  datastores: Record<string, { url: string }>;
  events: Array<{ at: number; event?: string; kind?: string; detail?: string }>;
  bindDiagnostics: { reuse: string };
  error?: { message: string };
}

async function fixture(hotReload: boolean, sweepMs = 400) {
  const root = mkdtempSync(join(tmpdir(), 'backlot-deadline-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: join(root, 'state'), BACKLOT_HOLDER_PID: '', BACKLOT_SWEEP_MS: String(sweepMs) };
  const wt = join(root, 'worktree');
  mkdirSync(wt);
  writeFileSync(join(wt, 'server.mjs'), "import{createServer}from'node:http';import{readFileSync}from'node:fs';createServer((q,r)=>r.end(readFileSync('restart.txt'))).listen(+process.env.PORT,'127.0.0.1');");
  writeFileSync(join(wt, 'restart.txt'), 'before');
  writeFileSync(join(wt, 'backlot.yml'), `name: deadline\nservices:\n  web:\n    run: node server.mjs\n    port: http\n    hot_reload: ${hotReload}\n    env: {PORT: "{{ports.http}}"}\n    ready: {http: /, timeout: 10}\ndatastores:\n  main: {driver: sqlite, create: "printf seed > {{ns}}"}\nupkeep:\n  - {when: restart.txt, run: "true"}\n`);
  const raw = (args: string[]) => new Promise<{ code: number; json: Json; text: string }>((resolve, reject) => {
    execFile(process.execPath, [CLI, args[0]!, '--json', ...args.slice(1)], { cwd: wt, env }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0;
      try { resolve({ code, json: JSON.parse(stdout), text: stdout + stderr }); } catch { reject(new Error(stdout + stderr)); }
    });
  });
  const cli = async (args: string[]) => {
    const r = await raw(args);
    if (r.code !== 0) throw new Error(r.text);
    return r.json;
  };
  return { wt, cli, raw, cleanup: async () => {
    try { await cli(['release']); await cli(['pool', 'recycle']); } finally {
      await cli(['daemon', 'stop']); rmSync(root, { recursive: true, force: true });
    }
  } };
}

describe('content operations preserve the lease deadline', () => {
  for (const ttl of ['480', '1']) {
    for (const mode of ['projection', 'full sync', 'reset-data', 'watch projection', 'watch fallback']) {
      it(`${mode} retains an explicit ${ttl}-minute deadline`, async () => {
        const f = await fixture(mode !== 'full sync');
        try {
          const first = await f.cli(['up', '--ttl', ttl, ...(mode.startsWith('watch') ? ['--watch'] : [])]);
          let result;
          if (mode.startsWith('watch')) {
            const filename = mode === 'watch fallback' ? 'restart.txt' : 'note.txt';
            writeFileSync(join(f.wt, filename), 'after');
            // Wait for completion evidence emitted by the real watcher.
            await expect.poll(async () => {
              if (mode === 'watch projection') {
                const status = await f.cli(['status']);
                return status.events.some((e) => e.kind === 'watch' && e.detail?.startsWith('projected '));
              }
              const context = await f.cli(['ctx']);
              return context.events.some((e) => e.event === 'started' && e.at > first.events[0].at);
            }, { timeout: 15000 }).toBe(true);
            result = await f.cli(['ctx']);
          } else {
            result = await f.cli([mode === 'reset-data' ? 'reset-data' : 'sync']);
            if (mode === 'projection') expect(result.bindDiagnostics.reuse).toBe('projected');
          }
          expect(result.lease.id).toBe(first.lease.id);
          expect(result.lease.expiresAt).toBe(first.lease.expiresAt);
          const nextTtl = ttl === '480' ? '1' : '480';
          const renewed = await f.cli(['up', '--ttl', nextTtl]);
          expect(Math.abs(renewed.lease.expiresAt - Date.now() - Number(nextTtl) * 60000)).toBeLessThan(3000);
        } finally { await f.cleanup(); }
      }, 30000);
    }
  }
});


it('sync earns a new lease after expiry instead of restoring the old deadline', async () => {
  const f = await fixture(false);
  try {
    const first = await f.cli(['up', '--ttl', '0.1']);
    await expect.poll(async () => {
      const status = await f.cli(['status']);
      return status.envs.find((e) => e.id === first.envId)?.lease == null;
    }, { timeout: 10000 }).toBe(true);
    const rebound = await f.cli(['sync']);
    expect(rebound.lease.id).not.toBe(first.lease.id);
    expect(rebound.lease.expiresAt).toBeGreaterThan(Date.now());
  } finally { await f.cleanup(); }
}, 20000);

it('reset-data on a lapsed lease the sweeper has not reached refuses before touching anything', async () => {
  const f = await fixture(false, 600_000);
  try {
    const first = await f.cli(['up', '--ttl', '0.05']);
    expect(first.lease.expiresAt).toBeGreaterThan(Date.now());
    const store = first.datastores.main.url;
    expect(readFileSync(store, 'utf8')).toBe('seed');
    writeFileSync(store, 'dirty');
    const marker = await f.cli(['exec', 'touch', 'dropping.txt']);
    expect(marker).toMatchObject({ ok: true });
    const startsBefore = first.events.filter((e) => e.event === 'started').length;
    await expect.poll(() => Date.now() > first.lease.expiresAt + 200, { timeout: 10000 }).toBe(true);

    const refused = await f.raw(['reset-data']);
    expect(refused.code, refused.text).toBe(2);
    expect(refused.json.error?.message).toContain('no active lease');
    const after = await f.cli(['ctx']);
    expect(after.lease).toMatchObject({ id: first.lease.id, hygiene: 'reuse', expiresAt: first.lease.expiresAt });
    expect(after.events.filter((e) => e.event === 'started').length).toBe(startsBefore);
    expect(readFileSync(store, 'utf8')).toBe('dirty');

    const renewed = await f.cli(['up', '--ttl', '1']);
    expect(renewed.envId).toBe(first.envId);
    expect(renewed.lease.expiresAt).toBeGreaterThan(Date.now());
    expect(Math.abs(renewed.lease.expiresAt - Date.now() - 60_000)).toBeLessThan(3000);
    expect(readFileSync(store, 'utf8')).toBe('dirty');
    expect(await f.cli(['exec', 'test', '-f', 'dropping.txt'])).toMatchObject({ ok: true });

    const reset = await f.cli(['reset-data']);
    expect(reset.lease).toMatchObject({ id: renewed.lease.id, expiresAt: renewed.lease.expiresAt });
    expect(readFileSync(store, 'utf8')).toBe('seed');
  } finally { await f.cleanup(); }
}, 40000);

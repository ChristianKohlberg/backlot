import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

async function fixture(hotReload: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'backlot-deadline-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: join(root, 'state'), BACKLOT_HOLDER_PID: '', BACKLOT_SWEEP_MS: '400' };
  const wt = join(root, 'worktree');
  mkdirSync(wt);
  writeFileSync(join(wt, 'server.mjs'), "import{createServer}from'node:http';import{readFileSync}from'node:fs';createServer((q,r)=>r.end(readFileSync('restart.txt'))).listen(+process.env.PORT,'127.0.0.1');");
  writeFileSync(join(wt, 'restart.txt'), 'before');
  writeFileSync(join(wt, 'backlot.yml'), `name: deadline\nservices:\n  web:\n    run: node server.mjs\n    port: http\n    hot_reload: ${hotReload}\n    env: {PORT: "{{ports.http}}"}\n    ready: {http: /, timeout: 10}\nupkeep:\n  - {when: restart.txt, run: "true"}\n`);
  const cli = (args: string[]) => new Promise<{
    envId: string;
    envs: Array<{ id: string; lease?: { id: string } }>;
    lease: { id: string; expiresAt: number };
    events: Array<{ at: number; event?: string; kind?: string; detail?: string }>;
    bindDiagnostics: { reuse: string };
  }>((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args, '--json'], { cwd: wt, env }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stdout + stderr));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  return { wt, cli, cleanup: async () => {
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

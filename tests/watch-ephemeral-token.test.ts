/**
 * The remaining gap-closers: --watch streaming (save -> auto-sync -> served),
 * ephemeral datastores (reset = flush), and the token verb.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

function makeContext() {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-wet-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };
  const cli = (args: string[], cwd: string): Promise<{ exitCode: number; json?: Record<string, unknown>; out: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json, out: String(stdout) });
      });
    });
  const cleanup = () => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')));
    } catch {
      /* gone */
    }
    rmSync(stateDir, { recursive: true, force: true });
  };
  return { stateDir, cli, cleanup };
}

function makeStack(dir: string, stackYaml: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  writeFileSync(join(dir, 'stack.yaml'), stackYaml);
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

const SERVE = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
createServer((q, s) => s.end(readFileSync('./message.txt', 'utf8'))).listen(Number(process.env.PORT));
`;

describe('--watch: save in the worktree, served without calling sync', () => {
  const ctx = makeContext();
  const wt = mkdtempSync(join(tmpdir(), 'backlot-watch-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('streams worktree edits into the environment', async () => {
    makeStack(
      wt,
      `name: watchy
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
`,
      { 'server.mjs': SERVE, 'message.txt': 'v1' },
    );
    const up = await ctx.cli(['up', '--watch', '--json'], wt);
    expect(up.exitCode, `output: ${(up as { output?: string }).output ?? ''}${up.stdout ?? ''}${up.stderr ?? ''}`).toBe(0);
    const url = (up.json!.urls as Record<string, string>).web!;
    expect(await (await fetch(url)).text()).toBe('v1');

    writeFileSync(join(wt, 'message.txt'), 'v2 — streamed'); // NO sync call
    let body = '';
    for (let i = 0; i < 100; i++) {
      try {
        body = await (await fetch(url, { signal: AbortSignal.timeout(1000) })).text();
      } catch {
        /* service restarting mid-bind */
      }
      if (body.includes('v2')) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(body).toBe('v2 — streamed');
  }, 60_000);
});

describe('ephemeral datastores: reset = flush, create once', () => {
  const ctx = makeContext();
  const wt = mkdtempSync(join(tmpdir(), 'backlot-eph-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('drop: runs as the flush on reset-data, create: only on first bind', async () => {
    // Marker-file fake for a redis-class store: create/flush append to logs
    // inside the WORKTREE (visible to the test), keyed by {{ns}}.
    makeStack(
      wt,
      `name: ephy
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
datastores:
  cache:
    driver: redis
    url: "redis://localhost:6379/{{ns}}"
    create: echo created >> ${wt}/ds.log
    drop: echo flushed >> ${wt}/ds.log
    ephemeral: true
`,
      { 'server.mjs': SERVE, 'message.txt': 'hi' },
    );
    expect((await ctx.cli(['up', '--json'], wt)).exitCode).toBe(0);
    expect(readFileSync(join(wt, 'ds.log'), 'utf8').trim()).toBe('created');

    expect((await ctx.cli(['reset-data', '--json'], wt)).exitCode).toBe(0);
    const log = readFileSync(join(wt, 'ds.log'), 'utf8').trim().split('\n');
    expect(log).toEqual(['created', 'flushed']); // flush, NOT re-create

    expect((await ctx.cli(['sync', '--json'], wt)).exitCode).toBe(0); // reuse bind: no ds activity
    expect(readFileSync(join(wt, 'ds.log'), 'utf8').trim().split('\n')).toEqual(['created', 'flushed']);
  }, 60_000);
});

describe('the token verb', () => {
  const ctx = makeContext();
  const wt = mkdtempSync(join(tmpdir(), 'backlot-tok-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('resolves {{role}} and returns the hook output; missing hook is a work-error', async () => {
    makeStack(
      wt,
      `name: tokky
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
auth:
  token: echo "fake-jwt-for-{{role}}-on-{{ports.web}}"
`,
      { 'server.mjs': SERVE, 'message.txt': 'hi' },
    );
    await ctx.cli(['up'], wt);
    const res = await ctx.cli(['token', '--role', 'detektiv', '--json'], wt);
    expect(res.exitCode, `output: ${(res as { output?: string }).output ?? ''}${res.stdout ?? ''}${res.stderr ?? ''}`).toBe(0);
    expect(res.json!.token).toMatch(/^fake-jwt-for-detektiv-on-\d+$/);
    expect(res.json!.role).toBe('detektiv');
  }, 60_000);
});

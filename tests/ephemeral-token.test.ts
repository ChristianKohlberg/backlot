/**
 * The remaining gap-closers: ephemeral datastores (reset = flush), the token
 * verb, and what a repeated `up` restarts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

function makeContext() {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-wet-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };
  const cli = (args: string[], cwd: string): Promise<{ exitCode: number; json?: Record<string, unknown>; out: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json, out: String(stdout), stdout: String(stdout), stderr: String(stderr) });
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
createServer((q, s) => s.end(readFileSync('./message.txt', 'utf8'))).listen(Number(process.env.PORT), '127.0.0.1');
`;

const SERVE_PID = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
createServer((q, s) => s.end(process.pid + ':' + readFileSync('./message.txt', 'utf8'))).listen(Number(process.env.PORT), '127.0.0.1');
`;

describe('ephemeral datastores: reset = flush, create once', () => {
  const ctx = makeContext();
  const wt = mkdtempSync(join(tmpdir(), 'runly-eph-'));
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

    expect((await ctx.cli(['up', '--json'], wt)).exitCode).toBe(0); // reuse bind: no ds activity
    expect(readFileSync(join(wt, 'ds.log'), 'utf8').trim().split('\n')).toEqual(['created', 'flushed']);
  }, 60_000);
});

describe('the token verb', () => {
  const ctx = makeContext();
  const wt = mkdtempSync(join(tmpdir(), 'runly-tok-'));
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
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    expect(res.json!.token).toMatch(/^fake-jwt-for-detektiv-on-\d+$/);
    expect(res.json!.role).toBe('detektiv');
  }, 60_000);
});

describe('a repeated up keeps a service that has no build (2026-07-19 dogfood P1)', () => {
  const ctx = makeContext();
  const wt = mkdtempSync(join(tmpdir(), 'runly-syncproj-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('a plain source edit + up is served by the SAME service process', async () => {
    // Dogfooded on the founding monorepo: a one-line edit + re-bind took 57s
    // and restarted all three services. A dev server reads the worktree
    // itself; with no build there is no output that could have changed, so
    // `up` leaves it running (decision 0032).
    makeStack(
      wt,
      `name: syncproj
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
upkeep:
  - { when: dep.lock, run: "echo upkept >> upkeep.log" }
`,
      { 'server.mjs': SERVE_PID, 'message.txt': 'v1', 'dep.lock': 'lock-v1' },
    );
    const up = await ctx.cli(['up', '--json'], wt);
    expect(up.exitCode, `stdout: ${up.stdout ?? ''}\nstderr: ${up.stderr ?? ''}`).toBe(0);
    const url = (up.json!.urls as Record<string, string>).web!;
    const pid1 = (await (await fetch(url)).text()).split(':')[0];

    writeFileSync(join(wt, 'message.txt'), 'v2 — synced');
    const sync = await ctx.cli(['up', '--json'], wt);
    expect(sync.exitCode).toBe(0);
    expect((sync.json!.bindDiagnostics as { reuse: string }).reuse).toBe('reused');
    const after = await (await fetch(url)).text();
    expect(after).toContain('v2 — synced'); // the edit landed…
    expect(after.split(':')[0]).toBe(pid1); // …without a service restart

    // The safety valve: an upkeep-trigger edit falls back to the full bind —
    // the rule runs, and the services restart.
    writeFileSync(join(wt, 'dep.lock'), 'lock-v2');
    const sync2 = await ctx.cli(['up', '--json'], wt);
    expect(sync2.exitCode).toBe(0);
    expect((sync2.json!.bindDiagnostics as { reuse: string }).reuse).toBe('rebound');
    expect((await (await fetch(url)).text()).split(':')[0]).not.toBe(pid1);
    // The rule ran in the worktree itself (decision 0032), so that is where it wrote.
    const upkeepLog = join(wt, 'upkeep.log');
    // Two runs: the initial bind applied the rule once, the fallback re-ran it.
    expect(readFileSync(upkeepLog, 'utf8').trim().split('\n')).toHaveLength(2);
  }, 60_000);
});

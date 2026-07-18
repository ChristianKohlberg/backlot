/**
 * Decision 0007 enforcement: auto-escalation to pristine after two consecutive
 * bind failures, degraded marking + auto-reap for flapping services — plus the
 * previously-untested daemon codepaths: idle quiesce and the sleep pardon.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/core/journal.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

function makeContext(extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-hyg-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '300', ...extraEnv };
  const cli = (args: string[], cwd: string): Promise<{ exitCode: number; json?: Record<string, unknown> }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json, stdout: String(stdout), stderr: String(stderr) });
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

const envsOf = async (ctx: ReturnType<typeof makeContext>, cwd: string) =>
  ((await ctx.cli(['status', '--json'], cwd)).json!.envs ?? []) as Array<{ id: string; state: string; lease: unknown }>;

describe('auto-escalation: two failures -> pristine bind heals a poisoned cache', () => {
  const ctx = makeContext();
  const wt = mkdtempSync(join(tmpdir(), 'backlot-esc-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('fail, fail, auto-pristine, green', async () => {
    // The service crashes iff a POISON file exists. poison.txt is in caches:,
    // so reuse/reset-data binds preserve it — only pristine wipes it.
    writeFileSync(
      join(wt, 'server.mjs'),
      `import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
if (existsSync('./poison.txt')) { console.error('Error: poisoned cache'); process.exit(1); }
createServer((q, s) => s.end('clean')).listen(Number(process.env.PORT));
`,
    );
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: escalate
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
    fatal_logs: "Error:"
caches: [poison.txt]
`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });

    expect((await ctx.cli(['up', '--json'], wt)).exitCode).toBe(0); // healthy first
    await ctx.cli(['exec', 'touch poison.txt'], wt); // a check poisons a cache path
    // Nudge the source so the next bind actually restarts (the fast path
    // correctly reuses a healthy env when nothing changed).
    writeFileSync(join(wt, 'nudge.txt'), 'restart me');

    expect((await ctx.cli(['sync', '--json'], wt)).exitCode).toBe(1); // strike 1 (work-error)
    expect((await ctx.cli(['sync', '--json'], wt)).exitCode).toBe(1); // strike 2

    const third = await ctx.cli(['sync', '--json'], wt); // auto-escalated to pristine
    expect(third.exitCode, `stdout: ${third.stdout ?? ''}\nstderr: ${third.stderr ?? ''}`).toBe(0);
    expect(third.json!.state).toBe('hot');
  }, 60_000);
});

describe('degraded marking + auto-reap for a flapping service', () => {
  const ctx = makeContext();
  const wt = mkdtempSync(join(tmpdir(), 'backlot-flap-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('a service dying after ready flaps out; the env goes degraded and is reaped', async () => {
    writeFileSync(
      join(wt, 'server.mjs'),
      `import { createServer } from 'node:http';
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT));
setTimeout(() => process.exit(1), 250); // dies AFTER readiness — the partial-zombie shape
`,
    );
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: flappy
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });

    expect((await ctx.cli(['up', '--json'], wt)).exitCode).toBe(0); // ready, then it starts dying
    // 3 bounded restarts (0.5+1+1.5s) -> flapping -> degraded -> sweeper reaps.
    let envs: Awaited<ReturnType<typeof envsOf>> = [];
    for (let i = 0; i < 60; i++) {
      envs = await envsOf(ctx, wt);
      if (envs.length === 0) break; // reaped
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(envs.length).toBe(0);
  }, 60_000);
});

describe('idle quiesce (hot -> warm) and rebind', () => {
  const ctx = makeContext({ BACKLOT_IDLE_TTL_MS: '800', BACKLOT_LEASE_TTL_MS: '600' });
  const wt = mkdtempSync(join(tmpdir(), 'backlot-idle-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('an unleased hot env quiesces to warm (services stopped), then rebinds hot', async () => {
    writeFileSync(
      join(wt, 'server.mjs'),
      `import { createServer } from 'node:http';
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT));
`,
    );
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: idle
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });

    const up = await ctx.cli(['up', '--json'], wt);
    const url = (up.json!.urls as Record<string, string>).web!;
    await ctx.cli(['release'], wt);

    let state = '';
    for (let i = 0; i < 40; i++) {
      const envs = await envsOf(ctx, wt);
      state = envs[0]?.state ?? 'gone';
      if (state === 'warm') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(state).toBe('warm');
    await expect(fetch(url, { signal: AbortSignal.timeout(800) })).rejects.toThrow(); // services genuinely stopped

    const again = await ctx.cli(['up', '--json'], wt); // warm -> hot rebind, same port
    expect((again.json!.urls as Record<string, string>).web).toBe(url);
    expect((await fetch(url)).status).toBe(200);
  }, 60_000);
});

describe('sleep pardon (journal level)', () => {
  it('pardon shifts every lease deadline and idle timestamp by the gap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backlot-pardon-'));
    const j = new Journal(join(dir, 'j.db'));
    const base = Date.now();
    j.saveEnv({
      id: 'e1', stack: 's', stackRoot: '/x', state: 'hot', root: '/tmp/e1',
      ports: {}, datastoreNs: {}, fingerprints: {}, presets: {},
      bindCount: 0, createdAt: base, lastUsedAt: base, servicePids: {}, failStreak: 0,
    });
    j.saveLease({ id: 'l1', envId: 'e1', kind: 'session', holder: 'h', hygiene: 'reuse', expiresAt: base + 10_000 });
    j.pardon(3_600_000); // the laptop slept an hour
    expect(j.leaseForEnv('e1')!.expiresAt).toBe(base + 10_000 + 3_600_000);
    expect(j.getEnv('e1')!.lastUsedAt).toBe(base + 3_600_000);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Decision 0007 enforcement: auto-escalation to pristine after two consecutive
 * bind failures, degraded marking + auto-reap for flapping services — plus the
 * previously-untested daemon codepaths: idle quiesce and the sleep pardon.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/core/journal.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

function makeContext(extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-hyg-'));
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

describe('auto-escalation: two failures -> pristine bind heals a cache the ledger vouched for', () => {
  const ctx = makeContext();
  const wt = mkdtempSync(join(tmpdir(), 'runly-esc-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('fail, fail, auto-pristine, green', async () => {
    // Environments run in the worktree (decision 0032), and pristine never
    // deletes anything there. What it does is stop TRUSTING the worktree
    // ledger: an upkeep output wiped behind runly's back (the ledger still says
    // "applied") breaks the service until a pristine bind re-runs the rule.
    writeFileSync(
      join(wt, 'server.mjs'),
      `import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
if (!existsSync('./cache/dep')) { console.error('Error: cache missing'); process.exit(1); }
createServer((q, s) => s.end('clean')).listen(Number(process.env.PORT), '127.0.0.1');
`,
    );
    writeFileSync(join(wt, 'dep.txt'), 'v1\n');
    writeFileSync(join(wt, '.gitignore'), 'cache/\n');
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
upkeep:
  - { when: dep.txt, run: "mkdir -p cache && cp dep.txt cache/dep" }
caches: [cache]
`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });

    expect((await ctx.cli(['up', '--json'], wt)).exitCode).toBe(0); // healthy first
    rmSync(join(wt, 'cache'), { recursive: true, force: true }); // wiped by hand; the ledger still vouches
    // Nudge the source so the next bind actually restarts (the fast path
    // correctly reuses a healthy env when nothing changed).
    writeFileSync(join(wt, 'nudge.txt'), 'restart me');

    expect((await ctx.cli(['sync', '--json'], wt)).exitCode).toBe(1); // strike 1 (work-error)
    expect((await ctx.cli(['sync', '--json'], wt)).exitCode).toBe(1); // strike 2

    const third = await ctx.cli(['sync', '--json'], wt); // auto-escalated to pristine
    expect(third.exitCode, `stdout: ${third.stdout ?? ''}\nstderr: ${third.stderr ?? ''}`).toBe(0);
    expect(third.json!.state).toBe('hot');
    expect(existsSync(join(wt, 'cache', 'dep'))).toBe(true); // the rule ran again, in place
    expect(existsSync(join(wt, 'nudge.txt'))).toBe(true); // and nothing of the worktree was deleted
  }, 60_000);
});

describe('degraded marking + auto-reap for a flapping service', () => {
  const ctx = makeContext();
  const wt = mkdtempSync(join(tmpdir(), 'runly-flap-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('a service dying after ready flaps out; the env goes degraded and is reaped', async () => {
    writeFileSync(
      join(wt, 'server.mjs'),
      `import { createServer } from 'node:http';
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
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
  const wt = mkdtempSync(join(tmpdir(), 'runly-idle-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('an unleased hot env quiesces to warm (services stopped), then rebinds hot', async () => {
    writeFileSync(
      join(wt, 'server.mjs'),
      `import { createServer } from 'node:http';
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
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
    const dir = mkdtempSync(join(tmpdir(), 'runly-pardon-'));
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

describe('the upkeep ledger belongs to the worktree, not to an environment (decision 0032)', () => {
  const ctx = makeContext({ BACKLOT_POOL_MAX: '2' });
  const wt = mkdtempSync(join(tmpdir(), 'runly-ledger-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('a second environment of the same worktree trusts the install the first one did; pristine re-runs it', async () => {
    writeFileSync(join(wt, 'dep.txt'), 'v1\n');
    writeFileSync(join(wt, '.gitignore'), 'node_modules/\nupkeep.log\n');
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: ledger
services:
  idle: { run: "echo ready; sleep 300", ready: { log: "ready", timeout: 20 } }
upkeep:
  - { when: dep.txt, run: "mkdir -p node_modules && echo installed > node_modules/marker && echo ran >> upkeep.log" }
checks:
  deps: { run: "test -f node_modules/marker" }
`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const runs = () => readFileSync(join(wt, 'upkeep.log'), 'utf8').trim().split('\n').length;

    const up = await ctx.cli(['up', '--json'], wt); // environment 1 installs, in the worktree
    expect(up.exitCode, JSON.stringify(up.json)).toBe(0);
    expect(runs()).toBe(1);

    const run = await ctx.cli(['run', 'deps', '--json'], wt); // environment 2, same worktree
    expect(run.exitCode, JSON.stringify(run.json)).toBe(0);
    expect(run.json!.envId).not.toBe(up.json!.envId);
    expect(runs()).toBe(1); // the install is a fact about the worktree: not repeated

    const pristine = await ctx.cli(['run', 'deps', '--pristine', '--json'], wt);
    expect(pristine.exitCode, JSON.stringify(pristine.json)).toBe(0);
    expect(runs()).toBe(2); // pristine trusts nothing: the rule ran again
  }, 60_000);
});

describe('environments stranded by a stack-identity change are reaped', () => {
  const ctx = makeContext({ BACKLOT_SWEEP_MS: '400' });
  const wt = mkdtempSync(join(tmpdir(), 'runly-strand-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('an unleased env whose recorded stack id no longer matches its root is recycled', async () => {
    // The sha256 id migration left every pre-upgrade env under an id no
    // loadStack() will ever produce again: invisible to its stack's pool but
    // still counted against POOL_MAX_TOTAL and still holding ports — forever,
    // because the only orphan test was "stackRoot missing".
    writeFileSync(join(wt, 'server.mjs'), `import{createServer}from'node:http';console.log('up');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n`);
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: strand\nservices:\n  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const up = await ctx.cli(['up', '--json'], wt);
    expect(up.exitCode).toBe(0);
    await ctx.cli(['release', '--json'], wt);

    // Fabricate the pre-upgrade survivor: same root, an id the old scheme made.
    const j = new Journal(join(ctx.stateDir, 'journal.db'));
    const real = j.allEnvs()[0]!;
    j.saveEnv({ ...real, id: 'strand-OLDID00-e1', stack: 'strand-OLDID00', ports: { web: 1 }, servicePids: {} });
    expect(j.allEnvs().length).toBe(2);

    // The sweeper must reap the stranger and keep the legitimate env.
    const deadline = Date.now() + 15_000;
    let ids: string[] = [];
    for (;;) {
      ids = new Journal(join(ctx.stateDir, 'journal.db')).allEnvs().map((e) => e.id);
      if (!ids.includes('strand-OLDID00-e1') || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(ids, `journal still holds: ${ids.join(', ')}`).not.toContain('strand-OLDID00-e1');
    expect(ids).toContain(real.id);
  }, 30_000);
});

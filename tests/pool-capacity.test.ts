/**
 * Fleet review finding: 'pool at capacity (1/1) — waited 60s' on macOS CI is
 * not a slow-runner problem when waiting can never help, and the old message
 * blamed timing, which sent the diagnosis the wrong way for months.
 *
 * Since decision 0032 a worktree has exactly ONE environment, and `run` binds
 * through the session's lease instead of needing a second one. What can still
 * be structurally hopeless is a second HOLDER on the same worktree while the
 * first one's lease outlasts the wait — that must fail fast, naming the holder.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poolMaxHeuristic } from '../src/core/policy.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    try {
      process.kill(Number(readFileSync(join(d, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* not a state dir */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function ctx() {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-cap-'));
  const wt = mkdtempSync(join(tmpdir(), 'runly-cap-wt-'));
  dirs.push(stateDir, wt);
  writeFileSync(join(wt, 'srv.mjs'), `import{createServer}from'node:http';console.log('up');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n`);
  writeFileSync(
    join(wt, 'stack.yaml'),
    `name: cap\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  // One environment per worktree, as on a small CI runner. WAIT_MS stays long so a
  // fail-fast is unmistakable: the old code burned the whole window.
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_WAIT_MS: '30000', BACKLOT_SWEEP_MS: '300' };
  const cli = (args: string[]) =>
    new Promise<{ json?: Record<string, unknown> }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 16 * 1024 * 1024 }, (_e, stdout) => {
        try {
          resolve({ json: JSON.parse(String(stdout)) });
        } catch {
          resolve({});
        }
      });
    });
  return { cli };
}

describe('pool capacity diagnostics', () => {
  it('never resolves below the two environments the core loop needs', () => {
    // The raw terms genuinely reach 1 on a 3 vCPU / 7 GB runner...
    expect(Math.min(Math.floor(3 / 2), Math.floor(7 / 4))).toBe(1);
    // ...but the floor is 2. It is the machine-wide default
    // (BACKLOT_POOL_MAX_TOTAL); the per-stack cap is gone (decision 0032).
    expect(poolMaxHeuristic()).toBeGreaterThanOrEqual(2);
    expect(poolMaxHeuristic()).toBeLessThanOrEqual(8);
  });

  it('a second holder on the same worktree fails fast with a structural diagnosis instead of waiting out the window', async () => {
    const { cli } = ctx();
    const up = await cli(['up', '--json']);
    expect(up.json?.state).toBe('hot');

    const started = Date.now();
    const other = await cli(['up', '--holder', 'someone-else', '--json']);
    const elapsed = Date.now() - started;

    const msg = String((other.json?.error as { message?: string })?.message ?? '');
    expect(msg).toContain('exactly one environment');
    expect(msg).toMatch(/held by '/); // names the blocking lease
    // The whole point: it must NOT burn the 30s wait on something impossible.
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);

  it('still queues normally when a lease will expire inside the window', async () => {
    const { cli } = ctx();
    // A short-TTL session lease frees the env well inside the wait window, so
    // a second holder must WAIT and succeed rather than fail fast.
    await cli(['up', '--ttl', '0.05', '--json']); // 3s
    const other = await cli(['up', '--holder', 'someone-else', '--json']);
    expect(other.json?.state).toBe('hot');
  }, 90_000);
});

describe('the capacity queue is per-stack, and holders bypass it', () => {
  it('a full stack A queue neither blocks stack B nor a holder rebinding its own lease', async () => {
    // One daemon, two stacks. Stack A: one environment, leased by A1 with a
    // short TTL, and a second holder A2 queued on the expiry. The global FIFO
    // used to make (a) stack B's up — free capacity, instantly satisfiable —
    // and (b) A1's own rebind — refreshes its existing lease, consumes no
    // capacity — wait behind A2's ticket for the full expiry dance.
    const stateDir = mkdtempSync(join(tmpdir(), 'runly-q-'));
    dirs.push(stateDir);
    const mkwt = (name: string) => {
      const wt = mkdtempSync(join(tmpdir(), `runly-q-${name}-`));
      dirs.push(wt);
      writeFileSync(join(wt, 'srv.mjs'), `import{createServer}from'node:http';console.log('up');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n`);
      writeFileSync(
        join(wt, 'stack.yaml'),
        `name: ${name}\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }\n`,
      );
      execFileSync('git', ['init', '-q'], { cwd: wt });
      return wt;
    };
    const wtA = mkwt('qa');
    const wtB = mkwt('qb');
    const env = {
      ...process.env,
      BACKLOT_STATE_DIR: stateDir,
      BACKLOT_POOL_MAX_TOTAL: '4',
      BACKLOT_LEASE_TTL_MS: '15000',
      BACKLOT_WAIT_MS: '40000',
      BACKLOT_SWEEP_MS: '300',
    };
    const cliIn = (wt: string, args: string[]) =>
      new Promise<{ code: number; stdout: string; elapsedMs: number }>((resolve) => {
        const started = Date.now();
        execFile(process.execPath, [CLI, ...args, '--json'], { cwd: wt, env }, (err, out) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(out), elapsedMs: Date.now() - started }),
        );
      });

    // Pre-warm stack B so its later claim is a warm rebind, not a cold
    // provision — the assertion below measures QUEUE behavior, and a cold
    // node boot on a loaded 3-vCPU runner would drown the signal.
    expect((await cliIn(wtB, ['up'])).code).toBe(0);
    expect((await cliIn(wtB, ['release'])).code).toBe(0);

    const a1 = await cliIn(wtA, ['up']);
    expect(a1.code, a1.stdout).toBe(0);
    const a1Env = (JSON.parse(a1.stdout) as { envId: string }).envId;

    const a2 = cliIn(wtA, ['up', '--holder', 'second-agent']); // queues on A1's expiry
    await new Promise((r) => setTimeout(r, 700));

    const b = await cliIn(wtB, ['up']);
    expect(b.code, b.stdout).toBe(0);
    expect(b.elapsedMs, `stack B waited ${b.elapsedMs}ms behind stack A's queue`).toBeLessThan(8000);

    const a1Again = await cliIn(wtA, ['up']);
    expect(a1Again.code, a1Again.stdout).toBe(0);
    expect(a1Again.elapsedMs, `holder rebind waited ${a1Again.elapsedMs}ms behind a capacity waiter`).toBeLessThan(6000);
    expect((JSON.parse(a1Again.stdout) as { envId: string }).envId).toBe(a1Env); // same lease, refreshed

    // Fairness intact: the queued waiter is served once the lease lapses.
    const a2r = await a2;
    expect(a2r.code, a2r.stdout).toBe(0);
  }, 60_000);
});

describe('an expired-but-unswept lease cannot jump the queue', () => {
  it('the holder bypass refuses a lapsed lease instead of resurrecting it', async () => {
    // leaseForHolder does not filter on expiry; only the sweeper deletes
    // lapsed leases. In the window between expiry and the sweep, a returning
    // holder's queue bypass used to refresh the corpse for a full new TTL —
    // jumping a waiter who was queued on precisely that expiry.
    const stateDir = mkdtempSync(join(tmpdir(), 'runly-exp-'));
    dirs.push(stateDir);
    const wt = mkdtempSync(join(tmpdir(), 'runly-exp-wt-'));
    dirs.push(wt);
    writeFileSync(join(wt, 'srv.mjs'), `import{createServer}from'node:http';console.log('up');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n`);
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: exp\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const env = {
      ...process.env,
      BACKLOT_STATE_DIR: stateDir,
      BACKLOT_POOL_MAX_TOTAL: '2',
      BACKLOT_LEASE_TTL_MS: '1500',
      BACKLOT_WAIT_MS: '30000',
      BACKLOT_SWEEP_MS: '5000', // the sweep lag IS the window under test
    };
    const cli = (args: string[]) =>
      new Promise<{ code: number; stdout: string; doneAt: number }>((resolve) => {
        execFile(process.execPath, [CLI, ...args, '--json'], { cwd: wt, env }, (err, out) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(out), doneAt: Date.now() }),
        );
      });

    expect((await cli(['up'])).code).toBe(0); // holder A leases; TTL 1.5s
    const waiter = cli(['up', '--holder', 'waiting-agent']); // queues on the expiry
    await new Promise((r) => setTimeout(r, 2500)); // lease lapsed, sweep not yet run
    const returning = cli(['up']); // holder A returns inside the window

    const [w, ret] = await Promise.all([waiter, returning]);
    expect(w.code, w.stdout).toBe(0);
    expect(ret.code, ret.stdout).toBe(0);
    // The waiter was first in line for the expiry; the returning holder's
    // lapsed lease must not have been refreshed over it.
    expect(w.doneAt, 'the queued waiter finished AFTER the returning holder — the lapsed lease was resurrected').toBeLessThan(ret.doneAt);
  }, 60_000);
});

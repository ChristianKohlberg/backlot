/**
 * Every repo-declared command must be BOUNDED (2026-07-19 review sweep).
 *
 * runBounded closed the wedge class for datastore/appliance commands; these
 * pin the sites that never got the fix: exec, token, service build, the
 * ready.cmd probe, upkeep rules, and template pruning's persisted drop. A
 * hung command at any of them held the environment's busy bit forever — the
 * sweeper skips busy envs, teardown refuses them even with --force, and every
 * later verb queues behind the wedge until the daemon is killed.
 *
 * BACKLOT_CMD_TIMEOUT_S shrinks the bound so a test proves it in seconds; the
 * unfixed code paths run their full sleep (60-600s) and blow the assertion.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) {
    try {
      execFileSync(process.execPath, [CLI, 'daemon', 'stop'], {
        env: { ...process.env, BACKLOT_STATE_DIR: d },
        timeout: 10_000,
      });
    } catch {
      /* best effort */
    }
    try {
      process.kill(Number(readFileSync(join(d, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* none */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function mkStack(yaml: string, extraFiles: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-bnd-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-bnd-wt-'));
  dirs.push(stateDir, wt);
  writeFileSync(join(wt, 'stack.yaml'), yaml);
  for (const [rel, content] of Object.entries(extraFiles)) writeFileSync(join(wt, rel), content);
  execFileSync('git', ['init', '-q'], { cwd: wt });
  const env = {
    ...process.env,
    BACKLOT_STATE_DIR: stateDir,
    BACKLOT_POOL_MAX: '2',
    BACKLOT_SWEEP_MS: '500',
    BACKLOT_CMD_TIMEOUT_S: '2',
  };
  // --json goes right after the verb: appended at the end it would ride into
  // exec's inner command, which passes flags through verbatim by design.
  const cli = (args: string[]) =>
    new Promise<{ code: number; stdout: string; elapsedMs: number }>((resolve) => {
      const started = Date.now();
      execFile(process.execPath, [CLI, args[0]!, '--json', ...args.slice(1)], { cwd: wt, env }, (err, out) =>
        resolve({
          code: err ? ((err as { code?: number }).code ?? 1) : 0,
          stdout: String(out),
          elapsedMs: Date.now() - started,
        }),
      );
    });
  return { cli, wt };
}

const IDLE = `name: bnd
services:
  idle: { run: "echo ready; sleep 300", ready: { log: "ready", timeout: 20 } }
`;

describe('a daemonizing service fails FAST as the work-error it is', () => {
  it('does not burn the readiness timeout probing a process that already exited', async () => {
    // The exit-0-immediately detector fires in <2s, but waitReady kept polling
    // a dead probe for the full ready.timeout and then blamed the ENVIRONMENT.
    const { cli } = mkStack(
      `name: bnd\nservices:\n  bg: { run: "sleep 30 & exit 0", port: web, ready: { http: /, timeout: 25 } }\n`,
    );
    const up = await cli(['up']);
    expect(up.code, up.stdout).toBe(1); // the repo's run command is at fault: work-error
    expect(up.elapsedMs).toBeLessThan(15_000); // seconds, not the 25s ready budget
    expect(JSON.parse(up.stdout).error.message).toMatch(/foreground|daemoniz/i);
  }, 60_000);
});

describe('exec is bounded and cannot wedge the environment', () => {
  it('kills a hung exec at the deadline; the environment stays usable', async () => {
    const { cli } = mkStack(IDLE);
    expect((await cli(['up'])).code).toBe(0);

    const hung = await cli(['exec', 'sleep', '60']);
    expect(hung.code, hung.stdout).toBe(1);
    expect(hung.elapsedMs).toBeLessThan(15_000);
    expect(JSON.parse(hung.stdout).error.message).toMatch(/timed out/i);

    // The wedge is the real defect: the env must still answer verbs.
    const after = await cli(['exec', 'echo', 'still-alive']);
    expect(after.code, after.stdout).toBe(0);
    expect(JSON.parse(after.stdout).stdout).toContain('still-alive');
  }, 60_000);
});

describe('a hung ready.cmd probe cannot outlive the readiness budget', () => {
  it('fails at ready.timeout instead of blocking on the probe command', async () => {
    const { cli } = mkStack(
      `name: bnd\nservices:\n  svc: { run: "sleep 300", ready: { cmd: "sleep 600", timeout: 3 } }\n`,
    );
    const up = await cli(['up']);
    expect(up.code, up.stdout).toBe(2); // not ready — env-error, as ever
    expect(up.elapsedMs).toBeLessThan(25_000); // ~3s budget + teardown, not 600s
    expect(JSON.parse(up.stdout).error.message).toMatch(/not ready after 3s/);
  }, 60_000);
});

describe('upkeep rules are bounded', () => {
  it('a hung upkeep command fails the bind as work-error at the deadline', async () => {
    const { cli } = mkStack(
      `name: bnd\nservices:\n  idle: { run: "echo ready; sleep 300", ready: { log: "ready", timeout: 20 } }\nupkeep:\n  - { when: trigger.txt, run: "sleep 600" }\n`,
      { 'trigger.txt': 'v1\n' },
    );
    const up = await cli(['up']);
    expect(up.code, up.stdout).toBe(1);
    expect(up.elapsedMs).toBeLessThan(15_000);
    expect(JSON.parse(up.stdout).error.message).toMatch(/upkeep.*timed out|timed out.*upkeep/i);
  }, 60_000);
});

describe('service builds are bounded', () => {
  it('a hung build fails the bind as work-error at the deadline', async () => {
    const { cli } = mkStack(
      `name: bnd\nservices:\n  web: { build: "sleep 600", run: "echo ready; sleep 300", ready: { log: "ready", timeout: 20 } }\n`,
    );
    const up = await cli(['up']);
    expect(up.code, up.stdout).toBe(1);
    expect(up.elapsedMs).toBeLessThan(15_000);
    expect(JSON.parse(up.stdout).error.message).toMatch(/build.*timed out|timed out/i);
  }, 60_000);
});

describe('the auth.token hook is bounded', () => {
  it('a hung token mint fails as work-error at the deadline', async () => {
    const { cli } = mkStack(`${IDLE}auth:\n  token: "sleep 600"\n`);
    expect((await cli(['up'])).code).toBe(0);
    const tok = await cli(['token', '--role', 'admin']);
    expect(tok.code, tok.stdout).toBe(1);
    expect(tok.elapsedMs).toBeLessThan(15_000);
  }, 60_000);
});

describe('template pruning survives a hung persisted drop command (unit)', () => {
  it('bounds the marker drop instead of stalling the retention sweep', async () => {
    process.env.BACKLOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'backlot-bnd-ret-'));
    dirs.push(process.env.BACKLOT_STATE_DIR);
    const saved = process.env.BACKLOT_CMD_TIMEOUT_S;
    process.env.BACKLOT_CMD_TIMEOUT_S = '1';
    try {
      const { pruneTemplates } = await import('../src/core/retention.js');
      const { policy } = await import('../src/core/policy.js');
      const root = mkdtempSync(join(tmpdir(), 'backlot-bnd-tpl-'));
      dirs.push(root);
      mkdirSync(join(root, 'stk'));
      // Oldest file first: a marker whose persisted drop hangs.
      const marker = join(root, 'stk', 'main-dev@abc.baked');
      writeFileSync(marker, JSON.stringify({ v: 1, ns: 'tpl_x', drop: 'sleep 600' }));
      utimesSync(marker, new Date(0), new Date(0));
      writeFileSync(join(root, 'stk', 'keep-1'), 'x');
      const started = Date.now();
      const pruned = await pruneTemplates({ ...policy(), templatesKeep: 1 }, root);
      expect(pruned).toBe(1);
      expect(Date.now() - started).toBeLessThan(10_000); // bounded, not 600s
    } finally {
      if (saved === undefined) delete process.env.BACKLOT_CMD_TIMEOUT_S;
      else process.env.BACKLOT_CMD_TIMEOUT_S = saved;
    }
  }, 30_000);
});

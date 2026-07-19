/**
 * Lease squatting: environments held by nobody.
 *
 * A lease's holder is a NAME (a worktree path by default), and nothing about a
 * name can die — so an agent that crashed kept its environment leased for the
 * full TTL, and a lease exempted that environment from idle reclamation
 * entirely. The result was gigabytes of dev-servers held for nothing, and a
 * pool that saturated against ghosts.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/core/journal.js';

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

function ctx(extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-lease-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-lease-wt-'));
  dirs.push(stateDir, wt);
  writeFileSync(join(wt, 'srv.mjs'), `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT));\n`);
  writeFileSync(
    join(wt, 'stack.yaml'),
    `name: lease\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: ready, timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '300', ...extraEnv };
  const cli = (args: string[]) =>
    new Promise<{ code: number; json?: Record<string, unknown> }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json });
      });
    });
  const journal = () => new Journal(join(stateDir, 'journal.db'));
  return { stateDir, wt, cli, journal };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await settle(150);
  }
  return pred();
}

describe('a lease tied to a dead process is released immediately', () => {
  it('does not hold the environment for the rest of its TTL', async () => {
    const { cli, journal } = ctx();
    // A stand-in for the agent: a real process that will die. Its pid is what
    // the lease is pinned to.
    const agent = spawn('sh', ['-c', 'sleep 600'], { detached: true, stdio: 'ignore' });
    agent.unref();

    const up = await cli(['up', '--holder-pid', String(agent.pid), '--json']);
    expect(up.json?.state).toBe('hot');

    const before = journal().allLeases();
    expect(before.length).toBe(1);
    expect(before[0]!.holderPid).toBe(agent.pid);
    // A 30-minute TTL: without liveness this lease would outlive the test by far.
    expect(before[0]!.expiresAt - Date.now()).toBeGreaterThan(10 * 60_000);

    process.kill(-agent.pid!, 'SIGKILL'); // the agent crashes

    const released = await waitFor(() => journal().allLeases().length === 0);
    expect(released, 'the lease outlived its holder').toBe(true);
  }, 120_000);

  it('leaves a lease alone while its holder is alive', async () => {
    const { cli, journal } = ctx();
    const agent = spawn('sh', ['-c', 'sleep 600'], { detached: true, stdio: 'ignore' });
    agent.unref();
    try {
      await cli(['up', '--holder-pid', String(agent.pid), '--json']);
      await settle(2000); // several sweeps
      expect(journal().allLeases().length, 'a live holder lost its lease').toBe(1);
    } finally {
      try {
        process.kill(-agent.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }, 120_000);

  it('accepts the identity through BACKLOT_HOLDER_PID as well', async () => {
    const agent = spawn('sh', ['-c', 'sleep 600'], { detached: true, stdio: 'ignore' });
    agent.unref();
    const { cli, journal } = ctx({ BACKLOT_HOLDER_PID: String(agent.pid) });
    try {
      await cli(['up', '--json']);
      expect(journal().allLeases()[0]!.holderPid).toBe(agent.pid);
    } finally {
      try {
        process.kill(-agent.pid!, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }, 120_000);

  it('rejects a nonsense --holder-pid instead of silently ignoring it', async () => {
    const { cli } = ctx();
    const res = await cli(['up', '--holder-pid', 'abc', '--json']);
    expect(res.code).toBe(64);
  }, 60_000);
});

describe('a leased environment still gives up its heat when nothing uses it', () => {
  it('quiesces to warm while KEEPING the lease', async () => {
    // 1s leased-idle threshold stands in for the 60-minute default.
    const { cli, journal } = ctx({ BACKLOT_LEASED_IDLE_TTL_MS: '1000', BACKLOT_IDLE_TTL_MS: '1000' });
    const up = await cli(['up', '--json']);
    expect(up.json?.state).toBe('hot');
    const envId = String(up.json?.envId);

    // Before: holding a lease exempted the environment from idle reclamation
    // entirely, so its services ran for the whole TTL even untouched.
    const quiesced = await waitFor(() => journal().getEnv(envId)?.state === 'warm');
    expect(quiesced, 'a leased but idle environment kept its services').toBe(true);

    // The LEASE survives — ownership is not what we reclaimed, only heat.
    expect(journal().allLeases().length).toBe(1);
    expect(Object.keys(journal().getEnv(envId)!.servicePids).length).toBe(0);

    // And the next verb rebinds it, so the agent sees only a slower call.
    const again = await cli(['up', '--json']);
    expect(again.json?.state).toBe('hot');
  }, 120_000);

  it('does not quiesce an environment that is being used', async () => {
    const { cli, journal } = ctx({ BACKLOT_LEASED_IDLE_TTL_MS: '2500', BACKLOT_IDLE_TTL_MS: '2500' });
    const up = await cli(['up', '--json']);
    const envId = String(up.json?.envId);

    // lastUsedAt only moved on BIND before this change, so an agent running
    // exec/ctx/logs for an hour looked completely idle — and would have had its
    // services stopped underneath it.
    for (let i = 0; i < 6; i++) {
      await settle(700);
      await cli(['ctx', '--json']);
    }

    expect(journal().getEnv(envId)?.state, 'an actively used environment was quiesced').toBe('hot');
  }, 120_000);
});

describe('pool ls makes squatting visible', () => {
  it('reports holder liveness and heat', async () => {
    const { cli } = ctx();
    const agent = spawn('sh', ['-c', 'sleep 600'], { detached: true, stdio: 'ignore' });
    agent.unref();
    await cli(['up', '--holder-pid', String(agent.pid), '--json']);

    const ls = await cli(['pool', 'ls', '--json']);
    const envs = ls.json?.envs as Array<{ holderAlive: boolean | null; heat: string; lease: unknown }>;
    expect(envs.length).toBeGreaterThan(0);
    // You cannot manage what you cannot see: before this, a crashed agent's
    // environment looked identical to a working one.
    expect(envs[0]!.holderAlive).toBe(true);
    expect(envs[0]!.heat).toBe('active');

    process.kill(-agent.pid!, 'SIGKILL');
    await settle(500);
    const after = await cli(['pool', 'ls', '--json']);
    const afterEnvs = after.json?.envs as Array<{ holderAlive: boolean | null }>;
    // Either the lease is already gone, or it is visibly held by a dead process.
    if (afterEnvs[0]?.holderAlive !== null) expect(afterEnvs[0]!.holderAlive).toBe(false);
  }, 120_000);
});

describe('a quiesce is never published as a teardown (decision 0021)', () => {
  it('the journal never reads `recycling` during a heat reclaim, and the lease survives', async () => {
    // Disk is truth: whatever the journal says at any instant is exactly what
    // a daemon crash at that instant bequeaths to recovery — and recovery's
    // contract for `recycling` is FINISH THE TEARDOWN (delete env AND lease).
    // The quiesce path used to borrow `recycling` while stopping services, so
    // a crash inside that window escalated a routine heat reclaim into total
    // destruction of a live agent's environment. A TERM-ignoring service
    // stretches the stop window to observable length.
    const c = ctx({ BACKLOT_LEASED_IDLE_TTL_MS: '1000', BACKLOT_LEASE_TTL_MS: '600000' });
    writeFileSync(
      join(c.wt, 'stack.yaml'),
      `name: lease\nservices:\n  web: { run: "trap '' TERM; echo ready; sleep 300", ready: { log: ready, timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`,
    );
    expect((await c.cli(['up', '--json'])).code).toBe(0);
    const envId = c.journal().allEnvs()[0]!.id;

    // Poll the published state through the idle window and the quiesce itself.
    const seen = new Set<string>();
    const deadline = Date.now() + 12_000;
    for (;;) {
      const row = c.journal().getEnv(envId);
      if (row) seen.add(row.state);
      if ((row?.state === 'warm' && Object.keys(row.servicePids).length === 0) || Date.now() > deadline) break;
      await settle(50);
    }

    expect([...seen], 'a heat reclaim must never be published as a teardown').not.toContain('recycling');
    const after = c.journal();
    const row = after.getEnv(envId);
    expect(row?.state).toBe('warm'); // heat reclaimed…
    expect(after.leaseForEnv(envId)).toBeTruthy(); // …lease intact
  }, 30_000);
});

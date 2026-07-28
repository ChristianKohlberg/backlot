/**
 * Three failure modes reported from one long agent-fleet session (issues #40,
 * #41, #34). They looked unrelated and turned out to be a single chain.
 *
 * 1. `BACKLOT_HOLDER_PID=$$ backlot up` is the documented way to hold a lease,
 *    and it CANNOT work from an agent harness: every command runs in a fresh
 *    shell, so `$$` names a shell that has already exited. The lease was created
 *    already dead — `holderAlive: false` on the very next command — and the
 *    sweeper's dead-holder rule (which exists to free crashed agents' envs in
 *    seconds) freed it while the agent was still working. The next bind took the
 *    environment, a `run` defaulting to the `empty` preset wiped the store, and
 *    the first agent was left looking at a different, unseeded database through
 *    the same URL. Roughly 30 agents over 14 hours read that as a stale seed
 *    template and went hunting in the wrong subsystem.
 *
 * 2. `pool recycle <env-id>` dropped the id and recycled the WHOLE pool. Aiming
 *    at one cold environment tore down five siblings, one of them mid-run.
 *
 * 3. Teardown never scanned for escaped grandchildren, and quiesce never reaped
 *    at all — so a service that called setsid() outlived both, kept its port,
 *    and had its cwd deleted underneath it. That is what made the pool look
 *    wedged and sent an operator to `pool recycle` in the first place.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/core/journal.js';
import { procScanSupported, scanTagged, scanByCwd } from '../src/core/procscan.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

function ctx(extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-agentlease-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-agentlease-wt-'));
  writeFileSync(
    join(wt, 'srv.mjs'),
    `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT));\n`,
  );
  writeFileSync(
    join(wt, 'stack.yaml'),
    `name: agentlease\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: ready, timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '300', ...extraEnv };
  const cli = (args: string[], cwd = wt) =>
    new Promise<{ code: number; json?: Record<string, unknown>; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const journal = () => new Journal(join(stateDir, 'journal.db'));
  cleanups.push(() => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* already gone */
    }
    for (const p of scanTagged(stateDir)) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });
  return { stateDir, wt, cli, journal };
}

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await settle(100);
  }
  return pred();
}

/** A pid that is certainly dead, and certainly was a real process. */
function deadPid(): number {
  const proc = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
  const pid = proc.pid!;
  return pid;
}

describe('a bind whose holder is already dead is refused, not silently accepted (#41)', () => {
  it('refuses --holder-pid naming a dead process and creates no lease', async () => {
    const { cli, journal } = ctx();
    const pid = deadPid();
    await waitFor(() => !alive(pid));

    const res = await cli(['up', '--holder-pid', String(pid), '--json']);

    // A usage error, not a bind failure: nothing about the environment is wrong.
    expect(res.code, 'a dead-on-arrival lease must not be accepted').toBe(64);
    // The message has to name the pattern that produces this, because the
    // symptom people actually chase is an empty database.
    expect(res.stderr).toMatch(/not a live process/);
    expect(res.stderr).toMatch(/--ttl/);
    // And crucially: no lease exists, so nothing is holding an env that the
    // sweeper is about to free underneath its user.
    expect(journal().allLeases().length).toBe(0);
  }, 60_000);

  it('refuses the same thing through BACKLOT_HOLDER_PID — the form agents actually use', async () => {
    const pid = deadPid();
    await waitFor(() => !alive(pid));
    const { cli, journal } = ctx({ BACKLOT_HOLDER_PID: String(pid) });

    const res = await cli(['up', '--json']);

    expect(res.code).toBe(64);
    // Name the source the caller used, or the message points at a flag they
    // never typed.
    expect(res.stderr).toMatch(/BACKLOT_HOLDER_PID/);
    expect(journal().allLeases().length).toBe(0);
  }, 60_000);

  it('still accepts --ttl, the form that works from a fresh shell every time', async () => {
    const { cli, journal } = ctx();
    const up = await cli(['up', '--ttl', '45', '--json']);
    expect(up.code).toBe(0);

    const leases = journal().allLeases();
    expect(leases.length).toBe(1);
    // No holder pid at all, so there is nothing for the dead-holder sweep to
    // act on: this lease lives for its stated time.
    expect(leases[0]!.holderPid).toBeUndefined();
    expect(leases[0]!.expiresAt - Date.now()).toBeGreaterThan(40 * 60_000);

    // Several sweeps later it is still there — the whole point.
    await settle(1500);
    expect(journal().allLeases().length, 'a TTL lease was reclaimed anyway').toBe(1);
  }, 120_000);
});

describe('pool recycle honours the environment it was given (#40)', () => {
  it('recycles exactly the named environment and leaves the others alone', async () => {
    const { cli, journal } = ctx({ BACKLOT_LEASE_TTL_MS: '2000' });
    // Two environments, sequentially, by letting the first lease lapse. Each
    // `up` from the same worktree refreshes one lease, so a second env needs a
    // second holder.
    const a = await cli(['up', '--json']);
    expect(a.code).toBe(0);
    const b = await cli(['up', '--holder', 'other-agent', '--json']);
    expect(b.code).toBe(0);
    const idA = String(a.json?.envId);
    const idB = String(b.json?.envId);
    expect(idA).not.toBe(idB);

    // Release both so neither is lease-protected — the scope bug has to fail
    // for scope reasons, not because a lease happened to save the sibling.
    await cli(['release', '--json']);
    await cli(['release', '--holder', 'other-agent', '--json']);
    await waitFor(() => journal().allLeases().length === 0);

    const res = await cli(['pool', 'recycle', idA, '--json']);
    expect(res.code).toBe(0);
    expect(res.json?.recycled).toEqual([idA]);

    // The id used to be parsed and dropped, so this asserted nothing survived.
    expect(journal().getEnv(idA), 'the named environment survived').toBeUndefined();
    expect(journal().getEnv(idB), 'recycle widened to an environment nobody named').toBeTruthy();
  }, 120_000);

  it('refuses to recycle a leased environment, naming its holder', async () => {
    const { cli, journal } = ctx();
    const up = await cli(['up', '--holder', 'busy-agent', '--json']);
    const envId = String(up.json?.envId);

    const res = await cli(['pool', 'recycle', envId, '--json']);

    // work-error: the caller asked for something that would destroy someone
    // else's work, and saying so beats doing it.
    expect(res.code).toBe(1);
    expect(JSON.stringify(res.json)).toMatch(/busy-agent/);
    expect(JSON.stringify(res.json)).toMatch(/--force/);
    expect(journal().getEnv(envId), 'a leased environment was recycled without force').toBeTruthy();
  }, 120_000);

  it('takes a leased environment only when --force says so', async () => {
    const { cli, journal } = ctx();
    const up = await cli(['up', '--holder', 'doomed-agent', '--json']);
    const envId = String(up.json?.envId);

    const res = await cli(['pool', 'recycle', envId, '--force', '--json']);
    expect(res.code).toBe(0);
    expect(journal().getEnv(envId)).toBeUndefined();
  }, 120_000);

  it('rejects an unknown id instead of falling back to the whole pool', async () => {
    const { cli, journal } = ctx();
    const up = await cli(['up', '--json']);
    const envId = String(up.json?.envId);

    const res = await cli(['pool', 'recycle', 'i_nope-e9', '--json']);

    expect(res.code).toBe(1);
    expect(JSON.stringify(res.json)).toMatch(/no environment/);
    // A typo must never be the trigger for a pool-wide teardown.
    expect(journal().getEnv(envId), 'an unknown id recycled a real environment').toBeTruthy();
  }, 120_000);

  it('says which environments a bare recycle left behind, and why', async () => {
    const { cli } = ctx();
    await cli(['up', '--holder', 'keeps-working', '--json']);

    const res = await cli(['pool', 'recycle', '--json']);
    expect(res.code).toBe(0);
    const skipped = res.json?.skipped as Array<{ envId: string; reason: string }>;
    // "Recycled 0 environments" with no reason is what makes a caller escalate
    // to force.
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.reason).toMatch(/keeps-working/);
  }, 120_000);
});

describe('pool status states the conclusion instead of leaving it to be inferred (#40)', () => {
  it('marks a quiesced, unleased environment available', async () => {
    const { cli, journal } = ctx({ BACKLOT_IDLE_TTL_MS: '1000', BACKLOT_LEASED_IDLE_TTL_MS: '1000' });
    const up = await cli(['up', '--json']);
    const envId = String(up.json?.envId);
    await cli(['release', '--json']);

    // Wait for the heat reclaim: state warm, which status reports as cold.
    const cooled = await waitFor(() => journal().getEnv(envId)?.state === 'warm');
    expect(cooled).toBe(true);

    const ls = await cli(['pool', 'ls', '--json']);
    const envs = ls.json?.envs as Array<{ id: string; heat: string; available: boolean; summary: string }>;
    const row = envs.find((e) => e.id === envId)!;

    expect(row.heat).toBe('cold'); // unchanged — 'cold' still means quiesced
    // …but 'cold' was read as 'broken', and the remedy people reached for was a
    // pool-wide recycle. Say plainly that this one is fine.
    expect(row.available, 'a free pool entry did not report itself as available').toBe(true);
    expect(row.summary).toMatch(/free/);
  }, 120_000);

  it('does not call a leased environment available', async () => {
    const { cli } = ctx();
    const up = await cli(['up', '--holder', 'holder-1', '--json']);
    const envId = String(up.json?.envId);
    const ls = await cli(['pool', 'ls', '--json']);
    const envs = ls.json?.envs as Array<{ id: string; available: boolean; summary: string }>;
    const row = envs.find((e) => e.id === envId)!;
    expect(row.available).toBe(false);
    expect(row.summary).toMatch(/holder-1/);
  }, 120_000);
});

describe('release explains a no-op instead of returning a bare false (#41)', () => {
  it('names the holder mismatch and who does hold the lease', async () => {
    const { cli, wt } = ctx();
    await cli(['up', '--json']);

    // The reported shape: the agent releases from somewhere other than the
    // directory that bound, and gets {"released": false} with nothing to act on.
    const res = await cli(['release', '--holder', 'never-bound', '--json']);
    expect(res.json?.released).toBe(false);
    expect(String(res.json?.reason)).toMatch(/never-bound/);
    // The real holder is the binding worktree path, so naming holders tells the
    // caller exactly what to pass.
    expect(JSON.stringify(res.json?.otherHolders)).toContain(wt);

    // And the honest path still works.
    const ok = await cli(['release', '--json']);
    expect(ok.json?.released).toBe(true);
  }, 120_000);

  it('distinguishes "already released" from "wrong holder"', async () => {
    const { cli } = ctx();
    const res = await cli(['release', '--json']);
    expect(res.json?.released).toBe(false);
    expect(String(res.json?.reason)).toMatch(/no leases at all/);
  }, 60_000);
});

describe('token --raw prints what an Authorization header wants (#41, #39)', () => {
  it('prints the bare token, and ctx advertises the supported path', async () => {
    const { cli, wt } = ctx();
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: agentlease\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: ready, timeout: 20 } }\n` +
        `auth:\n  token: "printf tk_{{role}}"\nchecks:\n  ok: { run: "true" }\n`,
    );
    expect((await cli(['up', '--json'])).code).toBe(0);

    const wrapped = await cli(['token', '--role', 'human', '--json']);
    expect(wrapped.json?.token).toBe('tk_human');

    // Several agents piped the JSON object straight into a header and read the
    // resulting 401 as a permissions problem.
    const raw = await cli(['token', '--role', 'human', '--raw']);
    expect(raw.code).toBe(0);
    expect(raw.stdout.trim()).toBe('tk_human');

    // ctx used to advertise only the manifest's internal hook, which still
    // carries its {{role}} placeholder and signs with the wrong key outside the
    // environment.
    const c = await cli(['ctx', '--json']);
    expect(c.json?.tokenVia).toBe('backlot token --role <role> --raw');
  }, 120_000);
});

describe.runIf(procScanSupported())('teardown and quiesce reap what escaped the group kill (#34)', () => {
  /**
   * The reported leak: ~548 orphaned processes holding ~15 GiB, many of them
   * backlot service children still running out of an environment tree that had
   * been deleted a day earlier. A tagged escapee is the shape the field hit —
   * `ng serve`'s detached esbuild workers inherit the tag but not the process
   * group, so the -pgid SIGKILL misses them.
   */
  function spawnEscapee(envId: string, stateDir: string, cwd: string): number {
    const proc = spawn(
      process.execPath,
      ['--eval', `require('net').createServer().listen(0,'127.0.0.1');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`],
      {
        detached: true, // its own process group: the setsid() escape
        cwd,
        env: { ...process.env, BACKLOT_ENV_ID: envId, BACKLOT_SERVICE: 'web', BACKLOT_STATE_ROOT: stateDir },
        stdio: 'ignore',
      },
    );
    proc.unref();
    return proc.pid!;
  }

  it('teardown kills a tagged escapee instead of leaving it with a deleted cwd', async () => {
    const { cli, stateDir, journal } = ctx();
    const up = await cli(['up', '--json']);
    const envId = String(up.json?.envId);
    const envRoot = journal().getEnv(envId)!.root;

    const escapee = spawnEscapee(envId, stateDir, envRoot);
    expect(alive(escapee)).toBe(true);

    await cli(['release', '--json']);
    const res = await cli(['pool', 'recycle', envId, '--json']);
    expect(res.code).toBe(0);

    // Teardown only ever reaped the pids it had RECORDED — which are the
    // top-level service pids, never their children. This one survived the whole
    // teardown and then had its cwd deleted underneath it.
    const reaped = await waitFor(() => !alive(escapee), 20_000);
    expect(reaped, 'a tagged escapee outlived teardown').toBe(true);
  }, 120_000);

  it('teardown also reaps a process that scrubbed the tag, by its cwd', async () => {
    const { cli, journal } = ctx();
    const up = await cli(['up', '--json']);
    const envId = String(up.json?.envId);
    const envRoot = journal().getEnv(envId)!.root;

    // No BACKLOT tag at all: invisible to scanTagged. Its cwd is the only thing
    // that still says whose it is.
    const proc = spawn(process.execPath, ['--eval', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`], {
      detached: true,
      cwd: envRoot,
      env: { PATH: process.env.PATH ?? '' },
      stdio: 'ignore',
    });
    proc.unref();
    const untagged = proc.pid!;
    expect(scanTagged(join(envRoot, 'nope')).some((p) => p.pid === untagged)).toBe(false);
    expect(scanByCwd(envRoot).some((p) => p.pid === untagged)).toBe(true);

    await cli(['release', '--json']);
    expect((await cli(['pool', 'recycle', envId, '--json'])).code).toBe(0);

    const reaped = await waitFor(() => !alive(untagged), 20_000);
    expect(reaped, 'an untagged process kept running inside a deleted env tree').toBe(true);
  }, 120_000);

  it('quiesce reaps escapees rather than deferring to a bind that may never come', async () => {
    // A quiesced environment can sit cold for hours. Deferring the reap to the
    // next bindAndStart meant its escapees held memory and PORTS for exactly
    // that long — and the next bind then failed with "port occupied by a
    // foreign process", which is what made the pool look wedged.
    const { cli, stateDir, journal } = ctx({ BACKLOT_IDLE_TTL_MS: '1000', BACKLOT_LEASED_IDLE_TTL_MS: '1000' });
    const up = await cli(['up', '--json']);
    const envId = String(up.json?.envId);
    const envRoot = journal().getEnv(envId)!.root;

    const escapee = spawnEscapee(envId, stateDir, envRoot);
    await cli(['release', '--json']);

    const cooled = await waitFor(() => journal().getEnv(envId)?.state === 'warm', 20_000);
    expect(cooled).toBe(true);

    const reaped = await waitFor(() => !alive(escapee), 20_000);
    expect(reaped, 'quiesce stopped the services but left an escapee running').toBe(true);
  }, 120_000);
});

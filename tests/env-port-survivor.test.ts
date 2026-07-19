/**
 * Regression test for the process-leak bug: an env whose quiesce or group-kill
 * left a service process alive (or running in a different process group) must
 * have that process reaped by the NEXT bind, not block it with "port occupied".
 *
 * Observed failure (2026-07-18): a service process survived ~26 minutes after
 * env teardown with its cwd deleted, still binding its port and blocking two
 * subsequent `backlot up` attempts.
 *
 * Root cause: `bindAndStart` called `stopAll()` on a fresh (post-restart or
 * post-quiesce) supervisor that had no in-memory services, making it a no-op.
 * The port-free check then failed because the survivor still held the port.
 *
 * Fix (`reapEnvProcesses`): after every `stopAll()` in `bindAndStart`:
 *   (a) `reapPids(env.servicePids)` — retries the kill for journal-recorded
 *       survivors on all platforms.
 *   (b) `scanTagged` (Linux only) — kills processes that escaped the group kill
 *       by calling setsid / spawning detached, which leaves them in a new
 *       process group. They are still findable by the BACKLOT tag in their env.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/core/journal.js';
import { procScanSupported, scanTagged, startTime } from '../src/core/procscan.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

function makeContext(extra: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-surv-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '300', ...extra };
  const cli = (
    args: string[],
    cwd: string,
  ): Promise<{ exitCode: number; json?: Record<string, unknown>; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const daemonPid = () => Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
  const cleanup = () => {
    try {
      process.kill(daemonPid());
    } catch {
      /* gone */
    }
    for (const p of scanTagged(stateDir)) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
  };
  return { stateDir, env, cli, cleanup, daemonPid };
}

function makeWt(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `backlot-surv-${name}-`));
  // A polite server: exits cleanly on SIGTERM. The tests below kill it
  // manually so the daemon's group-kill record is clean.
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { createServer } from 'node:http';
console.log('up');
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT));
`,
  );
  writeFileSync(
    join(dir, 'stack.yaml'),
    `name: ${name}\nservices:\n  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: up, timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const settle = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await settle(100);
  }
  return pred();
}

/** Spawn a port-holding process in its OWN process group, with BACKLOT tags. */
function spawnEscapee(port: number, envId: string, stateDir: string): { pid: number } {
  // Uses a raw TCP server (not HTTP) so the service doesn't accidentally answer
  // the backlot readiness probe and cause a bind race with the real service.
  // SIGTERM is ignored so the process is a faithful "stubborn escapee".
  const proc = spawn(
    process.execPath,
    ['--eval', `require('net').createServer().listen(${port},'127.0.0.1');process.on('SIGTERM',()=>{});`],
    {
      detached: true, // own process group — simulates setsid() escape
      env: {
        ...process.env,
        BACKLOT_ENV_ID: envId,
        BACKLOT_SERVICE: 'web',
        BACKLOT_STATE_ROOT: stateDir,
      },
      stdio: 'ignore',
    },
  );
  proc.unref();
  return { pid: proc.pid! };
}

const ctxList: Array<() => void> = [];
const dirList: string[] = [];
afterAll(() => {
  for (const c of ctxList) c();
  for (const d of dirList) rmSync(d, { recursive: true, force: true });
});

describe('env port-survivor: bind reaps tagged escapees instead of blocking', () => {
  /**
   * The tagged-escapee scenario: a service spawned a detached grandchild that
   * called setsid() and moved into a new process group. The group-kill only
   * reached the original group; the grandchild survived with the BACKLOT tag
   * still in its environment. The journal recorded nothing for the grandchild
   * (servicePids tracks the group leader, which is dead).
   *
   * Without the fix: bindAndStart's stopAll() is a no-op (fresh supervisor),
   * servicePids is empty so reapPids is a no-op, port check sees the escapee
   * and throws "port occupied by a foreign process".
   *
   * With the fix: reapEnvProcesses → scanTagged finds the grandchild by its
   * BACKLOT_ENV_ID tag → killGroupVerified kills it → port is free → service
   * starts.
   */
  it.skipIf(!procScanSupported())(
    'kills a tagged escaped-group process so the next bind succeeds',
    async () => {
      const ctx = makeContext();
      ctxList.push(ctx.cleanup);
      const wt = makeWt('escapee');
      dirList.push(wt);

      // Step 1: bring up to establish env E with port P.
      const up1 = await ctx.cli(['up', '--json'], wt);
      expect(up1.exitCode, `initial up failed: ${up1.stderr}`).toBe(0);

      const journal = new Journal(join(ctx.stateDir, 'journal.db'));
      const envRow = journal.allEnvs()[0]!;
      const port = envRow.ports['web']!;
      expect(port).toBeGreaterThan(0);

      // Step 2: kill daemon (orphans the service).
      process.kill(ctx.daemonPid(), 'SIGKILL');
      await settle(300);

      // Step 3: kill all tagged processes for this env (simulating successful
      // group-kill of the original service's group).
      for (const p of scanTagged(ctx.stateDir)) {
        try {
          process.kill(-p.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      await waitFor(() => scanTagged(ctx.stateDir).filter((p) => p.envId === envRow.id).length === 0, 5_000);

      // Step 4: spawn the escaped grandchild on port P with BACKLOT tags.
      // Its own process group was NOT killed — it escaped by calling setsid.
      const { pid: escapeePid } = spawnEscapee(port, envRow.id, ctx.stateDir);
      await settle(300); // let it bind

      expect(alive(escapeePid), 'escapee must be alive before second up').toBe(true);
      // Confirm it carries the tag (which is what the fix uses to find it).
      expect(
        scanTagged(ctx.stateDir).some((p) => p.pid === escapeePid),
        'escapee must carry the BACKLOT tag',
      ).toBe(true);

      // Step 5: patch journal — env warm, servicePids empty.
      // The group-kill found the original group gone (group leader was dead);
      // it never knew about the grandchild in its own group.
      envRow.state = 'warm';
      envRow.servicePids = {};
      journal.saveEnv(envRow);

      // Step 6: `up` again. New daemon starts; recover() sees warm env with
      // empty servicePids — nothing to reap via pids. Without the fix the
      // port-free check fails. With the fix, scanTagged finds the escapee and
      // kills it before the check.
      const up2 = await ctx.cli(['up', '--json'], wt);
      expect(up2.exitCode, `second up failed — port still held by escapee? alive=${alive(escapeePid)}\nstderr: ${up2.stderr}`).toBe(0);

      // The escapee must be dead.
      expect(await waitFor(() => !alive(escapeePid)), `escapee pid ${escapeePid} survived the bind`).toBe(true);
    },
    60_000,
  );

  /**
   * The phantom-pid scenario: after a daemon crash, the original service's pid
   * was reused by an unrelated process before recovery ran. reapPids sees the
   * pid as "alive but not ours" (sameProcess returns false, groupAlive returns
   * true) and keeps it as a survivor. Meanwhile a REAL tagged holder still has
   * the port. reapEnvProcesses must find and kill the real holder via scanTagged.
   *
   * Without the fix: stopAll() is a no-op, reapPids misidentifies the holder as
   * a phantom, port check fails.
   *
   * With the fix: scanTagged finds the real holder by its BACKLOT tag (correct
   * startTime from the scan), kills it, port is free.
   */
  /**
   * The same-daemon scenario — the only one the daemon-restart tests above do
   * NOT cover: on a restart, recover() already ran poolGc() and reclaimed
   * tagged orphans of warm envs, so those tests pass even without the bind-time
   * reap. Here the daemon STAYS ALIVE: the service spawns a detached
   * grandchild (setsid-style escape) that binds the port and ignores SIGTERM,
   * the idle sweeper quiesces the env (group-kill misses the grandchild), and
   * the user re-ups before the ~60s GC cadence (disabled here to model that
   * window — the observed incident held the port 26 minutes).
   *
   * Without the fix: bindAndStart's stopAll() finds nothing (env quiesced),
   * servicePids is empty, and the port-free check fails with "port occupied by
   * a foreign process". With the fix: reapEnvProcesses → scanTagged kills the
   * grandchild before the check and the bind succeeds.
   */
  it.skipIf(!procScanSupported())(
    'reaps an escaped grandchild on rebind after quiesce, same daemon (no restart)',
    async () => {
      const ctx = makeContext({ BACKLOT_IDLE_TTL_MS: '500', BACKLOT_GC_MS: '999999999' });
      ctxList.push(ctx.cleanup);
      const wt = mkdtempSync(join(tmpdir(), 'backlot-surv-quiesce-'));
      dirList.push(wt);
      // The service itself spawns the escapee: a detached grandchild in its own
      // process group that binds the service port and ignores SIGTERM.
      writeFileSync(
        join(wt, 'server.mjs'),
        `import { spawn } from 'node:child_process';
const child = spawn(process.execPath,
  ['--eval', "require('net').createServer().listen(Number(process.env.PORT),'127.0.0.1');process.on('SIGTERM',()=>{});"],
  { detached: true, stdio: 'ignore', env: process.env });
child.unref();
console.log('up grandchild=' + child.pid);
setInterval(() => {}, 1e6);
`,
      );
      writeFileSync(
        join(wt, 'stack.yaml'),
        `name: quiesce\nservices:\n  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: up, timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`,
      );
      execFileSync('git', ['init', '-q'], { cwd: wt });

      const up1 = await ctx.cli(['up', '--json'], wt);
      expect(up1.exitCode, `initial up failed: ${up1.stderr}`).toBe(0);

      const logs = await ctx.cli(['logs', 'web', '--lines', '5'], wt);
      const grandchild = Number((logs.stdout + logs.stderr).match(/grandchild=(\d+)/)?.[1]);
      expect(grandchild, 'service must report its grandchild pid').toBeGreaterThan(0);
      expect(alive(grandchild)).toBe(true);

      const rel = await ctx.cli(['release', '--json'], wt);
      expect(rel.exitCode, `release failed: ${rel.stderr}`).toBe(0);

      // Idle sweeper quiesces the env: group-kill stops the service, the
      // grandchild escapes (own group) and keeps the port.
      const journalPath = join(ctx.stateDir, 'journal.db');
      expect(
        await waitFor(() => new Journal(journalPath).allEnvs()[0]?.state === 'warm'),
        'env must quiesce to warm after release',
      ).toBe(true);
      expect(alive(grandchild), 'grandchild must survive the quiesce group-kill').toBe(true);

      // Re-up on the SAME daemon. Without the bind-time reap this fails with
      // "port occupied by a foreign process".
      const up2 = await ctx.cli(['up', '--json'], wt);
      expect(up2.exitCode, `second up failed — port still held by grandchild? alive=${alive(grandchild)}\nstdout: ${up2.stdout}\nstderr: ${up2.stderr}`).toBe(0);
      expect(await waitFor(() => !alive(grandchild)), `grandchild pid ${grandchild} survived the rebind`).toBe(true);
    },
    60_000,
  );

  it.skipIf(!procScanSupported())(
    'reaps a tagged holder even when its pid appears to be a phantom (startTime mismatch)',
    async () => {
      const ctx = makeContext();
      ctxList.push(ctx.cleanup);
      const wt = makeWt('phantom');
      dirList.push(wt);

      const up1 = await ctx.cli(['up', '--json'], wt);
      expect(up1.exitCode, `initial up failed: ${up1.stderr}`).toBe(0);

      const journal = new Journal(join(ctx.stateDir, 'journal.db'));
      const envRow = journal.allEnvs()[0]!;
      const port = envRow.ports['web']!;

      // Kill daemon and all tagged processes.
      process.kill(ctx.daemonPid(), 'SIGKILL');
      await settle(300);
      for (const p of scanTagged(ctx.stateDir)) {
        try {
          process.kill(-p.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
      await waitFor(() => scanTagged(ctx.stateDir).filter((p) => p.envId === envRow.id).length === 0, 5_000);

      // Spawn a real holder that carries the BACKLOT tag.
      const { pid: holderPid } = spawnEscapee(port, envRow.id, ctx.stateDir);
      await settle(300);
      expect(alive(holderPid)).toBe(true);
      const actualStart = startTime(holderPid);

      // Patch journal: use a WRONG startTime so reapPids treats this pid as a
      // phantom (sameProcess returns false, groupAlive returns true → survivor).
      // recover() and a naive reapPids pass both see a "phantom" and skip killing.
      // Only scanTagged — using the actual start from /proc — can identify and
      // kill the real holder.
      envRow.state = 'warm';
      envRow.servicePids = { web: { pid: holderPid, startTime: (actualStart ?? 0) + 999_999 } };
      journal.saveEnv(envRow);

      const up2 = await ctx.cli(['up', '--json'], wt);
      expect(up2.exitCode, `second up failed; holder alive=${alive(holderPid)}\nstderr: ${up2.stderr}`).toBe(0);
      expect(await waitFor(() => !alive(holderPid)), `holder pid ${holderPid} survived`).toBe(true);
    },
    60_000,
  );
});

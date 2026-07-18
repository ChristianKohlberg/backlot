/**
 * Issue #5: a consumer or daemon that dies ungracefully must not strand the
 * environment's dev-servers. These tests assert on the PROCESS TABLE, not on
 * journal rows — the whole bug was that the journal looked fine while ~1 GB
 * per orphan stayed resident.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../src/core/journal.js';
import { killGroupVerified } from '../src/daemon/supervisor.js';
import { scanTagged, procScanSupported, startTime, sameProcess, groupAlive } from '../src/core/procscan.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

function makeContext(extra: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-orph-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '300', ...extra };
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
  const daemonPid = () => Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
  const cleanup = () => {
    try {
      process.kill(daemonPid());
    } catch {
      /* gone */
    }
    // Belt and braces: nothing tagged for this state root may outlive the test.
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

/**
 * A server that IGNORES SIGTERM — the .NET-host / trapping-shell shape that
 * outlived the old single-SIGTERM reap. Without escalation to SIGKILL this
 * process is immortal, which is exactly the leak.
 */
const STUBBORN = `import { createServer } from 'node:http';
process.on('SIGTERM', () => { /* deliberately ignored */ });
console.log('up');
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT));
`;

const POLITE = `import { createServer } from 'node:http';
console.log('up');
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT));
`;

function makeWt(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), `backlot-orph-${name}-`));
  writeFileSync(join(dir, 'server.mjs'), body);
  writeFileSync(
    join(dir, 'stack.yaml'),
    `name: ${name}
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
checks:
  ok: { run: "true" }
`,
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

/**
 * The pids that actually matter.
 *
 * `sh -c node server.mjs` FORKS on this platform, so the pid backlot records
 * is only the wrapper — it dies obediently on SIGTERM while the real server
 * survives holding the memory. Asserting on the recorded pid alone passes
 * against the un-fixed code, so every leak assertion here counts the real
 * `server.mjs` processes instead.
 */
const servers = (stateDir: string): number[] =>
  scanTagged(stateDir)
    .filter((p) => {
      try {
        const argv = readFileSync(`/proc/${p.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        // argv[0] is `sh` for the wrapper — only the real node server counts.
        return argv[0]?.includes('node') === true && argv.some((a) => a.includes('server.mjs'));
      } catch {
        return false;
      }
    })
    .map((p) => p.pid);

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await settle(100);
  }
  return pred();
}

const contexts: Array<() => void> = [];
const dirs: string[] = [];
afterAll(() => {
  for (const c of contexts) c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('process identity', () => {
  it.skipIf(!procScanSupported())('pins a pid to one process life', () => {
    const st = startTime(process.pid);
    expect(st).toBeGreaterThan(0);
    expect(sameProcess(process.pid, st)).toBe(true);
    // A recorded start time that does not match means the pid was reused —
    // signalling it would hit a bystander.
    expect(sameProcess(process.pid, st! + 1)).toBe(false);
  });

  it('reports a dead pid as not-ours rather than alive', () => {
    // Pick a pid that is almost certainly free, and confirm the negative.
    let free = 4_194_300;
    while (alive(free) && free > 1) free--;
    expect(sameProcess(free, 123)).toBe(false);
  });
});

describe('reap safety: pid reuse must never hit a bystander', () => {
  it('refuses to signal a group whose leader pid is no longer the recorded process', async () => {
    // A live group that backlot never spawned, standing in for whatever
    // inherited a recycled pid. Its recorded start time is deliberately wrong.
    const victim = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
    victim.unref();
    await settle(300);
    const pid = victim.pid!;
    expect(alive(pid)).toBe(true);

    const realStart = startTime(pid);
    const dead = await killGroupVerified(pid, (realStart ?? 0) + 999, 300);

    // Not ours, group still populated -> unresolved, and CRUCIALLY untouched.
    expect(dead).toBe(false);
    expect(alive(pid)).toBe(true);

    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }, 30_000);

  it('still reports a genuinely empty group as gone', async () => {
    const victim = spawn('sh', ['-c', 'true'], { detached: true, stdio: 'ignore' });
    victim.unref();
    await waitFor(() => !alive(victim.pid!), 5000);
    expect(await killGroupVerified(victim.pid!, 12345, 300)).toBe(true);
  }, 30_000);

  it('kills a group it CAN identify', async () => {
    const victim = spawn('sh', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' });
    victim.unref();
    await settle(300);
    const pid = victim.pid!;
    // Correct recorded identity -> the reap proceeds.
    expect(await killGroupVerified(pid, startTime(pid), 500)).toBe(true);
    expect(alive(pid)).toBe(false);
  }, 30_000);
});

describe('the degraded contract on platforms without /proc', () => {
  it('reports gc as unsupported rather than silently reclaiming nothing', async () => {
    const ctx = makeContext();
    contexts.push(ctx.cleanup);
    const wt = makeWt('unsup', POLITE);
    dirs.push(wt);
    await ctx.cli(['up', '--json'], wt);
    const gc = await ctx.cli(['pool', 'gc', '--json'], wt);
    // This runs on EVERY platform: Linux must report supported, macOS must
    // report unsupported. Either way the caller learns whether a sweep
    // happened, instead of reading an empty list as "nothing to reclaim".
    expect(gc.json?.supported).toBe(procScanSupported());
  }, 60_000);
});

describe('orphan reclaim (issue #5)', () => {
  it.skipIf(!procScanSupported())('tags every supervised service so it stays identifiable after its owner dies', async () => {
    const ctx = makeContext();
    contexts.push(ctx.cleanup);
    const wt = makeWt('tagged', POLITE);
    dirs.push(wt);

    const up = await ctx.cli(['up', '--json'], wt);
    expect(up.exitCode).toBe(0);

    const tagged = scanTagged(ctx.stateDir);
    expect(tagged.length).toBeGreaterThan(0);
    expect(tagged.some((p) => p.service === 'web')).toBe(true);
    // The tag is scoped to THIS state root, so a parallel backlot install
    // (or another test's daemon) can never be swept by this one.
    expect(tagged.every((p) => p.envId.startsWith('tagged'))).toBe(true);
  });

  // Needs the tag scan to find the real server, which is Linux-only.
  it.skipIf(!procScanSupported())('kills a service that ignores SIGTERM instead of leaving it stranded', async () => {
    const ctx = makeContext();
    contexts.push(ctx.cleanup);
    const wt = makeWt('stubborn', STUBBORN);
    dirs.push(wt);

    const up = await ctx.cli(['up', '--json'], wt);
    expect(up.exitCode).toBe(0);

    const running = servers(ctx.stateDir);
    expect(running.length).toBe(1);
    const server = running[0]!;
    expect(alive(server)).toBe(true);

    // Recycle is the graceful path — it must still win against SIGTERM-ignorers.
    const rec = await ctx.cli(['pool', 'recycle', '--all', '--json'], wt);
    expect(rec.exitCode).toBe(0);
    // The REAL server, not just the sh wrapper, must be gone.
    expect(await waitFor(() => !alive(server))).toBe(true);
    expect(servers(ctx.stateDir)).toEqual([]);
  }, 60_000);

  it.skipIf(!procScanSupported())('reclaims a dev-server orphaned by an ungracefully killed daemon', async () => {
    const ctx = makeContext();
    contexts.push(ctx.cleanup);
    const wt = makeWt('orphan', STUBBORN);
    dirs.push(wt);

    const up = await ctx.cli(['up', '--json'], wt);
    expect(up.exitCode).toBe(0);

    const server = servers(ctx.stateDir)[0]!;
    expect(alive(server)).toBe(true);

    // SIGKILL the daemon: no shutdown hook runs, so the service is orphaned
    // exactly as an OOM-kill would leave it.
    process.kill(ctx.daemonPid(), 'SIGKILL');
    await settle(300);
    expect(alive(server)).toBe(true); // still leaking at this point — that's the bug

    // Any command restarts the daemon, whose recovery must reclaim it.
    const ls = await ctx.cli(['pool', 'ls', '--json'], wt);
    expect(ls.exitCode).toBe(0);

    expect(await waitFor(() => !alive(server))).toBe(true);
    expect(servers(ctx.stateDir)).toEqual([]);
  }, 60_000);

  it.skipIf(!procScanSupported())('pool gc reclaims a tagged process whose env row is gone, and reports it', async () => {
    const ctx = makeContext();
    contexts.push(ctx.cleanup);
    const wt = makeWt('gc', STUBBORN);
    dirs.push(wt);

    const up = await ctx.cli(['up', '--json'], wt);
    expect(up.exitCode).toBe(0);

    const journal = new Journal(join(ctx.stateDir, 'journal.db'));
    const env = journal.allEnvs()[0]!;
    const server = servers(ctx.stateDir)[0]!;

    // Simulate the worst case the issue describes: the daemon has completely
    // lost the environment, so nothing pid-based could ever find the process.
    journal.deleteEnv(env.id);

    const gc = await ctx.cli(['pool', 'gc', '--json'], wt);
    expect(gc.exitCode).toBe(0);
    expect(gc.json?.supported).toBe(true);
    expect((gc.json?.reclaimed as unknown[]).length).toBeGreaterThan(0);
    expect(await waitFor(() => !alive(server))).toBe(true);
    expect(servers(ctx.stateDir)).toEqual([]);
  }, 60_000);

  it.skipIf(!procScanSupported())('never reclaims a service belonging to a live, hot environment', async () => {
    const ctx = makeContext();
    contexts.push(ctx.cleanup);
    const wt = makeWt('keep', POLITE);
    dirs.push(wt);

    const up = await ctx.cli(['up', '--json'], wt);
    expect(up.exitCode).toBe(0);

    const server = servers(ctx.stateDir)[0]!;

    const gc = await ctx.cli(['pool', 'gc', '--json'], wt);
    expect(gc.exitCode).toBe(0);
    expect((gc.json?.reclaimed as unknown[]).length).toBe(0);
    expect(gc.json?.skipped).toBeGreaterThan(0);

    // And it is genuinely still serving, not merely un-signalled.
    await settle(300);
    expect(alive(server)).toBe(true);
    expect(servers(ctx.stateDir)).toContain(server);
  }, 60_000);

  it.skipIf(!procScanSupported())('doctor reports an orphan rather than silently passing', async () => {
    const ctx = makeContext();
    contexts.push(ctx.cleanup);
    const wt = makeWt('diag', STUBBORN);
    dirs.push(wt);

    const up = await ctx.cli(['up', '--json'], wt);
    expect(up.exitCode).toBe(0);

    const journal = new Journal(join(ctx.stateDir, 'journal.db'));
    journal.deleteEnv(journal.allEnvs()[0]!.id);

    const doc = await ctx.cli(['pool', 'doctor', '--json'], wt);
    expect(doc.json?.ok).toBe(false);
    const issues = doc.json?.issues as Array<{ issue: string }>;
    expect(issues.some((i) => i.issue.includes('orphaned process'))).toBe(true);
  }, 60_000);
});

describe('journal compatibility', () => {
  it('reads the legacy bare-number service_pids shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backlot-orph-jrn-'));
    dirs.push(dir);
    const journal = new Journal(join(dir, 'journal.db'));
    journal.saveEnv({
      id: 'legacy-e1', stack: 'legacy', stackRoot: dir, state: 'hot', root: dir,
      ports: {}, datastoreNs: {}, fingerprints: {}, presets: {},
      bindCount: 0, createdAt: 1, lastUsedAt: 1, servicePids: { web: { pid: 4242 } }, failStreak: 0,
    });
    // Rewrite the blob the way backlot <= 0.5.0 wrote it: a bare number.
    const db = new DatabaseSync(join(dir, 'journal.db'));
    db.prepare('UPDATE envs SET service_pids = ? WHERE id = ?').run('{"web":4242}', 'legacy-e1');
    db.close();

    const back = new Journal(join(dir, 'journal.db')).getEnv('legacy-e1')!;
    expect(back.servicePids.web!.pid).toBe(4242);
    expect(back.servicePids.web!.startTime).toBeUndefined();
  });
});

describe('process identity is available on every platform', () => {
  it('pins a live pid and rejects a wrong recorded value, /proc or not', () => {
    // The Linux path reads /proc; elsewhere it shells out to `ps -o lstart=`.
    // Either way the contract is the same, and it is the contract the reaper
    // depends on to avoid signalling a recycled pid.
    const st = startTime(process.pid);
    expect(st).toBeDefined();
    expect(sameProcess(process.pid, st)).toBe(true);
    expect(sameProcess(process.pid, (st ?? 0) + 10_000)).toBe(false);
  });

  it('reports a group as alive while any member survives, not just the leader', async () => {
    const p = spawn('sh', ['-c', 'sleep 5'], { detached: true, stdio: 'ignore' });
    p.unref();
    await settle(300);
    expect(groupAlive(p.pid!)).toBe(true);
    process.kill(-p.pid!, 'SIGKILL');
    await waitFor(() => !groupAlive(p.pid!), 5000);
    expect(groupAlive(p.pid!)).toBe(false);
  }, 30_000);
});

describe('supervisor restart budget', () => {
  it.skipIf(!procScanSupported())('treats a crash after stable operation as fresh, not part of a flap', async () => {
    // A 400ms stability threshold makes the reset observable: each kill below
    // is separated by a restart plus a wait, so every crash follows a stable
    // run and must reset the budget. Five crashes with the budget of 3 would
    // otherwise degrade the environment.
    const ctx = makeContext({ BACKLOT_SWEEP_MS: '400', BACKLOT_STABLE_MS: '400' });
    contexts.push(ctx.cleanup);
    const wt = makeWt('budget', POLITE);
    dirs.push(wt);
    const up = await ctx.cli(['up', '--json'], wt);
    expect(up.exitCode).toBe(0);

    // Kill the real server three times with pauses; the supervisor restarts it
    // each time. Three crashes must not degrade an environment that has been
    // healthy in between — the budget is for a tight loop, not a lifetime.
    for (let i = 0; i < 5; i++) {
      const pid = servers(ctx.stateDir)[0];
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          process.kill(pid, 'SIGKILL');
        }
      }
      // Under parallel test load a restart can take a while; wait generously
      // rather than encode this machine's speed into the assertion.
      const back = await waitFor(() => servers(ctx.stateDir).length > 0, 30_000);
      expect(back, `service did not restart after kill ${i + 1}`).toBe(true);
      await settle(900); // stay up past the 400ms stability threshold
    }

    const ls = await ctx.cli(['pool', 'ls', '--json'], wt);
    const envs = ls.json?.envs as Array<{ id: string; state: string }>;
    // A degraded env is auto-reaped by the sweeper, so it VANISHES rather than
    // showing 'degraded' — asserting only on the state would silently miss the
    // failure. The environment must still be here, and still healthy.
    expect(envs.length, 'the environment was degraded and reaped').toBeGreaterThan(0);
    expect(envs.every((e) => e.state !== 'degraded')).toBe(true);
    expect(servers(ctx.stateDir).length, 'the service should still be supervised').toBeGreaterThan(0);
  }, 180_000);
});

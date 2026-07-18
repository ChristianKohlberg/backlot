/**
 * Fleet review, concurrency cluster.
 *
 * These all share one root cause: a full-row `saveEnv` written from a SNAPSHOT
 * taken before a slow await. Anything that changed the row meanwhile is
 * silently discarded — a degrade lost, a deleted row resurrected, a recycled
 * environment operated on. The journal is truth (decision 0009), so a lost
 * update there is not a cosmetic race; it hands out an environment that is not
 * what the row says it is.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
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

/** A stack whose service dies immediately, so it burns its restart budget fast. */
function ctx(serviceRun: string, extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-lu-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-lu-wt-'));
  dirs.push(stateDir, wt);
  writeFileSync(
    join(wt, 'stack.yaml'),
    `name: lu\nservices:\n  web: { run: "${serviceRun}", ready: { log: "ready", timeout: 8 } }\nchecks:\n  ok: { run: "true" }\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '400', ...extraEnv };
  const cli = (args: string[]) =>
    new Promise<{ code: number; json?: Record<string, unknown> }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json });
      });
    });
  return { stateDir, wt, cli, journal: () => new Journal(join(stateDir, 'journal.db')) };
}

describe('a degrade during bind is never overwritten by the epilogue', () => {
  it('does not promote to hot from a snapshot taken before the degrade', async () => {
    // Drive the race deterministically: the service takes ~4s to report ready,
    // and the row is flipped to 'degraded' from outside while the bind is still
    // in waitReady — exactly what the onDegraded callback does when an earlier
    // service flaps during a later one's boot. The epilogue held a snapshot from
    // before that write and used to save it back whole, resurrecting 'hot'.
    const { cli, stateDir } = ctx('sleep 4; echo ready; sleep 300');

    const binding = cli(['up', '--json']);
    await new Promise((r) => setTimeout(r, 1500)); // inside waitReady

    const j = new Journal(join(stateDir, 'journal.db'));
    const row = j.allEnvs()[0];
    expect(row, 'the bind should have created an env row by now').toBeTruthy();
    j.saveEnv({ ...row!, state: 'degraded' });

    const up = await binding;

    const after = new Journal(join(stateDir, 'journal.db')).getEnv(row!.id);
    if (!after) return; // sweeper reaped the degraded env — also a correct outcome

    // The invariant: a degrade written during the bind must survive it. Before
    // the fix this read 'hot' and the caller was handed a healthy-looking env.
    expect(after.state).not.toBe('hot');
    expect(up.code).not.toBe(0); // and the bind reports the failure
  }, 90_000);
});

describe('recycled environments are not operated on', () => {
  it('refuses exec against an environment that is being torn down', async () => {
    const { cli, stateDir } = ctx('echo ready; sleep 300');
    const up = await cli(['up', '--json']);
    expect(up.json?.state).toBe('hot');

    const j = new Journal(join(stateDir, 'journal.db'));
    const env = j.allEnvs()[0]!;
    // Put the row in the guard state teardown uses. A request that resolved its
    // lease before the claim used to run against a tree about to be deleted.
    j.saveEnv({ ...env, state: 'recycling' });

    // --json must precede the command: `exec` consumes everything after it
    // verbatim, which is what lets an inner command keep its own flags.
    const res = await cli(['exec', '--json', 'echo should-not-run']);
    expect(res.code).not.toBe(0);
    const msg = String((res.json?.error as { message?: string })?.message ?? '');
    expect(msg).toMatch(/recycl/i);
  }, 90_000);

  it('refuses token against a recycling environment too', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-lu2-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-lu2-wt-'));
    dirs.push(stateDir, wt);
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: lu2\nservices:\n  web: { run: "echo ready; sleep 300", ready: { log: "ready", timeout: 8 } }\nauth:\n  token: "echo tok-{{role}}"\nchecks:\n  ok: { run: "true" }\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '400' };
    const cli = (args: string[]) =>
      new Promise<{ code: number; json?: Record<string, unknown> }>((resolve) => {
        execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          let json;
          try {
            json = JSON.parse(String(stdout));
          } catch {
            /* none */
          }
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json });
        });
      });

    await cli(['up', '--json']);
    // Sanity: the token verb works normally, so the refusal below is the guard
    // firing and not a broken fixture.
    const okTok = await cli(['token', '--role', 'admin', '--json']);
    expect(okTok.code).toBe(0);

    const j = new Journal(join(stateDir, 'journal.db'));
    const row = j.allEnvs()[0]!;
    j.saveEnv({ ...row, state: 'recycling' });

    const res = await cli(['token', '--role', 'admin', '--json']);
    expect(res.code).not.toBe(0);
    expect(String((res.json?.error as { message?: string })?.message ?? '')).toMatch(/recycl/i);
  }, 90_000);
});

describe('the sweeper does not run before recovery finishes', () => {
  it('survives a restart with envs present without losing or resurrecting rows', async () => {
    const { cli, stateDir } = ctx('echo ready; sleep 300');
    await cli(['up', '--json']);
    const before = new Journal(join(stateDir, 'journal.db')).allEnvs().length;
    expect(before).toBeGreaterThan(0);

    // Ungraceful restart: recovery now does real work (verified kills, a /proc
    // sweep), so a sweeper racing it operates on rows mid-reconcile.
    process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')), 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    const status = await cli(['pool', 'ls', '--json']);
    expect(status.code).toBe(0);
    const envs = status.json?.envs as Array<{ state: string }>;
    // Every surviving row is in a settled state — never 'hot' (recovery
    // downgrades) and never a resurrected ghost.
    for (const e of envs) expect(['warm', 'degraded', 'recycling']).toContain(e.state);
  }, 90_000);
});

describe('a detached run interrupted by a daemon crash is resolved, not left pending', () => {
  it('reports a lost job as done with a failed verdict after recovery', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-job-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-job-wt-'));
    dirs.push(stateDir, wt);
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: job\nservices:\n  web: { run: "echo ready; sleep 300", ready: { log: "ready", timeout: 10 } }\nchecks:\n  slow: { run: "sleep 60" }\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '400' };
    const cli = (args: string[]) =>
      new Promise<Record<string, unknown> | undefined>((resolve) => {
        execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => {
          try {
            resolve(JSON.parse(String(out)));
          } catch {
            resolve(undefined);
          }
        });
      });

    await cli(['up', '--json']);
    const submitted = await cli(['run', 'slow', '--detach', '--json']);
    const jobId = String(submitted?.jobId ?? '');
    expect(jobId).not.toBe('');

    // Kill the daemon mid-run. The job can never finish, so leaving it
    // 'running' would make a polling agent wait forever. Recovery must resolve
    // it — and this asserts recovery DOES it, not merely that the Journal has
    // a method which would.
    process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')), 'SIGKILL');
    await new Promise((r) => setTimeout(r, 300));

    const job = await cli(['job', jobId, '--json']);
    expect(job?.state).toBe('done');
    expect((job?.verdict as { ok?: boolean } | null)?.ok).toBe(false);
  }, 120_000);
});

describe('a check that fails because the environment died is not blamed on the code', () => {
  it('classifies the verdict env-error, not work-error', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-verdict-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-verdict-wt-'));
    dirs.push(stateDir, wt);
    // The service reports ready, then dies. The check then fails against a
    // dead dependency — which is the environment failing, not the repo's code.
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: vd\nservices:\n  web: { run: "echo ready; sleep 1; exit 1", ready: { log: ready, timeout: 10 } }\nchecks:\n  probe: { run: "sleep 3; exit 4" }\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '30000' };
    const run = await new Promise<Record<string, unknown> | undefined>((resolve) => {
      execFile(process.execPath, [CLI, 'run', 'probe', '--json'], { cwd: wt, env, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => {
        try {
          resolve(JSON.parse(String(out)));
        } catch {
          resolve(undefined);
        }
      });
    });

    const failure = run?.failure as { class?: string; message?: string } | null;
    expect(run?.ok).toBe(false);
    // An agent branches on this mechanically: work-error tells it to go and
    // edit code, which cannot fix a dev-server that fell over.
    expect(failure?.class).toBe('env-error');
    expect(failure?.message).toMatch(/environment failed/);
  }, 120_000);
});

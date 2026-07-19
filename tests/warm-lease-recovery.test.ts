/**
 * exec/token against a lease whose services died with the previous daemon
 * (engine.assertUsable's 'warm' branch).
 *
 * A daemon restart downgrades every hot env to warm: the lease SURVIVES in the
 * journal but the services do not. Before the guard, `exec` then ran against a
 * tree with nothing listening and the inner command's own failure ("connection
 * refused") surfaced as the repo's fault — an agent would start debugging its
 * code to fix a dev-server that simply was not running.
 *
 * Regressions this catches:
 *  - the classification drifting: this MUST be env-error (exit 2) so the
 *    agent's mechanical branch (decision 0010) sends it back to `backlot up`,
 *    not into its own diff;
 *  - the guidance disappearing: the message is the only place the fix
 *    ("run 'backlot up' to rebind") is named;
 *  - the recovery loop breaking: after the advised rebind, the SAME lease and
 *    environment must work again — that round-trip is the crash-recovery
 *    contract (decision 0009) as a consumer experiences it.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) {
    // Graceful stop (SIGTERM is handled): a SIGKILL'd daemon loses its
    // NODE_V8_COVERAGE dump, so `npm run coverage` would not see this suite.
    try {
      const pid = Number(readFileSync(join(d, 'daemon.pid'), 'utf8'));
      process.kill(pid);
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch {
      /* no daemon here */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe('a surviving lease on a restarted daemon', () => {
  it('exec is refused as env-error telling the holder to rebind — and the rebind works', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-warm-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-warm-wt-'));
    dirs.push(stateDir, wt);
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: warm\nservices:\n  web: { run: "echo ready; sleep 300", ready: { log: ready, timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '60000' };
    const cli = (args: string[]): Promise<{ code: number; json?: Record<string, unknown>; stdout: string }> =>
      new Promise((resolve) => {
        execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          let json: Record<string, unknown> | undefined;
          try {
            json = JSON.parse(String(stdout));
          } catch {
            /* non-json */
          }
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json, stdout: String(stdout) });
        });
      });

    // The normal loop: a hot lease, exec works.
    const up = await cli(['up', '--json']);
    expect(up.code).toBe(0);
    expect((up.json as { state: string }).state).toBe('hot');
    const envId = (up.json as { envId: string }).envId;
    const okExec = await cli(['exec', 'true']);
    expect(okExec.code).toBe(0);

    // Daemon restart: stop it and WAIT until it is actually gone (stop returns
    // before the shutdown timer fires).
    const daemonPid = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
    const stop = await cli(['daemon', 'stop', '--json']);
    expect(stop.code).toBe(0);
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(daemonPid, 0);
      } catch {
        break; // exited
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // The next exec auto-spawns a fresh daemon. Recovery keeps the lease but
    // the services are gone — running the command anyway would blame the code.
    // --json goes right after the verb: exec passes everything after it
    // through verbatim, so a trailing --json would ride into the command.
    const refused = await cli(['exec', '--json', 'true']);
    expect(refused.code).toBe(2); // env-error, per the exit-code contract
    const error = (refused.json as { error: { class: string; message: string } }).error;
    expect(error.class).toBe('env-error');
    expect(error.message).toMatch(/backlot up/); // names the actual fix
    expect(error.message).toMatch(/daemon restarted|not running/i);

    // The advised recovery must complete the loop: rebind the SAME env
    // (the lease survived, decision 0009), then exec works again.
    const reup = await cli(['up', '--json']);
    expect(reup.code).toBe(0);
    expect((reup.json as { state: string }).state).toBe('hot');
    expect((reup.json as { envId: string }).envId).toBe(envId);
    const execAfter = await cli(['exec', 'true']);
    expect(execAfter.code).toBe(0);
  }, 120_000);
});

/**
 * The daemonization detector (supervisor.ts): a service whose run command
 * forks and exits 0 immediately is NOT a supervisable service.
 *
 * Without the detector, backlot restarts the "crashed" service up to three
 * times — each restart forking ANOTHER background copy that escapes the group
 * kill — then polls a dead readiness probe for the full ready timeout and
 * finally blames the ENVIRONMENT (env-error). That is a process leak plus a
 * silently wrong verdict: the repo's own backgrounding run command is at
 * fault, and an agent told 'env-error' recycles environments in a loop
 * instead of fixing its manifest.
 *
 * Regressions this catches:
 *  - the fast-fail disappearing (the bind would burn the whole ready timeout
 *    before failing — asserted via the elapsed bound);
 *  - the verdict class drifting from work-error to env-error (the exit-code
 *    contract agents branch on, decision 0010);
 *  - the message no longer naming the actual problem (FOREGROUND), which is
 *    the only actionable hint the repo author gets;
 *  - the environment not being taken out of rotation (degraded) after the
 *    detector gives up on it.
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

describe('a service that daemonizes is refused, fast and with the blame on the repo', () => {
  it('up fails as work-error naming FOREGROUND, well before the ready timeout, and degrades the env', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-dmz-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-dmz-wt-'));
    dirs.push(stateDir, wt);
    // The classic accident: the run command backgrounds the real process and
    // returns 0 at once. The declared ready gate would wait 30s if polled.
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: dmz\nservices:\n  bg: { run: "sleep 300 &", ready: { log: "never-logged", timeout: 30 } }\nchecks:\n  ok: { run: "true" }\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
    // Sweep interval kept LONG so the degraded env is still observable below
    // (the sweeper reaps degraded envs, which would race the status assert).
    const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '600000' };
    const cli = (args: string[]): Promise<{ code: number; json?: Record<string, unknown> }> =>
      new Promise((resolve) => {
        execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
          let json: Record<string, unknown> | undefined;
          try {
            json = JSON.parse(String(stdout));
          } catch {
            /* non-json */
          }
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json });
        });
      });

    const started = Date.now();
    const up = await cli(['up', '--json']);
    const elapsed = Date.now() - started;

    // work-error (exit 1): the repo's run command is wrong, not the environment.
    expect(up.code).toBe(1);
    const error = (up.json as { error: { class: string; message: string } }).error;
    expect(error.class).toBe('work-error');
    expect(error.message).toMatch(/FOREGROUND|daemonized/i);

    // Fast-fail: the detector decides in ~2s of service uptime, not by burning
    // the 30s ready timeout polling a probe that can never pass.
    expect(elapsed).toBeLessThan(20_000);

    // The env must be OUT OF ROTATION — handing it to the next claim as
    // healthy is how a dead service gets leased.
    const status = await cli(['status', '--json']);
    const envs = (status.json as { envs: Array<{ state: string }> }).envs;
    expect(envs.length).toBeGreaterThan(0);
    expect(envs[0]!.state).toBe('degraded');
  }, 120_000);
});

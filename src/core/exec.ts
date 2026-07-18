/**
 * Bounded shell execution for repo-declared commands.
 *
 * Every datastore and appliance command comes from someone's stack.yaml, so it
 * can hang: an appliance `start:` that forgets `-d` stays in the foreground, a
 * `psql` against a half-up server blocks on connect. Unbounded, that wedges the
 * bind forever — and because the environment stays in the daemon's `busy` set,
 * the sweeper will not expire its lease and teardown refuses it, so the
 * environment is unreclaimable until the daemon is killed.
 *
 * So every such command is spawned as its own process group with a hard
 * deadline, and the timeout kills the GROUP: killing only `sh` would leave the
 * real client (psql, docker) running and still holding whatever it holds.
 * This mirrors the engine's check runner, which learned the same lesson.
 */
import { spawn } from 'node:child_process';

/** Repo-declared commands are IO-bound setup steps, not builds. */
export const DEFAULT_CMD_TIMEOUT_S = 300;

export interface CmdResult {
  code: number;
  output: string;
  timedOut: boolean;
}

export function runBounded(
  cmd: string,
  cwd: string,
  timeoutS: number = DEFAULT_CMD_TIMEOUT_S,
): Promise<CmdResult> {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', cmd], { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let settled = false;
    let timedOut = false;
    const sink = (d: Buffer) => {
      out = (out + d.toString()).slice(-16_000);
    };
    proc.stdout!.on('data', sink);
    proc.stderr!.on('data', sink);

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid!, 'SIGKILL'); // the group, not just the sh wrapper
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, timeoutS * 1000);
    timer.unref();

    const done = (r: CmdResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    // A spawn failure (EAGAIN/EMFILE under load) emits 'error' with no 'exit';
    // without this the promise never settles and the caller's lock wedges.
    proc.on('error', (err) => done({ code: 1, output: `${out}\nspawn error: ${err.message}`, timedOut }));
    proc.on('exit', (code) => done({ code: code ?? 1, output: out, timedOut }));
  });
}

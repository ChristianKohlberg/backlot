/**
 * Bounded shell execution for repo-declared commands.
 *
 * Every datastore and appliance command comes from someone's runly.yml, so it
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

/** Build/exec/check-grade work gets a longer leash than setup steps. */
export const LONG_CMD_TIMEOUT_S = 600;

/**
 * The deadline for a repo-declared command. Callers pass the default that fits
 * their site's class (setup steps 300s, or an upkeep rule's own `timeout`;
 * build/exec-grade work 600s); BACKLOT_CMD_TIMEOUT_S overrides ALL of them —
 * the escape hatch for a repo whose legitimate commands outrun the class default.
 */
export function cmdTimeoutS(fallback: number = DEFAULT_CMD_TIMEOUT_S): number {
  const e = process.env.BACKLOT_CMD_TIMEOUT_S;
  if (e === undefined || e === '') return fallback;
  const n = Number(e);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface CmdResult {
  code: number;
  output: string;
  timedOut: boolean;
}

export function runBounded(
  cmd: string,
  cwd: string,
  timeoutS: number = DEFAULT_CMD_TIMEOUT_S,
  env?: NodeJS.ProcessEnv,
  /** Sees every chunk as it arrives (a build log, decision 0038); `end` once per stream. */
  onOutput?: { data: (stream: 'out' | 'err', chunk: string) => void; end: (stream: 'out' | 'err') => void },
): Promise<CmdResult> {
  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', cmd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let settled = false;
    let timedOut = false;
    const sink = (stream: 'out' | 'err') => (d: Buffer) => {
      const text = d.toString();
      out = (out + text).slice(-16_000);
      try {
        onOutput?.data(stream, text);
      } catch {
        /* a log write must never fail the command */
      }
    };
    proc.stdout!.on('data', sink('out'));
    proc.stderr!.on('data', sink('err'));
    proc.stdout!.on('end', () => onOutput?.end('out'));
    proc.stderr!.on('end', () => onOutput?.end('err'));

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

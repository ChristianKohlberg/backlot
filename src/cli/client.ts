/**
 * CLI-side client: auto-spawn the daemon on first use (tmux/Docker pattern,
 * decision 0009) and speak JSON over the unix socket.
 */
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { openSync, statSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { socketPath, stateRoot } from '../core/paths.js';
import { isAlive } from '../core/procscan.js';

/** A wedged daemon must not hang a caller forever. Overridable for tests. */
const RPC_TIMEOUT_MS = (): number => Number(process.env.BACKLOT_RPC_TIMEOUT_MS ?? 15 * 60_000);

/**
 * Classify a client-side failure for the exit-code contract (decision 0010).
 *
 * Agents branch on the class mechanically, so an unreachable or wedged daemon
 * must NOT report env-error: that tells the agent to recycle an environment,
 * which cannot fix a broken daemon. Anything that never became a classified
 * daemon response is infrastructure.
 */
export function classifyClientError(err: unknown): 'infra-error' | 'env-error' {
  const tagged = (err as { backlotClass?: string })?.backlotClass;
  if (tagged === 'infra-error' || tagged === 'env-error') return tagged;
  const msg = String((err as Error)?.message ?? err);
  return /daemon (did not|closed|is not)|ECONNREFUSED|ENOENT|EACCES|EPIPE|ECONNRESET|socket/i.test(msg)
    ? 'infra-error'
    : 'env-error';
}

export interface RpcError {
  class?: string;
  code?: string;
  message: string;
  source?: string;
  logExcerpt?: string;
}

export type RpcResponse = { ok: true; data: unknown } | { ok: false; error: RpcError };

/**
 * The daemon streams newline-delimited frames: {type:'progress',phase} … then
 * one {type:'result',ok,…}. `onProgress` (optional) sees each phase; the
 * promise resolves on the result frame. Consumers that ignore progress (MCP,
 * ping, most verbs) just don't pass it — the frames are consumed and dropped.
 */
export function rpc(
  verb: string,
  args: Record<string, unknown>,
  onProgress?: (phase: string) => void,
): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: socketPath(), path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let buf = '';
        let result: RpcResponse | undefined;
        res.on('data', (d) => {
          buf += d;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.trim()) continue;
            let frame: { type?: string; phase?: string; ok?: boolean; data?: unknown; error?: RpcError };
            try {
              frame = JSON.parse(line);
            } catch {
              continue;
            }
            if (frame.type === 'progress') onProgress?.(String(frame.phase ?? ''));
            else if (frame.type === 'result') {
              result = frame.ok ? { ok: true, data: frame.data } : { ok: false, error: frame.error! };
            } else {
              // Back-compat: an un-typed object is a bare result.
              result = frame as unknown as RpcResponse;
            }
          }
        });
        res.on('end', () => (result ? resolve(result) : reject(new Error('daemon closed the stream without a result frame'))));
      },
    );
    req.on('error', reject);
    // setTimeout ALONE is inert: Node emits 'timeout' and does nothing else, so
    // a wedged daemon left the CLI (and any agent driving it) hanging forever.
    // Destroying the socket is what turns the deadline into a real one.
    req.setTimeout(RPC_TIMEOUT_MS(), () => {
      req.destroy(
        Object.assign(new Error(`daemon did not respond to '${verb}' within ${Math.round(RPC_TIMEOUT_MS() / 1000)}s — it may be wedged; check ${join(stateRoot(), 'daemon.log')}`), {
          backlotClass: 'infra-error' as const,
        }),
      );
    });
    req.end(JSON.stringify({ verb, args }));
  });
}

/**
 * What the daemon answering the socket says it is.
 *
 * `version` is undefined for a daemon that predates version reporting (<= 0.8.0)
 * — indistinguishable at the protocol level from "answered without it", which is
 * why callers must treat undefined as skew rather than as "same version".
 */
export interface DaemonInfo {
  pid?: number;
  version?: string;
  journalSchema?: number;
}

async function ping(): Promise<DaemonInfo | null> {
  try {
    const res = await rpc('ping', {});
    if (!res.ok) return null;
    const d = (res.data ?? {}) as DaemonInfo;
    return { pid: d.pid, version: d.version, journalSchema: d.journalSchema };
  } catch {
    return null;
  }
}

/** Ask the socket who is there, without spawning anything. Null = nobody answered. */
export async function daemonInfo(): Promise<DaemonInfo | null> {
  return ping();
}

/**
 * Wait for the daemon to be really gone — not answering AND not running.
 *
 * `update` needs this between the restart request and the respawn, for two
 * distinct reasons:
 *
 * - `shutdown` returns its result frame ~50ms BEFORE the process exits, so
 *   pinging straight away is answered by the daemon that is about to die,
 *   ensureDaemon concludes one is already up, and the update silently does
 *   nothing.
 * - The socket is removed a moment BEFORE the process exits and releases the
 *   election lock. A daemon spawned in that window finds the lock held by a
 *   still-live holder, and electSelf refuses to break a live claim (correctly —
 *   that check is what stops two daemons binding the same journal), so it
 *   concedes with exit 0. The client then reads "our child exited cleanly, a
 *   winner must exist" and waits out a full window for a winner that was never
 *   started. Waiting on the PID closes it.
 */
export async function awaitDaemonGone(oldPid?: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const answering = (await ping()) !== null;
    const running = oldPid !== undefined && isAlive(oldPid);
    if (!answering && !running) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

export async function ensureDaemon(): Promise<DaemonInfo> {
  // Validate the socket path FIRST: ping() swallows every throw into "not up",
  // which would turn socketPath()'s loud sun_path refusal into a silent spawn
  // of a daemon bound to a truncated (colliding) socket.
  socketPath();
  const existing = await ping();
  if (existing) return existing;
  // NOTE: the daemon is spawned from THIS CLI's own dist — which is what makes
  // `update` work (the next invocation after a stop brings up the installed
  // build) and equally what makes skew possible (an upgrade cannot replace a
  // daemon that is already running).
  const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.js');
  const log = openSync(join(stateRoot(), 'daemon.log'), 'a');
  // node:sqlite (the journal) prints "SQLite is an experimental feature" on
  // every spawn, burying daemon.log's signal. Suppress ONLY that warning class,
  // and only for the daemon we spawn — a direct CLI or daemon run still warns.
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', daemonEntry], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env },
  });
  child.unref();
  const pingUntil = async (deadline: number): Promise<DaemonInfo | null> => {
    while (Date.now() < deadline) {
      const info = await ping();
      if (info) return info;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };
  const up = await pingUntil(Date.now() + 10_000);
  if (up) return up;
  // Cold-start stampede: parallel verbs on a cold state dir each spawn a
  // daemon, the singleton election picks one, and every loser exits 0. Our
  // child exiting CLEANLY therefore proves a winner exists somewhere — so give
  // that winner one more window instead of failing a healthy cold start.
  if (child.exitCode === 0) {
    const winner = await pingUntil(Date.now() + 10_000);
    if (winner) return winner;
  }
  // Name the REASON, not just the log path. A daemon that refuses to start now
  // has causes a human must act on rather than retry — the journal-from-the-
  // future refusal (JOURNAL_SCHEMA_VERSION) is one — and "see daemon.log" sent
  // every one of them through a file the caller has to go and find.
  throw new Error(`daemon did not come up — see ${join(stateRoot(), 'daemon.log')}${lastLogLine()}`);
}

/** The tail of daemon.log, for a start failure whose cause is already written down. */
function lastLogLine(): string {
  try {
    const path = join(stateRoot(), 'daemon.log');
    const size = statSync(path).size;
    const fd = openSync(path, 'r');
    try {
      // Tail only: this log is append-only for the life of a state root.
      const len = Math.min(size, 4096);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      // Pick the line that CARRIES the reason. A refusal thrown while the
      // daemon's module graph is still initialising (the journal-from-the-future
      // check runs in an Engine field initialiser) surfaces as an uncaught
      // top-level throw, so the literal last line is Node's own
      // "Node.js v22.15.1" footer — useless to the person reading it.
      const lines = buf
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('at ') && !/^Node\.js v/.test(l) && !/^\^+$/.test(l));
      const errorLine = lines.filter((l) => /^[A-Za-z]*Error: /.test(l)).pop();
      const chosen = errorLine ?? lines[lines.length - 1];
      return chosen ? `\n  last log line: ${chosen.slice(0, 500)}` : '';
    } finally {
      closeSync(fd);
    }
  } catch {
    return ''; // best-effort: never turn a diagnostic into a second failure
  }
}

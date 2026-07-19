/**
 * CLI-side client: auto-spawn the daemon on first use (tmux/Docker pattern,
 * decision 0009) and speak JSON over the unix socket.
 */
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { socketPath, stateRoot } from '../core/paths.js';

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

async function ping(): Promise<boolean> {
  try {
    const res = await rpc('ping', {});
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureDaemon(): Promise<void> {
  // Validate the socket path FIRST: ping() swallows every throw into "not up",
  // which would turn socketPath()'s loud sun_path refusal into a silent spawn
  // of a daemon bound to a truncated (colliding) socket.
  socketPath();
  if (await ping()) return;
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
  const pingUntil = async (deadline: number): Promise<boolean> => {
    while (Date.now() < deadline) {
      if (await ping()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  if (await pingUntil(Date.now() + 10_000)) return;
  // Cold-start stampede: parallel verbs on a cold state dir each spawn a
  // daemon, the singleton election picks one, and every loser exits 0. Our
  // child exiting CLEANLY therefore proves a winner exists somewhere — so give
  // that winner one more window instead of failing a healthy cold start.
  if (child.exitCode === 0 && (await pingUntil(Date.now() + 10_000))) return;
  throw new Error(`daemon did not come up — see ${join(stateRoot(), 'daemon.log')}`);
}

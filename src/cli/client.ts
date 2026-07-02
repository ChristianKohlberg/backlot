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
    req.setTimeout(15 * 60_000);
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
  if (await ping()) return;
  const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.js');
  const log = openSync(join(stateRoot(), 'daemon.log'), 'a');
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env },
  });
  child.unref();
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    if (await ping()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not come up — see ${join(stateRoot(), 'daemon.log')}`);
}

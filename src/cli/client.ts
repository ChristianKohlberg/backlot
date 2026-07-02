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

export function rpc(verb: string, args: Record<string, unknown>): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath: socketPath(), path: '/rpc', method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as RpcResponse);
          } catch (err) {
            reject(err);
          }
        });
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

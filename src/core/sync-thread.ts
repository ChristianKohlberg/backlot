/**
 * The daemon-side face of the sync worker: same signature and error contract
 * as syncIntoEnv, executed on a worker thread. One worker per call — startup
 * is milliseconds against multi-second binds, and per-call workers mean no
 * pool to manage and no state to leak between binds. Unit tests and any
 * non-daemon caller keep using syncIntoEnv directly.
 */
import { Worker } from 'node:worker_threads';
import { BrokerError } from './util.js';
import type { Manifest } from './manifest.js';
import type { SyncResult } from './sync.js';

interface WorkerReply {
  ok: boolean;
  result?: SyncResult;
  error?: { klass: 'work-error' | 'env-error' | 'infra-error'; message: string; source?: string; logExcerpt?: string };
}

export function syncIntoEnvThreaded(
  stackRoot: string,
  envTree: string,
  manifest: Manifest,
  cleanUntracked: boolean,
): Promise<SyncResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./sync-worker.js', import.meta.url), {
      workerData: { stackRoot, envTree, manifest, cleanUntracked },
    });
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    worker.once('message', (msg: WorkerReply) =>
      done(() => {
        if (msg.ok && msg.result) resolve(msg.result);
        else if (msg.error) reject(new BrokerError(msg.error.klass, msg.error.message, msg.error.source, msg.error.logExcerpt));
        else reject(new Error('sync worker returned an empty reply'));
      }),
    );
    // A worker that dies without a message (OOM, EMFILE at spawn) must not
    // wedge the bind's promise — the env lock above it would never release.
    worker.once('error', (err) => done(() => reject(err)));
    worker.once('exit', (code) => done(() => reject(new Error(`sync worker exited (${code}) without a result`))));
  });
}

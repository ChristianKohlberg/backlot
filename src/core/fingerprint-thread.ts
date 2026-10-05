/**
 * The daemon-side face of the fingerprint worker: same signature and error
 * contract as fingerprintWorktree, executed on a worker thread. Enumerating
 * and stat-checking a 35k-file worktree (and hashing whatever moved) is
 * synchronous work that used to stall every other environment's verbs behind
 * one bind. One worker per call — startup is milliseconds against the work, and
 * per-call workers mean no pool to manage and no state to leak between binds.
 * Unit tests and any non-daemon caller use fingerprintWorktree directly.
 */
import { Worker } from 'node:worker_threads';
import { BrokerError } from './util.js';
import type { Manifest } from './manifest.js';
import type { SourceSnapshot } from './worktree.js';

interface WorkerReply {
  ok: boolean;
  result?: SourceSnapshot;
  error?: { klass: 'work-error' | 'env-error' | 'infra-error'; message: string; source?: string; logExcerpt?: string };
}

export function fingerprintWorktreeThreaded(stackRoot: string, manifest: Manifest, cacheDir: string): Promise<SourceSnapshot> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./fingerprint-worker.js', import.meta.url), {
      workerData: { stackRoot, manifest, cacheDir },
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
        else reject(new Error('fingerprint worker returned an empty reply'));
      }),
    );
    // A worker that dies without a message (OOM, EMFILE at spawn) must not
    // wedge the bind's promise — the env lock above it would never release.
    worker.once('error', (err) => done(() => reject(err)));
    worker.once('exit', (code) => done(() => reject(new Error(`fingerprint worker exited (${code}) without a result`))));
  });
}

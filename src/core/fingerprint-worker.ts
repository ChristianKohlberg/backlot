/**
 * Worker-thread entry for fingerprintWorktree, so the enumerate/stat/hash pass
 * runs off the daemon's event loop. Errors cross the thread boundary as plain
 * data; fingerprint-thread.ts rehydrates the BrokerError classification.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { fingerprintWorktree } from './worktree.js';
import { BrokerError } from './util.js';
import type { Manifest } from './manifest.js';

const { stackRoot, manifest, cacheDir } = workerData as { stackRoot: string; manifest: Manifest; cacheDir: string };

try {
  const result = fingerprintWorktree(stackRoot, manifest, cacheDir);
  parentPort?.postMessage({ ok: true as const, result });
} catch (err) {
  const broker = err instanceof BrokerError ? err : null;
  parentPort?.postMessage({
    ok: false as const,
    error: {
      klass: broker?.klass ?? ('env-error' as const),
      message: err instanceof Error ? err.message : String(err),
      source: broker?.source,
      logExcerpt: broker?.logExcerpt,
    },
  });
}

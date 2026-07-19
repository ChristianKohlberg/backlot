/**
 * Worker-thread entry for syncIntoEnv. The enumerate/hash/copy work is
 * synchronous by design (simple, atomic-cache-friendly), so it runs HERE —
 * off the daemon's event loop — and a large bind no longer stalls every
 * other environment's verbs behind it (decision 0020's one open
 * language-attributable item). Errors cross the thread boundary as plain
 * data; sync-thread.ts rehydrates the BrokerError classification.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { syncIntoEnv } from './sync.js';
import { BrokerError } from './util.js';
import type { Manifest } from './manifest.js';

const { stackRoot, envTree, manifest, cleanUntracked } = workerData as {
  stackRoot: string;
  envTree: string;
  manifest: Manifest;
  cleanUntracked: boolean;
};

try {
  const result = syncIntoEnv(stackRoot, envTree, manifest, cleanUntracked);
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

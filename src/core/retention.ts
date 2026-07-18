/**
 * Disk retention: nothing backlot writes may grow forever. Called from the
 * daemon sweeper (~10 min cadence); every function is idempotent, best-effort,
 * and unit-testable in isolation.
 */
import { readdirSync, statSync, rmSync, readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsRoot, templatesRoot, envsRoot } from './paths.js';
import { logEvent } from './events.js';
import { runQuiet } from './util.js';
import { parseBakedMarker } from '../drivers/datastores.js';
import type { Journal } from './journal.js';
import type { Policy } from './policy.js';

const dayMs = 24 * 60 * 60 * 1000;

const entriesOf = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Artifacts older than N days are pruned (verdict dirs are timestamped). */
export function pruneArtifacts(p: Policy, root = artifactsRoot()): number {
  let pruned = 0;
  for (const envDir of entriesOf(root)) {
    for (const runDir of entriesOf(join(root, envDir))) {
      const full = join(root, envDir, runDir);
      try {
        if (Date.now() - statSync(full).mtimeMs > p.artifactDays * dayMs) {
          rmSync(full, { recursive: true, force: true });
          pruned++;
        }
      } catch {
        /* raced */
      }
    }
    if (entriesOf(join(root, envDir)).length === 0) rmSync(join(root, envDir), { recursive: true, force: true });
  }
  return pruned;
}

/** Service log files past the cap keep only their tail (in-place truncate). */
export function truncateLogs(p: Policy, root = envsRoot()): number {
  let truncated = 0;
  for (const envDir of entriesOf(root)) {
    const logDir = join(root, envDir, 'logs');
    for (const logFile of entriesOf(logDir)) {
      const full = join(logDir, logFile);
      try {
        const size = statSync(full).size;
        if (size > p.logCapBytes) {
          // Read only the TAIL. Loading the whole file as one utf8 string
          // throws past Node's ~512 MiB string limit, so the very logs that
          // most needed trimming were the ones that could never be trimmed —
          // and they then grew without bound.
          const keepBytes = Math.floor(p.logCapBytes / 4);
          const fd = openSync(full, 'r');
          let tail: Buffer;
          try {
            tail = Buffer.alloc(Math.min(keepBytes, size));
            readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
          } finally {
            closeSync(fd);
          }
          writeFileSync(full, Buffer.concat([Buffer.from('[backlot: truncated by retention sweep]\n'), tail]));
          truncated++;
        }
      } catch {
        /* raced */
      }
    }
  }
  return truncated;
}

/** Done jobs older than N days leave the journal. */
export function pruneJobs(journal: Journal, p: Policy): number {
  return journal.pruneJobs(Date.now() - p.jobDays * dayMs);
}

/**
 * Templates: keep the newest M per stack (a template whose seed-hash key is
 * still current keeps being touched by binds; stale keys age out naturally).
 *
 * For the command family the marker is a sentinel for a server-side
 * `backlot_tpl_*` database; markers are self-describing (they carry their
 * drop command — see BakedMarker in drivers/datastores.ts), so pruning a
 * marker also DROPs the database instead of leaking it on the appliance
 * forever (vetbill-1i49). Legacy bare-string markers prune file-only.
 */
export async function pruneTemplates(p: Policy, root = templatesRoot()): Promise<number> {
  let pruned = 0;
  for (const stackDir of entriesOf(root)) {
    const dir = join(root, stackDir);
    if (!existsSync(dir)) continue;
    const files = entriesOf(dir)
      .map((f) => {
        try {
          return { f, mtime: statSync(join(dir, f)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { f: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);
    for (const { f } of files.slice(p.templatesKeep)) {
      const full = join(dir, f);
      if (f.endsWith('.baked')) {
        try {
          const marker = parseBakedMarker(readFileSync(full, 'utf8'));
          if (marker.drop) {
            // This command came from a manifest that may no longer exist on
            // disk. Re-executing it silently is the part that deserves a
            // record, so the state dir stays auditable.
            logEvent({ level: 'info', kind: 'retention', detail: `dropping baked template via persisted command from ${f}` });
            await runQuiet(marker.drop, root);
          }
        } catch {
          /* unreadable marker — still prune the file */
        }
      }
      rmSync(full, { force: true });
      pruned++;
    }
  }
  return pruned;
}

export async function retentionSweep(
  journal: Journal,
  p: Policy,
): Promise<{ artifacts: number; logs: number; jobs: number; templates: number }> {
  return {
    artifacts: pruneArtifacts(p),
    logs: truncateLogs(p),
    jobs: pruneJobs(journal, p),
    templates: await pruneTemplates(p),
  };
}

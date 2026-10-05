/**
 * Disk retention: nothing runly writes may grow forever. Called from the
 * daemon sweeper (~10 min cadence); every function is idempotent, best-effort,
 * and unit-testable in isolation.
 */
import { readdirSync, statSync, rmSync, readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { artifactsRoot, templatesRoot, envsRoot, worktreesRoot } from './paths.js';
import { logEvent } from './events.js';
import { runQuiet } from './util.js';
import { hasOtherTemplateOwner, parseBakedMarker, withBakeLock } from '../drivers/datastores.js';
import type { Journal } from './journal.js';
import type { Policy } from './policy.js';


const entriesOf = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Check artifacts are gone with `runly run` (decision 0032); an older runly
 * left them under the state root. Nothing reads them any more, so the whole
 * directory goes.
 */
export function pruneArtifacts(root = artifactsRoot()): number {
  const n = entriesOf(root).length;
  if (n > 0 || existsSync(root)) rmSync(root, { recursive: true, force: true });
  return n;
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
          writeFileSync(full, Buffer.concat([Buffer.from('[runly: truncated by retention sweep]\n'), tail]));
          truncated++;
        }
      } catch {
        /* raced */
      }
    }
  }
  return truncated;
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
export async function pruneTemplates(p: Policy, root = templatesRoot(), protectedStacks: ReadonlySet<string> = new Set()): Promise<number> {
  let pruned = 0;
  for (const stackDir of entriesOf(root)) {
    const dir = join(root, stackDir);
    if (!existsSync(dir)) continue;
    // The stack-scoped bake lock (the dir name IS the stack id): pruning was
    // the one remaining writer mutating this dir outside it, reopening the
    // deleted-mid-restore race the lock exists to close.
    pruned += await withBakeLock(stackDir, async () => {
      if (protectedStacks.has(stackDir) || existsSync(join(dir, '.retired-stack.json'))) return 0;
      let count = 0;
      const files = entriesOf(dir)
        .filter((f) => !f.startsWith('.') && !f.endsWith('.retirement.json'))
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
            if (hasOtherTemplateOwner(full, marker.ns)) continue;
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
        count++;
      }
      return count;
    });
  }
  return pruned;
}

/**
 * Per-worktree state (decision 0032 — the trigger-file hash cache and the upkeep
 * ledger) for a worktree that no longer exists. It must outlive every
 * environment, because `runly warm` writes it for a worktree with none; so it
 * goes only when its recorded root is gone AND no environment still names the
 * stack. A missing or unreadable record is left alone: it proves nothing.
 */
export function pruneWorktreeState(journal: Journal, root = worktreesRoot()): number {
  let pruned = 0;
  for (const stackId of entriesOf(root)) {
    const dir = join(root, stackId);
    try {
      const recordedRoot = ['ledger.json', 'triggers.json']
        .map((f) => {
          try {
            return (JSON.parse(readFileSync(join(dir, f), 'utf8')) as { root?: unknown }).root;
          } catch {
            return undefined;
          }
        })
        .find((r): r is string => typeof r === 'string');
      if (recordedRoot === undefined || existsSync(recordedRoot)) continue;
      if (journal.envsForStack(stackId).length > 0) continue;
      rmSync(dir, { recursive: true, force: true });
      pruned++;
    } catch {
      /* no readable ledger — leave it */
    }
  }
  return pruned;
}

export async function retentionSweep(
  journal: Journal,
  p: Policy,
  protectedStacks: ReadonlySet<string> = new Set(),
): Promise<{ artifacts: number; logs: number; templates: number; worktrees: number }> {
  return {
    worktrees: pruneWorktreeState(journal),
    artifacts: pruneArtifacts(),
    logs: truncateLogs(p),
    templates: await pruneTemplates(p, templatesRoot(), protectedStacks),
  };
}

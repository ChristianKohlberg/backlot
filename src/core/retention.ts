/**
 * Disk retention: nothing runly writes may grow forever. Called from the
 * daemon sweeper (~10 min cadence); every function is idempotent, best-effort,
 * and unit-testable in isolation.
 */
import { readdirSync, statSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { templatesRoot, envsRoot, worktreesRoot } from './paths.js';
import { logEvent } from './events.js';
import { cmdTimeoutS, runBounded } from './exec.js';
import { rotateIfOver } from './logs.js';
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
 * Service logs past the cap are rotated once (decision 0038): `<name>.log`
 * becomes `<name>.log.1`, replacing the previous rotation. The writer rotates
 * as it writes; this is the backstop for a file it never reached (a writer
 * from an older daemon, or a log that grew between restarts). Only `*.log`
 * files are touched.
 */
export function truncateLogs(p: Policy, root = envsRoot()): number {
  let rotated = 0;
  for (const envDir of entriesOf(root)) {
    const logDir = join(root, envDir, 'logs');
    for (const logFile of entriesOf(logDir)) {
      if (!logFile.endsWith('.log')) continue;
      if (rotateIfOver(join(logDir, logFile), p.logCapBytes)) rotated++;
    }
  }
  return rotated;
}

/**
 * Which stacks a template may still serve: anything a journal row names, or
 * whose worktree is still on disk (decision 0037). A stack whose worktree is
 * gone and that no row names keeps no "current" template — nobody can bind
 * it again.
 */
export interface TemplateRefs {
  /** `<stack>/<file>` of every template an environment or copy was restored from. */
  referenced: ReadonlySet<string>;
  /** False when the stack can never be bound again. */
  stackAlive: (stackId: string) => boolean;
  /**
   * Where a template's recorded drop command runs: it comes from the
   * manifest and is written to run in the repo (`node scripts/db.cjs drop …`).
   * The stack's own worktree while it exists, else a live worktree of the same
   * project (same manifest name; from the journal or a sibling's `.root`),
   * else the templates root.
   */
  dropCwd?: (stackId: string) => string;
}

/** The group a template file belongs to: `<datastore>-<preset>` before the content key. */
const templateGroup = (file: string): string => {
  const at = file.lastIndexOf('@');
  return at > 0 ? file.slice(0, at) : '';
};

/**
 * Templates are collected by reference (decision 0037). In each stack, per
 * datastore and preset, the newest `templatesKeep` (default 1) stay — the
 * current seed content — and so does every template an environment or a copy
 * was restored from. Anything else is dropped once it is older than
 * `templateGraceMs`; for a stack that can never be bound again, nothing is
 * current. A marker for a server-side template is dropped WITH its database
 * (its persisted drop command), unless another marker still names it.
 */
export async function pruneTemplates(
  p: Pick<Policy, 'templatesKeep'> & Partial<Pick<Policy, 'templateGraceMs'>>,
  root = templatesRoot(),
  refs: TemplateRefs = { referenced: new Set(), stackAlive: () => true },
): Promise<number> {
  let pruned = 0;
  const grace = p.templateGraceMs ?? 0;
  for (const stackDir of entriesOf(root)) {
    const dir = join(root, stackDir);
    if (!existsSync(dir)) continue;
    // The stack-scoped bake lock (the dir name IS the stack id): pruning was
    // the one remaining writer mutating this dir outside it, reopening the
    // deleted-mid-restore race the lock exists to close.
    pruned += await withBakeLock(stackDir, async () => {
      const keep = refs.stackAlive(stackDir) ? p.templatesKeep : 0;
      let count = 0;
      const files = entriesOf(dir)
        .filter((f) => !f.startsWith('.'))
        .map((f) => {
          try {
            return { f, mtime: statSync(join(dir, f)).mtimeMs };
          } catch {
            return null;
          }
        })
        .filter((x): x is { f: string; mtime: number } => x !== null)
        .sort((a, b) => b.mtime - a.mtime);
      const seen = new Map<string, number>();
      for (const { f, mtime } of files) {
        const group = templateGroup(f);
        const rank = seen.get(group) ?? 0;
        seen.set(group, rank + 1);
        if (rank < keep) continue; // the current one(s) of this datastore and preset
        if (refs.referenced.has(`${stackDir}/${f}`)) continue; // an environment or copy holds it
        if (Date.now() - mtime < grace) continue; // baked too recently: a restore may be about to reference it
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
              const r = await runBounded(marker.drop, refs.dropCwd?.(stackDir) ?? root, Math.min(60, cmdTimeoutS()));
              if (r.code !== 0 || r.timedOut) {
                // The marker is the only record that names the database: keep it
                // for the next sweep, and for 'runly pool doctor' to show.
                logEvent({ level: 'warn', kind: 'retention', detail: `the drop of template ${marker.ns} (${f}) did not confirm (${r.timedOut ? 'timed out' : `exit ${r.code}`}) — its marker stays: ${r.output.slice(-200)}` });
                continue;
              }
            }
          } catch {
            /* unreadable marker — still prune the file */
          }
        }
        rmSync(full, { force: true });
        count++;
      }
      // A stack dir with nothing left goes too (its `.root` record with it).
      if (entriesOf(dir).every((f) => f.startsWith('.'))) rmSync(dir, { recursive: true, force: true });
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
      const recordedRoot = ['ledger.json', 'triggers.json', 'builds.json']
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

/**
 * What the journal says about templates (decision 0037): the ones rows
 * reference, and which stacks are alive. A stack no row names is alive while
 * the worktree it was recorded for exists — recorded by its worktree state
 * (`worktrees/<stack>/*.json`) or by the `.root` its first bake wrote next to
 * its templates. A stack with no record at all is NOT alive (0.19): its
 * worktree records were pruned because the worktree was gone, and treating it
 * as alive kept the templates of every pruned worktree forever.
 */
export function templateRefs(journal: Journal, root = worktreesRoot(), templates = templatesRoot()): TemplateRefs {
  const referenced = new Set<string>();
  const named = new Set<string>();
  for (const env of journal.allEnvs()) {
    named.add(env.stack);
    for (const ref of Object.values(env.templates ?? {})) referenced.add(ref);
  }
  for (const copy of journal.allDbCopies()) {
    named.add(copy.stack);
    if (copy.template) referenced.add(copy.template);
  }
  const stackAlive = (stackId: string): boolean => {
    if (named.has(stackId)) return true;
    // No row names it: alive while the worktree it describes exists. No
    // record at all means that worktree's records were pruned: not alive.
    let recorded: string | undefined;
    try {
      const r = readFileSync(join(templates, stackId, '.root'), 'utf8').trim();
      if (r) recorded = r;
    } catch {
      /* not recorded at bake time (an older runly) */
    }
    for (const f of recorded === undefined ? ['ledger.json', 'triggers.json', 'builds.json'] : []) {
      try {
        const r = (JSON.parse(readFileSync(join(root, stackId, f), 'utf8')) as { root?: unknown }).root;
        if (typeof r === 'string') {
          recorded = r;
          break;
        }
      } catch {
        /* next */
      }
    }
    return recorded !== undefined && existsSync(recorded);
  };
  const ownRoot = (stackId: string): string | undefined => {
    for (const env of journal.allEnvs()) if (env.stack === stackId) return env.stackRoot;
    try {
      const r = readFileSync(join(templates, stackId, '.root'), 'utf8').trim();
      if (r) return r;
    } catch { /* none recorded */ }
    return undefined;
  };
  const dropCwd = (stackId: string): string => {
    const own = ownRoot(stackId);
    if (own !== undefined && existsSync(own)) return own;
    // Stack ids are `<manifest name>-<8-char hash of the root>`.
    const project = stackId.slice(0, -9);
    for (const env of journal.allEnvs()) if (env.stack.slice(0, -9) === project && existsSync(env.stackRoot)) return env.stackRoot;
    for (const copy of journal.allDbCopies()) if (copy.stack.slice(0, -9) === project && existsSync(copy.stackRoot)) return copy.stackRoot;
    for (const sibling of entriesOf(templates)) {
      if (sibling === stackId || sibling.slice(0, -9) !== project) continue;
      const r = ownRoot(sibling);
      if (r !== undefined && existsSync(r)) return r;
    }
    return templates;
  };
  return { referenced, stackAlive, dropCwd };
}

export async function retentionSweep(
  journal: Journal,
  p: Policy,
): Promise<{ logs: number; templates: number; worktrees: number }> {
  // Templates first: they read the worktree records pruneWorktreeState removes.
  const templates = await pruneTemplates(p, templatesRoot(), templateRefs(journal));
  return {
    worktrees: pruneWorktreeState(journal),
    logs: truncateLogs(p),
    templates,
  };
}

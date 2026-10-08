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
import { hasOtherTemplateOwner, isPrivateTemplateFile, isSharedTemplateDir, parseBakedMarker, sharedTemplateDir, templateProject, withBakeLock } from '../drivers/datastores.js';
import { readWorktreeTemplates } from './tree-ledger.js';
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

export type TemplateVerdict =
  | { f: string; keep: true; why: 'current' | 'referenced' | 'grace' }
  | { f: string; keep: false; why: 'superseded' | 'dead' | 'private' | 'duplicate' };

/**
 * What retention (and `pool doctor`, without the grace) does with each
 * template in one templates dir (decisions 0037, 0044):
 *
 * - per datastore and preset, the newest `keep` are current — in a stack dir
 *   that can be bound again, or in a `<name>@shared` dir while any worktree of
 *   that name can;
 * - a template a row or a live worktree's record references stays;
 * - a private (`--pristine`) template is never "current": it stays only while
 *   referenced;
 * - a per-worktree template whose file name the shared dir also holds is a
 *   duplicate of it (the migration adopted it), never "current" either;
 * - anything else goes once older than `grace`.
 */
export function templateVerdicts(
  dir: string,
  files: Array<{ f: string; mtime: number }>,
  refs: TemplateRefs,
  keepNewest: number,
  graceMs: number,
  sharedFiles: ReadonlySet<string> = new Set(),
): TemplateVerdict[] {
  const alive = refs.stackAlive(dir);
  const keep = alive ? keepNewest : 0;
  const seen = new Map<string, number>();
  const out: TemplateVerdict[] = [];
  for (const { f, mtime } of [...files].sort((a, b) => b.mtime - a.mtime)) {
    const priv = isPrivateTemplateFile(f);
    const duplicate = !priv && !isSharedTemplateDir(dir) && sharedFiles.has(f);
    let current = false;
    if (!priv && !duplicate) {
      const group = templateGroup(f);
      const rank = seen.get(group) ?? 0;
      seen.set(group, rank + 1);
      current = rank < keep;
    }
    if (current) out.push({ f, keep: true, why: 'current' });
    else if (refs.referenced.has(`${dir}/${f}`)) out.push({ f, keep: true, why: 'referenced' });
    else if (Date.now() - mtime < graceMs) out.push({ f, keep: true, why: 'grace' });
    else out.push({ f, keep: false, why: priv ? 'private' : duplicate ? 'duplicate' : alive ? 'superseded' : 'dead' });
  }
  return out;
}

/** The template files of one dir with their mtimes (dot-files — `.root` — excluded). */
export function templateFiles(dir: string): Array<{ f: string; mtime: number }> {
  return entriesOf(dir)
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      try {
        return { f, mtime: statSync(join(dir, f)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { f: string; mtime: number } => x !== null);
}

/** The file names in the shared dir of `dir`'s project (empty for a shared dir itself). */
export function sharedFilesFor(dir: string, root = templatesRoot()): Set<string> {
  if (isSharedTemplateDir(dir)) return new Set();
  return new Set(entriesOf(join(root, sharedTemplateDir(templateProject(dir)))));
}

/**
 * Templates are collected by reference (decisions 0037, 0044): see
 * `templateVerdicts`. A marker for a server-side template is dropped WITH its
 * database (its persisted drop command), unless another marker still names it.
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
    // The dir-scoped bake lock (the dir name IS the lock key — a stack id or
    // `<name>@shared`): pruning was the one remaining writer mutating this
    // dir outside it, reopening the deleted-mid-restore race the lock exists
    // to close.
    pruned += await withBakeLock(stackDir, async () => {
      let count = 0;
      for (const v of templateVerdicts(stackDir, templateFiles(dir), refs, p.templatesKeep, grace, sharedFilesFor(stackDir, root))) {
        if (v.keep) continue;
        const f = v.f;
        const full = join(dir, f);
        if (f.endsWith('.baked')) {
          try {
            const marker = parseBakedMarker(readFileSync(full, 'utf8'));
            // Another marker naming the same database (an adopted template's
            // other copy): only this marker goes, the database stays.
            if (!hasOtherTemplateOwner(full, marker.ns) && marker.drop) {
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
      const recordedRoot = ['ledger.json', 'triggers.json', 'builds.json', 'templates.json']
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
 *
 * Shared templates (decision 0044): `<name>@shared` is alive while any stack
 * of that name is; a live worktree's `templates.json` (the template each of
 * its datastores was last restored from) counts as a reference.
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
  const recordedRootOf = (stackId: string): string | undefined => {
    try {
      const r = readFileSync(join(templates, stackId, '.root'), 'utf8').trim();
      if (r) return r;
    } catch {
      /* not recorded at bake time (an older runly) */
    }
    for (const f of ['ledger.json', 'triggers.json', 'builds.json', 'templates.json']) {
      try {
        const r = (JSON.parse(readFileSync(join(root, stackId, f), 'utf8')) as { root?: unknown }).root;
        if (typeof r === 'string') return r;
      } catch {
        /* next */
      }
    }
    return undefined;
  };
  const stackAliveOne = (stackId: string): boolean => {
    if (named.has(stackId)) return true;
    // No row names it: alive while the worktree it describes exists. No
    // record at all means that worktree's records were pruned: not alive.
    const recorded = recordedRootOf(stackId);
    return recorded !== undefined && existsSync(recorded);
  };
  // A live worktree's current templates (decision 0044).
  for (const stackId of entriesOf(root)) {
    const rec = readWorktreeTemplates(stackId);
    if (!rec || !existsSync(rec.root)) continue;
    for (const ref of Object.values(rec.refs)) referenced.add(ref);
  }
  const projectStacks = (project: string): string[] => {
    const ids = new Set<string>();
    for (const id of named) if (templateProject(id) === project) ids.add(id);
    for (const d of [root, templates]) for (const id of entriesOf(d)) if (!isSharedTemplateDir(id) && templateProject(id) === project) ids.add(id);
    return [...ids];
  };
  const stackAlive = (stackId: string): boolean => {
    if (!isSharedTemplateDir(stackId)) return stackAliveOne(stackId);
    return projectStacks(templateProject(stackId)).some(stackAliveOne);
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
    // Stack ids are `<manifest name>-<8-char hash of the root>`; a shared dir is `<name>@shared`.
    const project = templateProject(stackId);
    for (const env of journal.allEnvs()) if (templateProject(env.stack) === project && existsSync(env.stackRoot)) return env.stackRoot;
    for (const copy of journal.allDbCopies()) if (templateProject(copy.stack) === project && existsSync(copy.stackRoot)) return copy.stackRoot;
    for (const sibling of entriesOf(templates)) {
      if (sibling === stackId || templateProject(sibling) !== project) continue;
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

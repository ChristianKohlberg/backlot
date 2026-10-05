/**
 * The worktree ledger (decision 0032): the half of decision 0008's fingerprint
 * ledger that describes the WORKTREE rather than an environment.
 *
 * Under the projection every environment had a private tree, so "this upkeep
 * rule was applied here" and "this service was built from that source" were
 * per-environment facts. Running in place, an install or a build lands in the
 * caller's worktree, which every environment of the stack — and `runly warm` —
 * shares. Kept per environment, the ledger would lie: environment A installs
 * lockfile v2, environment B's ledger still says v1 is applied, the lockfile
 * goes back to v1, and B skips the install over a v2 node_modules.
 *
 * So command upkeep rules and `@built:<service>` stamps live here, keyed by
 * stack id (one stack = one physical worktree); `@source` (what the running
 * services were started from) and the `@`-built-in rules (which act on an
 * environment's data) stay on the environment row. Writers hold the engine's
 * per-worktree lock; the file is replaced atomically.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { worktreesRoot } from './paths.js';
import { sha256 } from './util.js';

export interface TreeLedgerFile {
  /** The physical worktree this ledger describes — retention reads it. */
  root: string;
  fingerprints: Record<string, string>;
}

export const worktreeStateDir = (stackId: string): string => join(worktreesRoot(), stackId);
const ledgerPath = (stackId: string) => join(worktreeStateDir(stackId), 'ledger.json');

export function readTreeLedger(stackId: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(stackId), 'utf8')) as Partial<TreeLedgerFile>;
    return raw.fingerprints && typeof raw.fingerprints === 'object' ? { ...raw.fingerprints } : {};
  } catch {
    return {}; // absent or torn: every rule and build counts as not yet applied
  }
}

export function writeTreeLedger(stackId: string, root: string, fingerprints: Record<string, string>): void {
  const dir = worktreeStateDir(stackId);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `ledger.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ root, fingerprints } satisfies TreeLedgerFile));
  renameSync(tmp, ledgerPath(stackId));
}

/** `--pristine`: forget what was applied, so every rule and build runs again. */
export function clearTreeLedger(stackId: string): void {
  rmSync(ledgerPath(stackId), { force: true });
}

/** Which ledger a key belongs to. `@source` and `@`-built-in rules are per environment. */
export function isTreeKey(key: string): boolean {
  if (key.startsWith('@built:')) return true;
  if (key.startsWith('@')) return false; // @source and any future env-scoped stamp
  return !key.includes(' -> @');
}

export const pickTreeKeys = (fps: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(fps).filter(([k]) => isTreeKey(k)));
export const pickEnvKeys = (fps: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(fps).filter(([k]) => !isTreeKey(k)));

/**
 * A build stamp. The RESOLVED command is part of it: a build line that
 * templates an environment's port or datastore produces different output per
 * environment, so two environments may share a stamp only when they would run
 * the identical command over the identical source.
 */
export const buildStamp = (sourceHash: string, resolvedCommand: string): string =>
  sha256(`${sourceHash}\n${resolvedCommand}`);

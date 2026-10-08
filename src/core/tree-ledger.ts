/**
 * The worktree's upkeep ledger (decision 0032): which command upkeep rule was
 * last applied for which content of its `when:` files.
 *
 * Upkeep commands (an install, a codegen) write into the caller's worktree, so
 * whether one is due is a fact about the worktree, not about an environment;
 * `runly warm` reads and writes the same ledger a bind does. It is kept in the
 * state root, keyed by stack id (one stack = one physical worktree = one
 * environment), never in the worktree. The `@`-built-in rules act on an
 * environment's data and stay on the environment row. Writers hold the
 * engine's per-worktree lock; the file is replaced atomically.
 *
 * Builds are NOT recorded here or anywhere: a service's `build:` runs on every
 * bind that starts it, and the build tool decides what is up to date.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { worktreesRoot } from './paths.js';

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

/**
 * `runly destroy`: forget the command rules that declare no `outputs:` — the
 * pool that destroys an environment usually resets the worktree next
 * (`git clean -fdx`), which removes what they produced, and nothing else could
 * tell. Rules with `outputs:` stay: their outputs are checked at every bind.
 */
export function forgetRulesWithoutOutputs(stackId: string, root: string, keep: (key: string) => boolean): number {
  const fps = readTreeLedger(stackId);
  const kept = Object.fromEntries(Object.entries(fps).filter(([k]) => keep(k)));
  const dropped = Object.keys(fps).length - Object.keys(kept).length;
  if (dropped > 0) writeTreeLedger(stackId, root, kept);
  return dropped;
}

/** `--pristine`: forget what was applied, so every rule runs again. */
export function clearTreeLedger(stackId: string): void {
  rmSync(ledgerPath(stackId), { force: true });
}

/** Which ledger a key belongs to: command rules are the worktree's, `@` keys the environment's. */
export function isTreeKey(key: string): boolean {
  if (key.startsWith('@')) return false; // a leftover stamp from an older runly
  return !key.includes(' -> @');
}

export const pickTreeKeys = (fps: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(fps).filter(([k]) => isTreeKey(k)));
/** The environment's half: `@`-built-in rules only (`@source`/`@built:` stamps are gone). */
export const pickEnvKeys = (fps: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(fps).filter(([k]) => !k.startsWith('@') && k.includes(' -> @')));

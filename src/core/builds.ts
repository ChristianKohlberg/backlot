/**
 * Build skip (decision 0038): a service whose `build:` declares `when:` globs
 * is not rebuilt while the files they match are unchanged since its last
 * SUCCESSFUL build in this worktree.
 *
 * The inputs are listed the way upkeep triggers are (decision 0032): git's
 * file list filtered by the globs before anything is stat'ed, minus declared
 * `caches:` — so a `frontend/**` glob never walks node_modules. A file's
 * identity is path + size + mtime; the build line itself is part of the key,
 * so editing the command rebuilds. The ledger lives in the state root
 * (`worktrees/<stack>/builds.json`), never in the worktree, and is the
 * worktree's: `runly warm` writes it as well as `up`.
 *
 * An entry is dropped BEFORE its build runs and written only after it
 * succeeds, so a build that fails half-way is never vouched for.
 *
 * When the service declares `outputs:`, the entry also records a stat
 * snapshot of them taken right after the build. A skip needs that snapshot
 * to still hold: outputs that were deleted or overwritten since (a `git
 * clean`, a manual `rm -rf dist`, another tool) would otherwise leave the
 * service with nothing, or the wrong thing, to run.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './util.js';
import { enumerateSource } from './worktree.js';
import { worktreeStateDir } from './tree-ledger.js';
import type { Manifest } from './manifest.js';

interface BuildLedgerFile {
  root: string;
  builds: Record<string, { key: string; at: number; outputs?: string }>;
}

const ledgerPath = (stackId: string) => join(worktreeStateDir(stackId), 'builds.json');

function read(stackId: string): BuildLedgerFile['builds'] {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(stackId), 'utf8')) as Partial<BuildLedgerFile>;
    return raw.builds && typeof raw.builds === 'object' ? { ...raw.builds } : {};
  } catch {
    return {};
  }
}

function write(stackId: string, root: string, builds: BuildLedgerFile['builds']): void {
  const dir = worktreeStateDir(stackId);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `builds.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ root, builds } satisfies BuildLedgerFile));
  renameSync(tmp, ledgerPath(stackId));
}

/**
 * The key a build is recorded under: its (templated) command plus path, size
 * and mtime of every file its `when:` globs match.
 */
export async function buildInputsKey(root: string, manifest: Manifest, cmd: string, when: string[]): Promise<string> {
  const files = await enumerateSource(root, manifest, when);
  const lines = files.map((f) => {
    try {
      const st = statSync(join(root, f));
      return `${f}:${st.size}:${st.mtimeMs}`;
    } catch {
      return `${f}:gone`;
    }
  });
  return sha256(`${cmd}\n${lines.join('\n')}`);
}

/**
 * Was this service last built SUCCESSFULLY from exactly these inputs, and are
 * its outputs still what that build left? `outputs` is the current stat
 * snapshot of the declared outputs (undefined when none are declared).
 */
export function buildIsCurrent(stackId: string, service: string, key: string, outputs?: string): boolean {
  const entry = read(stackId)[service];
  if (entry?.key !== key) return false;
  if (outputs === undefined) return true;
  // An entry written before outputs were recorded vouches for its inputs only;
  // the caller has already checked that outputs exist at all.
  if (entry.outputs === undefined) return true;
  return entry.outputs === outputs;
}

/** Forget a service's build before running it again (a failure must not vouch for anything). */
export function forgetBuild(stackId: string, root: string, service: string): void {
  const builds = read(stackId);
  if (!(service in builds)) return;
  delete builds[service];
  write(stackId, root, builds);
}

/** Record a successful build, with the stat snapshot of its outputs when it declares any. */
export function recordBuild(stackId: string, root: string, service: string, key: string, outputs?: string): void {
  const builds = read(stackId);
  builds[service] = outputs === undefined ? { key, at: Date.now() } : { key, at: Date.now(), outputs };
  write(stackId, root, builds);
}

/** Has this service ever been built successfully in this worktree (any inputs)? */
export function everBuilt(stackId: string, service: string): boolean {
  return read(stackId)[service] !== undefined;
}

/** `--pristine`: nothing is trusted, so every build runs again. */
export function clearBuilds(stackId: string): void {
  rmSync(ledgerPath(stackId), { force: true });
}

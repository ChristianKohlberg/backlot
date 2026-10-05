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
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './util.js';
import { enumerateSource } from './worktree.js';
import { worktreeStateDir } from './tree-ledger.js';
import type { Manifest } from './manifest.js';

interface BuildLedgerFile {
  root: string;
  builds: Record<string, { key: string; at: number }>;
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
export function buildInputsKey(root: string, manifest: Manifest, cmd: string, when: string[]): string {
  const files = enumerateSource(root, manifest, when);
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

/** Was this service last built SUCCESSFULLY from exactly these inputs? */
export function buildIsCurrent(stackId: string, service: string, key: string): boolean {
  return read(stackId)[service]?.key === key;
}

/** Forget a service's build before running it again (a failure must not vouch for anything). */
export function forgetBuild(stackId: string, root: string, service: string): void {
  const builds = read(stackId);
  if (!(service in builds)) return;
  delete builds[service];
  write(stackId, root, builds);
}

/** Record a successful build. */
export function recordBuild(stackId: string, root: string, service: string, key: string): void {
  const builds = read(stackId);
  builds[service] = { key, at: Date.now() };
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

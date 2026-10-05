/**
 * What the worktree contains, for the few things runly still has to know about
 * it (decision 0032). Environments run IN the caller's worktree and runly does
 * not cache builds, so there is no whole-worktree source identity any more:
 * MSBuild, pnpm and the Angular CLI decide their own incrementality.
 *
 * Two questions remain, and both are about DECLARED paths only:
 *
 * - which files match an upkeep rule's `when:` glob (and a datastore's
 *   @rebake-template trigger) — `enumerateSource` lists the candidates the
 *   globs are matched against; only the matching files are ever read;
 * - which declared `outputs:` a check changed — `hashOutputs`.
 *
 * Git decides what belongs to the worktree (tracked + untracked-unignored
 * under the stack root, plus sync.include and checked-out submodules, minus
 * declared `caches:`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileHash, isFile, matchesAny, safeJoin } from './util.js';
import type { Manifest } from './manifest.js';

function gitFiles(root: string): string[] | null {
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** Gitlink (submodule) paths under `root`, as `git ls-files -s` reports them. */
function gitlinks(root: string): string[] {
  try {
    const staged = execFileSync('git', ['-C', root, 'ls-files', '-s', '-z', '--', '.'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return staged
      .split('\0')
      .filter((l) => l.startsWith('160000 '))
      .map((l) => l.split('\t')[1] ?? '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The worktree's files that match `only` (globs relative to the stack root),
 * or all of them when `only` is omitted.
 *
 * The listing is git's (one `ls-files`); the globs are applied BEFORE anything
 * is stat'ed, so a bind whose upkeep rules name a lockfile and a migrations
 * folder touches those files and nothing else of a 35k-file worktree.
 *
 * A submodule appears in ls-files only as its gitlink path, which stats as a
 * directory, so a CHECKED-OUT submodule is enumerated recursively — a trigger
 * inside it must fire like any other. An uninitialised submodule is an empty
 * directory and contributes nothing.
 */
export function enumerateSource(stackRoot: string, manifest: Manifest, only?: string[]): string[] {
  const listed = gitFiles(stackRoot) ?? walkAll(stackRoot);
  const seen = new Set(listed);
  const nested = (root: string, prefix: string, depth: number) => {
    if (depth > 8) return; // a submodule cycle
    for (const gl of gitlinks(root)) {
      const sub = join(root, gl);
      if (!existsSync(join(sub, '.git'))) continue;
      for (const f of gitFiles(sub) ?? []) {
        const rel = `${prefix}${gl}/${f}`;
        if (!seen.has(rel)) {
          seen.add(rel);
          listed.push(rel);
        }
      }
      nested(sub, `${prefix}${gl}/`, depth + 1);
    }
  };
  nested(stackRoot, '', 0);
  // sync.include: git-ignored files that still count as source (an .env.local
  // an upkeep rule may name as its trigger).
  for (const inc of manifest.sync?.include ?? []) {
    safeJoin(stackRoot, inc, 'sync.include'); // reject ../ or absolute before use
    if (isFile(join(stackRoot, inc)) && !seen.has(inc)) {
      seen.add(inc);
      listed.push(inc);
    }
  }
  // `caches:` names what builds and installs write INTO the worktree. That is
  // output, not source: a trigger glob like `**/package.json` must not fire
  // because an install rewrote node_modules/. (git-ignored output is already
  // absent; this covers a repo that has not ignored its own.) sync.include
  // outranks it.
  const caches = manifest.caches ?? [];
  const included = new Set(manifest.sync?.include ?? []);
  // Tracked-but-deleted files still appear in ls-files --cached.
  return listed
    .filter((f) => only === undefined || matchesAny(f, only))
    .filter((f) => included.has(f) || caches.length === 0 || !matchesAny(f, caches))
    .filter((f) => isFile(join(stackRoot, f)))
    .sort();
}

function walkAll(root: string, prefix = ''): string[] {
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(join(root, prefix));
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === '.git' || name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    // lstat, not stat: a DANGLING symlink makes stat throw ENOENT, which took
    // down the whole enumeration. Directory symlinks are listed but not
    // followed, so a link pointing at an ancestor cannot recurse forever.
    let st;
    try {
      st = lstatSync(join(root, rel));
    } catch {
      continue; // vanished mid-walk
    }
    if (st.isSymbolicLink()) out.push(rel);
    else if (st.isDirectory()) out.push(...walkAll(root, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Content hashes of the declared `outputs:`, for reporting which of them a
 * check changed. There is no write-back any more — the check wrote them where
 * they belong — but naming them in the verdict is still how a caller learns
 * that a run regenerated a lockfile or a client.
 */
export function hashOutputs(stackRoot: string, outputs: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const rel of outputs) {
    let abs: string;
    try {
      abs = safeJoin(stackRoot, rel, 'outputs');
    } catch {
      continue;
    }
    out[rel] = fileHash(abs);
  }
  return out;
}

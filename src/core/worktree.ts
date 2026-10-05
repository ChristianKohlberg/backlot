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
 * - whether a service's declared build `outputs:` changed across its build —
 *   `snapshotOutputs`, which decides whether `up` restarts the service.
 *
 * Git decides what belongs to the worktree (tracked + untracked-unignored
 * under the stack root, plus sync.include and checked-out submodules, minus
 * declared `caches:`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isFile, matchesAny, safeJoin } from './util.js';
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
 * A snapshot of a service's declared build outputs: every file matching the
 * globs, with its size and mtime, as one comparable string. `up` takes one
 * before and one after the service's build and restarts the service only when
 * they differ (decision 0032). Path + size + mtime is what a build tool
 * changes when it writes; content is read only with `compare: content`
 * (decision 0038).
 *
 * Each glob is walked from its literal prefix only, so `backend/host/bin/**`
 * never walks the rest of the worktree. A glob that escapes the worktree is
 * ignored.
 */
export function snapshotOutputs(stackRoot: string, globs: string[], compare: 'stat' | 'content' = 'stat'): string {
  const seen = new Map<string, string>();
  // `content` (decision 0038): a build tool that rewrites identical files
  // (the Angular CLI does) moves every mtime and would restart the service
  // for nothing; hashing what is IN the files ignores that.
  const fingerprint = (full: string, st: { size: number; mtimeMs: number }): string => {
    if (compare === 'stat') return `${st.size}:${st.mtimeMs}`;
    try {
      return `${st.size}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
    } catch {
      return `${st.size}:unreadable`;
    }
  };
  const walk = (dir: string, rel: string, all = false) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.git') continue;
      const childRel = rel ? `${rel}/${name}` : name;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue; // vanished mid-walk
      }
      if (st.isDirectory()) walk(full, childRel, all);
      else if (all || matchesAny(childRel, globs)) seen.set(childRel, fingerprint(full, st));
    }
  };
  for (const glob of globs) {
    const parts = glob.replace(/^\.\//, '').split('/');
    const stop = parts.findIndex((seg) => /[*?[]/.test(seg));
    const base = (stop === -1 ? parts.slice(0, -1) : parts.slice(0, stop)).join('/');
    let start: string;
    try {
      start = base ? safeJoin(stackRoot, base, 'outputs') : stackRoot;
    } catch {
      continue;
    }
    if (stop === -1) {
      // A literal file path: stat it directly.
      try {
        const literal = safeJoin(stackRoot, parts.join('/'), 'outputs');
        const st = lstatSync(literal);
        if (st.isFile()) seen.set(parts.join('/'), fingerprint(literal, st));
        else if (st.isDirectory()) walk(join(stackRoot, parts.join('/')), parts.join('/'), true); // a directory: everything under it
      } catch {
        /* absent */
      }
      continue;
    }
    walk(start, base);
  }
  return [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([f, v]) => `${f}:${v}`).join('\n');
}

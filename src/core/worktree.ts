/**
 * The worktree's source identity (decision 0032). Environments run IN the
 * caller's worktree, so nothing is copied any more; what is left of the old
 * projection is the question it also answered on the way: "which source state
 * is this?" Git decides what belongs to it (tracked + untracked-unignored
 * under the stack root, plus sync.include and checked-out submodules, minus
 * declared `caches:`), and the answer is one hash over every (path, content
 * hash) pair.
 *
 * That hash is what the engine compares against an environment's `@source`
 * (are the running services serving this state?) and against the per-worktree
 * build stamps (is the build output in this worktree from this state?).
 *
 * Performance: hashing is (size, mtime)-gated. A file whose stat matches the
 * per-worktree cache reuses its recorded hash, so an unchanged 35k-file repo
 * stats instead of re-hashing gigabytes. The cache lives in the state root,
 * never in the worktree.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileHash, isFile, matchesAny, safeJoin, sha256 } from './util.js';
import type { Manifest } from './manifest.js';

export interface SourceSnapshot {
  /** Every file that is part of the source state, relative to the stack root. */
  files: string[];
  /** Hash of the full (path -> content hash) map: the source identity. */
  sourceHash: string;
  /** Files whose content had to be read because their stat moved (or was racy). */
  hashed: number;
}

interface CacheEntry {
  hash: string;
  size: number;
  mtime: number;
}

/**
 * The cache plus the wall-clock at which it was written.
 *
 * Filesystem mtimes are coarse (a few ms on Linux, 1s on some filesystems), so
 * a file rewritten to the SAME SIZE within the same tick as the stat we
 * recorded is indistinguishable from the file we already hashed. Trusting the
 * stat then reuses the old hash forever, and the engine believes the running
 * services serve content they do not.
 *
 * git solves this with "racily clean": an entry whose mtime is not strictly
 * older than the index write is not trusted and must be re-hashed. Same rule.
 */
interface CacheFile {
  /** The worktree this cache describes — retention reads it. */
  root?: string;
  writtenAt?: number;
  entries: Record<string, CacheEntry>;
}

/** Filesystem timestamp granularity to distrust around the write. */
const RACY_WINDOW_MS = 2000;
const CACHE_FILE = 'hashes.json';

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
 * The files that make up the source state.
 *
 * A submodule appears in ls-files only as its gitlink path, which stats as a
 * directory. The projection used to refuse submodules because their contents
 * never reached the environment; running in place, they are simply there, so
 * a CHECKED-OUT submodule is enumerated recursively and its files join the
 * source identity — an edit inside it must move `@source` like any other. An
 * uninitialised submodule is an empty directory and contributes nothing.
 */
export function enumerateSource(stackRoot: string, manifest: Manifest): string[] {
  const listed = gitFiles(stackRoot) ?? walkAll(stackRoot);
  const seen = new Set(listed);
  const nested = (root: string, prefix: string, depth: number) => {
    if (depth > 8) return; // a submodule cycle is not a source state
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
  // sync.include: git-ignored files that still define the source state (an
  // .env.local the services read). Running in place they are present anyway;
  // listing them makes an edit to one move the source identity, so the next
  // bind restarts what reads it.
  for (const inc of manifest.sync?.include ?? []) {
    safeJoin(stackRoot, inc, 'sync.include'); // reject ../ or absolute before use
    if (isFile(join(stackRoot, inc)) && !seen.has(inc)) {
      seen.add(inc);
      listed.push(inc);
    }
  }
  // `caches:` names what builds and installs write INTO the worktree. That is
  // output, not source: counting it would make every build change the source
  // identity it was stamped with, and the next bind would restart for a file
  // runly itself produced. (git-ignored output is already absent; this covers
  // a repo that has not ignored its own.) sync.include outranks it.
  const caches = manifest.caches ?? [];
  const included = new Set(manifest.sync?.include ?? []);
  // Tracked-but-deleted files still appear in ls-files --cached.
  return listed
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

function loadCache(cacheDir: string): CacheFile {
  try {
    const raw = JSON.parse(readFileSync(join(cacheDir, CACHE_FILE), 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') return raw as CacheFile;
  } catch {
    /* absent or torn — start cold, which only costs one hashing pass */
  }
  return { entries: {} };
}

const statOf = (p: string): { size: number; mtime: number } | null => {
  try {
    const s = statSync(p);
    return { size: s.size, mtime: s.mtimeMs };
  } catch {
    return null;
  }
};

/**
 * Fingerprint the live worktree. Read-only on the worktree; the only write is
 * the stat cache under `cacheDir` (in the state root), replaced atomically so
 * two environments of one worktree fingerprinting at once cannot tear it.
 */
export function fingerprintWorktree(stackRoot: string, manifest: Manifest, cacheDir: string): SourceSnapshot {
  const files = enumerateSource(stackRoot, manifest);
  const cache = loadCache(cacheDir);
  const racyFrom = cache.writtenAt === undefined ? -Infinity : cache.writtenAt - RACY_WINDOW_MS;
  const next: Record<string, CacheEntry> = {};
  const present: string[] = [];
  const hashLines: string[] = [];
  let hashed = 0;
  for (const rel of files) {
    const abs = join(stackRoot, rel);
    // A worktree is LIVE: a branch switch or a build can delete a file between
    // enumeration and this read. It is simply not part of this state.
    const st = statOf(abs);
    if (!st) continue;
    const cached = cache.entries[rel];
    const trust = cached !== undefined && cached.size === st.size && cached.mtime === st.mtime && cached.mtime < racyFrom;
    const hash = trust ? cached.hash : fileHash(abs);
    if (hash === null) continue; // disappeared between the stat and the read
    if (!trust) hashed++;
    next[rel] = { hash, size: st.size, mtime: st.mtime };
    present.push(rel);
    hashLines.push(`${rel}:${hash}`);
  }
  mkdirSync(cacheDir, { recursive: true });
  const tmp = join(cacheDir, `${CACHE_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, JSON.stringify({ root: stackRoot, writtenAt: Date.now(), entries: next } satisfies CacheFile));
  renameSync(tmp, join(cacheDir, CACHE_FILE));
  return { files: present, sourceHash: sha256(hashLines.join('\n')), hashed };
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

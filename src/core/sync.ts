/**
 * Bind-by-sync (decision 0005): project the consumer's worktree into the
 * environment's own tree. Git decides what belongs to a binding (tracked +
 * untracked-unignored under the stack root, plus sync.include); the copy is
 * hash-gated. Deletions are mirrored from the previous binding's file list;
 * caches and sync.keep survive. v0.1 transport is enumerate+copy — the
 * fetch/patch optimization arrives with remote substrates (0.3).
 *
 * Performance: hashing is (size, mtime)-gated on BOTH sides. A file whose
 * stat matches the per-env sync cache reuses its recorded hash, so a warm
 * rebind of an unchanged 28k-file repo stats instead of re-hashing 2 GB.
 * Correctness is preserved: any stat drift re-hashes, and the env-side stat
 * check is what keeps the "tracked files restored hard" reset guarantee —
 * a check that mutated a tracked env file is detected and overwritten.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync,
  readdirSync, statSync, lstatSync, chmodSync, constants as fsConstants,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileHash, matchesAny, sha256, isFile, safeJoin } from './util.js';
import type { Manifest } from './manifest.js';

export interface SyncResult {
  copied: number;
  deleted: number;
  files: string[];
  /** Hash of the full (path -> content hash) map: the binding's source identity. */
  sourceHash: string;
}

interface CacheEntry {
  hash: string;
  srcSize: number;
  srcMtime: number;
  dstSize: number;
  dstMtime: number;
  /** Permission bits. chmod changes ctime, not mtime, so content alone misses it. */
  mode?: number;
}
type SyncCache = Record<string, CacheEntry>;

/**
 * The cache plus the wall-clock at which it was written.
 *
 * Filesystem mtimes are coarse (a few ms on Linux, 1s on some filesystems), so
 * a file rewritten to the SAME SIZE within the same tick as the stat we
 * recorded is indistinguishable from the file we already synced. The stat gate
 * then reuses the cached hash forever and the environment silently keeps stale
 * content — the stat never drifts again on its own.
 *
 * git solves this with "racily clean": an entry whose mtime is not strictly
 * older than the index write is not trusted and must be re-hashed. Same rule.
 */
interface CacheFile {
  syncedAt?: number;
  entries: SyncCache;
}

/** Filesystem timestamp granularity to distrust around the write. */
const RACY_WINDOW_MS = 2000;

function enumerate(stackRoot: string, manifest: Manifest): string[] {
  let listed: string[];
  try {
    const out = execFileSync(
      'git',
      ['-C', stackRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    listed = out.split('\0').filter(Boolean);
  } catch {
    // Not a git repo: fall back to everything (minus default noise).
    listed = walkAll(stackRoot);
  }
  const include = manifest.sync?.include ?? [];
  for (const inc of include) {
    safeJoin(stackRoot, inc, 'sync.include'); // reject ../ or absolute before use
    if (isFile(join(stackRoot, inc)) && !listed.includes(inc)) listed.push(inc);
  }
  // Tracked-but-deleted files still appear in ls-files --cached.
  return listed.filter((f) => isFile(join(stackRoot, f)));
}

function walkAll(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, prefix))) {
    if (name === '.git' || name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${name}` : name;
    // lstat, not stat: a DANGLING symlink makes stat throw ENOENT, which took
    // down the whole enumeration — and this is the live path for `bind --ref`,
    // whose `git archive | tar -x` extraction preserves symlinks, dangling
    // ones included. Directory symlinks are listed but not followed, so a link
    // pointing at an ancestor cannot send this into an infinite walk.
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

const CACHE_FILE = '.backlot-synced.json';
const cachePath = (envRoot: string) => join(envRoot, CACHE_FILE);

function loadCache(envTree: string): CacheFile {
  try {
    const raw = JSON.parse(readFileSync(cachePath(envTree), 'utf8'));
    if (Array.isArray(raw)) return { entries: {} }; // v0.1 list format
    // v0.2 wrote the entry map at the top level, with no timestamp. Treat it as
    // entries with an unknown write time, which makes every entry racy once —
    // one extra hashing pass, then the new format takes over.
    if (raw && typeof raw === 'object' && 'entries' in raw) return raw as CacheFile;
    return { entries: (raw ?? {}) as SyncCache };
  } catch {
    return { entries: {} };
  }
}

const statOf = (p: string): { size: number; mtime: number; mode: number } | null => {
  try {
    const s = statSync(p);
    return { size: s.size, mtime: s.mtimeMs, mode: s.mode & 0o777 };
  } catch {
    return null;
  }
};

export function syncIntoEnv(stackRoot: string, envTree: string, manifest: Manifest): SyncResult {
  mkdirSync(envTree, { recursive: true });
  const files = enumerate(stackRoot, manifest).sort();
  const protectedPatterns = [...(manifest.caches ?? []), ...(manifest.sync?.keep ?? [])];
  const cache = loadCache(envTree);
  const prev = cache.entries;
  // An entry whose recorded mtime sits at or after the previous cache write
  // cannot be trusted: the file may have changed again inside the same
  // timestamp tick. Re-hash those instead of believing the stat.
  const racyFrom = cache.syncedAt === undefined ? -Infinity : cache.syncedAt - RACY_WINDOW_MS;
  const next: SyncCache = {};

  let copied = 0;
  for (const rel of files) {
    // git ls-files can't emit ../ but the sync.include path can — belt-and-suspenders
    // so neither the copy nor the deletion-mirror below can ever leave envTree.
    const dst = safeJoin(envTree, rel, 'synced file');
    const src = join(stackRoot, rel);
    const cached = prev[rel];
    const srcStat = statOf(src)!;

    // Source hash: stat-gated.
    const trustSrcStat =
      cached !== undefined &&
      cached.srcSize === srcStat.size &&
      cached.srcMtime === srcStat.mtime &&
      cached.srcMtime < racyFrom; // strictly older than the last write: safe
    const srcHash = trustSrcStat ? cached.hash : fileHash(src)!;

    // Env-side hash: stat-gated too (this is the reset guarantee — a mutated
    // tracked file in the env has a drifted stat or hash and gets overwritten).
    const dstStat = statOf(dst);
    let dstHash: string | null = null;
    if (dstStat) {
      const trustDstStat =
        cached !== undefined &&
        cached.dstSize === dstStat.size &&
        cached.dstMtime === dstStat.mtime &&
        cached.dstMtime < racyFrom;
      dstHash = trustDstStat ? cached.hash : fileHash(dst);
    }

    const contentDiffers = dstHash !== srcHash;
    if (contentDiffers) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst, fsConstants.COPYFILE_FICLONE); // CoW clone on APFS/reflink fs; falls back to copy
      copied++;
    }
    // copyFileSync only applies the source mode when it CREATES the file, and a
    // chmod moves ctime rather than mtime — so `chmod +x` on an unchanged file
    // never reached the environment, and the service failed with 'Permission
    // denied' blamed on the repo.
    const dstNow = statOf(dst);
    if (dstNow && dstNow.mode !== srcStat.mode) {
      chmodSync(dst, srcStat.mode);
      if (!contentDiffers) copied++; // a real change was propagated
    }
    const newDstStat = statOf(dst)!;
    next[rel] = {
      hash: srcHash,
      srcSize: srcStat.size,
      srcMtime: srcStat.mtime,
      dstSize: newDstStat.size,
      dstMtime: newDstStat.mtime,
      mode: srcStat.mode,
    };
  }

  // Mirror deletions relative to the PREVIOUS binding, never touching caches/keep.
  let deleted = 0;
  for (const rel of Object.keys(prev)) {
    if (next[rel] || matchesAny(rel, protectedPatterns)) continue;
    let victim: string;
    try {
      victim = safeJoin(envTree, rel, 'synced file'); // never rm outside the env tree
    } catch {
      continue; // a poisoned cache entry can't make us delete outside envTree
    }
    if (existsSync(victim)) {
      rmSync(victim, { force: true });
      deleted++;
    }
  }


  writeFileSync(cachePath(envTree), JSON.stringify({ syncedAt: Date.now(), entries: next } satisfies CacheFile));

  const sourceHash = sha256(files.map((f) => `${f}:${next[f]!.hash}`).join('\n'));
  return { copied, deleted, files, sourceHash };
}

/**
 * Outputs contract (decision 0011): report env-side changes to declared
 * outputs; copy back only on explicit pull.
 */
export function changedOutputs(stackRoot: string, envTree: string, manifest: Manifest): string[] {
  return (manifest.outputs ?? []).filter((rel) => {
    const envH = fileHash(join(envTree, rel));
    return envH !== null && envH !== fileHash(join(stackRoot, rel));
  });
}

export function pullOutputs(stackRoot: string, envTree: string, manifest: Manifest): string[] {
  const changed = changedOutputs(stackRoot, envTree, manifest);
  for (const rel of changed) {
    // outputs write BACK into the worktree — must never escape it (a rogue
    // '../../.bashrc' output would otherwise be overwritten from env content).
    const dst = safeJoin(stackRoot, rel, 'outputs');
    const src = safeJoin(envTree, rel, 'outputs');
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst, fsConstants.COPYFILE_FICLONE);
  }
  return changed;
}

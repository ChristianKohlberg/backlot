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
  readdirSync, statSync, lstatSync, chmodSync, renameSync, rmdirSync, constants as fsConstants,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileHash, matchesAny, sha256, isFile, safeJoin, BrokerError } from './util.js';
import type { Manifest } from './manifest.js';

export interface SyncResult {
  copied: number;
  deleted: number;
  /** Files the CLEAN-SLATE sweep removed (droppings no sync produced) —
   * distinct from mirror deletions: the bind must know the tree lost content
   * the fingerprint ledger may be vouching for. */
  sweptDroppings: number;
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
  // A submodule appears in ls-files only as its GITLINK path, which stats as a
  // directory and is dropped by the isFile filter below — so its contents were
  // silently absent from the environment and the build failed with a
  // work-error blaming the repo, with no hint about the cause. Fail loudly
  // instead: partial support here would be worse than an honest refusal.
  // The escape hatch the refusal advertises: a gitlink with at least one
  // sync.include entry beneath it is admitted — the declared files ride along
  // via the include push below (ls-files never descends past a gitlink).
  const include = manifest.sync?.include ?? [];
  try {
    const staged = execFileSync('git', ['-C', stackRoot, 'ls-files', '-s', '-z', '--', '.'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const gitlinks = staged
      .split('\0')
      .filter(Boolean)
      .filter((l) => l.startsWith('160000 '))
      .map((l) => l.split('\t')[1] ?? '')
      .filter(Boolean)
      // Only EXISTING FILES beneath the gitlink count: include admits single
      // files, so a directory entry, a typo, or the gitlink path itself would
      // be silently dropped by the include push below — and admitting the
      // gitlink on its say-so recreates exactly the silent omission this
      // refusal exists to prevent.
      .filter((gl) => !include.some((inc) => inc.startsWith(`${gl}/`) && isFile(join(stackRoot, inc))));
    if (gitlinks.length > 0) {
      throw new BrokerError(
        'work-error',
        `this repository uses git submodules (${gitlinks.slice(0, 3).join(', ')}${gitlinks.length > 3 ? ', …' : ''}), which backlot does not project into an environment — their contents would be silently missing. Vendor them, or declare the paths you need under sync.include.`,
        'sync',
      );
    }
  } catch (err) {
    if (err instanceof BrokerError) throw err;
    /* not a git repo, or ls-files unavailable — the walkAll path covers it */
  }

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

/**
 * The clean-slate sweep gets its own walker: walkAll's name-skip of .git and
 * node_modules serves SOURCE enumeration, but env-side those names are exactly
 * the droppings a clean-slate bind must purge — a check's stray clone, an
 * undeclared install (architecture.md §6: only declared caches: and sync.keep
 * are protected). Empty directories are droppings too; walkAll never emits
 * directories, so they survived every reset. A directory a protected pattern
 * matches keeps its whole subtree; one still holding synced or protected
 * content survives the rmdir (ENOTEMPTY). Returns the number of files removed.
 */
function sweepDroppings(
  envTree: string,
  prefix: string,
  synced: SyncCache,
  protectedPatterns: string[],
  /** Lowercased synced keys on a case-INSENSITIVE fs (same probe as the
   * deletion mirror): a case-only rename leaves the OLD casing on disk while
   * `synced` holds the new key, and both name the same file. */
  syncedLower: Set<string> | null,
): number {
  let deleted = 0;
  for (const name of readdirSync(join(envTree, prefix))) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (rel === CACHE_FILE || matchesAny(rel, protectedPatterns)) continue;
    let st;
    try {
      st = lstatSync(join(envTree, rel));
    } catch {
      continue; // vanished mid-sweep
    }
    if (st.isDirectory()) {
      deleted += sweepDroppings(envTree, rel, synced, protectedPatterns, syncedLower);
      try {
        rmdirSync(join(envTree, rel)); // throws ENOTEMPTY unless genuinely empty
      } catch {
        /* still holds synced or protected content */
      }
    } else if (!synced[rel] && !syncedLower?.has(rel.toLowerCase())) {
      try {
        rmSync(join(envTree, rel), { force: true });
        deleted++;
      } catch {
        /* unreadable — leave it */
      }
    }
  }
  return deleted;
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

/**
 * `cleanUntracked` sweeps env-side files no sync produced — droppings left by a
 * check, service, or exec.
 *
 * It is deliberately NOT the default. docs/architecture.md describes the reset
 * as cleaning untracked files on every bind, but doing that would delete any
 * artifact a repo builds inside the environment and forgets to declare under
 * `caches:` — including upkeep output — turning every bind into a full rebuild.
 * So it runs only when the caller asked for a clean slate (reset-data or
 * pristine); a plain `reuse` bind stays fast and keeps its droppings.
 */
/**
 * Probe the filesystem rather than guessing from the platform: APFS is
 * case-insensitive by default but can be formatted case-sensitive, and a
 * case-sensitive volume can be mounted on macOS. Guessing either way is wrong
 * on somebody's machine.
 *
 * Cached per tree — this runs on every sync.
 */
const caseSensitivityCache = new Map<string, boolean>();
function isCaseInsensitive(dir: string): boolean {
  const hit = caseSensitivityCache.get(dir);
  if (hit !== undefined) return hit;
  let result = false;
  const probe = join(dir, '.backlot-case-probe');
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(probe, '');
    result = existsSync(join(dir, '.BACKLOT-CASE-PROBE'));
  } catch {
    result = false; // cannot tell — assume case-sensitive, the safer default
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      /* best-effort */
    }
  }
  caseSensitivityCache.set(dir, result);
  return result;
}

/**
 * Remove directories left empty by a deletion, up to (never including) the env
 * tree root. A rename that moves a file out of a directory otherwise leaves the
 * empty directory behind forever, and tools that glob directories see a layout
 * the worktree no longer has.
 */
function pruneEmptyParents(envTree: string, removed: string): void {
  let dir = dirname(removed);
  while (dir.startsWith(envTree) && dir !== envTree) {
    try {
      rmdirSync(dir); // throws ENOTEMPTY unless it is genuinely empty
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

export function syncIntoEnv(
  stackRoot: string,
  envTree: string,
  manifest: Manifest,
  cleanUntracked = false,
): SyncResult {
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
  const vanished = new Set<string>();
  /** One `path:hash` line per synced file, in enumeration order — the input to
   * sourceHash, collected here so no later lookup has to assert non-null. */
  const hashLines: string[] = [];
  for (const rel of files) {
    // git ls-files can't emit ../ but the sync.include path can — belt-and-suspenders
    // so neither the copy nor the deletion-mirror below can ever leave envTree.
    const dst = safeJoin(envTree, rel, 'synced file');
    const src = join(stackRoot, rel);
    const cached = prev[rel];
    // A worktree is LIVE: a branch switch or a build can delete a file between
    // enumeration and this read. Asserting non-null crashed the bind with an
    // unclassified TypeError instead of simply syncing what is there.
    const srcStat = statOf(src);
    if (!srcStat) {
      vanished.add(rel);
      continue;
    }

    // Source hash: stat-gated.
    const trustSrcStat =
      cached !== undefined &&
      cached.srcSize === srcStat.size &&
      cached.srcMtime === srcStat.mtime &&
      cached.srcMtime < racyFrom; // strictly older than the last write: safe
    const srcHash = trustSrcStat ? cached.hash : fileHash(src);
    if (srcHash === null) {
      vanished.add(rel); // disappeared between the stat and the hash
      continue;
    }

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
    // The env copy was written (or verified) moments ago, so a missing stat
    // here means something OUTSIDE backlot is deleting the env tree under a
    // live sync. Carrying on would record a cache entry for a file that is not
    // there; crashing on the undefined was an unclassified TypeError.
    const newDstStat = statOf(dst);
    if (!newDstStat) {
      throw new BrokerError(
        'env-error',
        `just-synced file '${rel}' vanished from the environment tree — something is deleting env files concurrently; retry the bind`,
        'sync',
      );
    }
    next[rel] = {
      hash: srcHash,
      srcSize: srcStat.size,
      srcMtime: srcStat.mtime,
      dstSize: newDstStat.size,
      dstMtime: newDstStat.mtime,
      mode: srcStat.mode,
    };
    hashLines.push(`${rel}:${srcHash}`);
  }

  // Mirror deletions relative to the PREVIOUS binding, never touching caches/keep.
  let deleted = 0;
  // On a case-INSENSITIVE filesystem (macOS APFS by default), a case-only
  // rename — README.md -> Readme.md — leaves the old key in `prev` and the new
  // one in `next` while both name the SAME file on disk. Deleting the old key
  // then destroys the file that was just synced. Compare case-insensitively
  // before removing anything.
  const nextLower = new Set(Object.keys(next).map((k) => k.toLowerCase()));
  const caseInsensitiveFs = isCaseInsensitive(envTree);
  for (const rel of Object.keys(prev)) {
    if (next[rel] || matchesAny(rel, protectedPatterns)) continue;
    if (caseInsensitiveFs && nextLower.has(rel.toLowerCase())) continue;
    let victim: string;
    try {
      victim = safeJoin(envTree, rel, 'synced file'); // never rm outside the env tree
    } catch {
      continue; // a poisoned cache entry can't make us delete outside envTree
    }
    if (existsSync(victim)) {
      rmSync(victim, { force: true });
      pruneEmptyParents(envTree, victim);
      deleted++;
    }
  }


  // A clean-slate bind also removes what no sync produced. The deletion mirror
  // above only knows files the PREVIOUS sync wrote, so anything a check,
  // service, or exec created inside the environment used to survive every bind
  // and contaminate later verdicts.
  let sweptDroppings = 0;
  if (cleanUntracked) {
    sweptDroppings = sweepDroppings(envTree, '', next, protectedPatterns, caseInsensitiveFs ? nextLower : null);
    deleted += sweptDroppings;
  }

  // Atomic: a torn cache file silently disables deletion mirroring on the next
  // bind (loadCache swallows the parse error and returns empty), so stale files
  // would linger with no signal at all.
  const tmp = `${cachePath(envTree)}.tmp`;
  writeFileSync(tmp, JSON.stringify({ syncedAt: Date.now(), entries: next } satisfies CacheFile));
  renameSync(tmp, cachePath(envTree));

  const present = files.filter((f) => !vanished.has(f));
  const sourceHash = sha256(hashLines.join('\n'));
  return { copied, deleted, sweptDroppings, files: present, sourceHash };
}

/**
 * Outputs contract (decision 0011): report env-side changes to declared
 * outputs; copy back only on explicit pull.
 */
/**
 * Which declared outputs did the ENVIRONMENT change?
 *
 * Comparing the env copy against the LIVE worktree answered a different
 * question: a worktree file edited after the bind also differs, so backlot
 * reported it as an env-side change and a subsequent pull copied the stale
 * bind-time copy over the newer worktree content. The bind-time hash recorded
 * in the sync cache is the correct baseline.
 */
export function changedOutputs(stackRoot: string, envTree: string, manifest: Manifest): string[] {
  const bound = loadCache(envTree).entries;
  return (manifest.outputs ?? []).filter((rel) => {
    const envH = fileHash(join(envTree, rel));
    if (envH === null) return false;
    const baseline = bound[rel]?.hash;
    // With no recorded baseline (an output the sync never produced) fall back to
    // the worktree comparison — it is the only reference available.
    return baseline === undefined ? envH !== fileHash(join(stackRoot, rel)) : envH !== baseline;
  });
}

export function pullOutputs(stackRoot: string, envTree: string, manifest: Manifest): string[] {
  const changed = changedOutputs(stackRoot, envTree, manifest);
  const bound = loadCache(envTree).entries;
  for (const rel of changed) {
    // A retried pull (agent retry, or a retry after a timed-out first attempt)
    // finds the worktree already byte-identical to the env copy — the first
    // pull wrote it. Identical content needs no pull and is not a conflict,
    // even though both hashes now differ from the bind-time baseline.
    if (fileHash(join(stackRoot, rel)) === fileHash(join(envTree, rel))) continue;
    // Refuse to overwrite a worktree file that ALSO moved on since the bind.
    // The worktree is the source of truth (decision 0011); silently reverting
    // an edit the user made after binding is data loss, not a write-back.
    const baseline = bound[rel]?.hash;
    if (baseline !== undefined && fileHash(join(stackRoot, rel)) !== baseline) {
      throw new BrokerError(
        'work-error',
        `output '${rel}' changed in BOTH the environment and the worktree since the bind — refusing to overwrite your worktree copy. Resolve it by hand, or discard the worktree change and pull again.`,
        'outputs',
      );
    }
    // outputs write BACK into the worktree — must never escape it (a rogue
    // '../../.bashrc' output would otherwise be overwritten from env content).
    const dst = safeJoin(stackRoot, rel, 'outputs');
    const src = safeJoin(envTree, rel, 'outputs');
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst, fsConstants.COPYFILE_FICLONE);
  }
  return changed;
}

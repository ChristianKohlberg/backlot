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
  readdirSync, statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileHash, matchesAny, sha256, isFile } from './util.js';
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
}
type SyncCache = Record<string, CacheEntry>;

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
    if (statSync(join(root, rel)).isDirectory()) out.push(...walkAll(root, rel));
    else out.push(rel);
  }
  return out;
}

const cachePath = (envRoot: string) => join(envRoot, '.infront-synced.json');

function loadCache(envTree: string): SyncCache {
  try {
    const raw = JSON.parse(readFileSync(cachePath(envTree), 'utf8'));
    return Array.isArray(raw) ? {} : (raw as SyncCache); // migrate from the v0.1 list format
  } catch {
    return {};
  }
}

const statOf = (p: string): { size: number; mtime: number } | null => {
  try {
    const s = statSync(p);
    return { size: s.size, mtime: s.mtimeMs };
  } catch {
    return null;
  }
};

export function syncIntoEnv(stackRoot: string, envTree: string, manifest: Manifest): SyncResult {
  mkdirSync(envTree, { recursive: true });
  const files = enumerate(stackRoot, manifest).sort();
  const protectedPatterns = [...(manifest.caches ?? []), ...(manifest.sync?.keep ?? [])];
  const prev = loadCache(envTree);
  const next: SyncCache = {};

  let copied = 0;
  for (const rel of files) {
    const src = join(stackRoot, rel);
    const dst = join(envTree, rel);
    const cached = prev[rel];
    const srcStat = statOf(src)!;

    // Source hash: stat-gated.
    const srcHash =
      cached && cached.srcSize === srcStat.size && cached.srcMtime === srcStat.mtime
        ? cached.hash
        : fileHash(src)!;

    // Env-side hash: stat-gated too (this is the reset guarantee — a mutated
    // tracked file in the env has a drifted stat or hash and gets overwritten).
    const dstStat = statOf(dst);
    let dstHash: string | null = null;
    if (dstStat) {
      dstHash =
        cached && cached.dstSize === dstStat.size && cached.dstMtime === dstStat.mtime
          ? cached.hash
          : fileHash(dst);
    }

    if (dstHash !== srcHash) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      copied++;
    }
    const newDstStat = dstHash !== srcHash ? statOf(dst)! : dstStat!;
    next[rel] = { hash: srcHash, srcSize: srcStat.size, srcMtime: srcStat.mtime, dstSize: newDstStat.size, dstMtime: newDstStat.mtime };
  }

  // Mirror deletions relative to the PREVIOUS binding, never touching caches/keep.
  let deleted = 0;
  for (const rel of Object.keys(prev)) {
    if (!next[rel] && !matchesAny(rel, protectedPatterns) && existsSync(join(envTree, rel))) {
      rmSync(join(envTree, rel), { force: true });
      deleted++;
    }
  }
  writeFileSync(cachePath(envTree), JSON.stringify(next));

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
    mkdirSync(dirname(join(stackRoot, rel)), { recursive: true });
    copyFileSync(join(envTree, rel), join(stackRoot, rel));
  }
  return changed;
}

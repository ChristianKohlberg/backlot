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
import { execFile } from 'node:child_process';
import { createReadStream, existsSync, lstatSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { isFile, matchesAny, safeJoin, statOf } from './util.js';
import type { Manifest } from './manifest.js';

const execFileP = promisify(execFile);

/**
 * git's file list under `root`, restricted to `pathspecs` when given (literal
 * directory or file paths relative to `root`). Asynchronous: on a large
 * worktree the listing takes long enough that a synchronous call stalled every
 * proxied connection of every environment while it ran.
 */
async function gitFiles(root: string, pathspecs: string[] = ['.']): Promise<string[] | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_LITERAL_PATHSPECS: '1' } },
    );
    return stdout.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** Does the repository `root` belongs to declare submodules at all? (No .gitmodules, no gitlinks to look for.) */
function declaresSubmodules(root: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.gitmodules'))) return true;
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return false;
  }
}

/** Gitlink (submodule) paths under `root`, as `git ls-files -s` reports them. */
async function gitlinks(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileP('git', ['-C', root, 'ls-files', '-s', '-z', '--', '.'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout
      .split('\0')
      .filter((l) => l.startsWith('160000 '))
      .map((l) => l.split('\t')[1] ?? '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The literal directory (or file) each glob can only match under, as git
 * pathspecs — or null when one of them can match anywhere (a bare name, a
 * leading `**`), so the whole worktree has to be listed.
 */
export function globPathspecs(globs: string[]): string[] | null {
  const specs = new Set<string>();
  for (const g of globs) {
    const p = g.replace(/^glob\((.*)\)$/, '$1').replace(/^\.\//, '');
    const parts = p.split('/');
    if (parts.length === 1 && !/[*?[]/.test(p)) return null; // a bare name matches a segment anywhere
    const stop = parts.findIndex((seg) => /[*?[]/.test(seg));
    const prefix = (stop === -1 ? parts : parts.slice(0, stop)).filter(Boolean).join('/');
    if (!prefix || prefix.split('/').includes('..')) return null;
    specs.add(prefix);
  }
  return [...specs];
}

/**
 * The worktree's files that match `only` (globs relative to the stack root),
 * or all of them when `only` is omitted.
 *
 * The listing is git's (one `ls-files`, limited to the globs' literal
 * prefixes); the globs are applied BEFORE anything is stat'ed, so a bind
 * whose upkeep rules name a lockfile and a migrations folder touches those
 * files and nothing else of a 35k-file worktree.
 *
 * A submodule appears in ls-files only as its gitlink path, which stats as a
 * directory, so a CHECKED-OUT submodule is enumerated recursively — a trigger
 * inside it must fire like any other. An uninitialised submodule is an empty
 * directory and contributes nothing. A repository without a .gitmodules has
 * no gitlinks, and the second listing is skipped.
 */
export async function enumerateSource(stackRoot: string, manifest: Manifest, only?: string[]): Promise<string[]> {
  return (await enumerateSourceStats(stackRoot, manifest, only)).map((f) => f.path);
}

/** Files between two yields to the event loop while a listing is stat'ed. */
const YIELD_EVERY = 2000;
/** Let the proxy and every other request run between two slices of a long loop. */
export const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * `enumerateSource` with each file's size and mtime — ONE stat per file,
 * which the build key needs anyway (decision 0038). The stats run in slices,
 * yielding the event loop between them: on a 35k-file worktree the stat loop
 * alone held every proxied connection of every environment for 100+ ms.
 */
export async function enumerateSourceStats(stackRoot: string, manifest: Manifest, only?: string[]): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const pathspecs = only === undefined ? null : globPathspecs(only);
  const narrowed = pathspecs !== null && pathspecs.length > 0;
  const listed = (await gitFiles(stackRoot, narrowed ? pathspecs : undefined)) ?? walkAll(stackRoot);
  const seen = new Set(listed);
  const nested = async (root: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 8) return; // a submodule cycle
    if (!declaresSubmodules(root)) return;
    for (const gl of await gitlinks(root)) {
      const sub = join(root, gl);
      if (!existsSync(join(sub, '.git'))) continue;
      for (const f of (await gitFiles(sub)) ?? []) {
        const rel = `${prefix}${gl}/${f}`;
        if (!seen.has(rel)) {
          seen.add(rel);
          listed.push(rel);
        }
      }
      await nested(sub, `${prefix}${gl}/`, depth + 1);
    }
  };
  await nested(stackRoot, '', 0);
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
  const candidates = listed
    .filter((f) => only === undefined || matchesAny(f, only))
    .filter((f) => included.has(f) || caches.length === 0 || !matchesAny(f, caches))
    .sort();
  const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (let i = 0; i < candidates.length; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) await yieldLoop();
    const f = candidates[i] as string;
    const st = statOf(join(stackRoot, f));
    if (st?.isFile()) out.push({ path: f, size: st.size, mtimeMs: st.mtimeMs });
  }
  return out;
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
export async function snapshotOutputs(stackRoot: string, globs: string[], compare: 'stat' | 'content' = 'stat'): Promise<string> {
  const seen = new Map<string, { full: string; size: number; mtimeMs: number }>();
  let visited = 0;
  // Sliced like the source listing: a bin/ of thousands of files must not
  // hold the daemon's event loop (and every proxied connection) for its walk.
  const walk = async (dir: string, rel: string, all = false): Promise<void> => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === '.git') continue;
      if (++visited % YIELD_EVERY === 0) await yieldLoop();
      const childRel = rel ? `${rel}/${name}` : name;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue; // vanished mid-walk
      }
      if (st.isDirectory()) await walk(full, childRel, all);
      else if (all || matchesAny(childRel, globs)) seen.set(childRel, { full, size: st.size, mtimeMs: st.mtimeMs });
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
        if (st.isFile()) seen.set(parts.join('/'), { full: literal, size: st.size, mtimeMs: st.mtimeMs });
        else if (st.isDirectory()) await walk(join(stackRoot, parts.join('/')), parts.join('/'), true); // a directory: everything under it
      } catch {
        /* absent */
      }
      continue;
    }
    await walk(start, base);
  }
  const entries = [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // `content` (decision 0038): a build tool that rewrites identical files
  // (the Angular CLI does) moves every mtime and would restart the service
  // for nothing; hashing what is IN the files ignores that. Streamed, a few
  // at a time, so a large bundle never blocks the daemon's event loop.
  const prints = compare === 'stat'
    ? entries.map(([, st]) => `${st.size}:${st.mtimeMs}`)
    : await mapLimit(entries, 8, async ([, st]) => `${st.size}:${(await hashFile(st.full)) ?? 'unreadable'}`);
  return entries.map(([f], i) => `${f}:${prints[i]}`).join('\n');
}

/** sha256 of a file, streamed; null when it cannot be read. */
export function hashFile(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', () => resolve(null));
  });
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

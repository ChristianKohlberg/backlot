import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import * as pathMod from 'node:path';
import { cmdTimeoutS, runBounded } from './exec.js';

export const sha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

/**
 * Run a shell command, swallowing failures (best-effort cleanup paths).
 * Bounded: these run inside awaited sweeps, and a hung `drop` against an
 * unreachable appliance used to stall retention forever while each later
 * sweep piled another wedged `sh` onto the same marker.
 */
export const runQuiet = (cmd: string, cwd: string): Promise<void> =>
  runBounded(cmd, cwd, cmdTimeoutS()).then(() => undefined);

export const fileHash = (path: string): string | null => {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
};

export const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

/**
 * Minimal glob matcher for manifest patterns (caches, sync.include, outputs,
 * upkeep and build `when:`). Supports **, *, ?. A bare name with no glob chars
 * and no slash matches that path segment anywhere (node_modules). All patterns
 * also protect their subtree (an implicit trailing /**).
 *
 * `**` is anchored at path segments: a leading or inner `**\/` stands for zero
 * or more WHOLE directories, so `**\/bin` matches `bin` and `src/bin` but never
 * `src/Cabin` (it used to compile to `^.*bin`, which made a .NET
 * `caches: [**\/bin]` swallow every source directory whose name ends in "bin").
 * `*` and `?` stay inside one segment. Dotfiles are not special.
 *
 * Compiled patterns are cached: the same few manifest globs are matched
 * against every file of a worktree listing, and compiling them per file cost
 * seconds per `up` on a large tree.
 */
const globCache = new Map<string, RegExp>();
const GLOB_CACHE_MAX = 4096;

export function globToRegex(pattern: string): RegExp {
  const hit = globCache.get(pattern);
  if (hit) return hit;
  const re = compileGlob(pattern);
  if (globCache.size >= GLOB_CACHE_MAX) globCache.clear();
  globCache.set(pattern, re);
  return re;
}

function compileGlob(pattern: string): RegExp {
  const p = pattern.replace(/^glob\((.*)\)$/, '$1').replace(/^\.\//, '');
  if (!/[*?[]/.test(p) && !p.includes('/')) {
    return new RegExp(`(^|/)${p.replace(/[.+^${}()|\\]/g, '\\$&')}(/|$)`);
  }
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        const segmentStart = i === 0 || p[i - 1] === '/';
        if (segmentStart && p[i + 2] === '/') {
          // `**/`: zero or more whole directories.
          re += '(?:.*/)?';
          i += 2;
        } else {
          // A trailing `**` (everything below), or `**` inside a segment.
          re += '.*';
          i++;
        }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|\\[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}(/.*)?$`);
}

export const matchesAny = (path: string, patterns: string[]): boolean => {
  for (const p of patterns) if (globToRegex(p).test(path)) return true;
  return false;
};

/** Resolve {{...}} placeholders against a nested context object. */
export function template(str: string, ctx: Record<string, unknown>): string {
  return str.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, expr: string) => {
    const val = expr.split('.').reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, ctx);
    if (val === undefined || val === null) throw new Error(`unresolved template variable {{${expr}}}`);
    return String(val);
  });
}

export const templateEnv = (
  env: Record<string, string> | undefined,
  ctx: Record<string, unknown>,
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) out[k] = template(v, ctx);
  return out;
};

export class BrokerError extends Error {
  constructor(
    public readonly klass: 'work-error' | 'env-error' | 'infra-error',
    message: string,
    public readonly source?: string,
    public readonly logExcerpt?: string,
  ) {
    super(message);
  }
  toJSON() {
    return { class: this.klass, message: this.message, source: this.source, logExcerpt: this.logExcerpt };
  }
}

/**
 * A manifest-supplied relative path (sync.include, outputs, a datastore key)
 * must stay INSIDE its base after resolution — never escape via `..` or an
 * absolute path. Returns the safe joined absolute path, or throws work-error.
 * This is the guard that keeps file ops from leaving runly's own dirs even
 * on an honest `../shared/.env` typo, not only a malicious manifest.
 */
export function safeJoin(base: string, rel: string, what: string): string {
  const { resolve, isAbsolute } = pathMod;
  if (isAbsolute(rel)) throw new BrokerError('work-error', `${what} must be a relative path, got absolute '${rel}'`, 'manifest');
  const abs = resolve(base, rel);
  const baseResolved = resolve(base);
  if (abs !== baseResolved && !abs.startsWith(baseResolved + pathMod.sep)) {
    throw new BrokerError('work-error', `${what} '${rel}' escapes its directory — path traversal is not allowed`, 'manifest');
  }
  return abs;
}

/**
 * The output of a failed command that reads as a missing tool or runtime — the
 * DAEMON's environment, not the repo's code. Under a unit it is the
 * environment `runly daemon install` captured; a missing DOTNET_ROOT once made
 * every template bake fail there, reported as the code's fault.
 */
const ENVIRONMENTAL = /command not found|: not found\b|You must install or update \.NET|\.NET location: Not found|DOTNET_ROOT|spawn \S+ ENOENT|exec format error|cannot execute binary|env: '?[^\s']+'?: No such file or directory/i;

/** A hint naming the daemon's environment when `output` looks like one, else undefined. */
export function environmentHint(output: string): string | undefined {
  if (!ENVIRONMENTAL.test(output)) return undefined;
  const sup = process.env.RUNLY_SUPERVISOR;
  return sup === 'systemd' || sup === 'launchd'
    ? ` — this looks like the daemon's environment, not the code: a tool or runtime was not found. The daemon runs under its ${sup} unit with the environment 'runly daemon install' captured (it prints it); re-run the install from a shell that has the tool, or add a variable with --env NAME, then 'runly daemon stop' — the next verb starts it again`
    : ` — this looks like the daemon's environment, not the code: a tool or runtime was not found. The daemon kept the environment of the shell that started it; 'runly daemon stop', and the next verb starts it from yours`;
}

/**
 * A failed repo command as an error: env-error with the hint when it reads as
 * a missing tool or runtime, else `klass` (work-error: the code's fault).
 */
export function commandFailure(message: string, source: string | undefined, output: string, klass: 'work-error' | 'env-error' = 'work-error'): BrokerError {
  const hint = environmentHint(output);
  return new BrokerError(hint ? 'env-error' : klass, `${message}${hint ?? ''}`, source, output.slice(-800));
}

export const now = (): number => Date.now();

export const shortId = (): string => Math.random().toString(36).slice(2, 8);

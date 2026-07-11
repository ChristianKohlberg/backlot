import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import * as pathMod from 'node:path';

export const sha256 = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

/** Run a shell command, swallowing failures (best-effort cleanup paths). */
export const runQuiet = (cmd: string, cwd: string): Promise<void> =>
  new Promise((resolve) => {
    execFile('sh', ['-c', cmd], { cwd, maxBuffer: 16 * 1024 * 1024 }, () => resolve());
  });

export const fileHash = (path: string): string | null => {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
};

export const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();

/**
 * Minimal glob matcher for manifest patterns (caches, sync.keep, artifacts,
 * upkeep when:). Supports **, *, ?. A bare name with no glob chars and no
 * slash matches that path segment anywhere (node_modules). All patterns also
 * protect their subtree (an implicit trailing /**).
 */
export function globToRegex(pattern: string): RegExp {
  const p = pattern.replace(/^glob\((.*)\)$/, '$1').replace(/^\.\//, '');
  if (!/[*?[]/.test(p) && !p.includes('/')) {
    return new RegExp(`(^|/)${p.replace(/[.+^${}()|\\]/g, '\\$&')}(/|$)`);
  }
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i++;
        if (p[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|\\[\]]/g, '\\$&');
  }
  return new RegExp(`^${re}(/.*)?$`);
}

export const matchesAny = (path: string, patterns: string[]): boolean =>
  patterns.some((p) => globToRegex(p).test(path));

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
 * This is the guard that keeps file ops from leaving backlot's own dirs even
 * on an honest `../shared/.env` typo, not only a malicious manifest.
 */
export function safeJoin(base: string, rel: string, what: string): string {
  const { join, resolve, isAbsolute } = pathMod;
  if (isAbsolute(rel)) throw new BrokerError('work-error', `${what} must be a relative path, got absolute '${rel}'`, 'manifest');
  const abs = resolve(base, rel);
  const baseResolved = resolve(base);
  if (abs !== baseResolved && !abs.startsWith(baseResolved + pathMod.sep)) {
    throw new BrokerError('work-error', `${what} '${rel}' escapes its directory — path traversal is not allowed`, 'manifest');
  }
  return abs;
}

export const now = (): number => Date.now();

export const shortId = (): string => Math.random().toString(36).slice(2, 8);

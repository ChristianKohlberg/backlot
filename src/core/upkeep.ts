/**
 * The fingerprint ledger (decision 0008): a closed list of (trigger -> action)
 * rules, evaluated at bind (and `runly warm`) time, direction-agnostic. Actions
 * are repo commands, or engine built-ins prefixed with @.
 *
 * A rule's fingerprint is the content of the files its `when:` glob matches —
 * those files and nothing else (decision 0032). runly keeps no identity of the
 * rest of the worktree and no record of builds.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdTimeoutS, runBounded } from './exec.js';
import { globToRegex, sha256, fileHash, BrokerError } from './util.js';
import { enumerateSource } from './worktree.js';
import type { Manifest } from './manifest.js';

export interface UpkeepStep {
  /** 1-based position in the manifest's upkeep list — progress never names the command. */
  index: number;
  when: string;
  /** `ran` executed now; `fresh` matched the ledger; `skipped` was not this caller's to run. */
  status: 'ran' | 'fresh' | 'skipped';
  durationMs: number;
  reason?: string;
}

export interface UpkeepOutcome {
  ran: Array<{ when: string; run: string }>;
  fingerprints: Record<string, string>;
  /** Names of datastores whose templates must be rebaked (@rebake-template). */
  rebakeTemplates: string[];
  steps: UpkeepStep[];
}

export interface UpkeepOptions {
  /**
   * Evaluate `@` built-ins (default true). They act on an environment's data
   * (`@rebake-template`), so `runly warm` — which has no environment — skips
   * them and reports why.
   */
  builtins?: boolean;
  /**
   * Persist the ledger as it moves. Called with the rule's key REMOVED before
   * its command runs, and with the new hash after it succeeds: a rule that fails
   * half-way has left the worktree in neither state, and a ledger still naming
   * the old trigger would let a later revert to that trigger skip the repair.
   */
  commit?: (fingerprints: Record<string, string>) => void;
  /** Receives each command rule's output as it runs (`upkeep.build.log`, decision 0038). */
  onOutput?: { begin: (label: string) => void; data: (stream: 'out' | 'err', chunk: string) => void; end: (stream: 'out' | 'err') => void };
}

export const ruleKey = (rule: { when: string; run: string }): string => `${rule.when} -> ${rule.run}`;

/**
 * The worktree files any upkeep rule's `when:` glob matches — the only files a
 * bind reads to decide what upkeep is due. Empty, without asking git, when the
 * manifest declares no rules.
 */
export function triggerFiles(root: string, manifest: Manifest): string[] {
  const whens = (manifest.upkeep ?? []).map((rule) => rule.when);
  return whens.length === 0 ? [] : enumerateSource(root, manifest, whens);
}

/**
 * The trigger files with their content hashes, read once per bind.
 *
 * Trigger globs can match large files — a consumer's database backups are
 * 160 MB, named by several @rebake-template rules each — so hashing them per
 * rule on every bind would re-read the same bytes several times on the
 * daemon's thread. Each file is hashed once per bind, and only when its
 * (size, mtime) moved since the cache under `cacheDir` recorded it. The cache
 * holds the trigger files and nothing else, and lives in the state root.
 *
 * Filesystem mtimes are coarse, so a same-size rewrite inside one timestamp
 * tick of the recorded stat is indistinguishable from the file already hashed.
 * git's "racily clean" rule applies: an entry whose mtime is not strictly older
 * than the cache write (minus a window) is re-hashed.
 */
export interface TriggerSet {
  files: string[];
  hashOf: (rel: string) => string | null;
}

interface TriggerCacheEntry { hash: string; size: number; mtime: number }
const RACY_WINDOW_MS = 2000;

export function triggerSet(root: string, manifest: Manifest, cacheDir?: string): TriggerSet {
  const files = triggerFiles(root, manifest);
  let cache: { writtenAt?: number; entries: Record<string, TriggerCacheEntry> } = { entries: {} };
  if (cacheDir) {
    try {
      const raw = JSON.parse(readFileSync(join(cacheDir, 'triggers.json'), 'utf8'));
      if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') cache = raw;
    } catch {
      /* absent or torn: hash everything once */
    }
  }
  const racyFrom = cache.writtenAt === undefined ? -Infinity : cache.writtenAt - RACY_WINDOW_MS;
  const next: Record<string, TriggerCacheEntry> = {};
  const hashes = new Map<string, string | null>();
  for (const rel of files) {
    const abs = join(root, rel);
    let st: { size: number; mtimeMs: number };
    try {
      st = statSync(abs);
    } catch {
      hashes.set(rel, null);
      continue;
    }
    const cached = cache.entries[rel];
    const trust = cached !== undefined && cached.size === st.size && cached.mtime === st.mtimeMs && cached.mtime < racyFrom;
    const hash = trust ? cached.hash : fileHash(abs);
    hashes.set(rel, hash);
    if (hash !== null) next[rel] = { hash, size: st.size, mtime: st.mtimeMs };
  }
  if (cacheDir) {
    mkdirSync(cacheDir, { recursive: true });
    const tmp = join(cacheDir, `triggers.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, JSON.stringify({ root, writtenAt: Date.now(), entries: next }));
    renameSync(tmp, join(cacheDir, 'triggers.json'));
  }
  return { files, hashOf: (rel) => (hashes.has(rel) ? (hashes.get(rel) ?? null) : fileHash(join(root, rel))) };
}

/** The fingerprint of one `when:` glob: the content of exactly the files it matches. */
export function triggerHash(root: string, files: string[] | TriggerSet, when: string): string {
  const re = globToRegex(when);
  const list = Array.isArray(files) ? files : files.files;
  const hashOf = Array.isArray(files) ? (rel: string) => fileHash(join(root, rel)) : files.hashOf;
  const matching = list.filter((f) => re.test(f)).sort();
  return sha256(matching.map((f) => `${f}:${hashOf(f) ?? 'gone'}`).join('\n'));
}

/**
 * Content-derived bake key per datastore (vetbill-1i49).
 *
 * The baked-template identity used to hash only the static `create:` command
 * string — identical for every branch — so two environments of the same stack
 * whose trees carry *different* migrations/seeds could silently share one
 * template with the wrong schema. The @rebake-template rules already declare
 * exactly which files define a datastore's baked content; hashing those
 * files' current contents into the template name makes divergent content
 * yield disjoint templates by construction (rebake becomes cleanup, not the
 * only line of defense).
 *
 * Datastores with no @rebake-template rule get no key (undefined) and keep
 * their historical template names — existing bakes stay valid.
 */
export function templateBakeKeys(manifest: Manifest, root: string, files: string[] | TriggerSet): Record<string, string> {
  const perDs: Record<string, string[]> = {};
  for (const rule of manifest.upkeep ?? []) {
    if (!rule.run.startsWith('@rebake-template')) continue;
    const target = rule.run.slice('@rebake-template'.length).trim() || 'main';
    (perDs[target] ??= []).push(triggerHash(root, files, rule.when));
  }
  return Object.fromEntries(
    Object.entries(perDs).map(([ds, hashes]) => [ds, sha256(hashes.sort().join('\n')).slice(0, 12)]),
  );
}

export async function runUpkeep(
  root: string,
  files: string[] | TriggerSet,
  manifest: Manifest,
  previous: Record<string, string>,
  onProgress?: (phase: string) => void,
  opts: UpkeepOptions = {},
): Promise<UpkeepOutcome> {
  const outcome: UpkeepOutcome = { ran: [], fingerprints: { ...previous }, rebakeTemplates: [], steps: [] };
  const builtins = opts.builtins ?? true;
  for (const [index, rule] of (manifest.upkeep ?? []).entries()) {
    const key = ruleKey(rule);
    const position = index + 1;
    if (rule.run.startsWith('@') && !builtins) {
      outcome.steps.push({ index: position, when: rule.when, status: 'skipped', durationMs: 0, reason: 'acts on an environment\'s data; the next bind applies it' });
      continue;
    }
    const hash = triggerHash(root, files, rule.when);
    if (previous[key] === hash) {
      outcome.steps.push({ index: position, when: rule.when, status: 'fresh', durationMs: 0 });
      continue;
    }

    const started = Date.now();
    if (rule.run.startsWith('@')) {
      const [builtin, ...args] = rule.run.slice(1).split(/\s+/);
      if (builtin === 'rebake-template') {
        outcome.rebakeTemplates.push(args[0] ?? 'main');
      } else {
        throw new BrokerError('work-error', `unknown upkeep built-in '@${builtin}'`, 'upkeep');
      }
    } else {
      // Bounded like every other repo-declared command: an install blocking on
      // a half-up registry used to hold the env's busy bit until the daemon
      // was killed.
      const timeoutS = cmdTimeoutS(rule.timeout);
      // Commands and their output may contain credentials. Progress names only
      // the manifest rule's position, never its command or captured output.
      const label = `upkeep rule ${position}`;
      onProgress?.(`${label}: starting (timeout ${timeoutS}s)`);
      delete outcome.fingerprints[key];
      opts.commit?.(outcome.fingerprints);
      const heartbeat = onProgress && setInterval(() => {
        onProgress(`${label}: running (${Math.floor((Date.now() - started) / 1000)}s elapsed)`);
      }, 5000);
      heartbeat?.unref();
      let r;
      try {
        opts.onOutput?.begin(`${label} (when: ${rule.when})`);
        r = await runBounded(rule.run, root, timeoutS, undefined, opts.onOutput);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      if (r.timedOut) {
        onProgress?.(`${label}: timed out after ${timeoutS}s`);
        throw new BrokerError('work-error', `upkeep rule timed out after ${timeoutS}s (process group killed): ${rule.run}`, rule.when, r.output.slice(-800));
      }
      if (r.code !== 0) {
        onProgress?.(`${label}: failed (${Math.floor((Date.now() - started) / 1000)}s elapsed)`);
        // Triggered by the binding's own change -> work-error by default (decision 0008).
        throw new BrokerError('work-error', `upkeep rule failed: ${rule.run}`, rule.when, r.output.slice(-800));
      }
      onProgress?.(`${label}: finished (${Math.floor((Date.now() - started) / 1000)}s elapsed)`);
    }
    outcome.ran.push({ when: rule.when, run: rule.run });
    outcome.fingerprints[key] = hash;
    if (!rule.run.startsWith('@')) opts.commit?.(outcome.fingerprints);
    outcome.steps.push({ index: position, when: rule.when, status: 'ran', durationMs: Date.now() - started });
  }
  return outcome;
}

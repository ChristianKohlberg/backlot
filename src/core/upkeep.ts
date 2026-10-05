/**
 * The fingerprint ledger (decision 0008): a closed list of (trigger -> action)
 * rules, evaluated per environment at bind time, direction-agnostic. Actions
 * are repo commands, or engine built-ins prefixed with @.
 */
import { join } from 'node:path';
import { cmdTimeoutS, runBounded } from './exec.js';
import { globToRegex, sha256, fileHash, BrokerError } from './util.js';
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
}

export const ruleKey = (rule: { when: string; run: string }): string => `${rule.when} -> ${rule.run}`;

export function triggerHash(root: string, files: string[], when: string): string {
  const re = globToRegex(when);
  const matching = files.filter((f) => re.test(f)).sort();
  return sha256(matching.map((f) => `${f}:${fileHash(join(root, f)) ?? 'gone'}`).join('\n'));
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
export function templateBakeKeys(manifest: Manifest, root: string, files: string[]): Record<string, string> {
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

/**
 * Which rules WOULD fire for this worktree — the exact trigger check runUpkeep
 * performs, without running anything. A `sync` or `--watch` save under
 * hot-reload services uses it to decide honestly between "record the new
 * source, keep the services" and the full bind path: a save that changes what
 * a rule (or @rebake-template) fingerprints cannot be served by the dev
 * servers' own watchers alone.
 */
export function pendingUpkeep(
  root: string,
  files: string[],
  manifest: Manifest,
  previous: Record<string, string>,
): string[] {
  const pending: string[] = [];
  for (const rule of manifest.upkeep ?? []) {
    const key = ruleKey(rule);
    if (previous[key] !== triggerHash(root, files, rule.when)) pending.push(key);
  }
  return pending;
}

export async function runUpkeep(
  root: string,
  files: string[],
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
        r = await runBounded(rule.run, root, timeoutS);
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

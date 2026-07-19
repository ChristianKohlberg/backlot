/**
 * The fingerprint ledger (decision 0008): a closed list of (trigger -> action)
 * rules, evaluated per environment at bind time, direction-agnostic. Actions
 * are repo commands, or engine built-ins prefixed with @.
 */
import { join } from 'node:path';
import { cmdTimeoutS, runBounded } from './exec.js';
import { globToRegex, sha256, fileHash, BrokerError } from './util.js';
import type { Manifest } from './manifest.js';

export interface UpkeepOutcome {
  ran: Array<{ when: string; run: string }>;
  fingerprints: Record<string, string>;
  /** Names of datastores whose templates must be rebaked (@rebake-template). */
  rebakeTemplates: string[];
}

export function triggerHash(envTree: string, files: string[], when: string): string {
  const re = globToRegex(when);
  const matching = files.filter((f) => re.test(f)).sort();
  return sha256(matching.map((f) => `${f}:${fileHash(join(envTree, f)) ?? 'gone'}`).join('\n'));
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
export function templateBakeKeys(manifest: Manifest, envTree: string, files: string[]): Record<string, string> {
  const perDs: Record<string, string[]> = {};
  for (const rule of manifest.upkeep ?? []) {
    if (!rule.run.startsWith('@rebake-template')) continue;
    const target = rule.run.slice('@rebake-template'.length).trim() || 'main';
    (perDs[target] ??= []).push(triggerHash(envTree, files, rule.when));
  }
  return Object.fromEntries(
    Object.entries(perDs).map(([ds, hashes]) => [ds, sha256(hashes.sort().join('\n')).slice(0, 12)]),
  );
}

export async function runUpkeep(
  envTree: string,
  syncedFiles: string[],
  manifest: Manifest,
  previous: Record<string, string>,
): Promise<UpkeepOutcome> {
  const outcome: UpkeepOutcome = { ran: [], fingerprints: { ...previous }, rebakeTemplates: [] };
  for (const rule of manifest.upkeep ?? []) {
    const key = `${rule.when} -> ${rule.run}`;
    const hash = triggerHash(envTree, syncedFiles, rule.when);
    if (previous[key] === hash) continue;

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
      const timeoutS = cmdTimeoutS();
      const r = await runBounded(rule.run, envTree, timeoutS);
      if (r.timedOut) {
        throw new BrokerError('work-error', `upkeep rule timed out after ${timeoutS}s (process group killed): ${rule.run}`, rule.when, r.output.slice(-800));
      }
      if (r.code !== 0) {
        // Triggered by the binding's own change -> work-error by default (decision 0008).
        throw new BrokerError('work-error', `upkeep rule failed: ${rule.run}`, rule.when, r.output.slice(-800));
      }
    }
    outcome.ran.push({ when: rule.when, run: rule.run });
    outcome.fingerprints[key] = hash;
  }
  return outcome;
}

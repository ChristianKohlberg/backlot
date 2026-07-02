/**
 * The fingerprint ledger (decision 0008): a closed list of (trigger -> action)
 * rules, evaluated per environment at bind time, direction-agnostic. Actions
 * are repo commands, or engine built-ins prefixed with @.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { globToRegex, sha256, fileHash, BrokerError } from './util.js';
import type { Manifest } from './manifest.js';

export interface UpkeepOutcome {
  ran: Array<{ when: string; run: string }>;
  fingerprints: Record<string, string>;
  /** Names of datastores whose templates must be rebaked (@rebake-template). */
  rebakeTemplates: string[];
}

function triggerHash(envTree: string, files: string[], when: string): string {
  const re = globToRegex(when);
  const matching = files.filter((f) => re.test(f)).sort();
  return sha256(matching.map((f) => `${f}:${fileHash(join(envTree, f)) ?? 'gone'}`).join('\n'));
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
      await new Promise<void>((resolve, reject) => {
        execFile('sh', ['-c', rule.run], { cwd: envTree, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
          if (err) {
            // Triggered by the binding's own change -> work-error by default (decision 0008).
            reject(
              new BrokerError('work-error', `upkeep rule failed: ${rule.run}`, rule.when, String(stderr).slice(0, 800)),
            );
          } else resolve();
        });
      });
    }
    outcome.ran.push({ when: rule.when, run: rule.run });
    outcome.fingerprints[key] = hash;
  }
  return outcome;
}

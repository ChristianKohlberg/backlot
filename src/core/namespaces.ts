/**
 * Server-side namespaces whose names do not carry their stack (decision 0037).
 *
 * A datastore namespace is `backlot_<env or stack>_<name>`, cut to Postgres's
 * 63 bytes with a hash at the end. For a long stack id the cut lands inside
 * the stack id, so `pool doctor` could not tell the namespace was this state
 * root's from its name, called it foreign and never dropped it. Every
 * namespace that is cut is therefore recorded here, with its stack, before it
 * is created; doctor reads the record next to the name prefixes.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from './paths.js';

/** Postgres's identifier limit; every truncated namespace is exactly this long. */
export const NS_LIMIT = 63;

const file = () => join(stateRoot(), 'namespaces.json');

export function recordedNamespaces(): Map<string, string> {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, string>;
    return new Map(Object.entries(raw).filter(([, v]) => typeof v === 'string'));
  } catch {
    return new Map();
  }
}

function save(all: Map<string, string>): void {
  mkdirSync(stateRoot(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(Object.fromEntries(all)));
  renameSync(tmp, file());
}

/** Remember that `ns` (a truncated name) belongs to `stack`. A short name needs no record: its prefix says it. */
export function recordNamespace(ns: string, stack: string): void {
  if (ns.length < NS_LIMIT) return;
  const all = recordedNamespaces();
  if (all.get(ns) === stack) return;
  all.set(ns, stack);
  try {
    save(all);
  } catch {
    /* best effort: doctor then reports it as foreign, as before */
  }
}

/** Forget `ns` once it is dropped. */
export function forgetNamespace(ns: string): void {
  const all = recordedNamespaces();
  if (!all.delete(ns)) return;
  try {
    save(all);
  } catch {
    /* best effort */
  }
}

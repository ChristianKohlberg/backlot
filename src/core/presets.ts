import { declaredDefaultPreset, defaultPreset, envDatastoreNames, type DatastoreSpec, type Manifest } from './manifest.js';
import { BrokerError } from './util.js';

/** The presets a datastore offers. A manifest without a catalog keeps its historical default choices. */
export function presetCatalog(spec: DatastoreSpec): string[] {
  const declared = declaredDefaultPreset(spec);
  return spec.presets?.length ? spec.presets : [...new Set(['default', ...(declared === undefined ? [] : [declared])])];
}

/** A datastore's default preset, validated against its catalog. */
export function defaultPresetFor(name: string, spec: DatastoreSpec): string {
  const catalog = presetCatalog(spec);
  const declared = declaredDefaultPreset(spec);
  if (declared !== undefined && !catalog.includes(declared)) throw new BrokerError('work-error', `default preset '${declared}' for '${name}' is not declared in presets`, 'manifest');
  const value = defaultPreset(spec);
  if (!catalog.includes(value)) {
    throw new BrokerError('work-error', `no preset '${value}' for datastore '${name}' (have: ${catalog.join(', ') || 'none'})`, 'manifest');
  }
  return value;
}

/**
 * Validate an explicit `--preset` request (decision 0034) and every declared
 * default, before anything is claimed or changed. Returns ONLY the datastores
 * the caller named: an explicit preset reloads that datastore from its
 * template, and a datastore nobody named keeps whatever it holds.
 */
export function validatePresetRequest(manifest: Manifest, requested?: unknown, file = 'runly.yml'): Record<string, string> {
  const stores = manifest.datastores ?? {};
  if (requested !== undefined && (requested === null || typeof requested !== 'object' || Array.isArray(requested))) {
    throw new BrokerError('work-error', 'presets must map datastore names to preset names', 'manifest');
  }
  const choices = (requested ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(choices)) {
    if (!Object.hasOwn(stores, name)) throw new BrokerError('work-error', `no datastore '${name}' in ${file}`, 'manifest');
    if (typeof value !== 'string' || !value) throw new BrokerError('work-error', `preset for '${name}' must be a nonempty name`, 'manifest');
  }
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(stores)) {
    defaultPresetFor(name, spec);
    if (!Object.hasOwn(choices, name)) continue;
    const value = choices[name] as string;
    const catalog = presetCatalog(spec);
    if (!catalog.includes(value)) {
      throw new BrokerError('work-error', `no preset '${value}' for datastore '${name}' (have: ${catalog.join(', ') || 'none'})`, 'manifest');
    }
    out[name] = value;
  }
  return out;
}

/**
 * The preset a datastore is (re)created with when the caller named none: the
 * one it holds, while the catalog still offers it, else the default. A store
 * that is merely KEPT is never touched — this only decides what a restore that
 * happens anyway (a reset, a first creation) restores.
 */
export function presetToRestore(name: string, spec: DatastoreSpec, held: string | undefined): string {
  if (held !== undefined && presetCatalog(spec).includes(held)) return held;
  return defaultPresetFor(name, spec);
}

/**
 * CLI shorthand is only unambiguous for a single datastore — of the ones an
 * environment has: a `copies_only` datastore (decision 0039) is never reloaded
 * by `up`/`reset-data`, so it does not make `--preset NAME` ambiguous.
 */
export function parsePresetArgs(manifest: Manifest, values: string[]): Record<string, string> | undefined {
  if (values.length === 0) return undefined;
  const stores = envDatastoreNames(manifest);
  const choices: Record<string, string> = Object.create(null);
  for (const value of values) {
    const at = value.indexOf('=');
    if (at < 0 && stores.length !== 1) {
      throw new BrokerError('work-error', `--preset NAME requires exactly one datastore an environment has (here: ${stores.join(', ') || 'none'}); use --preset DATASTORE=NAME`, 'manifest');
    }
    const name = at < 0 ? stores[0]! : value.slice(0, at);
    const preset = at < 0 ? value : value.slice(at + 1);
    if (Object.hasOwn(choices, name)) throw new BrokerError('work-error', `preset for '${name}' was selected more than once`, 'manifest');
    choices[name] = preset;
  }
  return choices;
}

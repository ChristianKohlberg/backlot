import { defaultPreset, type Manifest } from './manifest.js';
import { BrokerError } from './util.js';
import type { LeaseKind } from './types.js';

/** Resolve selections before acquiring an environment or changing its data. */
export function selectPresets(manifest: Manifest, kind: LeaseKind, requested?: unknown, previous?: Record<string, string>): Record<string, string> {
  const stores = manifest.datastores ?? {};
  if (requested !== undefined && (requested === null || typeof requested !== 'object' || Array.isArray(requested))) {
    throw new BrokerError('work-error', 'presets must map datastore names to preset names', 'manifest');
  }
  const choices = (requested ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(choices)) {
    if (!Object.hasOwn(stores, name)) throw new BrokerError('work-error', `no datastore '${name}' in backlot.yml`, 'manifest');
    if (typeof value !== 'string' || !value) throw new BrokerError('work-error', `preset for '${name}' must be a nonempty name`, 'manifest');
  }
  return Object.fromEntries(Object.entries(stores).map(([name, spec]) => {
    // A manifest without a catalog retains its historical default choices.
    const catalog = spec.presets?.length ? spec.presets : [...new Set(['default', ...Object.values(spec.default_preset ?? {})])];
    for (const value of Object.values(spec.default_preset ?? {})) {
      if (!catalog.includes(value)) throw new BrokerError('work-error', `default preset '${value}' for '${name}' is not declared in presets`, 'manifest');
    }
    const inherited = previous?.[name];
    const value = (Object.hasOwn(choices, name) ? choices[name] : undefined) ?? (inherited && catalog.includes(inherited) ? inherited : defaultPreset(spec, kind));
    if (typeof value !== 'string' || !catalog.includes(value)) {
      throw new BrokerError('work-error', `no preset '${String(value)}' for datastore '${name}' (have: ${catalog.join(', ') || 'none'})`, 'manifest');
    }
    return [name, value];
  }));
}

/** CLI shorthand is only unambiguous for a single datastore. */
export function parsePresetArgs(manifest: Manifest, values: string[]): Record<string, string> | undefined {
  if (values.length === 0) return undefined;
  const stores = Object.keys(manifest.datastores ?? {});
  const choices: Record<string, string> = Object.create(null);
  for (const value of values) {
    const at = value.indexOf('=');
    if (at < 0 && stores.length !== 1) {
      throw new BrokerError('work-error', '--preset NAME requires exactly one datastore; use --preset DATASTORE=NAME', 'manifest');
    }
    const name = at < 0 ? stores[0]! : value.slice(0, at);
    const preset = at < 0 ? value : value.slice(at + 1);
    if (Object.hasOwn(choices, name)) throw new BrokerError('work-error', `preset for '${name}' was selected more than once`, 'manifest');
    choices[name] = preset;
  }
  return choices;
}

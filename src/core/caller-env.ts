/** Caller environment transport is allowlisted by service, never journaled. */
import type { Manifest, ServiceSpec } from './manifest.js';
import { loadStack } from './manifest.js';
import { BrokerError } from './util.js';

export function collectCallerEnv(cwd: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return selectCallerEnv(loadStack(cwd).manifest, source);
}

export function selectCallerEnv(manifest: Manifest, source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.values(manifest.services).flatMap((spec) =>
    Object.keys(spec.env_from ?? {}).flatMap((name) => source[name] === undefined ? [] : [[name, source[name]!]]),
  ));
}

/** Validate the socket payload without echoing values into error messages. */
export function validateCallerEnv(manifest: Manifest, input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BrokerError('work-error', 'callerEnv must be an object containing only declared environment inputs', 'env_from');
  }
  const allowed = new Set(Object.values(manifest.services).flatMap((s) => Object.keys(s.env_from ?? {})));
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(input)) {
    if (!allowed.has(name) || typeof value !== 'string' || value.includes('\0')) {
      throw new BrokerError('work-error', 'callerEnv contains an undeclared name or invalid value; only manifest env_from inputs are accepted', 'env_from');
    }
    values[name] = value;
  }
  return values;
}

export function requireCallerEnv(manifest: Manifest, active: Iterable<string>, values: Record<string, string>): void {
  for (const service of active) {
    for (const [name, mode] of Object.entries(manifest.services[service]!.env_from ?? {})) {
      if (mode === 'required' && values[name] === undefined) {
        throw new BrokerError('work-error', `service '${service}' requires caller environment '${name}'; export it and run 'backlot up' again (inputs are not retained across daemon restarts)`, 'env_from');
      }
    }
  }
}

/**
 * A supplied value wins; an omitted one keeps the service's explicit `env`
 * default, and undefined deliberately masks a same-named inherited daemon
 * value when there is no such default.
 */
export function serviceCallerEnv(spec: ServiceSpec, values: Record<string, string>): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.keys(spec.env_from ?? {}).flatMap((name): Array<[string, string | undefined]> =>
    values[name] !== undefined ? [[name, values[name]]] : name in (spec.env ?? {}) ? [] : [[name, undefined]],
  ));
}

/** Declaration identity only: safe to compare without hashing secret values. */
export function callerEnvSpec(manifest: Manifest): string {
  return JSON.stringify(Object.entries(manifest.services)
    .filter(([, spec]) => Object.keys(spec.env_from ?? {}).length > 0)
    .map(([name, spec]) => [name, Object.entries(spec.env_from!).sort(([a], [b]) => a.localeCompare(b))])
    .sort(([a], [b]) => String(a).localeCompare(String(b))));
}

/** Preserve chunk boundaries without ever writing a prefix of a secret first. */
export function redactStream(values: string[]): (chunk: string, final?: boolean) => string {
  const secrets = [...new Set(values.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return (chunk) => chunk;
  let pending = '';
  return (chunk, final = false) => {
    const input = pending + chunk;
    pending = '';
    let output = '';
    for (let i = 0; i < input.length;) {
      const remaining = input.slice(i);
      if (!final && secrets.some((secret) => remaining.length < secret.length && secret.startsWith(remaining))) {
        pending = remaining;
        break;
      }
      const match = secrets.find((secret) => input.startsWith(secret, i));
      if (match) {
        output += '[redacted]';
        i += match.length;
      } else {
        output += input[i]!;
        i++;
      }
    }
    return output;
  };
}

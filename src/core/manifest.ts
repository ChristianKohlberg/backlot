import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import { fileURLToPath } from 'node:url';
import { BrokerError } from './util.js';

export interface ReadySpec {
  http?: string;
  log?: string;
  cmd?: string;
  timeout?: number;
}

export interface ServiceSpec {
  run: string;
  build?: string;
  watch_run?: string;
  cwd?: string;
  port?: string;
  env?: Record<string, string>;
  ready?: ReadySpec;
  fatal_logs?: string;
  depends_on?: string[];
}

export interface DatastoreSpec {
  driver: 'sqlite' | 'postgres' | 'mssql' | 'mysql' | 'redis';
  server?: 'external';
  probe?: string;
  url?: string;
  create?: string;
  drop?: string;
  template_restore?: string;
  presets?: string[];
  default_preset?: { run?: string; session?: string };
  template?: boolean;
  ephemeral?: boolean;
}

export interface CheckSpec {
  run: string;
  cwd?: string;
  env?: Record<string, string>;
  artifacts?: string[];
}

export interface UpkeepRule {
  when: string;
  run: string;
}

export interface Manifest {
  name: string;
  services: Record<string, ServiceSpec>;
  datastores?: Record<string, DatastoreSpec>;
  caches?: string[];
  sync?: { keep?: string[]; include?: string[] };
  outputs?: string[];
  upkeep?: UpkeepRule[];
  auth?: { logins?: { user: string; password: string }; token?: string };
  checks?: Record<string, CheckSpec>;
}

export interface Stack {
  manifest: Manifest;
  /** Directory containing stack.yaml — the sync source root. */
  root: string;
  /** Stable identity: pools are keyed by this. */
  id: string;
}

const schemaPath = () =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'stack.schema.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let validator: any;
function validate(data: unknown): void {
  if (!validator) {
    // ajv is CJS; the constructor lands on .default under real ESM interop.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AjvCtor: any = (Ajv2020 as any).default ?? Ajv2020;
    const ajv = new AjvCtor({ allErrors: true });
    validator = ajv.compile(JSON.parse(readFileSync(schemaPath(), 'utf8')));
  }
  if (!validator(data)) {
    throw new BrokerError('work-error', `stack.yaml is invalid: ${JSON.stringify(validator.errors)}`, 'manifest');
  }
}

/** Walk upward from cwd to the nearest stack.yaml. */
export function findStackRoot(from: string): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'stack.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new BrokerError('work-error', `no stack.yaml found from ${from} upward`, 'manifest');
    }
    dir = parent;
  }
}

export function loadStack(from: string): Stack {
  const root = findStackRoot(from);
  const manifest = parse(readFileSync(join(root, 'stack.yaml'), 'utf8')) as Manifest;
  validate(manifest);
  // Identity = absolute root + declared name; filesystem-safe.
  const id = `${manifest.name}-${Buffer.from(root).toString('base64url').slice(-8)}`;
  return { manifest, root, id };
}

export function defaultPreset(ds: DatastoreSpec, kind: 'run' | 'session'): string {
  return ds.default_preset?.[kind] ?? ds.presets?.[0] ?? 'default';
}

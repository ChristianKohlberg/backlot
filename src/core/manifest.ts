import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

export interface ApplianceSpec {
  /** host:port whose reachability IS the appliance's identity. */
  probe: string;
  /** Daemonizing command run once (machine-wide) when the probe fails. */
  start?: string;
  /** Command for the explicit stop verb; never run automatically. */
  stop?: string;
  /** Optional readiness gate polled after TCP accepts (exit 0 = ready). */
  ready?: string;
  /** Seconds to wait after start for probe+ready. Default 60. */
  timeout?: number;
}

export interface CheckSpec {
  run: string;
  cwd?: string;
  env?: Record<string, string>;
  artifacts?: string[];
  /** Hard kill (whole process group) after this many seconds. Default 600. */
  timeout?: number;
}

export interface UpkeepRule {
  when: string;
  run: string;
}

export interface Manifest {
  name: string;
  services: Record<string, ServiceSpec>;
  appliances?: Record<string, ApplianceSpec>;
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
  /** Directory containing the manifest — the sync source root. */
  root: string;
  /** Stable identity: pools are keyed by this. */
  id: string;
}

const schemaPath = () =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'backlot.schema.json');

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
    throw new BrokerError('work-error', `the backlot manifest is invalid: ${JSON.stringify(validator.errors)}`, 'manifest');
  }
}

/** Walk upward from cwd to the nearest manifest. */
/** backlot.yml is canonical; stack.yaml (the pre-0.6 name) stays accepted so
 * existing consumers survive the upgrade. When both exist, backlot.yml wins —
 * a rename, not a coin toss. */
export const MANIFEST_NAMES = ['backlot.yml', 'stack.yaml'] as const;

function manifestIn(dir: string): string | null {
  for (const name of MANIFEST_NAMES) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function findStackRoot(from: string): string {
  let dir = resolve(from);
  for (;;) {
    if (manifestIn(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new BrokerError('work-error', `no backlot.yml (or stack.yaml) found from ${from} upward`, 'manifest');
    }
    dir = parent;
  }
}

export function loadStack(from: string): Stack {
  const root = findStackRoot(from);
  const file = manifestIn(root);
  if (!file) throw new BrokerError('work-error', `no backlot.yml (or stack.yaml) in ${root}`, 'manifest');
  const manifest = parse(readFileSync(file, 'utf8')) as Manifest;
  validate(manifest);
  // Identity = absolute root + declared name; filesystem-safe. Hash the WHOLE
  // path: slicing base64url(root) kept only the last ~6 bytes, so sibling
  // worktrees like agent-1/myapp and agent-2/myapp collided into one pool.
  const id = `${manifest.name}-${createHash('sha256').update(root).digest('base64url').slice(0, 8)}`;
  return { manifest, root, id };
}

export function defaultPreset(ds: DatastoreSpec, kind: 'run' | 'session'): string {
  return ds.default_preset?.[kind] ?? ds.presets?.[0] ?? 'default';
}

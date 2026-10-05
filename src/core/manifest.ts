import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import { fileURLToPath } from 'node:url';
import { BrokerError, safeJoin } from './util.js';

export interface ReadySpec {
  http?: string;
  log?: string;
  cmd?: string;
  timeout?: number;
}

export interface ServiceSpec {
  run: string;
  build?: string;
  /** Accepted and ignored since decision 0032 (`--watch` was removed). */
  watch_run?: string;
  /** Accepted and ignored since decision 0032: a service without `build:` keeps running on `up` anyway. */
  hot_reload?: boolean;
  /**
   * Globs (relative to the stack root) of what this service's `build:`
   * produces. Snapshotted (path, size, mtime) around the build on every `up`;
   * the service is restarted only when they changed. Without it, a service
   * with a build is restarted after every build (decision 0032).
   */
  outputs?: string[];
  cwd?: string;
  port?: string;
  env?: Record<string, string>;
  /** Allowlisted inputs supplied by the caller, retained only in lease memory. */
  env_from?: Record<string, 'required' | 'optional'>;
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

export interface UpkeepRule {
  when: string;
  run: string;
  /** Hard process-group deadline in seconds; default 300, global override wins. */
  timeout?: number;
}

/**
 * A seeded, dev-grade login the stack advertises to consumers. `role` names the
 * `{{role}}` an `auth.token` hook would take; `description` says what the login is
 * FOR, so a consumer picks the right one without reading the seed.
 */
export interface Login {
  user: string;
  password: string;
  role?: string;
  description?: string;
}

/**
 * `auth.logins` accepts a single login (the original form) or a list. The list's
 * FIRST entry is the primary one — see `normalizeLogins`.
 */
export type LoginsSpec = Login | Login[];

/**
 * One shape for consumers regardless of which form the manifest used: `[]` when no
 * login is declared, otherwise every declared login in order. A single-object
 * manifest yields exactly one entry, so callers never branch on the manifest form.
 */
export function normalizeLogins(spec: LoginsSpec | undefined): Login[] {
  if (!spec) return [];
  return Array.isArray(spec) ? spec : [spec];
}

export interface PreviewSpec {
  /**
   * When true, `runly preview` is refused (work-error). Stacks with fixed dev
   * credentials or a known signing key must set this.
   */
  forbidden?: boolean;
  /**
   * Named preview publisher adapter (default: cloudflare-quick). Known:
   * `cloudflare-quick`, `cloudflare-named`, `tailscale` (tailnet-only HTTPS via
   * `tailscale serve`, decision 0031).
   */
  publisher?: string;
  /**
   * Zone a naming publisher publishes under, e.g. `example.dev`. Required by
   * `cloudflare-named`; meaningless to `cloudflare-quick`, which is handed its
   * hostname by Cloudflare.
   */
  domain?: string;
  /**
   * What makes a hostname this environment's own.
   *
   * A naming publisher derives `<service>-<prefix>.<domain>`, so two
   * environments sharing a prefix want the same name — and the second one takes
   * it from the first. The manifest is the wrong place to make that unique: a
   * pooled stack has several environments and one manifest. Left unset, the
   * environment id supplies the prefix, which is unique by construction. Set it
   * only to pin a name a human has to remember, and only where one environment
   * of this stack runs at a time.
   */
  prefix?: string;
  /**
   * The HTTPS port on this machine's tailnet name that the `tailscale` publisher
   * serves on (`https://<machine>.<tailnet>.ts.net:<port>`). Unset means a port
   * derived from the environment id and service, stable for the environment's
   * lifetime and moved past any port this machine already serves. Pin it only
   * for an address a human has to remember, and only where one environment of
   * this stack publishes at a time — a second publish of a pinned port is
   * refused rather than taken over. Ignored by the Cloudflare publishers.
   */
  https_port?: number;
}

export interface Manifest {
  name: string;
  services: Record<string, ServiceSpec>;
  preview?: PreviewSpec;
  appliances?: Record<string, ApplianceSpec>;
  datastores?: Record<string, DatastoreSpec>;
  /** Build/install output in the worktree: never an upkeep trigger (decision 0032). */
  caches?: string[];
  /** `include`: git-ignored files an upkeep `when:` glob may still match. `keep` is accepted and ignored (decision 0032). */
  sync?: { keep?: string[]; include?: string[] };
  /** Accepted and ignored since decision 0032 (it served `runly run`). */
  outputs?: string[];
  upkeep?: UpkeepRule[];
  auth?: { logins?: LoginsSpec; token?: string };
  /**
   * Accepted and ignored since decision 0032: `runly run` was removed. Repo
   * scripts read `runly ctx --env` instead. A manifest that still declares it
   * loads, with a one-line deprecation warning (`manifestDeprecations`).
   */
  checks?: Record<string, unknown>;
}

/**
 * One-line warnings for manifest sections runly accepts but no longer acts on.
 * The CLI prints them to stderr; the manifest still loads.
 */
export function manifestDeprecations(manifest: Manifest): string[] {
  const out: string[] = [];
  if (manifest.checks !== undefined) {
    out.push(`runly.yml declares 'checks:', which is ignored since 'runly run' was removed (decision 0032) — run your checks yourself, with 'runly ctx --env' for the environment`);
  }
  return out;
}

export interface Stack {
  manifest: Manifest;
  /** Directory containing the manifest — the worktree environments run in (decision 0032). */
  root: string;
  /** Stable identity: pools are keyed by this. */
  id: string;
}

const schemaPath = () =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'runly.schema.json');

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
    throw new BrokerError('work-error', `the runly manifest is invalid: ${JSON.stringify(validator.errors)}`, 'manifest');
  }
}

/** Walk upward from cwd to the nearest manifest. */
/** runly.yml is canonical; backlot.yml and stack.yaml stay accepted so
 * existing consumers survive the upgrade. When several exist, runly.yml wins —
 * a rename, not a coin toss. */
export const MANIFEST_NAMES = ['runly.yml', 'backlot.yml', 'stack.yaml'] as const;

function manifestIn(dir: string): string | null {
  for (const name of MANIFEST_NAMES) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

export function canonicalDirectory(from: string): string {
  try { return realpathSync(resolve(from)); }
  catch { throw new BrokerError('work-error', `cannot resolve project directory '${from}'`, 'manifest'); }
}

const IDENTITY_HASH_LENGTH = 8;

export function stackIdentity(name: string, root: string): string {
  return `${name}-${createHash('sha256').update(root).digest('base64url').slice(0, IDENTITY_HASH_LENGTH)}`;
}

/** The identity a migrated row carried while its root was still spelled `legacyRoot`. */
export function retiredStackIdentity(stack: string, legacyRoot: string): string {
  return stackIdentity(stack.slice(0, -(IDENTITY_HASH_LENGTH + 1)), legacyRoot);
}

export function findStackRoot(from: string): string {
  let dir = canonicalDirectory(from);
  for (;;) {
    if (manifestIn(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new BrokerError('work-error', `no runly.yml (or backlot.yml / stack.yaml) found from ${from} upward`, 'manifest');
    }
    dir = parent;
  }
}

export function loadStack(from: string): Stack {
  const root = findStackRoot(from);
  const file = manifestIn(root);
  if (!file) throw new BrokerError('work-error', `no runly.yml (or backlot.yml / stack.yaml) in ${root}`, 'manifest');
  const manifest = parse(readFileSync(file, 'utf8')) as Manifest;
  validate(manifest);
  // A path that escapes the worktree is refused at load, whether or not an
  // upkeep rule ever makes runly read it: it is never a legitimate source file.
  for (const inc of manifest.sync?.include ?? []) safeJoin(root, inc, 'sync.include');
  // Identity = absolute root + declared name; filesystem-safe. Hash the WHOLE
  // path: slicing base64url(root) kept only the last ~6 bytes, so sibling
  // worktrees like agent-1/myapp and agent-2/myapp collided into one pool.
  const id = stackIdentity(manifest.name, root);
  return { manifest, root, id };
}

export function defaultPreset(ds: DatastoreSpec, kind: 'run' | 'session'): string {
  return ds.default_preset?.[kind] ?? ds.presets?.[0] ?? 'default';
}

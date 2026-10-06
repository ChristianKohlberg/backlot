import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BrokerError, safeJoin } from './util.js';

export interface ReadySpec {
  http?: string;
  log?: string;
  cmd?: string;
  timeout?: number;
}

/**
 * What a service (or an appliance) costs the box, for the server-wide load
 * budget (decision 0036). `memory` is a size (`600M`, `2G`, or bytes), `cpu`
 * a number of cores. `build` is what its build costs while it runs. Anything
 * left out is a conservative default, and `runly plan` says so.
 */
export interface ResourceSpec {
  memory?: string | number;
  cpu?: number;
  build?: { memory?: string | number; cpu?: number };
}

/**
 * A build step. The string form runs on every `up` that starts or keeps the
 * service. The object form adds `when:` — globs of the files the build reads;
 * when none of the matched files changed (path, size, mtime) since the last
 * SUCCESSFUL build of this service in this worktree, the build is skipped
 * (decision 0038).
 */
export type BuildSpec = string | { run: string; when?: string[]; serial?: boolean };

/**
 * What a build produces. String/array form: globs compared by path, size and
 * mtime. Object form: `compare: content` hashes the files instead, so a build
 * that rewrites identical files does not restart the service (decision 0038).
 */
export type OutputsSpec = string | string[] | { paths: string[]; compare?: 'stat' | 'content' };

/** The build line and its `when:` globs, whichever form the manifest used. */
export function buildOf(spec: { build?: BuildSpec }): { run: string; when?: string[]; serial?: boolean } | undefined {
  if (spec.build === undefined) return undefined;
  if (typeof spec.build === 'string') return { run: spec.build };
  return { run: spec.build.run, when: spec.build.when, serial: spec.build.serial };
}

/** The output globs and how they are compared, whichever form the manifest used. */
export function outputsOf(spec: { outputs?: OutputsSpec }): { paths: string[]; compare: 'stat' | 'content' } {
  const o = spec.outputs;
  if (o === undefined) return { paths: [], compare: 'stat' };
  if (typeof o === 'string') return { paths: [o], compare: 'stat' };
  if (Array.isArray(o)) return { paths: o, compare: 'stat' };
  return { paths: o.paths, compare: o.compare ?? 'stat' };
}

export interface ServiceSpec {
  run: string;
  build?: BuildSpec;
  /**
   * How long this service may sit with no client bytes through its public
   * port and no runly verb on its environment before it is stopped (decision
   * 0035). A duration (`90s`, `10m`, `2h`), seconds as a number, or `never`.
   * Default: BACKLOT_SERVICE_IDLE_MS (10 minutes).
   */
  idle?: string | number;
  resources?: ResourceSpec;
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
  outputs?: OutputsSpec;
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
  /** One preset name; the pre-0.13 `{run, session}` split is accepted and read as one value (session, then run). */
  default_preset?: string | { run?: string; session?: string };
  template?: boolean;
  ephemeral?: boolean;
  /**
   * Repo command printing the namespaces ({{ns}} values) of this datastore
   * that exist on its server, one per line. Only `runly pool doctor` reads it:
   * a listed name that matches runly's naming and no journal row references is
   * an orphan, and `--fix` drops it with `drop:` (decision 0037).
   */
  list?: string;
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
  /** What it costs while running, counted against the load budget when runly would start it (decision 0036). */
  resources?: ResourceSpec;
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
  /**
   * How one `up` runs its builds: `parallel` (default) in depends_on waves,
   * the builds of one wave at once; `serial` one at a time in manifest order.
   */
  builds?: 'parallel' | 'serial';
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
export function manifestDeprecations(manifest: Manifest, file = 'runly.yml'): string[] {
  const out: string[] = [];
  if (manifest.checks !== undefined) {
    out.push(`${file} declares 'checks:', which is ignored since 'runly run' was removed (decision 0032) — run your checks yourself, with 'runly ctx --env' for the environment`);
  }
  return out;
}

export interface Stack {
  manifest: Manifest;
  /** Directory containing the manifest — the worktree environments run in (decision 0032). */
  root: string;
  /** Stable identity: pools are keyed by this. */
  id: string;
  /** The manifest's file name as found (runly.yml, backlot.yml or stack.yaml), for messages. */
  file?: string;
}

/** The manifest's file name for a message: the one actually loaded. */
export const manifestFileOf = (stack?: { file?: string }): string => stack?.file ?? 'runly.yml';

const schemaPath = () =>
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schema', 'runly.schema.json');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let validator: any;
function validate(data: unknown): void {
  if (!validator) {
    // Loaded on first use: ajv and the schema compile cost ~100 ms, which a
    // CLI verb paid on every invocation although the daemon validates the
    // manifest it acts on anyway. ajv is CJS; the constructor lands on
    // .default under real ESM interop.
    const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const AjvCtor: any = Ajv2020.default ?? Ajv2020;
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

/**
 * Find, read and validate the manifest from `from` upward. `validate: false`
 * skips the schema check — only for a CLI-side read whose result the daemon
 * re-reads and validates before acting on it (the deprecation warnings).
 */
export function loadStack(from: string, opts: { validate?: boolean } = {}): Stack {
  const root = findStackRoot(from);
  const file = manifestIn(root);
  if (!file) throw new BrokerError('work-error', `no runly.yml (or backlot.yml / stack.yaml) in ${root}`, 'manifest');
  const manifest = parse(readFileSync(file, 'utf8')) as Manifest;
  if (opts.validate !== false) validate(manifest);
  // A path that escapes the worktree is refused at load, whether or not an
  // upkeep rule ever makes runly read it: it is never a legitimate source file.
  for (const inc of manifest.sync?.include ?? []) safeJoin(root, inc, 'sync.include');
  // Identity = absolute root + declared name; filesystem-safe. Hash the WHOLE
  // path: slicing base64url(root) kept only the last ~6 bytes, so sibling
  // worktrees like agent-1/myapp and agent-2/myapp collided into one pool.
  const id = stackIdentity(manifest.name, root);
  return { manifest, root, id, file: basename(file) };
}

/** The declared default preset, if any — one value, whichever form the manifest used. */
export function declaredDefaultPreset(ds: DatastoreSpec): string | undefined {
  const d = ds.default_preset;
  if (d === undefined) return undefined;
  return typeof d === 'string' ? d : (d.session ?? d.run);
}

export function defaultPreset(ds: DatastoreSpec): string {
  return declaredDefaultPreset(ds) ?? ds.presets?.[0] ?? 'default';
}

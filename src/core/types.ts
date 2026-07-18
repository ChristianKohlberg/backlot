/**
 * Core domain model (see docs/architecture.md §3).
 * Persisted in the per-machine SQLite journal; the daemon's memory is a cache.
 */

export type EnvState = 'provisioning' | 'hot' | 'warm' | 'degraded' | 'recycling';

export type Hygiene = 'reuse' | 'reset-data' | 'pristine';

export type LeaseKind = 'session' | 'run';

/** The field an agent branches on mechanically (decision 0010). */
export type ErrorClass = 'work-error' | 'env-error' | 'infra-error';

/**
 * A recorded service process. `startTime` (kernel clock ticks since boot,
 * Linux only) pins the pid to one process *life*, so a later daemon can tell
 * "still my service" from "the OS reused that pid" before signalling it.
 */
export interface ServicePid {
  pid: number;
  startTime?: number;
}

export interface Environment {
  id: string;
  stack: string;
  substrate: string;
  state: EnvState;
  root: string;
  /** Symbolic name -> allocated port. Stable for the environment's lifetime. */
  ports: Record<string, number>;
  datastoreNs: Record<string, string>;
  /** Per-upkeep-rule trigger hash as last applied IN THIS ENV (decision 0008). */
  fingerprints: Record<string, string>;
  bindCount: number;
  createdAt: number;
  lastUsedAt: number;
}

/** An immutable snapshot of source + data state (decision 0005). */
export interface Binding {
  envId: string;
  revision: number;
  ref: string;
  dirtyPatchHash: string | null;
  preset: string;
  hygiene: Hygiene;
  syncedAt: number;
}

export interface Lease {
  id: string;
  envId: string;
  kind: LeaseKind;
  /** Refreshed by any CLI touch; expiry releases the env WARM (decision 0003). */
  expiresAt: number;
  holder: string;
}

export interface Failure {
  class: ErrorClass;
  message: string;
  /** e.g. the upkeep rule or service that failed. */
  source?: string;
  logExcerpt?: string;
}

export interface Verdict {
  check: string;
  ok: boolean;
  exitCode: number;
  failure?: Failure;
  artifactsDir?: string;
  /** Declared outputs the env offers back; pulled only explicitly (decision 0011). */
  outputsChanged: string[];
  binding: Binding;
  durationMs: number;
}

/** What `backlot ctx --json` returns — the consumer's entire interface. */
export interface Context {
  stack: string;
  envId: string;
  lease: Lease;
  urls: Record<string, string>;
  logins?: { user: string; password: string };
  tokenCommand?: string;
  datastores: Record<string, { url: string }>;
  artifactsDir: string;
  hygiene: Hygiene;
  events: Array<{ at: number; service: string; event: string }>;
}

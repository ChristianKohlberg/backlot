/**
 * Core domain model (see docs/architecture.md §3).
 * Persisted in the per-machine SQLite journal; the daemon's memory is a cache.
 */

export type EnvState = 'provisioning' | 'hot' | 'warm' | 'degraded' | 'recycling';

export type Hygiene = 'reuse' | 'reset-data' | 'pristine';

/** Every lease is a session lease (decision 0032); a `run` row from a pre-0.13 journal is read as one. */
export type LeaseKind = 'session';

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
  pgid?: number;
  pgids?: number[];
}

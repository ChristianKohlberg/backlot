/**
 * Engine policy — NEVER repo knowledge (the manifest carries none of this).
 * Precedence per knob: env var > $STATE_DIR/config.json > heuristic/default.
 */
import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { stateRoot } from './paths.js';

export interface Policy {
  poolMax: number;
  sessionTtlMs: number;
  runTtlMs: number;
  idleTtlMs: number;
  waitMs: number;
  /** Retention knobs (task: disk sweep). */
  artifactDays: number;
  jobDays: number;
  logCapBytes: number;
  templatesKeep: number;
}

interface ConfigFile {
  poolMax?: number;
  sessionTtlMs?: number;
  runTtlMs?: number;
  idleTtlMs?: number;
  waitMs?: number;
  artifactDays?: number;
  jobDays?: number;
  logCapBytes?: number;
  templatesKeep?: number;
}

function configFile(): ConfigFile {
  try {
    return JSON.parse(readFileSync(join(stateRoot(), 'config.json'), 'utf8')) as ConfigFile;
  } catch {
    return {};
  }
}

/**
 * The designed capacity heuristic: min(cores/2, memGB/4), clamped to [2, 8].
 *
 * The floor is 2, not 1, because the documented core loop needs two
 * environments: a session `up` holds one, and `run` always mints its own
 * ephemeral holder, so it must be able to take a second. A pool of 1 cannot run
 * backlot as documented at all — it fails with 'pool at capacity (1/1)', which
 * is what small CI runners hit (3 vCPU / 7 GB gives 1 on both terms).
 *
 * This does raise peak memory on the smallest machines, which is a real cost.
 * It is accepted deliberately: a cap is not a reservation — the second
 * environment is only ever created when the user actually asks for concurrent
 * work — and shipping a default under which the primary workflow cannot run is
 * the worse failure. Set BACKLOT_POOL_MAX=1 to opt back out on a constrained
 * host, at the price of that loop.
 */
export function poolMaxHeuristic(): number {
  const byCores = Math.floor(cpus().length / 2);
  const byMem = Math.floor(totalmem() / (4 * 1024 ** 3));
  return Math.max(2, Math.min(8, Math.min(byCores || 1, byMem || 1)));
}

const num = (envVar: string, fileVal: number | undefined, fallback: number): number => {
  const e = process.env[envVar];
  if (e !== undefined && e !== '') return Number(e);
  if (fileVal !== undefined) return fileVal;
  return fallback;
};

export function policy(): Policy {
  const f = configFile();
  return {
    poolMax: num('BACKLOT_POOL_MAX', f.poolMax, poolMaxHeuristic()),
    sessionTtlMs: num('BACKLOT_LEASE_TTL_MS', f.sessionTtlMs, 30 * 60_000),
    runTtlMs: num('BACKLOT_LEASE_TTL_MS', f.runTtlMs, 10 * 60_000),
    idleTtlMs: num('BACKLOT_IDLE_TTL_MS', f.idleTtlMs, 30 * 60_000),
    waitMs: num('BACKLOT_WAIT_MS', f.waitMs, 60_000),
    artifactDays: num('BACKLOT_ARTIFACT_DAYS', f.artifactDays, 7),
    jobDays: num('BACKLOT_JOB_DAYS', f.jobDays, 7),
    logCapBytes: num('BACKLOT_LOG_CAP_BYTES', f.logCapBytes, 5 * 1024 * 1024),
    templatesKeep: num('BACKLOT_TEMPLATES_KEEP', f.templatesKeep, 4),
  };
}

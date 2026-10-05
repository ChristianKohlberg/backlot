/**
 * Engine policy — NEVER repo knowledge (the manifest carries none of this).
 * Precedence per knob: env var > $STATE_DIR/config.json > heuristic/default.
 */
import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { stateRoot } from './paths.js';

export interface Policy {
  /** Machine-wide ceiling across ALL stacks (the memory heuristic is per host). */
  poolMaxTotal: number;
  /**
   * Machine-wide ceiling for DATA-ONLY environments, counted separately.
   *
   * poolMaxTotal is derived from cores and memory because it bounds
   * running services. A data-only environment starts none, opens no port and
   * builds nothing — where the datastore is an appliance, its marginal cost is a
   * database catalog plus a synced tree. Charging it a stack-sized slot made a
   * test lane compete with the interactive leases people use to LOOK at the app,
   * which is the contention `up --data-only` existed to remove (#48). This cap
   * is therefore disk-shaped, not CPU-shaped, and there is no per-stack variant:
   * one lane per agent on one stack is the normal case.
   */
  poolMaxDataOnly: number;
  sessionTtlMs: number;
  idleTtlMs: number;
  /** How long a LEASED but untouched environment keeps its services running. */
  leasedIdleTtlMs: number;
  waitMs: number;
  /** Retention knobs (task: disk sweep). */
  logCapBytes: number;
  templatesKeep: number;
}

interface ConfigFile {
  poolMaxTotal?: number;
  poolMaxDataOnly?: number;
  sessionTtlMs?: number;
  idleTtlMs?: number;
  leasedIdleTtlMs?: number;
  waitMs?: number;
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
 * It is the machine-wide default (BACKLOT_POOL_MAX_TOTAL). The floor of 2
 * keeps two worktrees runnable at once even on a small CI runner (3 vCPU /
 * 7 GB gives 1 on both terms); a cap is not a reservation, so the second
 * environment is only created when a second worktree actually binds.
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
  const idleTtlMs = num('BACKLOT_IDLE_TTL_MS', f.idleTtlMs, 30 * 60_000);
  return {
    // The machine-wide ceiling: the heuristic is derived from this host's cores
    // and memory, so it is a budget for the host, not per project. (There is no
    // per-stack ceiling: a worktree has exactly one environment, decision 0032.)
    // Raise it deliberately if the host can take it.
    poolMaxTotal: num('BACKLOT_POOL_MAX_TOTAL', f.poolMaxTotal, poolMaxHeuristic()),
    // Deliberately NOT the cores/memory heuristic: a data-only environment runs
    // nothing, so what bounds it is disk, not CPU or RAM. Twice the heuristic
    // with a floor of 4 leaves room for a lane per agent without letting the
    // trees grow without limit.
    poolMaxDataOnly: num('BACKLOT_POOL_MAX_DATA_ONLY', f.poolMaxDataOnly, Math.max(4, 2 * poolMaxHeuristic())),
    sessionTtlMs: num('BACKLOT_LEASE_TTL_MS', f.sessionTtlMs, 30 * 60_000),
    idleTtlMs,
    // A LEASE used to exempt an environment from idle reclamation entirely, so
    // heat (services, and their memory) was held for as long as the lease
    // lasted — which for a crashed agent meant the full TTL. Leased
    // environments now quiesce too, just later: the lease survives, only the
    // heat is reclaimed, and the next verb rebinds. The default derives from
    // the RESOLVED idleTtlMs (architecture §11: "2 x idleTtlMs") — a constant
    // here made leased envs quiesce BEFORE abandoned ones once idleTtlMs was
    // raised past 30 minutes.
    leasedIdleTtlMs: num('BACKLOT_LEASED_IDLE_TTL_MS', f.leasedIdleTtlMs, 2 * idleTtlMs),
    waitMs: num('BACKLOT_WAIT_MS', f.waitMs, 60_000),
    logCapBytes: num('BACKLOT_LOG_CAP_BYTES', f.logCapBytes, 5 * 1024 * 1024),
    templatesKeep: num('BACKLOT_TEMPLATES_KEEP', f.templatesKeep, 4),
  };
}

/**
 * Engine policy — NEVER repo knowledge (the manifest carries none of this).
 * Precedence per knob: env var > $STATE_DIR/config.json > heuristic/default.
 */
import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { stateRoot } from './paths.js';
import { parseDuration, parseSize } from './units.js';

export interface Policy {
  /** Machine-wide ceiling across ALL stacks (the memory heuristic is per host). */
  poolMaxTotal: number;
  sessionTtlMs: number;
  idleTtlMs: number;
  waitMs: number;
  /** Retention knobs (task: disk sweep). */
  logCapBytes: number;
  /** Templates kept per stack/datastore/preset beyond the referenced ones (decision 0037). */
  templatesKeep: number;
  /** How long an unreferenced, superseded template survives before it is dropped (decision 0037). */
  templateGraceMs: number;
  /** A service with no client bytes and no runly verb for this long is stopped (decision 0035). */
  serviceIdleMs: number;
  /** A dead tether is believed only after this long (decision 0035). */
  tetherGraceMs: number;
  /**
   * An environment nobody leases is torn down (services, data, ports) after
   * this long without activity (0.19, BACKLOT_UNLEASED_TTL, default 24h,
   * `off` never). Templates and the worktree's records stay, so the next
   * `up` there restores rather than bakes and skips fresh upkeep.
   */
  unleasedTtlMs: number;
  /** The server-wide load budget (decision 0036). */
  budget: Budget;
}

/**
 * The load budget (decision 0036): what runly may commit on this box across
 * every stack. `enabled: false` (BACKLOT_BUDGET=off) admits everything.
 */
export interface Budget {
  enabled: boolean;
  /** Declared memory runly may have committed at once (running services + builds in flight). */
  memoryBytes: number;
  /** Declared cores runly may have committed at once. */
  cpu: number;
  /** Linux: MemAvailable must stay above this after a start (headroom for non-runly work). */
  reserveBytes: number;
  /**
   * Linux with PSI: a start waits while runnable work stalled on the CPU at
   * least this percent of the time over both the last 10 s and the last 60 s
   * (`/proc/pressure/cpu` "some"). 100 or more switches the gate off.
   */
  cpuPressure: number;
  /** Without PSI (macOS, old kernels): a start waits while the 1-minute load average exceeds this many times the core count. */
  loadPerCore: number;
  /** How long an `up` waits in the queue before it fails. */
  waitMs: number;
  /** How many requests may wait at once; the next one is refused. */
  maxQueue: number;
  /** What an undeclared service costs while running, and while building. */
  defaultRun: { memoryBytes: number; cpu: number };
  defaultBuild: { memoryBytes: number; cpu: number };
}

interface ConfigFile {
  serviceIdleMs?: number;
  tetherGraceMs?: number;
  /** A duration (`24h`, `90m`, seconds as a number) or `off`. */
  unleasedTtl?: string | number;
  templateGraceMs?: number;
  budget?: Partial<Budget> & { memory?: string | number; reserve?: string | number };
  poolMaxTotal?: number;
  sessionTtlMs?: number;
  idleTtlMs?: number;
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
 * The machine-wide cap on environment ROWS (BACKLOT_POOL_MAX_TOTAL).
 *
 * Since 0.16 (decision 0036) the load budget bounds what RUNS, so this cap
 * only bounds what is HELD — ports, data directories, database namespaces —
 * by environments that may be idle-stopped and cost nothing running:
 * 2 x cores, clamped to [4, 64] (32 on a 16-core box). With the budget
 * switched off (BACKLOT_BUDGET=off) nothing else bounds concurrent load, and
 * the pre-0.16 heuristic applies: min(cores/2, memGB/4) clamped to [2, 8].
 */
export function poolMaxHeuristic(budgetEnabled = budgetOn()): number {
  if (budgetEnabled) return Math.max(4, Math.min(64, (cpus().length || 1) * 2));
  return legacyPoolMaxHeuristic();
}

/** The pre-0.16 load-bounding heuristic, used when the budget is off. */
export function legacyPoolMaxHeuristic(): number {
  const byCores = Math.floor(cpus().length / 2);
  const byMem = Math.floor(totalmem() / (4 * 1024 ** 3));
  return Math.max(2, Math.min(8, Math.min(byCores || 1, byMem || 1)));
}

function budgetOn(): boolean {
  const v = (process.env.BACKLOT_BUDGET ?? '').trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return false;
  return configFile().budget?.enabled !== false;
}

const num = (envVar: string, fileVal: number | undefined, fallback: number): number => {
  const e = process.env[envVar];
  if (e !== undefined && e !== '') return Number(e);
  if (fileVal !== undefined) return fileVal;
  return fallback;
};

/** A duration knob: env var or config value as `24h`/`90m`/seconds, or `off` (Infinity). */
const duration = (envVar: string, fileVal: string | number | undefined, fallback: number): number => {
  const e = process.env[envVar];
  const fromEnv = e !== undefined && e !== '' ? parseDuration(e) : undefined;
  if (fromEnv !== undefined) return fromEnv;
  const fromFile = fileVal !== undefined ? parseDuration(fileVal) : undefined;
  return fromFile ?? fallback;
};

/** A size knob: env var or config value as bytes or `2G`. */
const size = (envVar: string, fileVal: string | number | undefined, fallback: number): number => {
  const e = process.env[envVar];
  if (e !== undefined && e !== '') return parseSize(e) ?? fallback;
  if (fileVal !== undefined) return parseSize(fileVal) ?? fallback;
  return fallback;
};

/** The defaults leave headroom for work that is not runly's (decision 0036). */
export function budgetPolicy(f: ConfigFile = configFile()): Budget {
  const b = f.budget ?? {};
  const total = totalmem();
  const cores = cpus().length || 1;
  const off = (process.env.BACKLOT_BUDGET ?? '').toLowerCase();
  return {
    enabled: !(off === 'off' || off === '0' || off === 'false') && b.enabled !== false,
    memoryBytes: size('BACKLOT_BUDGET_MEMORY', b.memory ?? b.memoryBytes, Math.floor(total * 0.7)),
    cpu: num('BACKLOT_BUDGET_CPU', b.cpu, cores * 1.5),
    reserveBytes: size('BACKLOT_BUDGET_RESERVE', b.reserve ?? b.reserveBytes, Math.max(2 * 1024 ** 3, Math.floor(total * 0.1))),
    // Calibrated on a 16-core box shared by ~10 agents: a load of 25-43 (the
    // old 2 x cores gate) held no-op ups for minutes while PSI "some" sat at
    // 20-40%, i.e. the CPUs still had room. 70% over 10 s AND 60 s is a box
    // that is genuinely saturated now and has been for a minute.
    cpuPressure: num('BACKLOT_BUDGET_CPU_PRESSURE', b.cpuPressure, 70),
    loadPerCore: num('BACKLOT_BUDGET_LOAD_PER_CORE', b.loadPerCore, 4),
    waitMs: num('BACKLOT_BUDGET_WAIT_MS', b.waitMs, 10 * 60_000),
    maxQueue: num('BACKLOT_BUDGET_MAX_QUEUE', b.maxQueue, 64),
    defaultRun: { memoryBytes: 512 * 1024 ** 2, cpu: 0.5 },
    defaultBuild: { memoryBytes: 1024 ** 3, cpu: 1 },
  };
}

export function policy(): Policy {
  const f = configFile();
  const idleTtlMs = num('BACKLOT_IDLE_TTL_MS', f.idleTtlMs, 30 * 60_000);
  return {
    // The machine-wide ceiling: the heuristic is derived from this host's cores
    // and memory, so it is a budget for the host, not per project. (There is no
    // per-stack ceiling: a worktree has exactly one environment, decision 0032.)
    // Raise it deliberately if the host can take it.
    poolMaxTotal: num('BACKLOT_POOL_MAX_TOTAL', f.poolMaxTotal, poolMaxHeuristic()),
    // There is no data-only ceiling any more (decision 0034): a database
    // without an application is a `runly db` copy, which is not an
    // environment and answers to no pool cap. BACKLOT_POOL_MAX_DATA_ONLY and
    // `poolMaxDataOnly` are ignored.
    sessionTtlMs: num('BACKLOT_LEASE_TTL_MS', f.sessionTtlMs, 30 * 60_000),
    idleTtlMs,
    waitMs: num('BACKLOT_WAIT_MS', f.waitMs, 60_000),
    // One rotation per file (decision 0038): a service keeps up to twice this.
    logCapBytes: num('BACKLOT_LOG_CAP_BYTES', f.logCapBytes, 20 * 1024 * 1024),
    // Per stack/datastore/preset now (decision 0037), not per stack: the
    // newest template of each, plus every one an environment or copy uses.
    templatesKeep: num('BACKLOT_TEMPLATES_KEEP', f.templatesKeep, 1),
    templateGraceMs: num('BACKLOT_TEMPLATE_GRACE_MS', f.templateGraceMs, 60 * 60_000),
    serviceIdleMs: num('BACKLOT_SERVICE_IDLE_MS', f.serviceIdleMs, 10 * 60_000),
    tetherGraceMs: num('BACKLOT_TETHER_GRACE_MS', f.tetherGraceMs, 60_000),
    unleasedTtlMs: duration('BACKLOT_UNLEASED_TTL', f.unleasedTtl, 24 * 3_600_000),
    budget: budgetPolicy(f),
  };
}

/**
 * The server-wide load budget (decision 0036).
 *
 * Every `up` (and every start on demand) states what it needs before it
 * builds or starts anything: the run resources of each service and appliance
 * it will start, plus its builds — those of one dependency wave run at once, so
 * the costliest wave's SUM is what is held, and only while it builds. A start's
 * share is handed back as each service starts (from then on the running service
 * itself is counted). The budget admits it when
 *
 *   - what runly has committed (running services' and in-flight builds'
 *     declared resources, across every stack this daemon serves) plus the
 *     need fits under the memory and cpu budget, and
 *   - on Linux, MemAvailable minus the need stays above the reserve (work
 *     that is not runly's — another daemon, a human's IDE), and
 *   - the CPU is not saturated: on Linux with PSI, `/proc/pressure/cpu`
 *     "some" is below `cpuPressure` percent over BOTH the last 10 s and the
 *     last 60 s (a sustained stall, not a spike that is already over);
 *     elsewhere the 1-minute load average is below `loadPerCore` x cores. A
 *     wake of a service that ran recently skips this gate (the memory gates
 *     still apply): it resumes what the box already carried.
 *
 * Otherwise the request queues, FIFO, with its position and an estimate, for
 * at most `waitMs`, and then fails with what it waited for. A need of nothing
 * (every build skipped, nothing to start) never queues. A need that can never
 * fit (bigger than the whole budget) fails at once. Idle-stopped services
 * release their share by no longer running. A refusal is a BudgetRefusal: the
 * environment did not fail, so it never counts toward hygiene escalation.
 */
import { readFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import type { ResourceSpec } from '../core/manifest.js';
import type { Budget } from '../core/policy.js';
import { BrokerError } from '../core/util.js';
import { formatDuration, formatSize, parseSize } from '../core/units.js';

export interface Cost {
  memoryBytes: number;
  cpu: number;
  /** False when the manifest did not say and a default was assumed. */
  declared: boolean;
}

/** What a service or appliance costs running and building — declared, or the conservative default. */
export function costsOf(spec: ResourceSpec | undefined, budget: Budget): { run: Cost; build: Cost } {
  const runMem = parseSize(spec?.memory);
  const buildMem = parseSize(spec?.build?.memory);
  return {
    run: {
      memoryBytes: runMem ?? budget.defaultRun.memoryBytes,
      cpu: spec?.cpu ?? budget.defaultRun.cpu,
      declared: runMem !== undefined && spec?.cpu !== undefined,
    },
    build: {
      memoryBytes: buildMem ?? budget.defaultBuild.memoryBytes,
      cpu: spec?.build?.cpu ?? budget.defaultBuild.cpu,
      declared: buildMem !== undefined && spec?.build?.cpu !== undefined,
    },
  };
}

export interface NeedItem {
  kind: 'build' | 'start' | 'appliance';
  name: string;
  cost: Cost;
  /** A build that will not run (its `when:` inputs are unchanged): listed, costs nothing. */
  skipped?: string;
  /** Builds sharing a wave run at once and their costs add up; a build without one runs alone. */
  wave?: number;
}

/**
 * The budget refused (it can never fit, its queue is full, the wait ran out,
 * or the caller went away). Nothing about the environment failed, so a bind
 * refused this way must not count toward the hygiene escalation (decision 0007).
 */
export class BudgetRefusal extends BrokerError {}

export interface Need {
  items: NeedItem[];
  /** Run resources of everything started — held for the whole operation. */
  start: { memoryBytes: number; cpu: number };
  /** The costliest build wave (builds of one wave run at once, so their costs add up) — held only while building. */
  build: { memoryBytes: number; cpu: number };
}

export function needOf(items: NeedItem[]): Need {
  const start = { memoryBytes: 0, cpu: 0 };
  const waves = new Map<string, { memoryBytes: number; cpu: number }>();
  items.forEach((it, i) => {
    if (it.skipped) return;
    if (it.kind === 'build') {
      const key = it.wave === undefined ? `solo:${i}` : `wave:${it.wave}`;
      const w = waves.get(key) ?? { memoryBytes: 0, cpu: 0 };
      w.memoryBytes += it.cost.memoryBytes;
      w.cpu += it.cost.cpu;
      waves.set(key, w);
    } else {
      start.memoryBytes += it.cost.memoryBytes;
      start.cpu += it.cost.cpu;
    }
  });
  const build = { memoryBytes: 0, cpu: 0 };
  for (const w of waves.values()) {
    build.memoryBytes = Math.max(build.memoryBytes, w.memoryBytes);
    build.cpu = Math.max(build.cpu, w.cpu);
  }
  return { items, start, build };
}

export const total = (n: Need) => ({ memoryBytes: n.start.memoryBytes + n.build.memoryBytes, cpu: n.start.cpu + n.build.cpu });

export interface Committed {
  memoryBytes: number;
  cpu: number;
  /** One line per contributor, for a refusal or `runly plan`. */
  items: Array<{ what: string; memoryBytes: number; cpu: number }>;
}

export interface Machine {
  totalBytes: number;
  /** Linux MemAvailable; null where the platform has no honest equivalent (macOS). */
  availableBytes: number | null;
  load1: number;
  cores: number;
  /** Linux PSI `/proc/pressure/cpu` "some" (percent of time a runnable task waited); null where absent. */
  cpuPressure?: { avg10: number; avg60: number } | null;
}

/** Linux pressure stall information for the CPU, or null (no PSI: macOS, an old kernel, a container without it). */
export function readCpuPressure(): { avg10: number; avg60: number } | null {
  if (process.platform !== 'linux') return null;
  try {
    const line = readFileSync('/proc/pressure/cpu', 'utf8').split('\n').find((l) => l.startsWith('some '));
    const avg10 = Number(/avg10=([\d.]+)/.exec(line ?? '')?.[1]);
    const avg60 = Number(/avg60=([\d.]+)/.exec(line ?? '')?.[1]);
    return Number.isFinite(avg10) && Number.isFinite(avg60) ? { avg10, avg60 } : null;
  } catch {
    return null;
  }
}

export function readMachine(): Machine {
  let availableBytes: number | null = null;
  if (process.platform === 'linux') {
    try {
      const kb = /MemAvailable:\s+(\d+)\s+kB/.exec(readFileSync('/proc/meminfo', 'utf8'))?.[1];
      if (kb !== undefined) availableBytes = Number(kb) * 1024;
    } catch {
      /* unreadable: the accounting half still applies */
    }
  }
  return { totalBytes: totalmem(), availableBytes, load1: loadavg()[0] ?? 0, cores: cpus().length || 1, cpuPressure: readCpuPressure() };
}

export interface Verdict {
  fits: boolean;
  /** Can never fit, whatever is released. */
  impossible?: string;
  /** What it would wait for. */
  waitFor?: string;
  committed: Committed;
  machine: Machine;
  budget: Budget;
}

/** One in-flight admission: its start part until released, its build part until the build phase ends. */
export class Reservation {
  constructor(
    readonly id: number,
    readonly label: string,
    public start: { memoryBytes: number; cpu: number },
    public build: { memoryBytes: number; cpu: number },
    private readonly onRelease: (r: Reservation) => void,
  ) {}
  released = false;
  readonly admittedAt = Date.now();

  /** The build phase is over: its share goes back. */
  releaseBuild(): void {
    this.build = { memoryBytes: 0, cpu: 0 };
  }

  /**
   * One of the services this reservation starts is now running, and is
   * counted as such (decision 0036): its share leaves the reservation, or
   * `ps` and every other admission saw it twice until the whole bind ended.
   */
  consume(cost: { memoryBytes: number; cpu: number }): void {
    this.start = {
      memoryBytes: Math.max(0, this.start.memoryBytes - cost.memoryBytes),
      cpu: Math.max(0, this.start.cpu - cost.cpu),
    };
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.onRelease(this);
  }
}

export class LoadBudget {
  private reservations = new Map<number, Reservation>();
  private queue: Array<{ ticket: number; label: string }> = [];
  private ticket = 0;
  /** A moving estimate of how long an admission is held, for the queue ETA. */
  private holdMs = 60_000;

  constructor(
    private readonly policy: () => Budget,
    private readonly committedRunning: () => Committed,
    private readonly machine: () => Machine = readMachine,
  ) {}

  /** Running services plus every in-flight reservation. */
  committed(): Committed {
    const base = this.committedRunning();
    const items = [...base.items];
    let memoryBytes = base.memoryBytes;
    let cpu = base.cpu;
    for (const r of this.reservations.values()) {
      const m = r.start.memoryBytes + r.build.memoryBytes;
      const c = r.start.cpu + r.build.cpu;
      if (m === 0 && c === 0) continue;
      memoryBytes += m;
      cpu += c;
      items.push({ what: `in flight: ${r.label}`, memoryBytes: m, cpu: c });
    }
    return { memoryBytes, cpu, items };
  }

  /** Would `need` be admitted right now (ignoring the queue)? `skipLoadGate`: a wake of a recently running service. */
  check(need: Need, opts: { skipLoadGate?: boolean } = {}): Verdict {
    const budget = this.policy();
    const committed = this.committed();
    const machine = this.machine();
    const want = total(need);
    if (!budget.enabled || (want.memoryBytes === 0 && want.cpu === 0)) return { fits: true, committed, machine, budget };
    if (want.memoryBytes > budget.memoryBytes) {
      return { fits: false, impossible: `it needs ${formatSize(want.memoryBytes)} of memory and the whole budget is ${formatSize(budget.memoryBytes)} (BACKLOT_BUDGET_MEMORY)`, committed, machine, budget };
    }
    if (want.cpu > budget.cpu) {
      return { fits: false, impossible: `it needs ${want.cpu} cpu and the whole budget is ${budget.cpu} (BACKLOT_BUDGET_CPU)`, committed, machine, budget };
    }
    const reasons: string[] = [];
    if (committed.memoryBytes + want.memoryBytes > budget.memoryBytes) {
      reasons.push(`memory: needs ${formatSize(want.memoryBytes)}, the budget has ${formatSize(Math.max(0, budget.memoryBytes - committed.memoryBytes))} of ${formatSize(budget.memoryBytes)} free (runly has committed ${formatSize(committed.memoryBytes)})`);
    }
    if (committed.cpu + want.cpu > budget.cpu) {
      reasons.push(`cpu: needs ${round(want.cpu)}, the budget has ${round(Math.max(0, budget.cpu - committed.cpu))} of ${round(budget.cpu)} free`);
    }
    if (machine.availableBytes !== null && machine.availableBytes - want.memoryBytes < budget.reserveBytes) {
      reasons.push(`free memory: the box has ${formatSize(machine.availableBytes)} available and keeps ${formatSize(budget.reserveBytes)} in reserve (BACKLOT_BUDGET_RESERVE)`);
    }
    if (!opts.skipLoadGate) {
      const psi = machine.cpuPressure ?? null;
      if (psi) {
        // PSI says what load average only hints at: how much of the time
        // runnable work actually WAITED for a CPU. Both windows must be over
        // the threshold, so a spike that is already over does not hold anyone.
        if (budget.cpuPressure < 100 && psi.avg10 >= budget.cpuPressure && psi.avg60 >= budget.cpuPressure) {
          reasons.push(`cpu pressure: runnable work waited ${psi.avg10.toFixed(0)}% of the last 10s and ${psi.avg60.toFixed(0)}% of the last minute (limit ${budget.cpuPressure}%, BACKLOT_BUDGET_CPU_PRESSURE)`);
        }
      } else if (machine.load1 > budget.loadPerCore * machine.cores) {
        reasons.push(`load: ${machine.load1.toFixed(1)} on ${machine.cores} cores is above ${budget.loadPerCore} per core (BACKLOT_BUDGET_LOAD_PER_CORE)`);
      }
    }
    return { fits: reasons.length === 0, waitFor: reasons.join('; ') || undefined, committed, machine, budget };
  }

  /** Queue position (1-based) of a label, for `runly plan`. */
  queueLength(): number {
    return this.queue.length;
  }

  /**
   * Wait until `need` fits and it is this request's turn; returns the
   * reservation, which the caller MUST release. Fails clearly when the need
   * can never fit, the queue is full, or the wait runs out.
   */
  async admit(
    need: Need,
    label: string,
    opts: {
      onWait?: (position: number, etaMs: number, waitFor: string) => void;
      waitMs?: number;
      source?: string;
      /** The caller went away: a queued request is dropped instead of binding for nobody. */
      signal?: AbortSignal;
      /** A wake of a service that ran recently: the CPU gate is skipped, memory still applies. */
      skipLoadGate?: boolean;
    } = {},
  ): Promise<Reservation> {
    const budget = this.policy();
    const source = opts.source ?? 'budget';
    const gone = () => new BudgetRefusal('env-error', `'${label}' was dropped from the load budget's queue: its caller disconnected`, source);
    if (opts.signal?.aborted) throw gone();
    const want = total(need);
    // Nothing to build or start costs nothing: it never waits behind anyone.
    if (want.memoryBytes === 0 && want.cpu === 0) return this.reserve(need, label);
    const first = this.check(need, opts);
    if (first.impossible) {
      throw new BudgetRefusal('env-error', `the load budget can never admit '${label}': ${first.impossible}. Declare smaller resources: in the manifest or raise the budget (decision 0036)`, source);
    }
    if (this.queue.length === 0 && first.fits) return this.reserve(need, label);
    if (this.queue.length >= budget.maxQueue) {
      throw new BudgetRefusal('env-error', `the load budget's queue is full (${this.queue.length} waiting, BACKLOT_BUDGET_MAX_QUEUE) — '${label}' was not queued; retry later`, source);
    }
    const ticket = ++this.ticket;
    this.queue.push({ ticket, label });
    const started = Date.now();
    const limit = opts.waitMs ?? budget.waitMs;
    let lastBeat = 0;
    try {
      for (;;) {
        if (opts.signal?.aborted) throw gone();
        const position = this.queue.findIndex((q) => q.ticket === ticket) + 1;
        const verdict = this.check(need, opts);
        if (position === 1 && verdict.fits) return this.reserve(need, label);
        const waitFor = position > 1 ? `${position - 1} request(s) ahead in the queue${verdict.waitFor ? `; ${verdict.waitFor}` : ''}` : (verdict.waitFor ?? 'its turn');
        if (Date.now() - started > limit) {
          throw new BudgetRefusal(
            'env-error',
            `waited ${formatDuration(Date.now() - started)} for the load budget and '${label}' still does not fit — ${waitFor}. ` +
              `Stop what you do not need ('runly down', 'runly ps --all' shows what runs), or raise the budget (BACKLOT_BUDGET_MEMORY, BACKLOT_BUDGET_CPU; decision 0036)`,
            source,
          );
        }
        if (opts.onWait && Date.now() - lastBeat >= 1000) {
          lastBeat = Date.now();
          opts.onWait(position, Math.max(1000, position * this.holdMs - (Date.now() - started)), waitFor);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      this.queue = this.queue.filter((q) => q.ticket !== ticket);
    }
  }

  private reserve(need: Need, label: string): Reservation {
    const r = new Reservation(++this.ticket, label, { ...need.start }, { ...need.build }, (done) => {
      this.reservations.delete(done.id);
      this.holdMs = Math.round(this.holdMs * 0.7 + (Date.now() - done.admittedAt) * 0.3);
    });
    this.reservations.set(r.id, r);
    return r;
  }
}

const round = (n: number) => Math.round(n * 10) / 10;

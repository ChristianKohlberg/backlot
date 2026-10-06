/**
 * The engine: pool + lease + bind + run orchestration, owning all policy
 * (drivers own transport/storage; the manifest owns repo knowledge).
 */
import { mkdirSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Journal, JOURNAL_SCHEMA_VERSION, type DbCopyRow, type DropRecipe, type EnvRow, type LeaseRow } from '../core/journal.js';
import { BUILD, VERSION, compareVersions, versionSkew } from '../core/version.js';
import { buildOf, canonicalDirectory, envDatastoreNames, outputsOf, stackIdentity, retiredStackIdentity, loadStack, normalizeLogins, manifestFileOf, type Manifest, type ServiceSpec, type Stack } from '../core/manifest.js';
import { snapshotOutputs } from '../core/worktree.js';
import { forgetNamespace, recordedNamespaces } from '../core/namespaces.js';
import { runlyEnvVars } from '../core/env-vars.js';
import { buildInputsKey, buildIsCurrent, clearBuilds, everBuilt, forgetBuild, recordBuild } from '../core/builds.js';
import { LogWriter, UPKEEP_LOG, beginBuildLog, buildLogOf, logFileOf, readLog } from '../core/logs.js';
import { formatDuration, parseDuration } from '../core/units.js';
import { BudgetRefusal, LoadBudget, costsOf, needOf, total, type Committed, type Need, type NeedItem, type Reservation } from './budget.js';
import { clearTreeLedger, pickEnvKeys, pickTreeKeys, readTreeLedger, worktreeStateDir, writeTreeLedger } from '../core/tree-ledger.js';
import { defaultPresetFor, presetToRestore, validatePresetRequest } from '../core/presets.js';
import { runUpkeep, templateBakeKeys, triggerSet, type UpkeepStep } from '../core/upkeep.js';
import { allocateInBlock, blockConflicts, ephemeralRange, inBlock, internalBlock, publicBlock, tunnelBlock } from '../core/ports.js';
import { HOLD_MS, PortInUse, ProxyHub } from './proxy.js';
import { connect as netConnect } from 'node:net';
import { dbCopiesRoot, envsRoot, stateRoot, templatesRoot, retiredTemplatesRoot, worktreesRoot } from '../core/paths.js';
import { BrokerError, template, templateEnv, now, sha256, shortId } from '../core/util.js';
import { callerEnvSpec, requireCallerEnv, selectCallerEnv, serviceCallerEnv, validateCallerEnv } from '../core/caller-env.js';
import { cmdTimeoutS, runBounded, runBoundedIO, LONG_CMD_TIMEOUT_S } from '../core/exec.js';
import { makeDatastore, parseBakedMarker, retireBakedTemplates, withBakeLock, tryWithBakeLock, type DsHandle } from '../drivers/datastores.js';
import { ensureAppliance, stopAppliance, probeTcp } from '../drivers/appliances.js';
import { DEFAULT_PREVIEW_PUBLISHER, resolvePreviewPublisher } from '../drivers/preview.js';
import { EnvSupervisor, killGroupVerified, killPidVerified, reapPids, mergeServicePids, serviceGroups, type ServiceExit } from './supervisor.js';
import { groupAlive, isAlive, processGroup, procScanSupported, sameProcess, scanByCwd, scanDbCopy, scanTagged, serviceTag, startTime, type TaggedProc } from '../core/procscan.js';
import { policy } from '../core/policy.js';
import { kernelSleepGap, readKernelSleepRecord } from '../core/sleep.js';
import { retentionSweep, templateRefs } from '../core/retention.js';
import { logEvent, recentEvents } from '../core/events.js';
import { BindTrace, type BindDiagnostics } from '../core/diagnostics.js';
import type { Hygiene, LeaseKind, ServicePid } from '../core/types.js';

const POOL_MAX_TOTAL = () => policy().poolMaxTotal;
/** A service the manifest declares (callers pass names taken from it). */
const serviceOf = (stack: Stack, name: string): ServiceSpec => {
  const spec = stack.manifest.services[name];
  if (!spec) throw new BrokerError('work-error', `no service '${name}' in ${manifestFileOf(stack)}`, 'manifest');
  return spec;
};
const LEASE_TTL = () => policy().sessionTtlMs;
const IDLE_TTL = () => policy().idleTtlMs;
/** A wake within this long of the service's idle stop skips the budget's CPU gate (decision 0036). */
const RECENT_RUN_MS = 60 * 60_000;
const WAIT_MS = () => policy().waitMs;
/** How long a service may sit idle (decision 0035): its manifest `idle:`, else the policy default. */
const serviceIdleMs = (spec: ServiceSpec | undefined): number => parseDuration(spec?.idle) ?? policy().serviceIdleMs;

/** Streamed bind phases → human progress on stderr (never on the --json stdout). */
export type Progress = (phase: string) => void;

/** What one claim attempt found: an environment to bind, or nothing (capacity, or not this caller's turn). */
type ClaimOutcome = { env: EnvRow; fresh: boolean } | null;

/** The answer to `up --data-only` from any client that still sends it (the CLI exits 64 before the daemon). */
export const DATA_ONLY_REMOVED =
  `'up --data-only' was removed (decision 0034): a database without an environment is 'runly db new <datastore>' ` +
  `(or 'runly db with <datastore> -- <cmd>', which drops it when the command exits); an environment with no services running is 'runly down'`;

export interface UpOptions {
  /**
   * Datastores to RELOAD from their template, each with the preset to load
   * (decision 0034). A datastore not named here keeps whatever it holds.
   */
  presets?: unknown;
  cwd: string;
  /** Explicit refresh envelope; absent means retain this lease's in-memory inputs. */
  callerEnv?: unknown;
  holder?: string;
  hygiene?: Hygiene;
  kind?: LeaseKind;
  ttlMs?: number;
  /**
   * Services to START, plus their transitive depends_on closure — ADDED to
   * what the environment already runs (decision 0034: `up` is additive and
   * never stops a running service). Empty or omitted is the manifest's default
   * set, which is every service. (Only the internal reset-data rebind adds
   * nothing; it does not come through `up`.)
   */
  services?: string[];
  /** Removed by decision 0034; a request that still sets it is refused with DATA_ONLY_REMOVED. */
  dataOnly?: boolean;
  /** Run every build, also those whose `when:` inputs are unchanged (decision 0038). */
  rebuild?: boolean;
  /**
   * The CALLER's process, so its lease can be released when it dies.
   * The CLI exits per invocation, so this must be the long-lived agent's pid —
   * supplied via --holder-pid or BACKLOT_HOLDER_PID.
   */
  holderPid?: number;
  /** Set by the daemon per-request; emits progress frames back to the client. */
  onProgress?: Progress;
  /**
   * Aborted when the requesting client disconnects (the daemon wires it to
   * the response's close). A queued `up` whose caller is gone gives up
   * instead of binding for nobody.
   */
  signal?: AbortSignal;
}

/** The caller of a queued request disconnected (not a bind failure). */
class CallerGone extends BrokerError {}

/**
 * Pin a lease to a live process, when the caller names one.
 *
 * The default holder is a worktree PATH, and nothing about a path can die — so
 * an agent that crashed kept its environment until the TTL expired. A pid plus
 * its start time can be checked cheaply and survives pid reuse.
 */
function holderIdentity(pid?: number): { holderPid?: number; holderStart?: number } {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return {};
  return { holderPid: pid, holderStart: startTime(pid) };
}

/** Does anything accept a TCP connection on this loopback port? (A relaunched service is listening again.) */
function acceptsOn(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ port, host, timeout: 500 });
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    const fail = () => {
      sock.destroy();
      resolve(false);
    };
    sock.once('error', fail);
    sock.once('timeout', fail);
  });
}

/** "crash-looped (last exit 3)" — how a service runly gave up on ended, for events, ps and errors. */
function describeExit(exit: ServiceExit): string {
  const last = exit.signal ? `signal ${exit.signal}` : exit.code === null ? 'no process' : `exit ${exit.code}`;
  if (exit.reason === 'daemonized') return `exited 0 at once — a service must stay in the foreground (last ${last})`;
  if (exit.reason === 'spawn-failed') return 'could not be spawned after 3 attempts';
  return `crash-looped past its restart budget (last ${last})`;
}

export class Engine {
  constructor(private readonly reapServiceGroup: typeof killGroupVerified = killGroupVerified) {
    // Start on demand (decision 0035): a connection to a stopped, wanted
    // service's public port starts it; the proxy holds the connection meanwhile.
    this.proxy.setWakeHook((envId, key) => this.requestWake(envId, key));
    // Client bytes are activity (decision 0035) — a clock per port, persisted throttled.
    this.proxy.setActivityHook((envId, key) => this.noteActivity(envId, key));
  }

  readonly journal = new Journal();
  /** The L4 proxy holding every environment's public ports (decision 0033). */
  readonly proxy = new ProxyHub();
  private supervisors = new Map<string, EnvSupervisor>();
  private lastSweep = now();
  private lastRetention = now();
  private lastGc = now();
  private lastSweepMono = performance.now();
  /** waketime (epoch ms) of the last kernel-recorded sleep already pardoned. */
  private lastPardonedWake = 0;
  /** FIFO tickets for capacity waiters, so an early waiter is not starved.
   * PER STACK: capacity is per-stack, so one queue for the whole engine made
   * a waiter on full stack A block stack B's instantly-satisfiable claim. */
  private waitTicket = 0;
  private waiting = new Map<string, number[]>();

  // -------- concurrency: a short pool lock for claim/release bookkeeping and
  // one lock per environment for bind/exec/reset. Two environments (or two
  // stacks) proceed in parallel; one environment is never mutated twice at once.
  private poolChain: Promise<unknown> = Promise.resolve();
  private envChains = new Map<string, Promise<unknown>>();
  /**
   * One lock per WORKTREE (keyed by stack id), held around everything runly
   * writes into it: upkeep rules, builds, and a pristine bind clearing the
   * worktree ledger (decision 0032). A worktree has one environment, but
   * `runly warm` runs there with none — and before the first bind creates it —
   * so the environment lock alone cannot serialize them. Ordering rule: an
   * environment lock is always taken BEFORE this one, never after — `warm`
   * takes the environment lock(s) of its stack first, so no cycle exists.
   */
  private treeChains = new Map<string, Promise<unknown>>();
  /** Envs with an operation in flight — the sweeper must not expire/quiesce these. */
  readonly busy = new Set<string>();
  /** What is in flight on a busy env, so a deferral can name it. */
  private busyOp = new Map<string, string>();
  /** Never persisted or returned. Lease IDs prevent reuse from inheriting another caller's inputs. */
  private leaseInputs = new Map<string, { values: Record<string, string>; revision: string }>();
  /** Opaque in-memory revisions only; no secret values or hashes in the journal. */
  private appliedInputs = new Map<string, string>();
  private appliedInputSpecs = new Map<string, string>();
  // Memory-only successful-bind configuration: a hot-reload refresh keeps the
  // services, so it cannot apply startup env/commands or other manifest configuration.
  private appliedManifests = new Map<string, string>();
  private inputRevision = 0;

  // -------- lifecycle (decision 0035)
  /** Unsaved proxy activity per env, by port key; flushed throttled and by the sweeper. */
  private activityDirty = new Map<string, Record<string, number>>();
  private activityFlushedAt = new Map<string, number>();
  /** When each running service process was started — a fresh start is activity. */
  private startedAt = new Map<string, number>();
  /** Services stopped for idleness (ps shows them as `idle`). */
  private idleStopped = new Set<string>();
  /**
   * Services of a LEASED environment that crash-looped and were stopped
   * (decision 0039), by env + service: `ps` and `ctx` show them as `failed`
   * with how they ended; a wake skips them; the next `up` starts them again.
   */
  private failedServices = new Map<string, ServiceExit & { at: number }>();
  /** In-flight wakes, by env + service, so a burst of connections starts a service once. */
  private waking = new Map<string, Promise<void>>();
  /** First time a tether was seen dead; it is believed only after the grace. */
  private goneSince = new Map<string, number>();
  /** The manifest each environment's running services were started from (budget accounting). */
  private envManifests = new Map<string, Manifest>();
  /** Appliances runly started in this daemon life, by probe address (budget accounting); pruned when one stops. */
  private startedAppliances = new Map<string, { name: string; cost: { memoryBytes: number; cpu: number } }>();
  /** When each idle-stopped service stopped: a wake soon after skips the CPU gate (decision 0036). */
  private idleStoppedAt = new Map<string, number>();
  /** A sweep is running: the next tick is skipped rather than overlapping it. */
  private sweeping = false;
  /** shutdown() has begun: no sweep, no wake, nothing new. */
  stopping = false;

  /** The server-wide load budget (decision 0036). */
  readonly budget = new LoadBudget(() => policy().budget, () => this.committedRunning());

  private poolLocked<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.poolChain.then(fn, fn);
    this.poolChain = next.catch(() => undefined);
    return next;
  }

  private envLocked<T>(envId: string, fn: () => Promise<T>, onWait?: (elapsedS: number) => void, op = 'an operation'): Promise<T> {
    const chain = this.envChains.get(envId) ?? Promise.resolve();
    // Heartbeat while queued behind another operation on this environment: a
    // blocked verb used to print its last phase and go SILENT until the lock
    // freed, so a legitimate wait was indistinguishable from a hang. A free
    // lock never emits — the closure below clears the timer before its first
    // 1s tick can fire.
    const waitStart = now();
    const beat = onWait ? setInterval(() => onWait(Math.round((now() - waitStart) / 1000)), 1000) : undefined;
    beat?.unref();
    const run = async () => {
      if (beat) clearInterval(beat);
      this.busy.add(envId);
      this.busyOp.set(envId, op);
      try {
        return await fn();
      } finally {
        this.busy.delete(envId);
        this.busyOp.delete(envId);
      }
    };
    const next = chain.then(run, run);
    this.envChains.set(envId, next.catch(() => undefined));
    return next;
  }

  private treeLocked<T>(stackId: string, fn: () => Promise<T>, onWait?: (elapsedS: number) => void): Promise<T> {
    const chain = this.treeChains.get(stackId) ?? Promise.resolve();
    const waitStart = now();
    const beat = onWait ? setInterval(() => onWait(Math.round((now() - waitStart) / 1000)), 1000) : undefined;
    beat?.unref();
    const run = () => {
      if (beat) clearInterval(beat);
      return fn();
    };
    const next = chain.then(run, run);
    this.treeChains.set(stackId, next.catch(() => undefined));
    return next;
  }

  /** Hold several environment locks at once, in a fixed (sorted) order. */
  private envsLocked<T>(envIds: string[], fn: () => Promise<T>, onWait: ((elapsedS: number) => void) | undefined, op: string): Promise<T> {
    const [first, ...rest] = [...envIds].sort();
    if (first === undefined) return fn();
    return this.envLocked(first, () => this.envsLocked(rest, fn, onWait, op), onWait, op);
  }

  /**
   * The worktree's upkeep ledger, and a committer that writes back only the
   * worktree's half of a merged fingerprint map. MUST be used inside
   * treeLocked: the read-modify-write is what the lock serializes.
   */
  private treeLedgerSession(stack: Stack) {
    let tree = pickTreeKeys(readTreeLedger(stack.id));
    return {
      get: () => tree,
      commitRules: (merged: Record<string, string>) => {
        tree = pickTreeKeys(merged);
        writeTreeLedger(stack.id, stack.root, tree);
      },
      clear: () => {
        clearTreeLedger(stack.id);
        tree = {};
      },
    };
  }

  /** Recovery (decision 0009): reap recorded PIDs from a previous daemon life; hot -> warm. */
  async recover(): Promise<void> {
    for (const env of this.journal.allEnvs()) {
      try {
        // Only migrate a proven lexical alias. Renamed manifests remain subject
        // to ordinary orphan retention; an unreadable source proves nothing and
        // is retried at every later bind and sweep boundary.
        this.adoptLegacyAliases(loadStack(env.stackRoot));
      } catch { /* leave unavailable or renamed projects unchanged */ }
    }
    for (const env of this.journal.allEnvs()) this.registerRetiredTemplates(env);
    if (existsSync(templatesRoot())) for (const retired of readdirSync(templatesRoot())) this.relocateRetiredTemplates(retired);
    let envs = 0;
    let stranded = 0;
    for (const env of this.journal.allEnvs()) {
      // Keep whatever survived the reap RECORDED. Clearing servicePids
      // unconditionally used to strand survivors permanently: supervisor()
      // vends a fresh empty supervisor after a restart, so every later
      // stopAll() for that env was a silent no-op and the process kept its
      // port until a human found it (issue #5).
      const survivors =
        Object.keys(env.servicePids).length > 0 ? await reapPids(env.servicePids) : {};
      stranded += Object.keys(survivors).length;
      // A 'recycling' env from a crashed daemon never finished teardown — finish
      // it. Persist survivors FIRST: teardownClaimed deletes the row, so a
      // process that outlived the reap would otherwise lose its only record and
      // be findable by tag alone.
      if (env.state === 'recycling') {
        if (Object.keys(survivors).length > 0) {
          env.servicePids = survivors;
          this.journal.saveEnv(env);
        }
        void this.teardownClaimed(env).catch((err) =>
          logEvent({ level: 'error', kind: 'teardown', envId: env.id, detail: `recovery teardown failed: ${String((err as Error).message ?? err)}` }),
        );
        continue;
      }
      if (env.state === 'hot' || env.state === 'degraded') env.state = 'warm';
      env.servicePids = survivors;
      // Reaping awaits real kills, so this row may have been torn down while we
      // were working. Saving a snapshot of a deleted row resurrects it.
      if (!this.journal.getEnv(env.id)) continue;
      // An older daemon projected a full copy of the worktree here. Nothing runs
      // from it any more (decision 0032) — once its processes are confirmed
      // gone, the copy is disk to give back. Its `@source` and build stamps
      // described that copy and are dropped; command rules belong to the
      // worktree's ledger, which starts empty, so they run once in place.
      const legacyTree = this.envDirs(env.id).legacyTree;
      if (Object.keys(survivors).length === 0 && existsSync(legacyTree) && this.isPrivateEnvDir(env)) {
        rmSync(legacyTree, { recursive: true, force: true });
        logEvent({ level: 'info', kind: 'retention', envId: env.id, detail: 'removed the projected source copy an older runly kept; services now run in the worktree (decision 0032)' });
      }
      env.fingerprints = pickEnvKeys(env.fingerprints);
      this.journal.saveEnv(env);
      envs++;
    }
    // Crash recovery reaps the tunnel like any other managed process. Clearing
    // records for tunnels that were ALREADY dead is not that: the kill was left
    // to poolGc, which no-ops off Linux, so a SIGKILLed daemon on macOS came
    // back, stopped the services, and left the public URL serving a dead port
    // until the lease finally lapsed. killGroupVerified is cross-platform and
    // already reports a pid that is gone (or no longer ours) as reaped.
    for (const lease of this.journal.allLeases()) {
      if (lease.previewPid) await this.stopPreviewForLease(lease);
    }
    logEvent({
      level: stranded ? 'warn' : 'info',
      kind: 'recover',
      detail: `reconciled ${envs} env(s)${stranded ? `, ${stranded} service(s) survived the reap` : ''}`,
    });
    // Data-only environments are gone (decision 0034). A leased one becomes
    // what it always was underneath — an environment whose lease wants no
    // services — so its holder keeps the lease and the data. An unleased one is
    // a test lane nobody holds any more; it is recycled, giving its datastores
    // back, rather than taking a machine-wide slot it was never charged for.
    for (const env of this.journal.allEnvs()) {
      if (!env.dataOnly || env.state === 'recycling') continue;
      env.dataOnly = false;
      env.activeServices = [];
      if (env.state === 'hot') env.state = 'warm';
      if (this.journal.leaseForEnv(env.id)) {
        this.journal.saveEnv(env);
        logEvent({ level: 'info', kind: 'migrate', envId: env.id, detail: 'a data-only environment from an older runly is now an environment with no services wanted; its lease and data are kept (decision 0034)' });
        continue;
      }
      env.state = 'recycling';
      this.journal.saveEnv(env);
      logEvent({ level: 'info', kind: 'migrate', envId: env.id, detail: 'an unleased data-only environment from an older runly is recycled (decision 0034: a database alone is a runly db copy)' });
      void this.teardownClaimed(env).catch((err) =>
        logEvent({ level: 'error', kind: 'teardown', envId: env.id, detail: `recycling a data-only environment failed: ${String((err as Error).message ?? err)}` }),
      );
    }
    // Anything the journal never knew about — the owner died before the pids
    // were ever written, or the env row is long gone — is only findable by tag.
    const gc = await this.poolGc(false);
    if (gc.reclaimed.length) {
      logEvent({ level: 'warn', kind: 'gc', detail: `reclaimed ${gc.reclaimed.length} orphaned process(es) at startup` });
    }
    // Take the public ports back (decision 0033): the proxy held them in the
    // previous daemon life and must hold them again before anyone else can.
    // Nothing runs behind them yet — recovery stopped every service — so they
    // refuse connections until the next bind. A journal from runly 0.13 has
    // ports outside the public block; those are reallocated here, once.
    for (const warning of blockConflicts()) logEvent({ level: 'warn', kind: 'proxy', detail: warning });
    for (const env of this.journal.allEnvs()) {
      if (env.state === 'recycling') continue;
      try {
        await this.ensureProxies(env);
        // The idle clocks survive the restart (decision 0035): a port's last
        // client byte is what the journal recorded, not "now", and not "never".
        for (const [key, at] of Object.entries(env.activity ?? {})) this.proxy.seedActivity(env.id, key, at);
      } catch (err) {
        logEvent({ level: 'warn', kind: 'proxy', envId: env.id, detail: `could not hold its public ports at startup (the next bind retries): ${String((err as Error).message ?? err)}` });
      }
    }
    // Database copies outlive the daemon, and so does the reason to drop one:
    // a holder that died while no daemon was looking, a worktree removed
    // meanwhile, a restore cut short by the stop. Not awaited — drops run
    // external commands, and requests should not queue behind them.
    void this.reapDbCopies().catch((err) => logEvent({ level: 'error', kind: 'db', detail: `reaping database copies at startup failed: ${String((err as Error).message ?? err)}` }));
  }

  /**
   * Reclaim runly-spawned processes that no live environment accounts for.
   *
   * A process is an orphan when it carries this state root's tag but its env
   * either no longer exists in the journal, or exists in a state that must have
   * no services running (warm/recycling). Anything belonging to a hot env, or
   * to an env with an operation in flight, is left strictly alone — a bind
   * racing the sweep must not have its dev-server shot out from under it.
   */
  async poolGc(retryRetiredTemplates = true): Promise<{ supported: boolean; reclaimed: Array<{ pid: number; envId: string; service: string }>; skipped: number }> {
    if (retryRetiredTemplates) await this.retireLegacyTemplateBatch(true);
    if (!procScanSupported()) return { supported: false, reclaimed: [], skipped: 0 };
    const tagged = scanTagged(stateRoot());
    if (tagged.length === 0) return { supported: true, reclaimed: [], skipped: 0 };

    // Snapshot which envs may legitimately own a running process right now.
    const live = new Set<string>();
    for (const env of this.journal.allEnvs()) {
      if (env.state === 'hot' || env.state === 'provisioning' || this.busy.has(env.id)) live.add(env.id);
    }
    for (const id of this.busy) live.add(id);

    // A preview tunnel recorded on a live lease is accounted for by that lease,
    // whatever heat its environment is in — a quiesced env keeps both.
    const leasedPreviews = this.leasedPreviewPids(tagged);

    const reclaimed: Array<{ pid: number; envId: string; service: string }> = [];
    let skipped = 0;
    const eligible = tagged.filter(proc => {
      if (live.has(proc.envId) || leasedPreviews.has(proc.pid)) {
        skipped++;
        return false;
      }
      return true;
    });
    for (const envId of new Set(eligible.map(proc => proc.envId))) {
      const processes = eligible.filter(proc => proc.envId === envId);
      const observedGroups = new Map(processes.map(proc => [proc.pid, processGroup(proc.pid) ?? proc.pid]));
      const env = this.journal.getEnv(envId);
      const candidates = Object.fromEntries(Object.entries(env?.servicePids ?? {}).filter(([, rec]) =>
        processes.some(proc => proc.pid === rec.pid && proc.startTime === rec.startTime)));
      const survivors = await this.reapDiscoveredProcesses(processes, candidates);
      for (const proc of processes) {
        if (!sameProcess(proc.pid, proc.startTime) && !groupAlive(observedGroups.get(proc.pid) ?? proc.pid)) {
          reclaimed.push({ pid: proc.pid, envId, service: proc.service });
        }
      }
      const fresh = this.journal.getEnv(envId);
      if (!fresh) continue;
      for (const [name, rec] of Object.entries(candidates)) {
        if (JSON.stringify(fresh.servicePids[name]) === JSON.stringify(rec)) delete fresh.servicePids[name];
      }
      fresh.servicePids = mergeServicePids(fresh.servicePids, survivors);
      for (const [name, rec] of Object.entries(env?.servicePids ?? {})) {
        if (!leasedPreviews.has(rec.pid) && JSON.stringify(fresh.servicePids[name]) === JSON.stringify(rec) &&
            !sameProcess(rec.pid, rec.startTime) && serviceGroups(rec).every(group => !groupAlive(group))) {
          delete fresh.servicePids[name];
        }
      }
      this.journal.saveEnv(fresh);
    }
    if (reclaimed.length) logEvent({ level: 'info', kind: 'gc', detail: `reclaimed ${reclaimed.length} orphaned process(es)` });
    return { supported: true, reclaimed, skipped };
  }

  // ---------------------------------------------------------------- pool

  /**
   * An environment's PRIVATE state — data dir, logs. There is no tree here any
   * more: services run in the caller's worktree (decision 0032). `legacyTree`
   * names the projection copy older daemons kept, so it can be reclaimed.
   */
  private envDirs(id: string) {
    const root = join(envsRoot(), id);
    return { root, data: join(root, 'data'), logs: join(root, 'logs'), legacyTree: join(root, 'tree') };
  }

  private async createEnv(stack: Stack): Promise<EnvRow> {
    // Monotonic, never-reused sequence — a reaped env's id can never collide
    // with a live one (the old length+1 scheme did, deterministically).
    const n = this.journal.nextEnvSeq(stack.id);
    const id = `${stack.id}-e${n}`;
    const dirs = this.envDirs(id);
    mkdirSync(dirs.data, { recursive: true });
    // Public ports come from the public block (decision 0033), excluding every
    // port any environment has recorded — a port probed free and released at
    // once could otherwise be handed to the next environment moments later.
    // The proxy listener the bind opens is what then holds it.
    const ports: Record<string, number> = {};
    for (const [, spec] of Object.entries(stack.manifest.services)) {
      if (spec.port && !(spec.port in ports)) ports[spec.port] = await this.allocPublicPort(new Set(Object.values(ports)));
    }
    const env: EnvRow = {
      id, stack: stack.id, stackRoot: stack.root, state: 'warm', root: dirs.root,
      ports, datastoreNs: {}, fingerprints: {}, presets: {},
      bindCount: 0, createdAt: now(), lastUsedAt: now(), servicePids: {}, failStreak: 0,
    };
    this.journal.saveEnv(env);
    return env;
  }

  /**
   * A public port nobody holds: inside the public block, recorded on no
   * environment row, not one this daemon listens on, and probed free (which
   * also skips a port a tunnel or another process binds on any address).
   */
  private async allocPublicPort(exclude: Set<number> = new Set()): Promise<number> {
    const taken = new Set<number>([...exclude, ...this.proxy.heldPorts()]);
    for (const e of this.journal.allEnvs()) for (const p of Object.values(e.ports)) taken.add(p);
    const block = publicBlock();
    const port = await allocateInBlock(block, taken);
    if (port === undefined) {
      throw new BrokerError('env-error', `no free public port left in ${block.lo}-${block.hi} — recycle unused environments ('runly status' lists them) or widen BACKLOT_PORT_RANGE`, 'pool');
    }
    return port;
  }

  /**
   * A fresh internal port for one start of env/key (decision 0033), reserved
   * in the proxy at once. The probe awaits, so another start can be probing
   * the same port meanwhile: the reservation is re-checked after it and taken
   * with no await in between. Released when the target goes down (a stop, a
   * failed start, a settle) or is owned by the target once it is up.
   */
  private async allocInternalPort(exclude: Set<number>, envId: string, key: string): Promise<number> {
    const block = internalBlock();
    const tried = new Set(exclude);
    for (;;) {
      const port = await allocateInBlock(block, new Set([...tried, ...this.proxy.assignedInternalPorts()]));
      if (port === undefined) {
        throw new BrokerError('env-error', `no free internal port left in ${block.lo}-${block.hi} — something else is listening there; widen BACKLOT_INTERNAL_PORT_RANGE`, 'pool');
      }
      if (this.proxy.assignedInternalPorts().has(port)) {
        tried.add(port); // reserved by a concurrent start while we probed
        continue;
      }
      this.proxy.reserveInternal(envId, key, port);
      return port;
    }
  }

  /**
   * Make the proxy hold every public port of `env` (decision 0033). Idempotent.
   *
   * A recorded port is kept whenever it can be: the whole point is that it is
   * stable. It moves only when it cannot be held — it lies outside the public
   * block (a journal from runly 0.13, whose ports came from the OS ephemeral
   * range), or another process took it while no listener held it (the daemon
   * was down). A move is saved to the journal at once and reported; returns
   * one line per moved port, empty when nothing moved.
   */
  private async ensureProxies(env: EnvRow): Promise<string[]> {
    const moved: string[] = [];
    const block = publicBlock();
    for (const [key, port] of Object.entries(env.ports)) {
      if (this.proxy.holds(env.id, key, port)) continue;
      let why: string | undefined;
      if (!inBlock(port, block)) {
        why = `outside the public block ${block.lo}-${block.hi} (allocated by an older runly)`;
      } else {
        try {
          await this.proxy.listen(env.id, key, port);
          continue;
        } catch (err) {
          if (!(err instanceof PortInUse)) throw err;
          why = 'taken by another process while runly was not holding it';
        }
      }
      let next: number | undefined;
      const tried = new Set<number>();
      for (let attempt = 0; attempt < 10 && next === undefined; attempt++) {
        const candidate = await this.allocPublicPort(tried);
        tried.add(candidate);
        try {
          await this.proxy.listen(env.id, key, candidate);
          next = candidate;
        } catch (err) {
          if (!(err instanceof PortInUse)) throw err;
        }
      }
      if (next === undefined) {
        throw new BrokerError('env-error', `could not hold a public port for '${key}' on environment ${env.id}: every candidate was taken`, 'pool');
      }
      env.ports[key] = next;
      const line = `public port for '${key}' moved ${port} → ${next}: the old one was ${why}`;
      moved.push(line);
      logEvent({ level: 'warn', kind: 'proxy', envId: env.id, detail: line });
    }
    if (moved.length > 0) {
      const live = this.journal.getEnv(env.id);
      if (live) {
        live.ports = { ...live.ports, ...env.ports };
        this.journal.saveEnv(live);
      }
    }
    return moved;
  }

  /** One atomic claim attempt — MUST run under the pool lock. */
  private async tryClaim(stack: Stack, holder: string, kind: LeaseKind, hygiene: Hygiene, ttlMs: number, holderPid?: number, onlyMine = false): Promise<ClaimOutcome> {
    // A holder keeps its env: rebinding your own lease is the normal loop —
    // unless that env is being torn down or has flapped, in which case drop the
    // stale lease and fall through to a fresh claim.
    const mine = this.journal.leaseForHolder(holder, stack.id);
    // The bypass may only refresh a LIVE lease (see acquireEnv); a lapsed one
    // belongs to whoever is queued on its expiry. In the queued path the
    // holder has reached the head of the FIFO, so re-upping its own expired
    // lease is a legitimate claim, not a resurrection.
    if (mine && !(onlyMine && mine.expiresAt <= now())) {
      const env = this.journal.getEnv(mine.envId);
      if (env && env.state !== 'recycling' && env.state !== 'degraded') {
        // The tether is the LATEST caller's: an `up` that names no holder
        // process (a human, BACKLOT_TETHER=off) clears the previous one. Kept,
        // an agent's tether outlived the hand-over, and the agent's exit then
        // tore down the environment — data and all — under the next user.
        this.journal.saveLease({ ...mine, hygiene, expiresAt: now() + ttlMs, holderPid: undefined, holderStart: undefined, ...holderIdentity(holderPid) });
        // A continuing lease keeps the services it wants: bindAndStart adds
        // the request to env.activeServices (decision 0034).
        return { env, fresh: false };
      }
      // Awaited: endLease became async when it grew a tunnel reap, and the
      // floating promise let the claim below write a SECOND lease row for this
      // same (holder, stack) while the kill was still running. leaseForHolder
      // has no ORDER BY, so every reader in that window resolved to the dead
      // row — including the run-lease cleanup, which then ended the wrong one.
      await this.endLease(mine);
    }
    // The queue-bypass path may ONLY refresh an existing lease — claiming free
    // capacity here would jump the FIFO the waiters are queued on.
    if (onlyMine) return null;
    const envs = this.journal.envsForStack(stack.id);
    const free = envs
      .filter((e) => !this.journal.leaseForEnv(e.id) && e.state !== 'degraded' && e.state !== 'recycling')
      .sort((a, b) => (a.state === 'hot' ? -1 : 1) - (b.state === 'hot' ? -1 : 1));
    let env = free[0];
    // ONE environment per worktree (decision 0032). A stack is one physical
    // worktree, and every environment of it would run its services, builds and
    // exec over the same files — a rebuild by one replacing bin/ under the
    // other's running services. So a second environment is never created: a
    // claim on a stack that already has one waits for it (acquireQueued).
    if (!env && envs.length === 0 && this.capacityBinding() === null) env = await this.createEnv(stack);
    if (env) {
      this.journal.saveLease({
        id: `l-${shortId()}`, envId: env.id, kind, holder, hygiene, expiresAt: now() + ttlMs,
        ...holderIdentity(holderPid),
      });
      // fresh: true — a NEW owner. It must not inherit a previous holder's
      // wanted services (bindAndStart starts from what is RUNNING instead), and
      // activeServices is not rewritten here: it may only change AFTER the bind
      // reconciles reality, so an early bind failure can't strand the journal
      // asserting a shape that isn't running.
      return { env, fresh: true };
    }
    return null;
  }

  /**
   * Does the machine-wide ceiling refuse a NEW environment right now? Named
   * explicitly because a refusal must quote the cap that bound (#47). There
   * is no per-stack cap (one environment per worktree, decision 0032) and no
   * data-only cap (decision 0034: a database without an application is a
   * `runly db` copy, which is not an environment). MUST run under the pool lock.
   */
  private capacityBinding(): 'machine' | null {
    return this.journal.allEnvs().length >= POOL_MAX_TOTAL() ? 'machine' : null;
  }

  /**
   * Cold, unleased environments that can be given up to free a MACHINE-WIDE
   * slot, least-recently-used first.
   *
   * Why eviction rather than just not counting them (#46's own suggestion): the
   * caps gate environment CREATION only — rebinding an existing environment is
   * never capacity-checked — so the row count is what bounds worst-case
   * concurrent load. Excluding cold rows from the count would leave nothing to
   * stop N of them being rebound hot at once. Giving the slot back for real
   * keeps the ceiling meaningful, and costs the least-recently-used environment
   * one cold provision the next time it is bound.
   *
   * Unleased + not busy + idle past IDLE_TTL qualifies. A recently released
   * environment is the warm pool doing its job, so it is never taken — if
   * nothing is that idle the caller gets a refusal naming the cap that actually
   * bound, which is still strictly better than the lockout.
   *
   * Deliberately NOT restricted to `warm`. Idle past IDLE_TTL is precisely what
   * the sweeper quiesces, but it only looks every BACKLOT_SWEEP_MS (15s by
   * default) — so an environment released and abandoned a moment ago is still
   * `hot` while already being condemned. Requiring `warm` meant that for a whole
   * sweep interval the caller was refused with "waiting will not help", when the
   * next sweep would in fact have made this environment evictable. Taking a
   * condemned `hot` environment is the same trade one step further, and
   * recycleOne stops its services through the ordinary teardown.
   */
  private evictionCandidates(): EnvRow[] {
    const floor = IDLE_TTL();
    return this.journal
      .allEnvs()
      .filter(
        (e) =>
          // 'provisioning' is mid-creation, 'recycling' is already going, and
          // 'degraded' is the sweeper's own to reap.
          (e.state === 'warm' || e.state === 'hot') &&
          !this.busy.has(e.id) &&
          !this.journal.leaseForEnv(e.id) &&
          now() - e.lastUsedAt > floor,
      )
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  }

  /**
   * Free a machine-wide slot by giving up the least-recently-used cold
   * environment. Returns the id evicted, or null if nothing qualified.
   *
   * MUST NOT hold the pool lock: recycleOne claims under it (the chain is not
   * re-entrant), and the teardown that follows deletes a tree, which the pool
   * lock must never wait on. claimForTeardown re-reads and refuses anything
   * leased or busy, so a candidate chosen here and leased in the gap is declined
   * rather than taken — never take an environment somebody else is holding (#40).
   */
  private async evictForMachineCapacity(stack: Stack): Promise<string | null> {
    const bound = await this.poolLocked(() => this.capacityBinding());
    if (bound !== 'machine') return null;
    const before = `${this.journal.allEnvs().length}/${POOL_MAX_TOTAL()}`;
    for (const cand of this.evictionCandidates()) {
      const human = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`);
      const idleFor = human(now() - cand.lastUsedAt);
      const wasState = cand.state;
      if (await this.recycleOne(cand.id, false) !== 'recycled') continue;
      logEvent({
        level: 'info',
        kind: 'pool-evict',
        envId: cand.id,
        detail:
          `evicted to free a machine-wide pool slot for stack '${stack.id}' — ` +
          `unleased and idle ${idleFor} (${wasState}, past the ${human(IDLE_TTL())} idle TTL), ` +
          `least recently used of ${this.evictionCandidates().length + 1} candidate(s); the pool held ${before}. ` +
          `Its next bind provisions cold.`,
      });
      return cand.id;
    }
    return null;
  }

  /**
   * Is some environment about to become claimable on its own?
   *
   * `busy` is the one that matters here and was missed: the idle quiesce runs
   * under the environment lock, which marks it busy, and decision 0021 keeps its
   * mid-quiesce state as plain `hot` on purpose. So the sweeper reclaiming heat
   * from the only candidate made it briefly unevictable — and the machine-wide
   * refusal, which tells the caller that waiting cannot help, fired on a
   * condition that clears in milliseconds. It reproduced on the macOS runner,
   * where teardown is slower (services get SIGTERM, then a verified SIGKILL).
   *
   * The other three are transient for the reasons the per-stack branch already
   * gives: the sweeper reaps them and frees capacity.
   */
  private transientlyUnclaimable(rows: EnvRow[]): boolean {
    return rows.some(
      (e) =>
        this.busy.has(e.id) ||
        e.state === 'degraded' ||
        e.state === 'recycling' ||
        e.state === 'provisioning',
    );
  }

  /**
   * Why this environment could not be given up, per environment.
   *
   * It used to say "too recent to evict" for every unleased row, which is the
   * defect #47 was about in miniature: a message that names one cause for four
   * different situations sends the reader after the wrong one. (It cost an hour
   * here, diagnosing a CI failure whose real cause was `busy`.)
   */
  private notEvictableBecause(e: EnvRow): string {
    const lease = this.journal.leaseForEnv(e.id);
    if (lease) return `leased by '${lease.holder}' (${lease.kind})`;
    if (this.busy.has(e.id)) return `${e.state}, an operation is in flight on it`;
    if (e.state !== 'warm' && e.state !== 'hot') return `state ${e.state}`;
    const idleMs = now() - e.lastUsedAt;
    const human = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`);
    return `${e.state}, idle ${human(idleMs)} — inside the ${human(IDLE_TTL())} idle TTL, so too recent to evict`;
  }

  /**
   * Is the pool full of environments whose leases outlast our whole wait?
   *
   * If so, queueing cannot possibly succeed, and reporting "waited 60s" blames a
   * timing problem that does not exist. MUST run under the pool lock.
   */
  private structuralCapacityBlock(stack: Stack, deadline: number): { scope: 'worktree' | 'machine'; detail: string } | null {
    const held = this.worktreeHold(stack, deadline);
    if (held !== undefined) return held === null ? null : { scope: 'worktree', detail: held };
    if (this.capacityBinding() === null) return null; // room to grow
    // The MACHINE-WIDE cap is what bound, and waiting cannot clear it: the
    // count is of env ROWS, and releasing a lease leaves the row behind. Only
    // an eviction, an orphan reap or a degraded reap ever lowers it (#47).
    const all = this.journal.allEnvs();
    if (this.transientlyUnclaimable(all) || this.evictionCandidates().length > 0) return null;
    return { scope: 'machine', detail: all.map((e) => `${e.id} (${this.notEvictableBecause(e)})`).join('; ') };
  }

  /**
   * Why this worktree's own environment cannot be claimed, if that is what is
   * in the way (decision 0032: one environment per worktree, so a second
   * holder waits for it instead of getting another).
   *
   * - `undefined`: the worktree has no environment, or it sits unleased and
   *   usable — whatever refused the claim is a capacity ceiling, not the
   *   worktree.
   * - `null`: it is in the way, but will clear by itself within the wait
   *   (a lease that lapses in time, a recycle or reap in progress).
   * - a string: it is leased past the wait window — naming who holds it.
   */
  private worktreeHold(stack: Stack, deadline: number): string | null | undefined {
    const own = this.journal.envsForStack(stack.id);
    if (own.length === 0) return undefined;
    const holders: string[] = [];
    for (const env of own) {
      if (env.state === 'degraded' || env.state === 'recycling' || env.state === 'provisioning') return null;
      const lease = this.journal.leaseForEnv(env.id);
      if (!lease) return this.busy.has(env.id) ? null : undefined;
      if (lease.expiresAt <= deadline) return null;
      holders.push(`${env.id} held by '${lease.holder}' (${lease.kind}, ${Math.round((lease.expiresAt - now()) / 60_000)}m left)`);
    }
    return holders.join('; ');
  }

  /**
   * One refusal text for both throw sites, quoting real counts and the cap that
   * actually bound.
   *
   * The old messages printed `(${POOL_MAX()}/${POOL_MAX()})` — the cap twice,
   * not a count — so a stack with ZERO environments was told "pool at capacity
   * (6/6)" and pointed at the wrong knob (#47).
   */
  private capacityRefusal(stack: Stack, scope: 'worktree' | 'machine', blocking: string | null): string {
    const counts = `the machine holds ${this.journal.allEnvs().length}/${POOL_MAX_TOTAL()} environments (BACKLOT_POOL_MAX_TOTAL)`;
    const waited = blocking === null ? ` after waiting ${Math.round(WAIT_MS() / 1000)}s` : '';
    if (scope === 'machine') {
      return (
        `pool at capacity${waited}: the MACHINE-WIDE cap is what refused — ${counts}. ` +
        `Releasing a lease will not help, because the machine-wide count is of environments, not leases: the row survives a release. ` +
        `Every environment on this box is either leased or too recently used to evict, so runly had nothing cold to give up.` +
        (blocking ? ` Holding: ${blocking}.` : '') +
        ` Raise BACKLOT_POOL_MAX_TOTAL if the host can take it, or 'runly pool recycle <env-id>' an environment you no longer need.` +
        ` A database alone needs no environment: 'runly db new <datastore>' (decision 0034).`
      );
    }
    // scope === 'worktree'
    return (
      `this worktree's environment is held by another lease${waited}` +
      (blocking ? ` past the wait window: ${blocking}` : '') +
      `. A worktree has exactly one environment (decision 0032) — ${stack.root} — so a second holder waits for it instead of getting another. ` +
      `Use the holder that owns it (--holder), release that lease, or bind from a separate worktree. ` +
      `A database for a parallel test lane needs no environment: 'runly db with <datastore> -- <cmd>' (decision 0034).`
    );
  }

  /** Queue at capacity WITHOUT holding the pool lock while sleeping. */
  private async acquireEnv(stack: Stack, holder: string, kind: LeaseKind, hygiene: Hygiene, ttlMs: number, holderPid?: number, signal?: AbortSignal): Promise<{ env: EnvRow; fresh: boolean }> {
    const start = now();
    // A holder that already holds this stack's LIVE lease consumes no
    // capacity — rebinding only re-saves it (renewing the deadline for an
    // explicit `up`, preserving it for content operations). Sending it through
    // the queue stalled the normal edit-up-retest loop behind strangers waiting for
    // expiry. Expiry is checked HERE, not just in the sweeper: a lapsed lease
    // survives in the journal until the next sweep, and refreshing that
    // corpse would jump a waiter queued on precisely its expiry. onlyMine
    // keeps the bypass honest: if the lease lapses mid-flight this claims
    // nothing and joins the queue like everyone else.
    const live = this.journal.leaseForHolder(holder, stack.id);
    if (live && live.expiresAt > now()) {
      const claimed = await this.poolLocked(() => this.tryClaim(stack, holder, kind, hygiene, ttlMs, holderPid, true));
      if (claimed !== null) return claimed;
    }
    // FIFO ticket. Without ordering, every waiter polled independently and a
    // freed environment went to whoever happened to poll first — so an early
    // waiter could time out while later arrivals were served.
    const ticket = ++this.waitTicket;
    const queue = this.waiting.get(stack.id) ?? [];
    queue.push(ticket);
    this.waiting.set(stack.id, queue);
    try {
      return await this.acquireQueued(stack, holder, kind, hygiene, ttlMs, start, ticket, holderPid, signal);
    } finally {
      const rest = (this.waiting.get(stack.id) ?? []).filter((t) => t !== ticket);
      if (rest.length > 0) this.waiting.set(stack.id, rest);
      else this.waiting.delete(stack.id);
    }
  }

  private async acquireQueued(
    stack: Stack,
    holder: string,
    kind: LeaseKind,
    hygiene: Hygiene,
    ttlMs: number,
    start: number,
    ticket: number,
    holderPid?: number,
    signal?: AbortSignal,
  ): Promise<{ env: EnvRow; fresh: boolean }> {
    for (;;) {
      // A caller that went away while queued must not claim anything.
      if (signal?.aborted) throw new CallerGone('env-error', `the caller disconnected while '${stack.manifest.name}' was queued for its environment`, 'pool');
      // Only the head of THIS STACK's queue may claim; everyone else waits.
      const queue = this.waiting.get(stack.id);
      const myTurn = !queue || queue.length === 0 || queue[0] === ticket;
      const claimed = myTurn ? await this.poolLocked(() => this.tryClaim(stack, holder, kind, hygiene, ttlMs, holderPid, false)) : null;
      if (claimed) return claimed;
      // A machine-wide block never clears by waiting — the count is of env rows,
      // and a release leaves the row behind — so a host holding as many cold
      // worktrees as the heuristic allows locked out every new stack
      // indefinitely, while nothing was running (#46). Give up the
      // least-recently-used cold environment instead and claim its slot.
      if (myTurn && (await this.evictForMachineCapacity(stack))) continue;
      // This worktree's one environment is dead (a service flapped past its
      // budget). It used to sit beside a freshly created second one until the
      // sweeper reaped it; with one environment per worktree, waiting for the
      // sweep would stall every bind here for a sweep interval. Reap it now.
      if (myTurn && (await this.reapDegradedOwn(stack))) continue;
      // Refuse to burn the full wait on something that provably cannot resolve.
      const blocked = await this.poolLocked(() => this.structuralCapacityBlock(stack, now() + WAIT_MS()));
      if (blocked) {
        throw new BrokerError('env-error', this.capacityRefusal(stack, blocked.scope, blocked.detail), 'pool');
      }
      if (now() - start > WAIT_MS()) {
        const scope = (await this.poolLocked(() => (this.worktreeHold(stack, now()) !== undefined ? 'worktree' as const : this.capacityBinding()))) ?? 'worktree';
        throw new BrokerError('env-error', this.capacityRefusal(stack, scope, null), 'pool');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ---------------------------------------------------------------- bind

  /**
   * The values `{{…}}` resolves to. Everything is PUBLIC (decision 0033): the
   * ports and URLs users, builds, exec and other services see are the proxy's.
   * The one exception is a service's own command line and env, given
   * `own = { key, port }`: there `{{ports.<own key>}}` is the INTERNAL port the
   * service must listen on. `{{public_ports.<key>}}` is always the public one,
   * for a service that has to advertise its own address.
   */
  private templateCtx(stack: Stack, env: EnvRow, own?: { key: string; port: number }) {
    const services: Record<string, { url: string }> = {};
    for (const [name, spec] of Object.entries(stack.manifest.services)) {
      if (spec.port) services[name] = { url: `http://localhost:${env.ports[spec.port]}` };
    }
    const ports = own ? { ...env.ports, [own.key]: own.port } : env.ports;
    const datastores: Record<string, { url: string; ns: string }> = {};
    const dirs = this.envDirs(env.id);
    const h: DsHandle = { envId: env.id, cwd: env.stackRoot, dataDir: dirs.data };
    for (const [name, spec] of Object.entries(stack.manifest.datastores ?? {})) {
      // A copies_only datastore (decision 0039) has no namespace in an environment.
      if (spec.copies_only === true) continue;
      const ds = makeDatastore(name, spec, stack.id);
      datastores[name] = { url: ds.url(h), ns: ds.ns(h) };
    }
    return { ports, public_ports: env.ports, services, datastores };
  }

  private supervisor(env: EnvRow): EnvSupervisor {
    let sup = this.supervisors.get(env.id);
    if (!sup) {
      const dirs = this.envDirs(env.id);
      sup = new EnvSupervisor(
        env.id, env.stackRoot, dirs.logs,
        (service, exit) => {
          const fresh = this.journal.getEnv(env.id);
          if (!fresh || fresh.state === 'recycling') return;
          // A LEASED environment is someone's work (decision 0039): the
          // service that crash-loops is stopped and reported as failed, and
          // the environment, its data, its other services and its logs stay.
          // The next `up` retries it.
          if (this.journal.leaseForEnv(env.id)) {
            this.serviceFailed(env.id, service, exit);
            return;
          }
          // Nobody holds it: the environment is degraded — skipped by acquire,
          // recycled by the sweeper (decision 0007).
          fresh.state = 'degraded';
          this.journal.saveEnv(fresh);
          logEvent({ level: 'warn', kind: 'degraded', envId: env.id, detail: `'${service}' ${describeExit(exit)} — the environment is unleased and will be recycled` });
        },
        () => {
          // A pid changed (start/restart/exit): keep the journal truthful so
          // recovery reaps the right process, not a stale/innocent pid.
          const s = this.supervisors.get(env.id);
          if (s) this.journal.updateServicePids(env.id, s.pids());
        },
        // Nothing listens behind its public port any more. A restart has
        // already marked the port `starting`, which this leaves alone, so
        // connections keep being held until the new process is ready.
        (service) => this.proxy.serviceStopped(env.id, service),
        {
          onCrashed: (service) => this.serviceCrashed(env.id, service),
          onRelaunched: (service) => {
            this.startedAt.set(`${env.id}\0${service}`, now());
            this.serviceRelaunched(env.id, service);
          },
          onGaveUp: (service) => this.serviceGaveUp(env.id, service),
        },
      );
      this.supervisors.set(env.id, sup);
    }
    return sup;
  }

  /**
   * The services a bind must bring up: the named ones plus the transitive
   * `depends_on` closure of each. An unknown name is a manifest work-error,
   * reported like the other service lookups. A depends_on cycle is tolerated
   * here (the visit is closure-guarded) and caught by the start loop's own
   * cycle check.
   */
  private resolveServiceClosure(stack: Stack, names: string[]): Set<string> {
    const all = stack.manifest.services;
    if (names.length === 0) return new Set(Object.keys(all)); // no selection = the whole app
    const closure = new Set<string>();
    const visit = (name: string) => {
      if (closure.has(name)) return;
      const spec = all[name];
      if (!spec) {
        throw new BrokerError('work-error', `no service '${name}' in ${manifestFileOf(stack)} (have: ${Object.keys(all).join(', ') || 'none'})`, 'manifest');
      }
      closure.add(name);
      for (const dep of spec.depends_on ?? []) visit(dep);
    };
    for (const n of names) visit(n);
    return closure;
  }

  /**
   * The services `env`'s lease wants up (decision 0034): `up` adds to this set
   * and `down` takes away. Undefined on the row means every declared service,
   * so a service added to the manifest later is included.
   */
  private desiredServices(stack: Stack, env: EnvRow): Set<string> {
    const declared = Object.keys(stack.manifest.services);
    if (env.activeServices === undefined) return new Set(declared);
    const kept = env.activeServices.filter((n) => n in stack.manifest.services);
    // A list whose every service has left the manifest says nothing any more;
    // it falls back to the default set rather than to none. Only an EMPTY list
    // (what `down` with no names records) means "no services".
    if (kept.length === 0 && env.activeServices.length > 0) return new Set(declared);
    return new Set(kept);
  }

  /** How a wanted set is recorded: undefined for every declared service, else the list (possibly empty). */
  private recordedShape(stack: Stack, wanted: Set<string>): string[] | undefined {
    const declared = Object.keys(stack.manifest.services);
    return declared.length > 0 && declared.every((n) => wanted.has(n)) ? undefined : [...wanted];
  }

  /**
   * The services that use datastore `ds`, read from the manifest: a service
   * uses it when its `run:`, `build:` or `env:` templates `{{datastores.<ds>.…}}`
   * — that is how a service is handed a connection string. `null` when no
   * service references it at all: then runly cannot tell who reads it (a
   * connection string in a config file, a hard-coded path), and the caller
   * must restart every running service to be safe (decision 0034).
   */
  private datastoreUsers(stack: Stack, ds: string): Set<string> | null {
    const escaped = ds.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ref = new RegExp(`\\{\\{\\s*datastores\\.${escaped}\\.`);
    const users = new Set<string>();
    for (const [name, spec] of Object.entries(stack.manifest.services)) {
      const texts = [spec.run, buildOf(spec)?.run ?? '', ...Object.values(spec.env ?? {})];
      if (texts.some((t) => ref.test(t))) users.add(name);
    }
    return users.size > 0 ? users : null;
  }

  /** The datastores an environment of `stack` provisions: all but the `copies_only` ones (decision 0039). */
  private envDatastores(stack: Stack): string[] {
    return envDatastoreNames(stack.manifest);
  }

  /** `up --preset` and `reset-data --preset` name only datastores an environment has (decision 0039). */
  private refuseCopiesOnlyPresets(stack: Stack, presets: Record<string, string>): void {
    for (const name of Object.keys(presets)) {
      if (stack.manifest.datastores?.[name]?.copies_only === true) {
        throw new BrokerError('work-error', `datastore '${name}' is copies_only in ${manifestFileOf(stack)}: an environment has none to reload — 'runly db new ${name} --preset ${presets[name]}' takes a copy`, 'manifest');
      }
    }
  }

  /**
   * Give back the namespaces of datastores an environment no longer
   * provisions — one made before its datastore became `copies_only` (decision
   * 0039) — by the drop recorded for each. A drop that fails stays on the row
   * for teardown to retry.
   */
  private async retireEnvDatastores(stack: Stack, env: EnvRow, say: Progress): Promise<void> {
    const keep = new Set(this.envDatastores(stack));
    for (const name of Object.keys(env.datastoreNs)) {
      const spec = stack.manifest.datastores?.[name];
      if (keep.has(name) || !spec || spec.copies_only !== true) continue;
      const recipe = env.dropRecipes?.[name];
      try {
        say(`dropping datastore '${name}' from this environment (copies_only)`);
        if (recipe) await this.runDropRecipe(recipe, recipe.cwd && existsSync(recipe.cwd) ? recipe.cwd : stack.root);
        else await makeDatastore(name, spec, stack.id).drop({ envId: env.id, cwd: stack.root, dataDir: this.envDirs(env.id).data });
      } catch (err) {
        logEvent({ level: 'warn', kind: 'datastore', envId: env.id, detail: `datastore '${name}' is copies_only now, but dropping its environment namespace failed (teardown retries): ${String((err as Error).message ?? err)}` });
        continue;
      }
      delete env.datastoreNs[name];
      delete env.presets[name];
      if (env.templates) delete env.templates[name];
      if (env.dropRecipes) delete env.dropRecipes[name];
      const live = this.journal.getEnv(env.id);
      if (live) {
        delete live.datastoreNs[name];
        delete live.presets[name];
        if (live.templates) delete live.templates[name];
        if (live.dropRecipes) delete live.dropRecipes[name];
        this.journal.saveEnv(live);
      }
      logEvent({ level: 'info', kind: 'datastore', envId: env.id, detail: `datastore '${name}' is copies_only: its environment namespace was dropped (decision 0039)` });
    }
  }

  /**
   * Create, keep or reload each datastore in `plan`, journalling every
   * completed restore at once so a later failure still reports the earlier
   * ones truthfully. A datastore not forced and already present is KEPT —
   * whatever it holds, even a preset the catalog no longer offers (decision
   * 0034: no preset means keep the data, never a silent reset to the default).
   */
  private async prepareDatastores(
    stack: Stack,
    env: EnvRow,
    bakeKeys: Record<string, string>,
    plan: Array<{ name: string; force: boolean; preset?: string }>,
    say: Progress,
  ): Promise<string[]> {
    const dsHandle: DsHandle = { envId: env.id, cwd: stack.root, dataDir: this.envDirs(env.id).data };
    const restored: string[] = [];
    for (const step of plan) {
      const spec = stack.manifest.datastores?.[step.name];
      if (!spec) continue;
      const ds = makeDatastore(step.name, spec, stack.id, bakeKeys[step.name]);
      await ds.probe();
      const held = env.presets[step.name];
      const exists = Boolean(env.datastoreNs[step.name]);
      const preset = step.preset ?? presetToRestore(step.name, spec, held);
      const restores = step.force || !exists;
      if (restores) say(`preparing datastore '${step.name}' (${preset})`);
      // The drop is recorded BEFORE the namespace can exist (decision 0037):
      // a teardown after a crash mid-restore, or after the worktree and its
      // manifest are gone, still knows how to give it back.
      env.dropRecipes = { ...(env.dropRecipes ?? {}), [step.name]: ds.dropRecipe(dsHandle) };
      this.journal.saveEnv({ ...(this.journal.getEnv(env.id) ?? env), dropRecipes: env.dropRecipes });
      await ds.ensure(dsHandle, preset, step.force, exists);
      env.datastoreNs[step.name] = ds.ns(dsHandle);
      // A kept store still holds what it held; only a restore changes that.
      env.presets[step.name] = restores || held === undefined ? preset : held;
      if (restores) {
        restored.push(step.name);
        const ref = ds.templateRef(preset);
        const templates = { ...(env.templates ?? {}) };
        if (ref) templates[step.name] = ref;
        else delete templates[step.name];
        env.templates = templates;
      }
      // Merge into the live row so a supervisor update is not overwritten.
      const current = this.journal.getEnv(env.id);
      if (current) {
        current.datastoreNs = { ...env.datastoreNs };
        current.presets = { ...env.presets };
        current.dropRecipes = env.dropRecipes;
        if (env.templates) current.templates = env.templates;
        this.journal.saveEnv(current);
      }
    }
    return restored;
  }

  private async bindAndStart(stack: Stack, envSnapshot: EnvRow, hygiene: Hygiene, onProgress?: Progress, requestedServices?: string[], freshClaim = false, callerEnv?: unknown, requestedPresets?: unknown, rebuild = false, signal?: AbortSignal): Promise<{ env: EnvRow; previewNotice?: string; bindDiagnostics: BindDiagnostics }> {
    const say = onProgress ?? (() => undefined);
    // The load budget (decision 0036): state what this bind builds and starts
    // BEFORE doing any of it, and wait in the server-wide queue while it does
    // not fit. The reservation's build share goes back after the build phase.
    const live = this.journal.getEnv(envSnapshot.id) ?? envSnapshot;
    const running = new Set(Object.keys(this.supervisor(live).pids()));
    const base = freshClaim ? running : new Set([...this.desiredServices(stack, live), ...running]);
    const added = requestedServices === undefined ? new Set<string>() : this.resolveServiceClosure(stack, requestedServices);
    const active = new Set([...base, ...added].filter((n) => n in stack.manifest.services));
    const need = await this.needFor(stack, live, new Set([...active].filter((n) => !running.has(n))), active, { rebuild: rebuild || hygiene === 'pristine', mode: 'bind' });
    const reservation = await this.budget.admit(need, `up ${stack.manifest.name} (${live.id})`, {
      onWait: (position, etaMs, why) => say(`waiting for the load budget: position ${position}, about ${formatDuration(etaMs)} — ${why}`),
      source: 'budget',
      signal,
    });
    try {
      return await this.bindAndStartInner(stack, envSnapshot, hygiene, onProgress, requestedServices, freshClaim, callerEnv, requestedPresets, rebuild, reservation);
    } finally {
      reservation.release();
      // A public port marked `starting` whose service never became ready (a
      // failed build, a boot timeout) must not keep holding connections until
      // they time out: they are closed, as a client found it before the proxy.
      this.proxy.settle(envSnapshot.id);
    }
  }

  private async bindAndStartInner(stack: Stack, envSnapshot: EnvRow, hygiene: Hygiene, onProgress: Progress | undefined, requestedServices: string[] | undefined, freshClaim: boolean, callerEnv: unknown, requestedPresets: unknown, rebuild: boolean, reservation: Reservation): Promise<{ env: EnvRow; previewNotice?: string; bindDiagnostics: BindDiagnostics }> {
    const say = onProgress ?? (() => undefined);
    const trace = new BindTrace();
    // Re-read under the env lock: the snapshot captured during acquire may be
    // stale (a concurrent degrade/pid update landed). Everything below mutates
    // and saves THIS fresh row, so no epilogue can clobber another verb's write.
    const env = this.journal.getEnv(envSnapshot.id) ?? envSnapshot;
    if (env.state === 'recycling') {
      throw new BrokerError('env-error', `environment ${env.id} is being recycled — retry`, 'pool');
    }
    // The kill switch depends on the MANIFEST alone, which has already been
    // re-read — so it acts here, before anything else can fail. A stack that
    // forbids preview must not stay published because a bind's ready probe
    // timed out. Every other reason to invalidate a tunnel depends on what this
    // bind commits, and is reconciled at the epilogue instead.
    const forbiddenNotice = await this.enforcePreviewForbidden(env, stack, say);
    if (!this.journal.leaseForEnv(env.id)) throw new BrokerError('env-error', 'lease ended before bind; run runly up again', 'lease');
    // Only the datastores the caller NAMED are reloaded; every other one keeps
    // what it holds (decision 0034).
    const reloadPresets = validatePresetRequest(stack.manifest, requestedPresets, stack.file);
    // Which services this bind leaves running (decision 0034: `up` is
    // ADDITIVE). It never stops a running service, so the base is everything
    // running now; a continuing lease also brings back what it wants and is
    // not running (after a quiesce or a daemon restart). A FRESH claim does
    // not inherit the previous holder's wishes — only what still runs. The
    // request adds the named services and their depends_on closure ([] = the
    // default set, every service); undefined (reset-data) adds nothing.
    const running = new Set(Object.keys(this.supervisor(env).pids()));
    const base = freshClaim ? running : new Set([...this.desiredServices(stack, env), ...running]);
    const added = requestedServices === undefined ? new Set<string>() : this.resolveServiceClosure(stack, requestedServices);
    const active = new Set([...base, ...added].filter((n) => n in stack.manifest.services));
    const inputLease = this.journal.leaseForEnv(env.id);
    if (!inputLease) throw new BrokerError('env-error', 'lease ended before bind; run runly up again', 'lease');
    const previousInputs = this.leaseInputs.get(inputLease.id);
    const inputValues = callerEnv === undefined ? selectCallerEnv(stack.manifest, previousInputs?.values ?? {}) : validateCallerEnv(stack.manifest, callerEnv);
    requireCallerEnv(stack.manifest, active, inputValues);
    const sameInputs = previousInputs !== undefined &&
      Object.keys(previousInputs.values).length === Object.keys(inputValues).length &&
      Object.entries(inputValues).every(([key, value]) => previousInputs.values[key] === value);
    const inputs = sameInputs ? previousInputs : { values: inputValues, revision: String(++this.inputRevision) };
    this.leaseInputs.set(inputLease.id, inputs);
    const manifestKey = JSON.stringify(stack.manifest);
    const manifestChanged = this.appliedManifests.get(env.id) !== manifestKey;
    const inputSpec = callerEnvSpec(stack.manifest);
    const inputsChanged = (inputSpec !== '[]' && this.appliedInputs.get(env.id) !== inputs.revision) ||
      inputSpec !== (this.appliedInputSpecs.get(env.id) ?? '[]');
    const dirs = this.envDirs(env.id);
    // Ports are allocated once at createEnv (decision 0004: stable for the
    // environment's lifetime). A service ADDED to the manifest afterwards had
    // no port, so every bind of an existing environment failed on the
    // undefined lookup — permanently, for envs created before the edit.
    // Existing keys are never reassigned, so stability holds.
    let addedPort = false;
    for (const spec of Object.values(stack.manifest.services)) {
      if (spec.port && !(spec.port in env.ports)) {
        env.ports[spec.port] = await this.allocPublicPort();
        addedPort = true;
      }
    }
    // …and a port key the manifest no longer declares gives its port back: its
    // listener closes, so nothing answers a URL no service stands behind.
    const declaredKeys = new Set(Object.values(stack.manifest.services).map((s) => s.port).filter((k): k is string => Boolean(k)));
    for (const key of Object.keys(env.ports)) {
      if (declaredKeys.has(key)) continue;
      this.proxy.closeKey(env.id, key);
      delete env.ports[key];
      addedPort = true;
      logEvent({ level: 'info', kind: 'proxy', envId: env.id, detail: `port key '${key}' is no longer declared in ${manifestFileOf(stack)} — its public port was released` });
    }
    if (addedPort) this.journal.saveEnv(env);
    // The proxy holds every public port from here on (decision 0033). A port it
    // cannot hold moves, and a service that templates another one's address
    // then needs a restart to see the new number — hence a full bind below.
    const portsMoved = await this.ensureProxies(env);
    for (const line of portsMoved) say(line);
    if (hygiene === 'pristine') {
      say('preparing a pristine environment');
      await this.stopForBind(env);
      // The environment's PRIVATE state only. The worktree is the caller's and
      // is never deleted (decision 0032) — not its caches, not its build output.
      // What pristine can still honestly promise is that nothing is TRUSTED:
      // the worktree's upkeep ledger is cleared, so every upkeep rule runs
      // again in place (builds run on every bind anyway). The datastores'
      // presets are KEPT: they say what each store is recreated with.
      rmSync(dirs.data, { recursive: true, force: true });
      rmSync(dirs.legacyTree, { recursive: true, force: true });
      mkdirSync(dirs.data, { recursive: true });
      env.fingerprints = {};
      // Persist the cleared ledger NOW, not at the end of the bind. Appliances
      // and upkeep run before the epilogue, and a crash in
      // any of them used to leave the journal asserting fingerprints
      // for state that no longer exists — so the next bind skipped work it had
      // to redo.
      this.journal.saveEnv(env);
      await this.treeLocked(stack.id, async () => {
        this.treeLedgerSession(stack).clear();
        // Nothing is trusted: every build runs again too (decision 0038).
        clearBuilds(stack.id);
      }, (s) => say(`waiting for another bind in this worktree … ${s}s`));
    } else if (Object.keys(env.servicePids).length === 0 && existsSync(dirs.legacyTree)) {
      // A projection copy from an older daemon: nothing runs from it any more.
      rmSync(dirs.legacyTree, { recursive: true, force: true });
    }

    // Appliances first: shared backing servers must answer before anything
    // else is worth doing. Milliseconds when they're up; a one-time start
    // when they're not (decision 0018). Failures here are infra-errors.
    trace.phase('appliances');
    await this.ensureAppliances(stack, say, reservation);

    // No copy: the services run in the worktree itself (decision 0032), and
    // runly keeps no identity of it. Upkeep reads exactly the files its rules'
    // `when:` globs match, compared with the worktree's ledger.
    trace.phase('upkeep');
    const waitTree = (s: number) => say(`waiting for another bind in this worktree … ${s}s`);
    const { upkeep, files } = await this.treeLocked(stack.id, async () => {
      // Read under the worktree lock: `runly warm` may be mid-install.
      const triggers = await triggerSet(stack.root, stack.manifest, worktreeStateDir(stack.id));
      const ledger = this.treeLedgerSession(stack);
      const out = await runUpkeep(stack.root, triggers, stack.manifest, { ...pickEnvKeys(env.fingerprints), ...ledger.get() }, say, {
        commit: (fps) => ledger.commitRules(fps),
        onOutput: this.upkeepLog(dirs.logs),
      });
      ledger.commitRules(out.fingerprints);
      return { upkeep: out, files: triggers };
    }, waitTree);
    trace.result.upkeep = { ran: upkeep.ran.length, skipped: (stack.manifest.upkeep?.length ?? 0) - upkeep.ran.length };
    // Content-derived template identity (vetbill-1i49): divergent
    // migrations/seeds in this worktree yield a different bake key and thus a
    // disjoint template name — two stacks can no longer silently share a
    // template with the wrong schema.
    const bakeKeys = templateBakeKeys(stack.manifest, stack.root, files);
    // A fired `@rebake-template` rule names the datastore whose trigger files
    // changed for THIS environment — but the template key already folds in
    // that content (decision 0039): a template whose key matches was baked
    // from the same create command and the same files, so it is reused, and
    // one that is missing is baked by the restore that needs it. Rebaking it
    // on every fresh environment cost a destroyed worktree 90-110 s per `up`.
    // Only `--pristine` (nothing is trusted) drops the current templates.
    if (hygiene === 'pristine') {
      for (const dsName of upkeep.rebakeTemplates) {
        const spec = stack.manifest.datastores?.[dsName];
        if (spec) await makeDatastore(dsName, spec, stack.id, bakeKeys[dsName]).rebake(stack.root);
      }
    }
    // Which datastores hold data from a template other than the current one:
    // a fired rule reloads only those (a fresh environment creates every
    // store anyway).
    const staleTemplate = (name: string): boolean => {
      const spec = stack.manifest.datastores?.[name];
      if (!spec || !upkeep.rebakeTemplates.includes(name)) return false;
      const ref = makeDatastore(name, spec, stack.id, bakeKeys[name]).templateRef(presetToRestore(name, spec, env.presets[name]));
      return ref === null || env.templates?.[name] !== ref;
    };

    // runly does not know whether the worktree's code changed (decision 0032:
    // no source identity, no build cache), so every `up` runs the build of
    // every service it leaves running and lets the build tool decide what is
    // current. What runly decides is only what to STOP:
    //
    // - Everything (stop, data, build, start) when the running services cannot
    //   simply continue: nothing running, a service unhealthy, changed
    //   manifest/inputs, an upkeep rule that ran, a moved public port, or a
    //   data hygiene.
    // - Otherwise nothing that runs is stopped except what must be (decision
    //   0034): a service whose declared `outputs:` changed across its build (or
    //   that declares none — the safe default), and the running services that
    //   use a datastore the caller asked to reload. Services the request adds
    //   are built and started next to the rest.
    //
    // A different set of services and a different preset are no longer reasons
    // for the full path: `up` is additive, and a preset reloads one datastore.
    const missing = [...active].filter((n) => !running.has(n));
    if (upkeep.ran.length > 0) trace.result.reasons.push('upkeep-required');
    if (env.state !== 'hot') trace.result.reasons.push('environment-not-running');
    if (!this.supervisor(env).allHealthyPids()) trace.result.reasons.push('service-process-unhealthy');
    if (inputsChanged) trace.result.reasons.push('environment-inputs-changed');
    if (manifestChanged) trace.result.reasons.push('manifest-changed');
    if (hygiene !== 'reuse') trace.result.reasons.push(`hygiene-${hygiene}`);
    if (portsMoved.length > 0) trace.result.reasons.push('public-port-moved');
    const keepRunning = trace.result.reasons.length === 0;
    // The environment keeps only its own half of the ledger (`@` built-ins);
    // the worktree's half (command rules) was written under the worktree lock.
    env.fingerprints = pickEnvKeys(upkeep.fingerprints);

    const startSlice = (only: Set<string>) => this.startServices(stack, env, active, only, inputs, say, 'stop-all', reservation);

    if (keepRunning) {
      trace.phase('build');
      const buildCtx = this.templateCtx(stack, env);
      const toRestart = new Set<string>();
      await this.treeLocked(stack.id, () => this.inWaves(this.buildWaves(stack, active), async (name) => {
        const spec = serviceOf(stack, name);
        // A service this `up` adds is built and started; nothing to compare.
        if (!running.has(name)) {
          const b = await this.buildService(stack, env, name, spec, buildCtx, say, { rebuild, mode: 'bind' });
          trace.result.builds.push({ service: name, durationMs: b.durationMs, restart: false, reason: b.ran ? 'not-running' : 'when-unchanged' });
          return;
        }
        const declared = outputsOf(spec);
        const before = declared.paths.length > 0 ? await snapshotOutputs(stack.root, declared.paths, declared.compare) : null;
        const b = await this.buildService(stack, env, name, spec, buildCtx, say, { rebuild, mode: 'bind' });
        if (!b.ran) {
          // Its inputs did not change, so its output did not either.
          trace.result.builds.push({ service: name, durationMs: b.durationMs, restart: false, reason: 'when-unchanged' });
          return;
        }
        const changed = before === null || (await snapshotOutputs(stack.root, declared.paths, declared.compare)) !== before;
        if (changed) toRestart.add(name);
        trace.result.builds.push({
          service: name,
          durationMs: b.durationMs,
          restart: changed,
          reason: before === null ? 'no-outputs-declared' : changed ? 'outputs-changed' : 'outputs-unchanged',
        });
      }), waitTree);
      reservation.releaseBuild();
      // A reloaded datastore must not be held open across its restore: the
      // running services that use it stop first and start again on the new
      // data. Who uses it is read from the manifest; if nothing references it,
      // nobody can tell, so every running service restarts.
      const reloads = Object.keys(reloadPresets);
      for (const ds of reloads) {
        const users = this.datastoreUsers(stack, ds);
        for (const name of running) if (users === null || users.has(name)) toRestart.add(name);
      }
      trace.result.started = [...missing];
      trace.result.restarted = [...toRestart];
      trace.result.reloaded = [...reloads];
      if (toRestart.size === 0 && missing.length === 0 && reloads.length === 0) {
        trace.result.reuse = 'reused';
        trace.phase('finalize');
        env.lastUsedAt = now();
        // Refresh from the LIVE supervisor before saving. A service that restarted
        // during this bind updated the journal through onPidsChanged, and writing
        // the pre-bind snapshot back put dead pids there — which recovery would
        // later signal, missing the real process.
        env.servicePids = this.supervisor(env).pids();
        env.activeServices = this.recordedShape(stack, active);
        this.journal.saveEnv(env);
        return {
          env,
          previewNotice: forbiddenNotice ?? (await this.reconcilePreviewForBind(env, stack, active, say, { hygiene, portsReallocated: true })),
          bindDiagnostics: trace.finish(),
        };
      }
      trace.result.reuse = toRestart.size > 0 ? 'restarted' : 'reused';
      if (toRestart.size > 0) {
        trace.phase('stop');
        // Hold, don't refuse: a client arriving while these restart waits on the
        // public port and is forwarded once the new process is ready.
        this.markStarting(env, stack, [...toRestart]);
        await this.stopServicesForRestart(env, [...toRestart]);
      }
      if (reloads.length > 0) {
        trace.phase('data');
        await this.prepareDatastores(stack, env, bakeKeys, reloads.map((name) => ({ name, force: true, preset: reloadPresets[name] })), say);
      }
      trace.phase('ready');
      await startSlice(new Set([...toRestart, ...missing]));
    } else {
    // Services must not hold open handles across a data restore or code change.
    trace.phase('stop');
    this.markStarting(env, stack, [...active]);
    await this.stopForBind(env);

    // Data state: every datastore exists for the environment's whole life. A
    // reset restores all of them (each with the preset it holds, unless the
    // caller named another); a named preset reloads that one; the rest keep
    // their data (probe first — infra-error, not code blame).
    trace.phase('data');
    trace.result.reloaded = Object.keys(reloadPresets);
    await this.retireEnvDatastores(stack, env, say);
    // Data and builds are independent (decision 0039): the datastores are
    // restored (or baked) while the services build, and the services start
    // only once both are done. A build's templates may name a datastore's url
    // or ns — both are derived from the environment, not from the restore.
    const data = async () => {
      const t0 = performance.now();
      try {
        await this.prepareDatastores(stack, env, bakeKeys, this.envDatastores(stack).map((name) => ({
          name,
          force: reloadPresets[name] !== undefined || hygiene !== 'reuse' || staleTemplate(name),
          preset: reloadPresets[name],
        })), say);
      } finally {
        phaseMs.data = performance.now() - t0;
      }
    };
    // Builds: every service this bind starts that declares one (decision
    // 0032) — except a `build: { when: }` whose inputs are unchanged since its
    // last successful build (decision 0038). runly keeps no build cache —
    // MSBuild, pnpm and the Angular CLI decide what is already up to date.
    // Under the worktree lock: `runly warm` builds into the same output.
    const ctx = this.templateCtx(stack, env);
    const builds = async () => {
      const t0 = performance.now();
      try {
        await this.treeLocked(stack.id, () => this.inWaves(this.buildWaves(stack, active), async (name) => {
          const b = await this.buildService(stack, env, name, serviceOf(stack, name), ctx, say, { rebuild, mode: 'bind' });
          trace.result.builds.push({ service: name, durationMs: b.durationMs, restart: true, reason: b.ran ? 'full-rebind' : 'when-unchanged' });
        }), waitTree);
      } finally {
        phaseMs.build = performance.now() - t0;
      }
    };
    const phaseMs = { data: 0, build: 0 };
    // Both run to the end before a failure is reported: a build is never left
    // running behind the caller's back, and the data error (if any) wins.
    const [dataDone, buildsDone] = await Promise.allSettled([data(), builds()]);
    trace.overlapped(phaseMs);
    reservation.releaseBuild();
    if (dataDone.status === 'rejected') throw dataDone.reason;
    if (buildsDone.status === 'rejected') throw buildsDone.reason;

    trace.phase('ready');
    await startSlice(active);
    }

    const sup = this.supervisor(env);
    trace.phase('finalize');
    // `env` is a SNAPSHOT taken before services started. Writing it back whole
    // discards anything that changed meanwhile — in particular the onDegraded
    // callback, which fires when an EARLIER service flaps while a later one is
    // still booting. Promoting to 'hot' from the stale snapshot lost that, and
    // the environment was handed out as healthy with a dead service in it.
    const current = this.journal.getEnv(env.id);
    if (!current) {
      // Recycled underneath us: saving would resurrect a deleted row.
      throw new BrokerError('env-error', `environment ${env.id} was recycled during bind — retry`, 'pool');
    }
    if (current.state === 'degraded') {
      env.state = 'degraded';
      // Record this bind's shape alongside its pids — writing back current's
      // pre-bind activeServices next to the just-started pids would let a reader
      // in the degraded window filter URLs by the wrong set.
      this.journal.saveEnv({ ...current, servicePids: sup.pids(), activeServices: this.recordedShape(stack, active), lastUsedAt: now() });
      throw new BrokerError('env-error', `environment ${env.id} degraded during bind — a service flapped past its restart budget`, 'pool');
    }
    // A service of this (leased) bind crash-looped while a later one booted
    // (decision 0039): the bind failed, but the environment and the services
    // that run stay; the next `up` starts the failed one again.
    const failedNow = [...active].flatMap((n) => {
      const f = this.failureOf(env.id, n);
      return f ? [{ name: n, f }] : [];
    });
    const firstFailed = failedNow[0];
    if (firstFailed) {
      const pids = sup.pids();
      this.journal.saveEnv({ ...current, state: Object.keys(pids).length > 0 ? 'hot' : 'warm', servicePids: pids, activeServices: this.recordedShape(stack, active), lastUsedAt: now() });
      throw new BrokerError(
        'work-error',
        `service ${failedNow.map((x) => `'${x.name}'`).join(', ')} ${describeExit(firstFailed.f)} during this bind — 'runly logs ${firstFailed.name}' shows why; the other services keep running and the next 'runly up' retries it`,
        firstFailed.name,
      );
    }
    // Nothing wanted means nothing running, which is exactly what `warm`
    // means — services stopped, ports and data intact. Publishing it as `hot`
    // would make the idle sweeper try to reclaim heat that was never taken.
    env.state = active.size === 0 ? 'warm' : 'hot';
    env.servicePids = sup.pids();
    env.activeServices = this.recordedShape(stack, active);
    env.bindCount += 1;
    env.lastUsedAt = now();
    this.appliedInputs.set(env.id, inputs.revision);
    this.appliedInputSpecs.set(env.id, inputSpec);
    this.appliedManifests.set(env.id, manifestKey);
    env.failStreak = 0; // a successful bind clears the escalation counter
    this.journal.saveEnv(env);
    return {
      env,
      previewNotice: forbiddenNotice ?? (await this.reconcilePreviewForBind(env, stack, active, say, { hygiene, portsReallocated: true })),
      bindDiagnostics: trace.finish(),
    };
  }

  /** The public ports of `services` hold new connections until their service is ready again. */
  private markStarting(env: EnvRow, stack: Stack, services: string[]): void {
    for (const name of services) {
      const key = stack.manifest.services[name]?.port;
      if (key) this.proxy.starting(env.id, key, name);
    }
  }

  /**
   * The order the builds of `names` run in: depends_on waves. A build runs
   * after the builds of what its service depends on (transitively), and the
   * builds of one wave run at once — independent services no longer wait for
   * each other. `build: {serial: true}` runs alone; `builds: serial` on the
   * stack runs every build alone, in manifest order (the behaviour before
   * 0.16.1). The load budget holds the costliest wave's sum (needFor).
   *
   * Builds that write one shared output or take one tool lock belong in
   * `serial`. Two Angular projects are fine in parallel: the CLI's persistent
   * cache is keyed per project (`.angular/cache/<version>/<project>`).
   */
  private buildWaves(stack: Stack, names: Iterable<string>): string[][] {
    const services = stack.manifest.services;
    const wanted = new Set([...names].filter((n) => buildOf(services[n] ?? {}) !== undefined));
    const ordered = Object.keys(services).filter((n) => wanted.has(n));
    if (stack.manifest.builds === 'serial') return ordered.map((n) => [n]);
    const level = new Map<string, number>();
    const depth = (n: string, seen: Set<string>): number => {
      const known = level.get(n);
      if (known !== undefined) return known;
      if (seen.has(n)) return 0; // a depends_on cycle: the start loop reports it
      seen.add(n);
      const deps = (services[n]?.depends_on ?? []).map((d) => depth(d, seen));
      seen.delete(n);
      const d = deps.length === 0 ? 0 : Math.max(...deps) + 1;
      level.set(n, d);
      return d;
    };
    const byLevel = new Map<number, string[]>();
    for (const n of ordered) {
      const l = depth(n, new Set());
      byLevel.set(l, [...(byLevel.get(l) ?? []), n]);
    }
    const waves: string[][] = [];
    for (const l of [...byLevel.keys()].sort((a, b) => a - b)) {
      const members = byLevel.get(l) ?? [];
      const serial = (n: string) => buildOf(services[n] ?? {})?.serial === true;
      for (const n of members) if (serial(n)) waves.push([n]);
      const together = members.filter((n) => !serial(n));
      if (together.length > 0) waves.push(together);
    }
    return waves;
  }

  /**
   * Run `fn` for each service of `waves`, wave after wave, the members of one
   * wave at once. A failure fails the call once its whole wave has settled —
   * never with a sibling build still running behind the caller's back.
   */
  private async inWaves(waves: string[][], fn: (name: string) => Promise<void>): Promise<void> {
    for (const wave of waves) {
      const results = await Promise.allSettled(wave.map((n) => fn(n)));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
    }
  }

  /** Build `names` (those that declare a build) in waves. MUST run under treeLocked. */
  private runBuilds(stack: Stack, env: EnvRow | undefined, names: Iterable<string>, ctx: Record<string, unknown> | undefined, say: Progress, opts: { rebuild: boolean; mode: 'bind' | 'wake' | 'warm' }): Promise<void> {
    return this.inWaves(this.buildWaves(stack, names), async (name) => {
      await this.buildService(stack, env, name, serviceOf(stack, name), ctx, say, opts);
    });
  }

  /**
   * Run one service's build in the worktree. MUST run under treeLocked. Its
   * output goes to `<service>.build.log` in the environment's log directory
   * (decision 0038), replaced by each build; `logDir` is undefined only for a
   * `warm` with no environment.
   */
  private async runServiceBuild(name: string, cmd: string, root: string, say: Progress, logDir?: string): Promise<void> {
    say(`building '${name}'`);
    const buildStart = now();
    const beat = setInterval(() => say(`building '${name}' … ${Math.round((now() - buildStart) / 1000)}s`), 5000);
    beat.unref();
    let log: LogWriter | undefined;
    if (logDir) {
      mkdirSync(logDir, { recursive: true });
      const file = buildLogOf(logDir, name);
      beginBuildLog(file, `build ${name}`);
      log = new LogWriter(file);
    }
    try {
      const buildTimeoutS = cmdTimeoutS(LONG_CMD_TIMEOUT_S);
      const r = await runBounded(cmd, root, buildTimeoutS, undefined, log ? { data: (st, c) => log?.write(st, c), end: (st) => log?.end(st) } : undefined);
      if (r.timedOut) {
        log?.line(`-- runly: build ${name} timed out after ${buildTimeoutS}s --`);
        throw new BrokerError('work-error', `build for service '${name}' timed out after ${buildTimeoutS}s (process group killed; set BACKLOT_CMD_TIMEOUT_S if legitimate)`, name, r.output.slice(-800));
      }
      log?.line(`-- runly: build ${name} exited ${r.code} after ${formatDuration(now() - buildStart)} --`);
      if (r.code !== 0) throw new BrokerError('work-error', `build failed for service '${name}' ('runly logs ${name} --build' has its output)`, name, r.output.slice(-800));
    } finally {
      clearInterval(beat);
    }
  }

  /**
   * Whether a service's build must run now (decision 0038), and the key a
   * successful run is recorded under. A `when:` build runs only when its
   * inputs changed since its last successful build in this worktree; a
   * string build always runs on a bind, and on a wake only when it never
   * succeeded here (a wake resumes what ran; `up` applies changes).
   */
  private async buildDecision(stack: Stack, name: string, spec: ServiceSpec, cmd: string, opts: { rebuild: boolean; mode: 'bind' | 'wake' | 'warm' | 'plan' }): Promise<{ run: boolean; key: string; reason?: string }> {
    const b = buildOf(spec) ?? { run: cmd };
    const key = b.when ? await buildInputsKey(stack.root, stack.manifest, cmd, b.when) : sha256(`${cmd}\nalways`);
    if (opts.rebuild) return { run: true, key };
    if (b.when) {
      // A skip also needs the outputs that build left: deleted or overwritten
      // outputs would leave the service with nothing (or the wrong thing) to run.
      const outputs = await this.outputsPrint(stack, spec);
      if (outputs !== '' && buildIsCurrent(stack.id, name, key, outputs)) return { run: false, key, reason: 'when: unchanged' };
    }
    if (!b.when && opts.mode === 'wake' && everBuilt(stack.id, name)) return { run: false, key, reason: 'a wake resumes the last build' };
    return { run: true, key };
  }

  /** Build one service if its build is due; record a success. MUST run under treeLocked. */
  private async buildService(
    stack: Stack, env: EnvRow | undefined, name: string, spec: ServiceSpec, ctx: Record<string, unknown> | undefined, say: Progress,
    opts: { rebuild: boolean; mode: 'bind' | 'wake' | 'warm' },
  ): Promise<{ ran: boolean; durationMs: number }> {
    const b = buildOf(spec);
    if (!b) return { ran: false, durationMs: 0 };
    const cmd = ctx ? template(b.run, ctx) : b.run;
    const decision = await this.buildDecision(stack, name, spec, cmd, opts);
    if (!decision.run) {
      say(`build ${name}: skipped (${decision.reason})`);
      return { ran: false, durationMs: 0 };
    }
    const started = performance.now();
    // Dropped before it runs: a build that fails half-way vouches for nothing.
    forgetBuild(stack.id, stack.root, name);
    await this.runServiceBuild(name, cmd, stack.root, say, env ? this.envDirs(env.id).logs : undefined);
    recordBuild(stack.id, stack.root, name, decision.key, await this.outputsPrint(stack, spec));
    return { ran: true, durationMs: performance.now() - started };
  }

  /**
   * A stat print of a service's declared outputs, as the build ledger keeps
   * it: undefined when it declares none, '' when none exist on disk.
   */
  private async outputsPrint(stack: Stack, spec: ServiceSpec): Promise<string | undefined> {
    const declared = outputsOf(spec);
    if (declared.paths.length === 0) return undefined;
    const snap = await snapshotOutputs(stack.root, declared.paths, 'stat');
    return snap === '' ? '' : sha256(snap);
  }

  /** The upkeep rules' output of this bind, in `upkeep.build.log` (decision 0038), begun by the first rule that runs. */
  private upkeepLog(logDir: string) {
    let log: LogWriter | undefined;
    return {
      begin: (label: string) => {
        if (!log) {
          mkdirSync(logDir, { recursive: true });
          const file = buildLogOf(logDir, UPKEEP_LOG);
          beginBuildLog(file, 'upkeep');
          log = new LogWriter(file);
        }
        log.line(`-- runly: ${label} --`);
      },
      data: (st: 'out' | 'err', c: string) => log?.write(st, c),
      end: (st: 'out' | 'err') => log?.end(st),
    };
  }

  /**
   * Ensure the stack's appliances (decision 0018), remembering the ones runly
   * started for the budget. A started one is counted as running from now on,
   * so its share leaves the caller's reservation.
   */
  private async ensureAppliances(stack: Stack, say: Progress, reservation?: Reservation): Promise<void> {
    for (const [name, spec] of Object.entries(stack.manifest.appliances ?? {})) {
      const state = await ensureAppliance(name, spec, stack.root, say);
      if (state === 'started') {
        const cost = costsOf(spec.resources, policy().budget).run;
        this.startedAppliances.set(spec.probe, { name, cost });
        reservation?.consume(cost);
      }
      if (state !== 'up') logEvent({ level: 'info', kind: 'appliance', detail: `'${name}' ${state} (${spec.probe})` });
    }
  }

  /**
   * Forget appliances that are no longer up (stopped by hand, crashed, a
   * reboot): their cost stayed committed for the rest of the daemon's life.
   * Re-probed every sweep — a TCP connect per appliance runly started.
   */
  private async pruneStartedAppliances(): Promise<void> {
    for (const [probe, a] of [...this.startedAppliances]) {
      if (!(await probeTcp(probe, 1000))) {
        this.startedAppliances.delete(probe);
        logEvent({ level: 'info', kind: 'appliance', detail: `'${a.name}' (${probe}) is no longer up — its cost leaves the budget` });
      }
    }
  }

  // ---------------------------------------------------------------- budget (decision 0036)

  /** Declared (or default) run resources of everything runly runs now, across every environment. */
  private committedRunning(): Committed {
    const b = policy().budget;
    const items: Committed['items'] = [];
    let memoryBytes = 0;
    let cpu = 0;
    for (const [envId, sup] of this.supervisors) {
      const manifest = this.envManifests.get(envId);
      for (const name of Object.keys(sup.pids())) {
        const c = costsOf(manifest?.services[name]?.resources, b).run;
        memoryBytes += c.memoryBytes;
        cpu += c.cpu;
        items.push({ what: `${envId}/${name}`, memoryBytes: c.memoryBytes, cpu: c.cpu });
      }
    }
    for (const [probe, a] of this.startedAppliances) {
      memoryBytes += a.cost.memoryBytes;
      cpu += a.cost.cpu;
      items.push({ what: `appliance ${a.name} (${probe})`, memoryBytes: a.cost.memoryBytes, cpu: a.cost.cpu });
    }
    return { memoryBytes, cpu, items };
  }

  /**
   * What starting `starts` and building `builds` would cost (decision 0036),
   * item by item: run resources per start, build resources per build that
   * will actually run, and run resources per appliance that is not up.
   */
  private async needFor(stack: Stack, env: EnvRow | undefined, starts: Set<string>, builds: Set<string>, opts: { rebuild: boolean; mode: 'bind' | 'wake' | 'plan' }): Promise<Need> {
    const b = policy().budget;
    const items: NeedItem[] = [];
    let ctx: Record<string, unknown> | undefined;
    try {
      ctx = env ? this.templateCtx(stack, env) : undefined;
    } catch {
      ctx = undefined;
    }
    // Builds of one wave run at once, so their costs add up (needOf).
    const waveOf = new Map<string, number>();
    this.buildWaves(stack, builds).forEach((wave, i) => { for (const n of wave) waveOf.set(n, i); });
    for (const [name, spec] of Object.entries(stack.manifest.services)) {
      const costs = costsOf(spec.resources, b);
      const declaredBuild = buildOf(spec);
      if (builds.has(name) && declaredBuild) {
        let skipped: string | undefined;
        try {
          const raw = declaredBuild.run;
          const cmd = ctx ? template(raw, ctx) : raw;
          const d = await this.buildDecision(stack, name, spec, cmd, { rebuild: opts.rebuild, mode: opts.mode === 'plan' ? 'bind' : opts.mode });
          if (!d.run) skipped = d.reason;
        } catch {
          /* an untemplatable line (no environment yet): it will run */
        }
        items.push({ kind: 'build', name, cost: costs.build, wave: waveOf.get(name), ...(skipped ? { skipped } : {}) });
      }
      if (starts.has(name)) items.push({ kind: 'start', name, cost: costs.run });
    }
    for (const [name, spec] of Object.entries(stack.manifest.appliances ?? {})) {
      if (!(await probeTcp(spec.probe, 1000))) items.push({ kind: 'appliance', name, cost: costsOf(spec.resources, b).run });
    }
    return needOf(items);
  }

  /**
   * Start `only` (a subset of `active`) in dependency order, readiness-gated,
   * fatal-log fast-fail. The other members of `active` are already running,
   * so they count as started for depends_on — and so does a dependency the
   * lease took `down` on purpose (it is not wanted; the dependent reaches its
   * stable public port). On a failure a bind stops everything (`stop-all`); a
   * wake stops only what it started (`stop-these`).
   */
  private async startServices(
    stack: Stack, env: EnvRow, active: Set<string>, only: Set<string>,
    inputs: { values: Record<string, string> }, say: Progress, onFailure: 'stop-all' | 'stop-these',
    reservation?: Reservation,
  ): Promise<void> {
    const sup = this.supervisor(env);
    this.envManifests.set(env.id, stack.manifest);
    const internalTaken = new Set<number>();
    const started = new Set<string>([...active].filter((n) => !only.has(n)));
    const entries = Object.entries(stack.manifest.services).filter(([n]) => only.has(n));
    for (;;) {
      const pending = entries.filter(([n]) => !started.has(n));
      if (pending.length === 0) break;
      const ready = pending.filter(([, s]) => (s.depends_on ?? []).every((d) => started.has(d) || !active.has(d)));
      if (ready.length === 0) throw new BrokerError('work-error', `depends_on cycle in ${manifestFileOf(stack)}`, 'manifest');
      for (const [name, spec] of ready) {
        // The service listens on a fresh INTERNAL port (decision 0033); the
        // proxy keeps the public one and forwards to it once it is ready.
        let internal: number | undefined;
        if (spec.port) {
          // The allocation loop at the top of a bind fills every declared
          // port key, so a miss here is a corrupted port ledger — classify it.
          if (env.ports[spec.port] === undefined) {
            throw new BrokerError('env-error', `environment ${env.id} has no port recorded for service '${name}' — the port ledger is inconsistent; try 'runly pool recycle ${env.id}'`, name);
          }
          internal = await this.allocInternalPort(internalTaken, env.id, spec.port);
          internalTaken.add(internal);
          this.proxy.starting(env.id, spec.port, name);
        }
        const ctx = this.templateCtx(stack, env, spec.port && internal !== undefined ? { key: spec.port, port: internal } : undefined);
        // Template the COMMANDS too — ports/urls may ride in the run line itself
        // (e.g. `ng serve --port {{ports.web}}`), not only in env:.
        const resolved = { ...spec, run: template(spec.run, ctx) };
        const callerValues = serviceCallerEnv(spec, inputs.values);
        const serviceEnv = { ...templateEnv(spec.env, ctx), ...callerValues };
        this.failedServices.delete(`${env.id}\0${name}`);
        sup.start(name, resolved, serviceEnv, Object.values(callerValues).filter((value): value is string => value !== undefined));
        // From now on the running service is what the budget counts; its share
        // leaves the reservation (it was counted twice until the bind ended).
        reservation?.consume(costsOf(spec.resources, policy().budget).run);
        // A fresh start is activity: an old idle clock must not stop it at once.
        this.startedAt.set(`${env.id}\0${name}`, now());
        this.idleStopped.delete(`${env.id}\0${name}`);
        // Readiness goes to the internal port, past the proxy: runly's own
        // probes are never client activity.
        const url = internal !== undefined ? `http://localhost:${internal}` : undefined;
        say(`starting '${name}', waiting until ready`);
        const readyStart = now();
        const beat = setInterval(() => say(`waiting for '${name}' … ${Math.round((now() - readyStart) / 1000)}s`), 3000);
        beat.unref();
        try {
          await sup.waitReady(name, spec, url, serviceEnv);
          clearInterval(beat);
          if (spec.port && internal !== undefined) this.proxy.up(env.id, spec.port, internal, name);
          say(`'${name}' ready`);
        } catch (err) {
          clearInterval(beat);
          if (onFailure === 'stop-these') {
            try {
              await this.stopServicesForRestart(env, [...only].filter((n) => n in sup.pids() || n === name));
            } catch (stopErr) {
              logEvent({ level: 'warn', kind: 'wake', envId: env.id, detail: `stopping what a failed start began: ${String((stopErr as Error).message ?? stopErr)}` });
            }
            throw err;
          }
          const survivors = await sup.stopAll();
          this.supervisors.delete(env.id);
          const unreaped = await this.reapEnvProcesses(env, survivors);
          // Same stale-snapshot rule as the epilogue: preserve a concurrent
          // degrade, and never write back a row that has been recycled away.
          const live = this.journal.getEnv(env.id);
          if (live) {
            live.state = live.state === 'degraded' ? 'degraded' : 'warm';
            live.servicePids = unreaped;
            this.journal.saveEnv(live);
          }
          throw err;
        }
        started.add(name);
      }
    }
  }

  // ---------------------------------------------------------------- verbs

  /**
   * A proven lexical alias: the row's identity is exactly what the current
   * manifest name yields for the spelling it recorded, and that spelling still
   * resolves to `stack`'s physical root. A renamed manifest, or a source that
   * is unreadable or gone, proves nothing and is left alone.
   */
  private legacyAlias(env: EnvRow, stack: Stack): { id: string; stack: string; root: string } | null {
    if (env.stack === stack.id || stackIdentity(stack.manifest.name, env.stackRoot) !== env.stack) return null;
    try {
      if (canonicalDirectory(env.stackRoot) !== stack.root) return null;
    } catch {
      return null;
    }
    return { id: env.id, stack: stack.id, root: stack.root };
  }

  /**
   * Migrate every proven alias of `stack` to its physical identity. Idempotent,
   * and applied at every boundary that judges a row by identity — recovery, the
   * holder verbs, the sweeper's orphan check — so a manifest that was merely
   * unreadable when the daemon started can only defer the migration, never turn
   * it into a reclaim or a duplicate environment once repaired.
   */
  private adoptLegacyAliases(stack: Stack): void {
    const changes = this.journal.allEnvs().map((env) => this.legacyAlias(env, stack)).filter((c) => c !== null);
    if (changes.length === 0) return;
    this.journal.canonicalizeStacks(changes);
    for (const change of changes) {
      const migrated = this.journal.getEnv(change.id);
      if (migrated) this.registerRetiredTemplates(migrated);
      logEvent({ level: 'info', kind: 'retention', envId: change.id, detail: `stack identity migrated to '${change.stack}' (physical root ${change.root})` });
    }
  }

  /** A durable descriptor keeps failed retirement discoverable after the last env is recycled. */
  private registerRetiredTemplates(env: EnvRow): void {
    if (!env.legacyStackRoot) return;
    const retired = retiredStackIdentity(env.stack, env.legacyStackRoot);
    const dir = join(templatesRoot(), retired);
    if (retired === env.stack || !existsSync(dir)) return;
    const record = join(dir, '.retired-stack.json');
    if (!existsSync(record)) {
      writeFileSync(`${record}.tmp`, JSON.stringify({
        stack: env.stack, legacyRoot: env.legacyStackRoot, root: env.stackRoot,
      }));
      renameSync(`${record}.tmp`, record);
    }
    this.relocateRetiredTemplates(retired);
  }

  private relocateRetiredTemplates(retired: string): void {
    tryWithBakeLock(retired, () => {
      if (this.journal.envsForStack(retired).length > 0) return;
      const dir = join(templatesRoot(), retired);
      try {
        const descriptor = JSON.parse(readFileSync(join(dir, '.retired-stack.json'), 'utf8'));
        if (typeof descriptor.stack !== 'string' || typeof descriptor.legacyRoot !== 'string' || typeof descriptor.root !== 'string') return;
        if (retiredStackIdentity(descriptor.stack, descriptor.legacyRoot) !== retired || descriptor.stack === retired) return;
      } catch { return; }
      mkdirSync(retiredTemplatesRoot(), { recursive: true });
      const destination = join(retiredTemplatesRoot(), retired);
      renameSync(dir, existsSync(destination) ? `${destination}.${shortId()}` : destination);
    });
  }

  /** One bounded external drop, after ownership/reaping work; never part of recovery. */
  private async retireLegacyTemplateBatch(force = false): Promise<void> {
    for (const env of this.journal.allEnvs()) this.registerRetiredTemplates(env);
    if (existsSync(templatesRoot())) for (const retired of readdirSync(templatesRoot())) this.relocateRetiredTemplates(retired);
    let entries: string[];
    try { entries = readdirSync(retiredTemplatesRoot()); } catch { return; }
    for (const entry of entries) {
      const dir = join(retiredTemplatesRoot(), entry);
      let retired: string;
      let descriptor: { stack: string; legacyRoot: string; root: string };
      try {
        descriptor = JSON.parse(readFileSync(join(dir, '.retired-stack.json'), 'utf8'));
        if (typeof descriptor.stack !== 'string' || typeof descriptor.legacyRoot !== 'string' || typeof descriptor.root !== 'string') continue;
        retired = retiredStackIdentity(descriptor.stack, descriptor.legacyRoot);
        if ((entry !== retired && !entry.startsWith(retired + '.')) || descriptor.stack === retired) continue;
      } catch { continue; }
      // A skipped migration or an in-flight old bake still owns these templates.
      if (this.journal.envsForStack(retired).length > 0) continue;
      if (this.journal.envsForStack(descriptor.stack).some((row) => this.busy.has(row.id))) continue;
      const attempted = await withBakeLock(descriptor.stack, () => withBakeLock(retired, async () => {
        const { dropped, deferred, attempted } = await retireBakedTemplates(
          dir, existsSync(descriptor.root) ? descriptor.root : templatesRoot(), force,
        );
        if (deferred > 0) {
          if (attempted > 0) logEvent({ level: 'warn', kind: 'retention', detail: `retired templates for '${retired}' remain; failed drops retain .retirement.json records with bounded retries. Check the appliance, then run runly pool gc to retry.` });
          return attempted > 0;
        }
        rmSync(dir, { recursive: true, force: true });
        logEvent({ level: 'info', kind: 'retention', detail: `retired templates keyed by legacy stack identity '${retired}' (${dropped} server-side template(s) dropped)` });
        return true;
      }));
      if (attempted) break;
    }
  }

  private callerHolder(cwd: string, holder: string | undefined, stack: Stack): string {
    this.adoptLegacyAliases(stack);
    if (holder !== undefined) return holder;
    const canonical = canonicalDirectory(cwd);
    const own = this.journal.leaseForHolder(canonical, stack.id);
    if (own && own.expiresAt > now()) return canonical;
    for (const env of this.journal.envsForStack(stack.id)) {
      const lease = this.journal.leaseForEnv(env.id);
      if (!lease || lease.expiresAt <= now() || !isAbsolute(lease.holder)) continue;
      const legacyRoot = env.legacyStackRoot;
      const legacyPathHolder = legacyRoot && (lease.holder === legacyRoot || lease.holder.startsWith(legacyRoot + sep));
      let candidate: string | undefined;
      try { candidate = canonicalDirectory(legacyPathHolder ? join(env.stackRoot, lease.holder.slice(legacyRoot.length)) : lease.holder); }
      catch { candidate = undefined; }
      if (candidate === undefined || canonical === candidate) {
        throw new BrokerError('env-error', `a legacy path holder still owns ${env.id}; pass holder ${JSON.stringify(lease.holder)} (--holder on the CLI) to inspect or release that lease before using the canonical default holder`, 'lease');
      }
    }
    return canonical;
  }

  async up(opts: UpOptions) {
    const requestStarted = performance.now();
    const services = opts.services ?? [];
    const stack = loadStack(opts.cwd);
    const holder = this.callerHolder(opts.cwd, opts.holder, stack);
    const forbiddenNotice = await this.enforceHolderPreviewForbidden(stack, holder, opts.onProgress);
    // Removed by decision 0034; the CLI answers it with exit 64 before the daemon.
    if (opts.dataOnly) throw new BrokerError('work-error', DATA_ONLY_REMOVED, 'manifest');
    this.refuseCopiesOnlyPresets(stack, validatePresetRequest(stack.manifest, opts.presets, stack.file));
    // Resolve a requested slice BEFORE acquiring an env: an unknown name is a
    // user typo, not a bind failure, so it must not reach bindAndStart's catch
    // (which bumps failStreak — two typos would escalate the next real bind to a
    // pristine data wipe) or churn a pooled env. bindAndStart resolves it again
    // authoritatively; this is just the early, side-effect-free guard.
    if (services.length > 0) this.resolveServiceClosure(stack, services);
    // A lease pinned to a dead pid is released by the very next sweep, so it
    // would hand this caller's environment — and its seeded database — to
    // whoever binds next while the caller is still using it. The CLI refuses
    // this as a usage error; this guard covers every other client of the RPC.
    if (opts.holderPid !== undefined && !isAlive(opts.holderPid)) {
      throw new BrokerError(
        'work-error',
        `holder pid ${opts.holderPid} is not a live process — the lease would be reclaimable the moment it is created. ` +
          `Under Claude Code, leave the holder pid out: the CLI tethers the lease to the agent itself (CLAUDE_PID); elsewhere use a TTL (--ttl <minutes>)`,
        'lease',
      );
    }
    // Validate before claiming: missing input is caller configuration, not an
    // environment failure deserving hygiene escalation or a stranded lease.
    const suppliedInputs = opts.callerEnv === undefined ? undefined : validateCallerEnv(stack.manifest, opts.callerEnv);
    const existingLease = this.journal.leaseForHolder(holder, stack.id);
    const existingEnv = existingLease ? this.journal.getEnv(existingLease.envId) : undefined;
    // What this bind will (at least) run: the request, plus what the lease
    // already wants (decision 0034: `up` is additive).
    const selectedInputs = new Set([
      ...this.resolveServiceClosure(stack, services),
      ...(existingEnv ? this.desiredServices(stack, existingEnv) : []),
    ]);
    requireCallerEnv(stack.manifest, selectedInputs, suppliedInputs ?? (existingLease ? this.leaseInputs.get(existingLease.id)?.values : undefined) ?? {});
    const kind = opts.kind ?? 'session';
    let hygiene = opts.hygiene ?? 'reuse';
    opts.onProgress?.(`acquiring this worktree's environment (machine ${this.journal.allEnvs().length}/${POOL_MAX_TOTAL()})`);
    const queueStarted = performance.now();
    let queueMs = 0;
    const { env, fresh } = await this.acquireEnv(stack, holder, kind, hygiene, opts.ttlMs ?? LEASE_TTL(), opts.holderPid, opts.signal);
    // Auto-escalation (decision 0007): two consecutive bind failures on this
    // warm environment -> the next bind is pristine, whatever was asked.
    if (hygiene !== 'pristine' && env.failStreak >= 2) hygiene = 'pristine';
    try {
      const { env: bound, previewNotice, bindDiagnostics } = await this.envLocked(
        env.id,
        () => {
          queueMs = performance.now() - queueStarted;
          if (opts.signal?.aborted) throw new CallerGone('env-error', `the caller disconnected before its bind of ${env.id} started`, 'pool');
          return this.bindAndStart(stack, env, hygiene, opts.onProgress, services, fresh, suppliedInputs, opts.presets, Boolean(opts.rebuild), opts.signal);
        },
        (s) => opts.onProgress?.(`waiting for another operation on this environment … ${s}s`),
        'a bind',
      );
      bindDiagnostics.phasesMs.queue = queueMs;
      bindDiagnostics.durationMs = performance.now() - requestStarted;
      return { ...this.ctx(opts.cwd, holder, bound.id), previewNotice: previewNotice ?? forbiddenNotice, bindDiagnostics };
    } catch (err) {
      // Only a bind that FAILED counts toward the escalation (decision 0007).
      // A budget refusal or a caller that went away touched nothing: counted,
      // one refusal switched wake-on-connect off and two made the next `up`
      // pristine — wiping the data of an environment that never failed.
      const notABindFailure = err instanceof BudgetRefusal || err instanceof CallerGone;
      const fresh = this.journal.getEnv(env.id);
      if (fresh && !notABindFailure) {
        fresh.failStreak += 1;
        this.journal.saveEnv(fresh);
      }
      throw err;
    }
  }

  /**
   * The environment a lease points to. leaseForHolder JOINs envs, so the row
   * existed when the lease was resolved — but a concurrent forced teardown can
   * delete it before this read (deleteEnv is one transaction now, so a torn
   * write can no longer leave a lease naming a deleted row; journals from
   * before that change still can, and the sweeper prunes those). Every verb
   * that asserted `getEnv(lease.envId)!` used to crash with an unclassified
   * TypeError instead of telling the caller what to do about it.
   */
  private envForLease(lease: LeaseRow): EnvRow {
    const env = this.journal.getEnv(lease.envId);
    if (!env) {
      throw new BrokerError(
        'env-error',
        `your lease points at environment ${lease.envId}, which no longer exists (it was recycled) — run 'runly up' to bind a fresh one`,
        'lease',
      );
    }
    return env;
  }

  ctx(cwd: string, holder?: string, envId?: string) {
    const stack = loadStack(cwd);
    const h = this.callerHolder(cwd, holder, stack);
    const lease = this.journal.leaseForHolder(h, stack.id);
    const targetId = envId ?? lease?.envId;
    if (!targetId) {
      throw new BrokerError('env-error', `no active lease for this worktree — run 'runly up' first`, 'lease');
    }
    const env = this.journal.getEnv(targetId);
    if (!env) {
      throw new BrokerError('env-error', `environment ${targetId} no longer exists (it was recycled) — run 'runly up' to bind a fresh one`, 'lease');
    }
    // Reading the context is not activity (decision 0039): an agent that only
    // polls `ctx` must not keep services awake. Only verbs that USE the
    // environment touch its clock (see touch()).
    const ctx = this.templateCtx(stack, env);
    // A subset env only reports the URLs it actually has up; a full env (active
    // undefined) reports everything, unchanged.
    const activeSet = env.activeServices ? new Set(env.activeServices) : null;
    const urls: Record<string, string> = {};
    for (const [name, s] of Object.entries(ctx.services)) {
      if (activeSet && !activeSet.has(name)) continue;
      urls[name] = s.url;
    }
    const previewUrls: Record<string, string> = {};
    if (lease?.previewService && lease.previewUrl) previewUrls[lease.previewService] = lease.previewUrl;
    return {
      stack: stack.manifest.name,
      envId: env.id,
      state: env.state,
      lease: lease ? { id: lease.id, kind: lease.kind, hygiene: lease.hygiene, expiresAt: lease.expiresAt } : null,
      urls,
      /** The environment's PUBLIC ports by manifest key (`runly ctx --env` → RUNLY_PORT_<KEY>). */
      ports: { ...env.ports },
      /**
       * The proxy in front of each public port, by port key (decision 0033):
       * state, client→server bytes and the last client byte's time. runly's
       * own readiness probes bypass it and are never counted.
       */
      proxy: this.proxy.stats(env.id),
      previewUrls,
      /**
       * Every declared service and where it stands (decision 0034): `running`,
       * `stopped` (wanted, but not running — a quiesce or a daemon restart; the
       * next `up` starts it) or `down` (not wanted: never started, or taken
       * down with `runly down`). `urls` lists the wanted ones.
       */
      services: this.serviceStates(stack, env),
      /** Services that crash-looped and were stopped (decision 0039), with their last exit; the next `up` retries them. */
      failures: this.serviceFailures(stack, env),
      /**
       * `logins` stays the PRIMARY login even for a stack that declares a list, so
       * a consumer reading `ctx.logins.user` is unaffected by the manifest growing
       * more of them; `allLogins` carries the full set. Both are null/omitted when
       * the stack declares none.
       */
      logins: normalizeLogins(stack.manifest.auth?.logins)[0] ?? null,
      allLogins: normalizeLogins(stack.manifest.auth?.logins),
      /**
       * The manifest's INTERNAL hook, templated and run inside the leased
       * environment — not something to run by hand. It still carries its
       * `{{role}}` placeholder, and run from a worktree it signs with the wrong
       * key, so a token minted that way comes back 401 and reads as a
       * permissions problem. `tokenVia` is the supported path.
       */
      tokenCommand: stack.manifest.auth?.token ?? null,
      tokenVia: stack.manifest.auth?.token ? 'runly token --role <role> --raw' : null,
      /**
       * Every datastore exists for the environment's whole life (decision
       * 0034). `preset` is what it holds now — the last preset restored into
       * it — or null before its first restore. `runly ctx --env` exports it as
       * RUNLY_DATASTORE_<NAME>_PRESET.
       */
      datastores: Object.fromEntries(Object.entries(ctx.datastores).map(([n, d]) => [n, { url: d.url, ns: d.ns, preset: env.datastoreNs[n] ? (env.presets[n] ?? null) : null }])),
      events: this.supervisors.get(env.id)?.events.slice(-20) ?? [],
    };
  }

  /**
   * Where each declared service stands: running, failed (wanted, crash-looped
   * and stopped — decision 0039), stopped (wanted, not running) or down (not
   * wanted).
   */
  private serviceStates(stack: Stack, env: EnvRow): Record<string, 'running' | 'failed' | 'stopped' | 'down'> {
    const running = new Set(Object.keys(this.supervisors.get(env.id)?.pids() ?? {}));
    const wanted = this.desiredServices(stack, env);
    return Object.fromEntries(Object.keys(stack.manifest.services).map((n) => [
      n,
      running.has(n) ? 'running' : !wanted.has(n) ? 'down' : this.failureOf(env.id, n) ? 'failed' : 'stopped',
    ]));
  }

  /** The failed services of `env` (decision 0039): how each last ended, and the log to read. */
  private serviceFailures(stack: Stack, env: EnvRow): Record<string, { reason: string; exitCode: number | null; signal: string | null; at: number; detail: string; hint: string }> {
    const states = this.serviceStates(stack, env);
    const out: Record<string, { reason: string; exitCode: number | null; signal: string | null; at: number; detail: string; hint: string }> = {};
    for (const [name, state] of Object.entries(states)) {
      const f = state === 'failed' ? this.failureOf(env.id, name) : undefined;
      if (f) out[name] = { reason: f.reason, exitCode: f.code, signal: f.signal, at: f.at, detail: describeExit(f), hint: `runly logs ${name}` };
    }
    return out;
  }

  /**
   * `runly warm`: run THIS worktree's due upkeep rules and its services'
   * `build:` steps, with no lease and no services (decision 0032). The intended
   * caller is an idle pool slot that was just moved to a new commit
   * (`git checkout <sha> && runly warm`): the installs are done and the build
   * tools' own incremental state is current, so the next agent's bind finds
   * the upkeep fresh and its builds near no-ops.
   *
   * Upkeep rules go through the same worktree ledger a bind reads, so a rule
   * warm ran is a rule the next bind skips. Builds are not recorded anywhere:
   * warm runs every one, and the next bind runs them again — cheaply, because
   * the build tool finds its output current. It holds the environment lock of
   * this worktree (if it has one: a check must not run while its output
   * changes underneath it) and then the worktree lock — the same order every
   * bind uses, so it can wait but never deadlock.
   *
   * What it cannot do without an environment it reports as skipped: a build
   * line that templates an environment's ports or datastores has no values to
   * run with, and `@` built-ins act on an environment's data.
   */
  async warm(cwd: string, onProgress?: Progress) {
    const started = performance.now();
    const stack = loadStack(cwd);
    const say = onProgress ?? (() => undefined);
    const envIds = this.journal.envsForStack(stack.id).map((e) => e.id);
    type Step =
      | ({ kind: 'upkeep' } & UpkeepStep)
      | { kind: 'build'; service: string; status: 'ran' | 'skipped' | 'failed'; durationMs: number; reason?: string };
    const steps: Step[] = [];
    let failure: { class: string; message: string; source?: string; logExcerpt?: string } | null = null;
    await this.envsLocked(envIds, () => this.treeLocked(stack.id, async () => {
      const ledger = this.treeLedgerSession(stack);
      try {
        const upkeep = await runUpkeep(stack.root, await triggerSet(stack.root, stack.manifest, worktreeStateDir(stack.id)), stack.manifest, ledger.get(), say, {
          builtins: false,
          commit: (fps) => ledger.commitRules(fps),
        });
        ledger.commitRules(upkeep.fingerprints);
        steps.push(...upkeep.steps.map((st) => ({ kind: 'upkeep' as const, ...st })));
      } catch (err) {
        const e = err instanceof BrokerError ? err : new BrokerError('work-error', String((err as Error).message ?? err), 'upkeep');
        failure = e.toJSON();
        return;
      }
      const env = envIds[0] !== undefined ? this.journal.getEnv(envIds[0]) : undefined;
      // Builds of one wave finish in any order; the steps are reported in
      // manifest order so the result does not depend on who finished first.
      const order = Object.keys(stack.manifest.services);
      const buildSteps = new Map<string, (typeof steps)[number]>();
      const flush = () => { for (const n of order) { const st = buildSteps.get(n); if (st) steps.push(st); } };
      // No environment means no ports, URLs or datastores to fill in, and
      // running the line with a placeholder would build the wrong thing.
      const buildable = order.filter((name) => {
        const b = buildOf(serviceOf(stack, name));
        if (!b) return false;
        if (/\{\{/.test(b.run)) {
          buildSteps.set(name, { kind: 'build', service: name, status: 'skipped', durationMs: 0, reason: 'its build line templates environment values; the next bind builds it' });
          return false;
        }
        return true;
      });
      try {
        await this.inWaves(this.buildWaves(stack, buildable), async (name) => {
          const buildStart = performance.now();
          try {
            // The same build ledger a bind reads (decision 0038): a `when:`
            // build warm ran is one the next `up` skips.
            const r = await this.buildService(stack, env, name, serviceOf(stack, name), undefined, say, { rebuild: false, mode: 'warm' });
            buildSteps.set(name, r.ran
              ? { kind: 'build', service: name, status: 'ran', durationMs: performance.now() - buildStart }
              : { kind: 'build', service: name, status: 'skipped', durationMs: 0, reason: 'when: unchanged since its last successful build' });
          } catch (err) {
            buildSteps.set(name, { kind: 'build', service: name, status: 'failed', durationMs: performance.now() - buildStart });
            throw err instanceof BrokerError ? err : new BrokerError('work-error', String((err as Error).message ?? err), name);
          }
        });
      } catch (err) {
        failure = (err as BrokerError).toJSON();
        return;
      } finally {
        flush();
      }
    }, (s) => say(`waiting for another bind in this worktree … ${s}s`)), (s) => say(`waiting for an operation on this worktree's environment … ${s}s`), 'a warm-up');
    const ran = steps.filter((st) => st.status === 'ran').length;
    logEvent({
      level: failure ? 'warn' : 'info',
      kind: 'warm',
      detail: `warmed ${stack.root}: ${ran} step(s) ran${failure ? `, then failed: ${(failure as { message: string }).message}` : ''}`,
    });
    return {
      ok: failure === null,
      stack: stack.manifest.name,
      root: stack.root,
      steps,
      failure,
      durationMs: performance.now() - started,
    };
  }

  async resetData(cwd: string, holder?: string, onProgress?: Progress, presets?: unknown) {
    const stack = loadStack(cwd);
    const h = this.callerHolder(cwd, holder, stack);
    const noLease = () => new BrokerError('env-error', `no active lease — run 'runly up' first`, 'lease');
    const forbiddenNotice = await this.enforceHolderPreviewForbidden(stack, h, onProgress);
    this.refuseCopiesOnlyPresets(stack, validatePresetRequest(stack.manifest, presets, stack.file));
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease || lease.expiresAt <= now()) throw noLease();
    const env = this.envForLease(lease);
    const resetStarted = performance.now();
    let queueMs = 0;
    const { previewNotice, bindDiagnostics } = await this.envLocked(
      env.id,
      () => {
        queueMs = performance.now() - resetStarted;
        const held = this.journal.leaseForHolder(h, stack.id);
        if (!held || held.id !== lease.id || held.expiresAt <= now()) throw noLease();
        this.journal.saveLease({ ...held, hygiene: 'reset-data' });
        return this.bindAndStart(stack, env, 'reset-data', onProgress, undefined, false, undefined, presets);
      },
      (s) => onProgress?.(`waiting for another operation on this environment … ${s}s`),
      'a data reset',
    );
    bindDiagnostics.phasesMs.queue = queueMs;
    bindDiagnostics.durationMs = performance.now() - resetStarted;
    return { ...this.ctx(cwd, h), previewNotice: previewNotice ?? forbiddenNotice, bindDiagnostics };
  }

  /**
   * Re-read an environment INSIDE its lock and refuse work on one that is being
   * torn down.
   *
   * Teardown claims the row under the pool lock and then runs slowly outside the
   * env lock, so a request that resolved its lease before the claim can arrive
   * here afterwards and operate on a tree that is about to be deleted (or
   * already is). bindAndStart already re-checks; exec and token
   * phase did not.
   */
  /**
   * Record that an environment was USED, without extending its lease.
   *
   * Activity is what keeps services awake (decision 0035), so only verbs that
   * USE the environment call this (decision 0039): `up` and `reset-data` (a
   * bind sets the clock itself), `exec`, `token`, `preview` and `down`. The
   * read-only verbs — `ctx`, `ps`, `plan`, `logs`, `status`, `db ls`,
   * `doctor` — do not: an agent polling them is not using a service, and
   * counting them kept idle services running for as long as anyone looked.
   */
  private touch(envId: string): void {
    try {
      this.journal.touchEnv(envId);
    } catch {
      /* the row may have been recycled — nothing to record */
    }
  }

  /** `resumable`: the caller starts idle-stopped services itself (resumeForVerb) instead of being refused. */
  private assertUsable(envId: string, opts: { resumable?: boolean } = {}): EnvRow {
    const fresh = this.journal.getEnv(envId);
    if (!fresh || fresh.state === 'recycling') {
      throw new BrokerError('env-error', `environment ${envId} is being recycled — retry`, 'pool');
    }
    // A daemon restart downgrades every hot env to warm: the lease survives but
    // the services do not. exec/token then failed against a tree with nothing
    // running, and the command's own error ("connection refused") read as the
    // repo's fault with no hint that a rebind was all it needed.
    // …but an environment whose lease wants NO services (`runly down`,
    // decision 0034) is warm by design: its ports and datastores are exactly
    // what the holder has. Refusing it here would break `exec` on the one shape
    // that has nothing else to offer.
    const wantsServices = fresh.activeServices === undefined || fresh.activeServices.length > 0;
    if (fresh.state === 'warm' && wantsServices && !opts.resumable) {
      throw new BrokerError(
        'env-error',
        `environment ${envId} holds your lease but its services are not running (the daemon restarted) — run 'runly up' to rebind before exec/token`,
        'lease',
      );
    }
    return fresh;
  }

  async exec(cwd: string, cmd: string, holder?: string) {
    const stack = loadStack(cwd);
    const h = this.callerHolder(cwd, holder, stack);
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'runly up' first`, 'lease');
    const env = this.envForLease(lease);
    const ctx = this.templateCtx(stack, env);
    const extra: Record<string, string> = { BACKLOT_ENV_ID: env.id };
    for (const [name, port] of Object.entries(env.ports)) extra[`BACKLOT_PORT_${name.toUpperCase()}`] = String(port);
    // Match ctx: on a subset env only the services that are actually up get a
    // URL, so an exec'd command doesn't dereference a service the agent was told
    // is down (the port is stable but nothing is listening on it).
    const activeSet = env.activeServices ? new Set(env.activeServices) : null;
    for (const [name, s] of Object.entries(ctx.services)) {
      if (activeSet && !activeSet.has(name)) continue;
      extra[`BACKLOT_URL_${name.toUpperCase()}`] = s.url;
    }
    for (const [name, d] of Object.entries(ctx.datastores)) extra[`BACKLOT_DS_${name.toUpperCase()}`] = d.url;
    // The names `runly ctx --env` prints, so a script reads one set whether it
    // runs under `exec` or after `eval "$(runly ctx --env)"`.
    Object.assign(extra, runlyEnvVars({
      envId: env.id,
      ports: env.ports,
      urls: Object.fromEntries(Object.entries(ctx.services).filter(([n]) => !activeSet || activeSet.has(n)).map(([n, s]) => [n, s.url])),
      datastores: Object.fromEntries(Object.entries(ctx.datastores).map(([n, d]) => [n, { url: d.url, preset: env.datastoreNs[n] ? (env.presets[n] ?? null) : null }])),
      logins: normalizeLogins(stack.manifest.auth?.logins)[0] ?? null,
    }));
    return this.envLocked(env.id, async () => {
      await this.resumeForVerb(this.assertUsable(env.id, { resumable: true }), 'exec');
      this.touch(env.id);
      // Bounded, detached, and tagged like a service: an exec blocking on stdin
      // held the env's busy bit forever, and its untagged children were
      // invisible to `pool gc` after a daemon crash.
      const timeoutS = cmdTimeoutS(LONG_CMD_TIMEOUT_S);
      // In the worktree, where the environment runs (decision 0032).
      const r = await runBoundedIO(cmd, stack.root, timeoutS, {
        ...process.env,
        ...extra,
        ...serviceTag(env.id, 'exec', stateRoot()),
      });
      if (r.timedOut) {
        throw new BrokerError('work-error', `exec timed out after ${timeoutS}s (process group killed; set BACKLOT_CMD_TIMEOUT_S if legitimate)`, 'exec', r.stderr.slice(-800));
      }
      return { exitCode: r.code, stdout: r.stdout.slice(-8000), stderr: r.stderr.slice(-8000) };
    }, undefined, 'an exec');
  }

  /** Resolve auth.token with {{role}} and run it in the worktree the environment runs in. */
  async token(cwd: string, role: string, holder?: string) {
    const stack = loadStack(cwd);
    const spec = stack.manifest.auth?.token;
    if (!spec) throw new BrokerError('work-error', `${manifestFileOf(stack)} declares no auth.token command`, 'manifest');
    // The role is spliced into a SHELL line ({{role}}), so it may only be a
    // name: `--role 'x; rm -rf ~'` ran the rest as a command. It also rides in
    // the environment as RUNLY_ROLE, for a hook that prefers to read it there.
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:@+-]*$/.test(role)) {
      throw new BrokerError('work-error', `--role must be a name (letters, digits and _ . : @ + -), got ${JSON.stringify(role)}`, 'auth');
    }
    const lease = this.journal.leaseForHolder(this.callerHolder(cwd, holder, stack), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'runly up' first`, 'lease');
    const env = this.envForLease(lease);
    const ctx = { ...this.templateCtx(stack, env), role };
    return this.envLocked(env.id, async () => {
      await this.resumeForVerb(this.assertUsable(env.id, { resumable: true }), 'token');
      this.touch(env.id);
      const timeoutS = cmdTimeoutS();
      const r = await runBoundedIO(template(spec, ctx), stack.root, timeoutS, { ...process.env, RUNLY_ROLE: role });
      if (r.timedOut) {
        throw new BrokerError('work-error', `auth.token command timed out after ${timeoutS}s (process group killed)`, 'auth', r.stderr.slice(-400));
      }
      if (r.code !== 0) throw new BrokerError('work-error', `auth.token command failed`, 'auth', r.stderr.slice(-400));
      return { token: r.stdout.trim(), role };
    }, undefined, 'a token command');
  }

  /**
   * Where this worktree's environment keeps the logs of `services` (decision
   * 0038) — all of them when none are named. The CLI reads, filters and
   * follows the files itself; the daemon only resolves which ones. With
   * `build`, the build output of each service's last build, and the upkeep
   * output of the last `up` that ran a rule.
   */
  logsSpec(cwd: string, services: string[], build: boolean, holder?: string) {
    const stack = loadStack(cwd);
    for (const name of services) {
      if (!stack.manifest.services[name]) {
        throw new BrokerError('work-error', `no service '${name}' in ${manifestFileOf(stack)} (have: ${Object.keys(stack.manifest.services).join(', ')})`, name);
      }
    }
    const lease = this.journal.leaseForHolder(this.callerHolder(cwd, holder, stack), stack.id);
    const env = lease ? this.envForLease(lease) : this.journal.envsForStack(stack.id)[0];
    if (!env) throw new BrokerError('env-error', `this worktree has no environment — run 'runly up' first`, 'lease');
    // Reading logs is not activity (decision 0039).
    const dir = this.envDirs(env.id).logs;
    const names = services.length > 0 ? services : Object.keys(stack.manifest.services);
    const files = names.map((service) => ({ service, file: build ? buildLogOf(dir, service) : logFileOf(dir, service) }));
    if (build && services.length === 0) files.unshift({ service: UPKEEP_LOG, file: buildLogOf(dir, UPKEEP_LOG) });
    return { envId: env.id, dir, build, files };
  }

  /** The pre-0.16 single-service read, kept for RPC clients: the last `lines` lines, without stamps. */
  logs(cwd: string, service: string, lines: number, holder?: string) {
    const spec = this.logsSpec(cwd, [service], false, holder);
    const file = spec.files[0]?.file;
    const content = file ? readLog(file, service).map((l) => l.text) : [];
    return { service, lines: content.slice(-lines).join('\n') };
  }

  /**
   * Hand the environment back. A no-op answer must say WHY.
   *
   * A lease is keyed by holder NAME, which defaults to the worktree path — so
   * releasing from a different directory than the one that bound silently
   * matches nothing. `{released: false}` on its own gave an agent no way to tell
   * that apart from "already released", and the reported behaviour was simply to
   * give up and let the environment linger until its TTL. Name the mismatch, and
   * list who does hold this stack's leases.
   */
  async release(cwd: string, holder?: string) {
    const stack = loadStack(cwd);
    const asked = this.callerHolder(cwd, holder, stack);
    const lease = this.journal.leaseForHolder(asked, stack.id);
    if (!lease) {
      const others = this.journal
        .allLeases()
        .filter((l) => this.journal.getEnv(l.envId)?.stack === stack.id)
        .map((l) => l.holder);
      return {
        released: false,
        holder: asked,
        reason: others.length
          ? `no lease is held by '${asked}' — this stack's leases belong to ${others.map((h) => `'${h}'`).join(', ')}; ` +
            `release from the directory that bound, or pass --holder <name>`
          : `no lease is held by '${asked}', and this stack has no leases at all — it was already released or it expired`,
        otherHolders: others,
      };
    }
    await this.endLease(lease);
    return { released: true, envId: lease.envId };
  }

  private previewPublisherName(stack: Stack): string {
    const fromManifest = stack.manifest.preview?.publisher?.trim();
    if (fromManifest) return fromManifest;
    const fromEnv = process.env.BACKLOT_PREVIEW_PUBLISHER?.trim();
    if (fromEnv) return fromEnv;
    return DEFAULT_PREVIEW_PUBLISHER;
  }

  private assertPreviewAllowed(stack: Stack): void {
    if (stack.manifest.preview?.forbidden) {
      throw new BrokerError(
        'work-error',
        `this stack forbids public preview in ${manifestFileOf(stack)} (preview.forbidden) — the manifest must not be published to the internet`,
        'manifest',
      );
    }
  }

  /**
   * Tagged members of a verified leased preview process group. A publisher's
   * wrapper can fork its tunnel child; excluding only the leader lets a scan
   * select the child and kill the whole leased group. All scan consumers share
   * this classification, using the same state-root-scoped process snapshot.
   *
   * Ownership requires the recorded leader identity AND matching env tags.
   * A stale/reused leader PID, an unreadable identity, or a generic preview:
   * service label cannot exempt another process. Descendants that leave the
   * group (setsid) need a separate ownership mechanism and are not protected.
   */
  private leasedPreviewPids(tagged: TaggedProc[]): Set<number> {
    const byPid = new Map(tagged.map((p) => [p.pid, p]));
    const groups = new Map<string, Set<number>>();
    for (const lease of this.journal.allLeases()) {
      if (lease.previewPid === undefined || lease.previewStart === undefined) continue;
      const leader = byPid.get(lease.previewPid);
      if (!leader || leader.envId !== lease.envId || leader.startTime !== lease.previewStart) continue;
      const group = processGroup(leader.pid);
      // Check identity after reading the group so an exited/reused leader
      // cannot lend its replacement's process group to the old lease.
      if (group === undefined || !sameProcess(leader.pid, lease.previewStart)) continue;
      const owned = groups.get(lease.envId) ?? new Set<number>();
      owned.add(group);
      groups.set(lease.envId, owned);
    }
    const pids = new Set<number>();
    for (const proc of tagged) {
      const owned = groups.get(proc.envId);
      if (!owned) continue;
      const group = processGroup(proc.pid);
      if (group !== undefined && owned.has(group) && sameProcess(proc.pid, proc.startTime)) pids.add(proc.pid);
    }
    return pids;
  }

  /**
   * Stop and clear any lease-scoped preview tunnel recorded on this lease.
   *
   * Teardown may NEVER be blocked by a manifest edit: `preview.publisher` is
   * re-read from disk on every call, so a name that resolved at start can be a
   * typo by the time the sweeper gets here — and an unknown name throws a
   * work-error. Thrown from the sweeper's lease loop that aborted every tick,
   * so TTL expiry, dead-holder release and eviction stopped daemon-wide. The
   * teardown path therefore falls back to the default publisher instead.
   *
   * Returns false when the tunnel could NOT be confirmed dead. The record is
   * kept in that case (reapPids' contract): a forgotten preview pid is a
   * public, unauthenticated URL nobody can ever name again.
   */
  private async stopPreviewForLease(lease: LeaseRow): Promise<boolean> {
    if (!lease.previewPid) return true;
    let pub = resolvePreviewPublisher(DEFAULT_PREVIEW_PUBLISHER);
    const env = this.journal.getEnv(lease.envId);
    if (env) {
      try {
        pub = resolvePreviewPublisher(this.previewPublisherName(loadStack(env.stackRoot)));
      } catch {
        /* stack root unreadable, or the manifest now names an unknown publisher — still reap the tunnel */
      }
    }
    let stopped = false;
    try {
      stopped = await pub.stop({ pid: lease.previewPid, startTime: lease.previewStart });
    } catch (err) {
      logEvent({
        level: 'warn',
        kind: 'preview',
        envId: lease.envId,
        detail: `stopping the preview tunnel failed: ${String((err as Error).message ?? err)}`,
      });
    }
    if (!stopped) {
      logEvent({ level: 'error', kind: 'preview', envId: lease.envId, detail: this.unreapedPreview(lease) });
      return false;
    }
    this.journal.clearLeasePreview(lease.id, lease.previewPid);
    return true;
  }

  /**
   * What an operator can actually do about a tunnel that outlived its kill.
   *
   * Pointing at `pool gc` was only ever true on Linux — it is a tag scan, and
   * `procScanSupported()` is Linux-only — which is precisely the platform where
   * the record is NOT recoverable. Name the pid and the public URL instead, so
   * the remedy survives the lease row that is usually about to be deleted.
   */
  private unreapedPreview(lease: LeaseRow): string {
    const where = procScanSupported()
      ? `'runly pool gc' can still reclaim it by tag`
      : `there is no tag scan on this platform — kill pid ${lease.previewPid} by hand`;
    return (
      `the preview tunnel (pid ${lease.previewPid}) could not be confirmed dead —` +
      ` ${lease.previewUrl ?? 'its public URL'} may still be serving, unauthenticated; ${where}`
    );
  }

  /**
   * Release a lease and reap its preview tunnel first.
   *
   * Re-read between the stop and the delete. `release` and the sweeper hold no
   * env lock, and the stop blocks in `killGroupVerified` for up to ~4s — long
   * enough for a concurrent `preview` to take the env lock, publish, and write
   * its pid onto this very row. Deleting the row on the strength of the old
   * snapshot then orphaned the NEW tunnel: no lease names it, `pool gc` skips
   * nothing it can see, and `preview stop` has nothing left to stop. Taking the
   * env lock here instead would nest it inside the pool lock (tryClaim calls
   * this) and stall every claim machine-wide for the length of a bind.
   */
  private async endLease(lease: LeaseRow): Promise<void> {
    let row: LeaseRow | undefined = lease;
    for (let attempt = 0; attempt < 4 && row?.previewPid; attempt++) {
      const stopped = row.previewPid;
      await this.stopPreviewForLease(row);
      const fresh = this.journal.leaseForEnv(lease.envId);
      if (!fresh || fresh.id !== lease.id || fresh.previewPid === stopped) break;
      row = fresh;
    }
    const last = this.journal.leaseForEnv(lease.envId);
    if (last?.id === lease.id && last.previewPid) {
      logEvent({ level: 'error', kind: 'preview', envId: lease.envId, detail: this.unreapedPreview(last) });
    }
    this.journal.deleteLease(lease.id);
    this.leaseInputs.delete(lease.id);
    this.goneSince.delete(`lease:${lease.id}`);
  }

  /**
   * Everything about an environment that decides whether publishing `service`
   * is legal, and the local port to publish. Returns that port.
   *
   * One function because it has to run TWICE — once before queueing for the env
   * lock, and again inside it against a re-read row. Every field it reads is one
   * a concurrent bind rewrites.
   */
  private previewTarget(env: EnvRow, stack: Stack, service: string): number {
    const spec = stack.manifest.services[service];
    if (!spec) {
      throw new BrokerError('work-error', `no service '${service}' in ${manifestFileOf(stack)}`, 'manifest');
    }
    const activeSet = env.activeServices ? new Set(env.activeServices) : null;
    if (activeSet && !activeSet.has(service)) {
      throw new BrokerError(
        'work-error',
        activeSet.size === 0
          ? `service '${service}' is down — this lease runs no services; 'runly up ${service}' first`
          : `service '${service}' is not up on this lease — only ${[...activeSet].map((s) => `'${s}'`).join(', ')} are; 'runly up ${service}' adds it`,
        'preview',
      );
    }
    if (!spec.port) {
      throw new BrokerError('work-error', `service '${service}' has no port — preview publishes a network port`, 'preview');
    }
    const port = env.ports[spec.port];
    if (!port) {
      throw new BrokerError('env-error', `service '${service}' has no allocated port on this environment`, 'preview');
    }
    return port;
  }

  async previewStart(cwd: string, service: string, holder?: string, ttlMs?: number, httpsPort?: number): Promise<{ service: string; url: string }> {
    const stack = loadStack(cwd);
    this.assertPreviewAllowed(stack);
    const h = this.callerHolder(cwd, holder, stack);
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease) {
      throw new BrokerError('env-error', `no active lease for this worktree — run 'runly up' first`, 'lease');
    }
    // Fast fail before queueing behind a bind that may hold the lock for
    // minutes; re-run authoritatively INSIDE the lock below.
    this.previewTarget(this.envForLease(lease), stack, service);
    const env = this.assertUsable(this.envForLease(lease).id);
    const pub = resolvePreviewPublisher(this.previewPublisherName(stack));
    return this.envLocked(env.id, async () => {
      // Re-read INSIDE the lock. `lease` was resolved before queueing, so a
      // publish that ran while we waited has already replaced the pid it names;
      // stopping the snapshot's pid would kill nothing and then forget the live
      // tunnel — an orphaned public URL. This is the row we may act on.
      const held = this.journal.leaseForHolder(h, stack.id);
      if (!held || held.id !== lease.id) {
        throw new BrokerError('env-error', `the lease was replaced while this preview was queued — retry`, 'lease');
      }
      // …and the ENVIRONMENT with it. Everything that decides whether publishing
      // is legal — the lease's shape, its slice, its port ledger — is a field on
      // a row a `down web` or a failed bind queued ahead of us has already
      // rewritten. Judging that from the pre-lock snapshot published a PUBLIC,
      // unauthenticated URL for a port nothing was listening on any more, and
      // nothing re-examines a lease-scoped tunnel until the next bind.
      const live = this.assertUsable(env.id);
      const localPort = this.previewTarget(live, stack, service);
      // Before the destructive step, not after it: `checkPrerequisite` used to
      // run inside `pub.start`, so a cloudflared that went missing since the
      // last publish killed the working tunnel and then failed, leaving the
      // caller with no preview and an error that reads as if nothing happened.
      pub.checkPrerequisite();
      // Publishing over an unconfirmed pid would overwrite the only record of a
      // tunnel that may still be serving — the exact loss stopPreviewForLease
      // keeps the row to prevent.
      if (!(await this.stopPreviewForLease(held))) {
        throw new BrokerError('infra-error', this.unreapedPreview(held), 'preview');
      }
      const dirs = this.envDirs(env.id);
      const { url, pid } = await pub.start({
        envId: env.id,
        service,
        // `localhost`, the same origin ctx advertises for the service — never a
        // literal 127.0.0.1. Node 17+ resolves `localhost` to ::1 first, so a dev
        // server bound to `localhost` (ng serve, vite) often listens on [::1]
        // ONLY, and a tunnel aimed at 127.0.0.1 then answers 502 for a service
        // that is perfectly up. Both cloudflared and tailscale resolve
        // `localhost` to whichever loopback is listening.
        localUrl: `http://localhost:${localPort}`,
        logDir: dirs.logs,
        // A caller's --https-port outranks the manifest for this publish only;
        // publishers that do not serve on a port ignore it (decision 0031).
        settings: httpsPort !== undefined ? { ...stack.manifest.preview, https_port: httpsPort } : stack.manifest.preview,
      });
      // Identity, not mere existence: `pub.start` can take up to 45s holding only
      // this env's lock, and a concurrent release + `up` in that window hands the
      // holder a DIFFERENT lease on a DIFFERENT environment. Writing the tunnel
      // onto that row would advertise env A's port as env B's preview and leave
      // env A to return to the pool publishing the next holder's services.
      const freshLease = this.journal.leaseForHolder(h, stack.id);
      if (!freshLease || freshLease.id !== lease.id) {
        if (!(await pub.stop(pid))) {
          logEvent({
            level: 'error',
            kind: 'preview',
            envId: env.id,
            detail: `the lease lapsed mid-publish and the new tunnel (pid ${pid.pid}) outlived its kill — ${url} may still be serving, unauthenticated`,
          });
        }
        throw new BrokerError(
          'env-error',
          `the lease this preview was published for ${freshLease ? 'was replaced' : 'lapsed'} while cloudflared was starting — retry after binding again`,
          'lease',
        );
      }
      freshLease.previewService = service;
      freshLease.previewUrl = url;
      freshLease.previewPid = pid.pid;
      freshLease.previewStart = pid.startTime;
      freshLease.previewPort = localPort;
      // The lease clock only ever moves on a SUCCESSFUL publish, like every
      // other verb that takes --ttl: `preview nosuchservice --ttl 60` used to
      // extend the lease and then fail.
      if (ttlMs !== undefined && ttlMs > 0) freshLease.expiresAt = now() + ttlMs;
      this.journal.saveLease(freshLease);
      this.touch(env.id);
      logEvent({ level: 'info', kind: 'preview', envId: env.id, detail: `published '${service}' at ${url}` });
      return { service, url };
    }, undefined, 'a preview publish');
  }

  async previewStop(cwd: string, holder?: string): Promise<{ stopped: boolean; service?: string }> {
    const stack = loadStack(cwd);
    const h = this.callerHolder(cwd, holder, stack);
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease) {
      throw new BrokerError('env-error', `no active lease for this worktree — nothing to stop`, 'lease');
    }
    // Under the same lock as previewStart, and re-read inside it: unlocked, a
    // stop racing a publish killed the old pid and cleared the row the publish
    // had just written, losing the new tunnel.
    return this.envLocked(lease.envId, async () => {
      const held = this.journal.leaseForHolder(h, stack.id);
      if (!held || held.id !== lease.id) return { stopped: false };
      if (!held.previewPid) return { stopped: false };
      const service = held.previewService;
      if (!(await this.stopPreviewForLease(held))) {
        throw new BrokerError('infra-error', this.unreapedPreview(held), 'preview');
      }
      logEvent({ level: 'info', kind: 'preview', envId: held.envId, detail: `stopped preview for '${service ?? 'unknown'}'` });
      return { stopped: true, service };
    }, undefined, 'a preview stop');
  }

  /** Live-probed appliance overview for the stack at cwd. */
  async applianceLs(cwd: string) {
    const stack = loadStack(cwd);
    const appliances: Record<string, { probe: string; up: boolean; startable: boolean; stoppable: boolean }> = {};
    for (const [name, spec] of Object.entries(stack.manifest.appliances ?? {})) {
      appliances[name] = {
        probe: spec.probe,
        up: await probeTcp(spec.probe),
        startable: Boolean(spec.start),
        stoppable: Boolean(spec.stop),
      };
    }
    return { stack: stack.manifest.name, appliances };
  }

  /** Ensure one appliance (or all of them) — the same path a bind takes. */
  async applianceStart(cwd: string, name?: string) {
    const stack = loadStack(cwd);
    const specs = Object.entries(stack.manifest.appliances ?? {}).filter(([n]) => !name || n === name);
    if (name && specs.length === 0) {
      throw new BrokerError('work-error', `no appliance '${name}' in ${manifestFileOf(stack)}`, 'appliance');
    }
    const results: Record<string, string> = {};
    for (const [n, spec] of specs) {
      results[n] = await ensureAppliance(n, spec, stack.root, () => undefined);
      if (results[n] !== 'up') logEvent({ level: 'info', kind: 'appliance', detail: `'${n}' ${results[n]} (${spec.probe})` });
    }
    return { results };
  }

  /** Explicit stop — the only path that ever stops an appliance. */
  async applianceStop(cwd: string, name: string) {
    const stack = loadStack(cwd);
    const spec = stack.manifest.appliances?.[name];
    if (!spec) throw new BrokerError('work-error', `no appliance '${name}' in ${manifestFileOf(stack)}`, 'appliance');
    await stopAppliance(name, spec, stack.root);
    this.startedAppliances.delete(spec.probe);
    logEvent({ level: 'info', kind: 'appliance', detail: `'${name}' stopped (${spec.probe})` });
    return { stopped: name };
  }

  // ---------------------------------------------------------------- down

  /**
   * `runly down [service…]` (decision 0034): stop just these services — or,
   * with no names, every service — and keep the lease, the data and the public
   * ports. The proxy keeps listening; connections to a downed service are
   * refused until an `up` brings it back. Dependents of a downed service are
   * NOT stopped ("just those"); they are named in the answer, because they now
   * talk to a port with nothing behind it.
   */
  async down(opts: { cwd: string; holder?: string; services: string[]; onProgress?: Progress }) {
    const stack = loadStack(opts.cwd);
    const h = this.callerHolder(opts.cwd, opts.holder, stack);
    const say = opts.onProgress ?? (() => undefined);
    for (const name of opts.services) {
      if (!stack.manifest.services[name]) {
        throw new BrokerError('work-error', `no service '${name}' in ${manifestFileOf(stack)} (have: ${Object.keys(stack.manifest.services).join(', ') || 'none'}) — only services are named here; datastores stay for the environment's life (decision 0034)`, 'manifest');
      }
    }
    const noLease = () => new BrokerError('env-error', `no active lease for this worktree — there is nothing to take down ('runly up' first)`, 'lease');
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease || lease.expiresAt <= now()) throw noLease();
    const env = this.envForLease(lease);
    const outcome = await this.envLocked(env.id, async () => {
      const held = this.journal.leaseForHolder(h, stack.id);
      if (!held || held.id !== lease.id || held.expiresAt <= now()) throw noLease();
      const live = this.journal.getEnv(env.id);
      if (!live || live.state === 'recycling') throw new BrokerError('env-error', `environment ${env.id} is being recycled — retry`, 'pool');
      const wanted = this.desiredServices(stack, live);
      const runningBefore = Object.keys(this.supervisor(live).pids());
      const names = opts.services.length > 0 ? [...new Set(opts.services)] : [...new Set([...Object.keys(stack.manifest.services), ...runningBefore])];
      const stopping = names.filter((n) => runningBefore.includes(n));
      if (stopping.length > 0) say(`stopping ${stopping.map((n) => `'${n}'`).join(', ')}`);
      if (opts.services.length === 0) await this.stopForBind(live);
      else if (stopping.length > 0) await this.stopServicesForRestart(live, stopping);
      const fresh = this.journal.getEnv(env.id);
      if (!fresh) throw new BrokerError('env-error', `environment ${env.id} was recycled during down — retry`, 'pool');
      const remaining = new Set([...wanted].filter((n) => !names.includes(n)));
      for (const n of names) this.failedServices.delete(`${env.id}\0${n}`);
      fresh.activeServices = this.recordedShape(stack, remaining);
      const stillRunning = Object.keys(this.supervisor(fresh).pids());
      if (stillRunning.length === 0 && fresh.state === 'hot') fresh.state = 'warm';
      fresh.lastUsedAt = now();
      this.journal.saveEnv(fresh);
      // A preview of a service that is now down would publish a port with
      // nothing behind it for the rest of the lease.
      const previewNotice = await this.reconcilePreviewForBind(fresh, stack, remaining, say, { hygiene: 'reuse', portsReallocated: false });
      const dependents = stillRunning.filter((n) => (stack.manifest.services[n]?.depends_on ?? []).some((d) => names.includes(d)));
      return { stopped: stopping, down: names.filter((n) => n in stack.manifest.services), dependentsStillRunning: dependents, previewNotice };
    }, (s) => say(`waiting for another operation on this environment … ${s}s`), 'a down');
    logEvent({ level: 'info', kind: 'down', envId: env.id, detail: `down ${outcome.down.join(', ') || '(nothing)'}; stopped ${outcome.stopped.length} running service(s); lease, data and ports kept` });
    return { ...this.ctx(opts.cwd, h, env.id), ...outcome };
  }

  // ---------------------------------------------------------------- db copies

  /** In-flight creations and drops of database copies; the reaper never touches these. */
  private dbBusy = new Set<string>();

  /** What `db new` / `db ls` / `ps` show for one copy. */
  private dbCopyView(c: DbCopyRow) {
    return {
      name: c.name,
      datastore: c.datastore,
      preset: c.preset,
      url: c.url,
      ns: c.ns,
      state: c.state,
      worktree: c.stackRoot,
      holder: c.holder,
      holderPid: c.holderPid ?? null,
      /** null = no agent tether was given: the copy lives until its worktree goes or it is dropped. */
      holderAlive: c.holderPid === undefined ? null : !this.holderGone(c.holderPid, c.holderStart),
      createdAt: c.createdAt,
    };
  }

  /**
   * Is a recorded holder process gone? One rule for leases and database copies
   * alike (decision 0034: copies are reaped exactly like environments), so a
   * grace period added here applies to both.
   */
  private holderGone(pid: number, start?: number): boolean {
    return !sameProcess(pid, start);
  }

  /**
   * `runly db new <datastore>` (decision 0034): a fresh copy of the datastore,
   * restored from the SAME template the environments use (baked first if it is
   * missing), outside any environment — no lease, no ports, no services. Many
   * may exist at once. The row is journalled BEFORE the restore, as
   * `creating`, so a daemon that dies mid-restore leaves a record the next one
   * reaps.
   */
  async dbNew(opts: { cwd: string; datastore: string; preset?: string; holder?: string; holderPid?: number; onProgress?: Progress }) {
    const say = opts.onProgress ?? (() => undefined);
    const stack = loadStack(opts.cwd);
    const stores = stack.manifest.datastores ?? {};
    const spec = stores[opts.datastore];
    if (!spec) {
      throw new BrokerError('work-error', `no datastore '${opts.datastore}' in ${manifestFileOf(stack)} (have: ${Object.keys(stores).join(', ') || 'none'})`, 'manifest');
    }
    const chosen = validatePresetRequest(stack.manifest, opts.preset === undefined ? undefined : { [opts.datastore]: opts.preset }, stack.file);
    const preset = chosen[opts.datastore] ?? defaultPresetFor(opts.datastore, spec);
    const holder = this.callerHolder(opts.cwd, opts.holder, stack);
    if (opts.holderPid !== undefined && !isAlive(opts.holderPid)) {
      throw new BrokerError('work-error', `holder pid ${opts.holderPid} is not a live process — the copy would be dropped the moment it is created`, 'lease');
    }
    let short = shortId();
    while (this.journal.getDbCopy(`${opts.datastore}-${short}`)) short = shortId();
    const name = `${opts.datastore}-${short}`;
    // Templates are keyed by content (vetbill-1i49), so the bake key comes from
    // the worktree's trigger files exactly as a bind computes it. The trigger
    // cache is written atomically, so this needs no worktree lock — a copy
    // never waits for a bind's builds.
    const bakeKeys = templateBakeKeys(stack.manifest, stack.root, await triggerSet(stack.root, stack.manifest, worktreeStateDir(stack.id)));
    const ds = makeDatastore(opts.datastore, spec, stack.id, bakeKeys[opts.datastore]);
    const dir = join(dbCopiesRoot(), name);
    const h: DsHandle = { envId: `${stack.id}-db-${short}`, cwd: stack.root, dataDir: dir };
    const dropCmd = ds.dropCommand(h);
    if (!ds.fileBased && dropCmd === null) {
      throw new BrokerError('work-error', `datastore '${opts.datastore}' declares no drop: command, so runly could never remove a copy of it — add one to ${manifestFileOf(stack)}`, 'manifest');
    }
    const row: DbCopyRow = {
      name, stack: stack.id, stackRoot: stack.root, datastore: opts.datastore, preset,
      ns: ds.ns(h), url: ds.url(h), state: 'creating', holder, ...holderIdentity(opts.holderPid),
      dropCmd: dropCmd ?? undefined, dropCwd: stack.root, dropPath: ds.fileBased ? dir : undefined,
      createdAt: now(), dropAttempts: 0, nextDropAt: 0,
    };
    this.dbBusy.add(name);
    this.journal.saveDbCopy(row);
    try {
      for (const [appliance, aspec] of Object.entries(stack.manifest.appliances ?? {})) {
        const state = await ensureAppliance(appliance, aspec, stack.root, say);
        if (state !== 'up') logEvent({ level: 'info', kind: 'appliance', detail: `'${appliance}' ${state} (${aspec.probe})` });
      }
      if (ds.fileBased) mkdirSync(dir, { recursive: true });
      await ds.probe();
      say(`restoring '${opts.datastore}' (${preset}) into ${name}`);
      await ds.ensure(h, preset, true, false);
      row.state = 'ready';
      row.template = ds.templateRef(preset) ?? undefined;
      this.journal.saveDbCopy(row);
      logEvent({ level: 'info', kind: 'db', detail: `created database copy ${name} of '${opts.datastore}' (${preset}) for ${holder}${row.holderPid ? ` (pid ${row.holderPid})` : ''}` });
      return this.dbCopyView(row);
    } catch (err) {
      // Whatever the restore got as far as creating goes again. A drop that
      // fails leaves the row for the reaper.
      try {
        await this.dropDbCopy(row, 'its creation failed');
      } catch { /* the reaper retries */ }
      throw err;
    } finally {
      this.dbBusy.delete(name);
    }
  }

  /**
   * `runly db with` records the command it runs against a copy (decision
   * 0039), so a drop can take that command down first when its CLI died.
   */
  dbAttach(name: string, child: { pid: number; start?: number; pgid?: number }) {
    if (!Number.isInteger(child.pid) || child.pid <= 0) throw new BrokerError('work-error', 'db-attach needs the pid of the command', 'db');
    if (child.pgid !== undefined && child.pgid !== child.pid) throw new BrokerError('work-error', 'db-attach: a recorded process group must be led by the command itself', 'db');
    const row = this.journal.getDbCopy(name);
    if (!row) throw new BrokerError('work-error', `no database copy '${name}'`, 'db');
    row.child = { pid: child.pid, ...(child.start !== undefined && Number.isFinite(child.start) ? { start: child.start } : {}), ...(child.pgid !== undefined ? { pgid: child.pgid } : {}) };
    this.journal.saveDbCopy(row);
    return { attached: name };
  }

  /**
   * Stop whatever still runs against copy `row` (decision 0039): the command
   * `runly db with` recorded — its process group when it has its own, else
   * the verified pid — and, on Linux, every process carrying the copy's tag.
   * Only a pid whose start time still matches is signalled. Returns how many
   * processes were stopped.
   */
  private async stopCopyUsers(row: DbCopyRow): Promise<number> {
    const kills: Array<Promise<boolean>> = [];
    const c = row.child;
    if (c && sameProcess(c.pid, c.start)) {
      // killGroupVerified signals the group only through a verified leader.
      kills.push(c.pgid !== undefined ? this.reapServiceGroup(c.pid, c.start, 2000, c.pgid) : killPidVerified(c.pid, c.start));
    }
    for (const p of scanDbCopy(row.name, stateRoot())) {
      if (p.pid === process.pid || p.pid === c?.pid) continue;
      kills.push(killPidVerified(p.pid, p.startTime));
    }
    await Promise.all(kills);
    const stopped = kills.length;
    if (stopped > 0) logEvent({ level: 'info', kind: 'db', detail: `stopped ${stopped} process(es) of 'runly db with' still running against ${row.name} before dropping it` });
    return stopped;
  }

  /** Is `path` a copy's own directory under the state root (never anything else)? */
  private isPrivateDbDir(path: string): boolean {
    const rel = relative(dbCopiesRoot(), path);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !rel.includes(sep);
  }

  /**
   * Drop one copy with what its row recorded — the command (run in the
   * worktree, or the state root once that is gone) or its private directory.
   * Needs neither the manifest nor the worktree. A failed drop keeps the row
   * (`dropping`) with a backoff, so the reaper retries instead of forgetting a
   * database nothing else can name. Callers hold `dbBusy` for the name.
   */
  private async dropDbCopy(row: DbCopyRow, reason: string): Promise<{ ok: boolean; output?: string }> {
    const live = this.journal.getDbCopy(row.name);
    if (!live) return { ok: true };
    live.state = 'dropping';
    this.journal.saveDbCopy(live);
    // Nothing may go on working against a database that is about to vanish.
    try {
      await this.stopCopyUsers(live);
    } catch (err) {
      logEvent({ level: 'warn', kind: 'db', detail: `stopping the command of ${live.name} failed: ${String((err as Error).message ?? err)}` });
    }
    let ok = true;
    let output: string | undefined;
    if (live.dropCmd) {
      const cwd = live.dropCwd && existsSync(live.dropCwd) ? live.dropCwd : stateRoot();
      const r = await runBounded(live.dropCmd, cwd, cmdTimeoutS());
      if (r.timedOut || r.code !== 0) {
        ok = false;
        output = r.output.slice(-800);
      }
    }
    if (ok && live.dropPath) {
      if (this.isPrivateDbDir(live.dropPath)) rmSync(live.dropPath, { recursive: true, force: true });
      else {
        ok = false;
        output = `refused to delete ${live.dropPath}: it is not a copy directory under ${dbCopiesRoot()}`;
      }
    }
    if (ok) {
      this.journal.deleteDbCopy(live.name);
      this.goneSince.delete(`copy:${live.name}`);
      logEvent({ level: 'info', kind: 'db', detail: `dropped database copy ${live.name} of '${live.datastore}' — ${reason}` });
      return { ok: true };
    }
    live.dropAttempts += 1;
    live.nextDropAt = now() + Math.min(3_600_000, 15_000 * 2 ** Math.min(live.dropAttempts - 1, 8));
    this.journal.saveDbCopy(live);
    logEvent({ level: 'error', kind: 'db', detail: `database copy ${live.name} (${live.ns}) was NOT dropped (${reason}; attempt ${live.dropAttempts}) — kept on record, retried by the sweeper; check the appliance` });
    return { ok: false, output };
  }

  /** `runly db drop <name>`: drop one copy now, whoever made it. */
  async dbDrop(name: string) {
    const row = this.journal.getDbCopy(name);
    if (!row) {
      const known = this.journal.allDbCopies().map((c) => c.name);
      throw new BrokerError('work-error', `no database copy '${name}'${known.length ? ` — known: ${known.join(', ')}` : ' — there are none'}`, 'db');
    }
    if (this.dbBusy.has(name)) throw new BrokerError('env-error', `database copy '${name}' is being created or dropped right now — retry in a moment`, 'db');
    this.dbBusy.add(name);
    try {
      const r = await this.dropDbCopy(row, 'dropped on request');
      if (!r.ok) {
        throw new BrokerError('env-error', `the drop of '${name}' failed — the copy stays on record and the sweeper retries it; check the datastore's server`, 'db', r.output);
      }
      return { dropped: name };
    } finally {
      this.dbBusy.delete(name);
    }
  }

  /** `runly db ls`: this worktree's copies, or every copy with `all`. */
  dbLs(cwd: string, all: boolean) {
    const root = all ? undefined : this.callerWorktree(cwd);
    return { scope: root ?? 'server', copies: this.journal.allDbCopies().filter((c) => root === undefined || c.stackRoot === root).map((c) => this.dbCopyView(c)) };
  }

  /** The caller's worktree root, for the per-worktree views (`ps`, `db ls`). */
  private callerWorktree(cwd: string): string {
    try {
      return loadStack(cwd).root;
    } catch (err) {
      throw new BrokerError('work-error', `${String((err as Error).message ?? err)} — pass --all for the whole server`, 'manifest');
    }
  }

  /** Why a copy must go now, or null (decision 0034: reaped exactly like environments; no TTL). */
  private dbCopyOrphanReason(c: DbCopyRow): string | null {
    if (c.state === 'creating') return 'its creation never finished (the daemon stopped mid-restore)';
    if (c.state === 'dropping') return 'an earlier drop did not complete';
    // `runly db with` tethers the copy to its own CLI, which never comes back
    // once dead: its copy (and the command it ran) go at once, not after the
    // agent tether's grace.
    if (c.child && c.holderPid !== undefined && this.holderGone(c.holderPid, c.holderStart)) return `its 'runly db with' process ${c.holderPid} is gone`;
    if (c.holderPid !== undefined && this.tetherGone(`copy:${c.name}`, c.holderPid, c.holderStart)) return `its holder process ${c.holderPid} is gone`;
    if (!existsSync(c.stackRoot)) return `its worktree ${c.stackRoot} is gone`;
    try {
      const current = loadStack(c.stackRoot);
      if (current.id !== c.stack) return `its worktree ${c.stackRoot} now resolves to '${current.id}', not '${c.stack}'`;
    } catch {
      /* an unreadable manifest is not proof (someone may be mid-edit) */
    }
    return null;
  }

  /** Drop every copy whose holder or worktree is gone. Runs in every sweep and after recovery. */
  private async reapDbCopies(): Promise<void> {
    for (const c of this.journal.allDbCopies()) {
      if (this.dbBusy.has(c.name) || c.nextDropAt > now()) continue;
      const reason = this.dbCopyOrphanReason(c);
      if (!reason) continue;
      this.dbBusy.add(c.name);
      try {
        await this.dropDbCopy(c, reason);
      } catch (err) {
        logEvent({ level: 'error', kind: 'db', detail: `reaping database copy ${c.name} failed: ${String((err as Error).message ?? err)}` });
      } finally {
        this.dbBusy.delete(c.name);
      }
    }
  }

  // ---------------------------------------------------------------- ps

  /** Resident memory per (env, service), summed over its tagged processes. Linux only; empty elsewhere. */
  private rssByService(): Map<string, number> {
    const out = new Map<string, number>();
    if (!procScanSupported()) return out;
    for (const proc of scanTagged(stateRoot())) {
      if (!proc.service || proc.service.startsWith('preview')) continue;
      try {
        const kb = /VmRSS:\s+(\d+)\s+kB/.exec(readFileSync(`/proc/${proc.pid}/status`, 'utf8'))?.[1];
        if (kb === undefined) continue;
        const key = `${proc.envId}\0${proc.service}`;
        out.set(key, (out.get(key) ?? 0) + Number(kb) * 1024);
      } catch {
        /* exited between the scan and the read */
      }
    }
    return out;
  }

  /**
   * `runly ps` (decision 0034): one view of what runs for the caller — the
   * services of this worktree's environment and its database copies — or,
   * with `all`, for the whole server.
   */
  ps(cwd: string, all: boolean) {
    const root = all ? undefined : this.callerWorktree(cwd);
    const rss = this.rssByService();
    const services: Array<Record<string, unknown>> = [];
    for (const env of this.journal.allEnvs()) {
      if (root !== undefined && env.stackRoot !== root) continue;
      let stack: Stack | undefined;
      try { stack = loadStack(env.stackRoot); } catch { stack = undefined; }
      const pids = this.supervisors.get(env.id)?.pids() ?? {};
      const stats = this.proxy.stats(env.id);
      const wanted = stack ? this.desiredServices(stack, env) : new Set(env.activeServices ?? Object.keys(env.servicePids));
      const lease = this.journal.leaseForEnv(env.id);
      const names = stack ? Object.keys(stack.manifest.services) : [...new Set([...Object.keys(env.servicePids), ...wanted])];
      for (const name of names) {
        const key = stack?.manifest.services[name]?.port;
        const st = key ? stats[key] : undefined;
        const pid = pids[name]?.pid;
        const failure = pid === undefined && wanted.has(name) ? this.failureOf(env.id, name) : undefined;
        const state = st?.state === 'starting' ? 'starting' : pid !== undefined ? 'running' : !wanted.has(name) ? 'down' : failure ? 'failed' : this.idleStopped.has(`${env.id}\0${name}`) ? 'idle' : 'stopped';
        const spec = stack?.manifest.services[name];
        // One clock for IDLE and STOPS IN (decision 0039): the one the sweeper
        // stops by — the service's own start, the last verb that used the
        // environment and the last client byte on its port — with the same
        // limit (the unleased cap included).
        const limit = this.serviceIdleLimit(env, spec);
        const clock = this.serviceClock(env, name, spec);
        const lastSeen = st?.lastActivityAt ?? (key ? env.activity?.[key] : undefined);
        services.push({
          env: env.id,
          worktree: env.stackRoot,
          service: name,
          state,
          publicPort: key ? env.ports[key] ?? null : null,
          internalPort: st?.internalPort ?? null,
          pid: pid ?? null,
          /** The last client byte through its public port (null: none yet). */
          lastActivityAt: lastSeen ?? null,
          /** How long the running service has been idle by the clock the sweeper reads; null when it is not running. */
          idleMs: pid !== undefined ? Math.max(0, now() - clock) : null,
          /** When this running service is stopped for idleness unless it is used (decision 0035); null when it never is. */
          idleStopInMs: pid !== undefined && Number.isFinite(limit) ? Math.max(0, clock + limit - now()) : null,
          rssBytes: rss.get(`${env.id}\0${name}`) ?? null,
          /** A failed service (decision 0039): how it last ended, and where to look. */
          failure: failure
            ? { reason: failure.reason, exitCode: failure.code, signal: failure.signal, at: failure.at, detail: describeExit(failure), hint: `runly logs ${name}` }
            : null,
          holder: lease?.holder ?? null,
          busy: this.busy.has(env.id) ? (this.busyOp.get(env.id) ?? 'an operation') : null,
        });
      }
    }
    const databases = this.journal.allDbCopies().filter((c) => root === undefined || c.stackRoot === root).map((c) => this.dbCopyView(c));
    const committed = this.budget.committed();
    const b = policy().budget;
    return {
      scope: root ?? 'server', services, databases,
      /** The server-wide load budget (decision 0036). */
      budget: { enabled: b.enabled, memoryBytes: b.memoryBytes, cpu: b.cpu, committedMemoryBytes: committed.memoryBytes, committedCpu: committed.cpu, waiting: this.budget.queueLength() },
    };
  }

  /**
   * `runly plan [service…]` (decision 0036): what an `up` with these
   * services would build and start now, what that costs (declared, or the
   * default, said so), what the box and the budget have free, and whether it
   * would start now or wait — without doing any of it.
   */
  async plan(cwd: string, services: string[], rebuild: boolean, holder?: string) {
    const stack = loadStack(cwd);
    if (services.length > 0) this.resolveServiceClosure(stack, services);
    const h = this.callerHolder(cwd, holder, stack);
    const lease = this.journal.leaseForHolder(h, stack.id);
    const env = (lease ? this.journal.getEnv(lease.envId) : undefined) ?? this.journal.envsForStack(stack.id)[0];
    const running = new Set(Object.keys(env ? this.supervisors.get(env.id)?.pids() ?? {} : {}));
    const continuing = env !== undefined && lease !== undefined;
    const base = env ? (continuing ? new Set([...this.desiredServices(stack, env), ...running]) : running) : new Set<string>();
    const active = new Set([...base, ...this.resolveServiceClosure(stack, services)].filter((n) => n in stack.manifest.services));
    const need = await this.needFor(stack, env, new Set([...active].filter((n) => !running.has(n))), active, { rebuild, mode: 'plan' });
    const verdict = this.budget.check(need);
    const queued = this.budget.queueLength();
    const fits = verdict.fits && queued === 0;
    const sum = total(need);
    return {
      stack: stack.manifest.name,
      envId: env?.id ?? null,
      items: need.items.map((it) => ({ kind: it.kind, name: it.name, memoryBytes: it.cost.memoryBytes, cpu: it.cost.cpu, declared: it.cost.declared, skipped: it.skipped ?? null })),
      need: { memoryBytes: sum.memoryBytes, cpu: sum.cpu, start: need.start, build: need.build },
      machine: verdict.machine,
      budget: {
        enabled: verdict.budget.enabled, memoryBytes: verdict.budget.memoryBytes, cpu: verdict.budget.cpu,
        reserveBytes: verdict.budget.reserveBytes, loadPerCore: verdict.budget.loadPerCore, waitMs: verdict.budget.waitMs,
      },
      committed: verdict.committed,
      queue: queued,
      startsNow: fits,
      verdict: verdict.impossible
        ? `can never start: ${verdict.impossible}`
        : fits ? 'starts now' : `would wait for ${[queued > 0 ? `${queued} request(s) already queued` : '', verdict.waitFor ?? ''].filter(Boolean).join('; ')}`,
      defaultsAssumed: need.items.filter((it) => !it.cost.declared && !it.skipped).map((it) => `${it.kind} ${it.name}`),
    };
  }

  /**
   * `runly destroy` (decision 0035): everything runly holds for this worktree
   * goes now — its environment (services, data, preview, ports, lease) and its
   * database copies. What a worktree pool calls when it takes a worktree back;
   * the sweeper does the same by itself when the worktree is removed or its
   * agent's tether dies. The worktree's upkeep and build records, and the
   * baked templates, stay (decision 0039): the next `up` finds its installs
   * and templates current instead of redoing them.
   */
  async destroy(cwd: string) {
    const stack = loadStack(cwd);
    const envs: string[] = [];
    for (const env of this.journal.envsForStack(stack.id)) {
      const outcome = await this.recycleOne(env.id, true);
      if (outcome === 'unclaimed') throw new BrokerError('env-error', `environment ${env.id} is busy (${this.busyOp.get(env.id) ?? 'an operation'}) — retry once it settles`, 'pool');
      if (outcome === 'survivors') throw new BrokerError('env-error', `environment ${env.id} has service processes that outlived teardown — 'runly pool doctor' names them; retry once they can be reclaimed`, 'pool');
      envs.push(env.id);
    }
    const copies: string[] = [];
    const failed: string[] = [];
    for (const c of this.journal.allDbCopies().filter((c) => c.stackRoot === stack.root)) {
      if (this.dbBusy.has(c.name)) {
        failed.push(c.name);
        continue;
      }
      this.dbBusy.add(c.name);
      try {
        if ((await this.dropDbCopy(c, 'its worktree was destroyed')).ok) copies.push(c.name);
        else failed.push(c.name);
      } finally {
        this.dbBusy.delete(c.name);
      }
    }
    // The worktree's own records (upkeep ledger, trigger cache, build ledger)
    // STAY (decision 0039): they describe files in the worktree, which destroy
    // never touches, so forgetting them only made the next `up` re-run every
    // upkeep rule and build for nothing. `up --pristine` forgets them; the
    // sweeper removes them once the worktree itself is gone.
    logEvent({ level: 'info', kind: 'destroy', detail: `destroyed ${stack.root}: ${envs.length} environment(s), ${copies.length} copy(ies)${failed.length ? `, ${failed.length} copy drop(s) failed (retried by the sweeper)` : ''}` });
    return { worktree: stack.root, environments: envs, copies, copiesNotDropped: failed };
  }

  /**
   * `runly pool doctor [--fix]` (decision 0037): what this state root owns
   * that nothing references any more. Dry run by default; `--fix` removes it.
   * Only runly's own: files under the state root in runly's naming,
   * processes carrying this state root's tag, listeners of this daemon, and
   * server-side namespaces a datastore's `list:` hook reports that carry
   * runly's naming AND a stack id this state root has a record of.
   */
  async poolDoctor(cwd: string, fix: boolean) {
    const findings: Array<{ kind: string; what: string; detail: string; fixed?: boolean; error?: string }> = [];
    const envIds = new Set(this.journal.allEnvs().map((e) => e.id));
    const copies = this.journal.allDbCopies();
    const knownStacks = new Set<string>([...this.journal.allEnvs().map((e) => e.stack), ...copies.map((c) => c.stack)]);
    for (const d of [templatesRoot(), worktreesRoot()]) for (const id of existsSync(d) ? readdirSync(d) : []) knownStacks.add(id);

    // 1. Environment directories no row names.
    for (const id of existsSync(envsRoot()) ? readdirSync(envsRoot()) : []) {
      // Re-read: a bind that created its environment after the snapshot above owns it.
      if (envIds.has(id) || !/-e\d+$/.test(id) || this.journal.getEnv(id)) continue;
      const dir = join(envsRoot(), id);
      const users = procScanSupported() ? scanByCwd(dir) : [];
      const f: (typeof findings)[number] = { kind: 'env-dir', what: dir, detail: users.length ? `no environment row names it; ${users.length} process(es) still run in it — left alone` : 'no environment row names it' };
      if (fix && users.length === 0) {
        rmSync(dir, { recursive: true, force: true });
        f.fixed = true;
      }
      findings.push(f);
    }
    // 2. Copy directories no copy row names.
    const copyNames = new Set(copies.map((c) => c.name));
    for (const name of existsSync(dbCopiesRoot()) ? readdirSync(dbCopiesRoot()) : []) {
      if (copyNames.has(name) || this.dbBusy.has(name) || this.journal.getDbCopy(name)) continue;
      const dir = join(dbCopiesRoot(), name);
      const f: (typeof findings)[number] = { kind: 'copy-dir', what: dir, detail: 'no database copy row names it' };
      if (fix && this.isPrivateDbDir(dir)) {
        rmSync(dir, { recursive: true, force: true });
        f.fixed = true;
      }
      findings.push(f);
    }
    // 3. Worktree records for a worktree that is gone and that no row names.
    const refs = templateRefs(this.journal);
    for (const id of existsSync(worktreesRoot()) ? readdirSync(worktreesRoot()) : []) {
      if (this.journal.envsForStack(id).length > 0 || copies.some((c) => c.stack === id) || refs.stackAlive(id)) continue;
      const dir = join(worktreesRoot(), id);
      const f: (typeof findings)[number] = { kind: 'worktree-state', what: dir, detail: 'its worktree is gone and no environment or copy names it' };
      if (fix) {
        rmSync(dir, { recursive: true, force: true });
        f.fixed = true;
      }
      findings.push(f);
    }
    // 4. Template markers nothing references, superseded or of a stack that is gone (no grace here).
    //    Under each stack's bake lock: a bake in flight writes its marker last,
    //    and must neither lose it nor see its database dropped half-made.
    const markerNs = new Set<string>();
    const markersOf = (stackDir: string): string[] => {
      const out: string[] = [];
      let files: string[];
      try { files = readdirSync(join(templatesRoot(), stackDir)); } catch { return out; }
      for (const f of files) {
        if (!f.endsWith('.baked')) continue;
        try { out.push(parseBakedMarker(readFileSync(join(templatesRoot(), stackDir, f), 'utf8')).ns); } catch { /* unreadable marker */ }
      }
      return out;
    };
    for (const stackDir of existsSync(templatesRoot()) ? readdirSync(templatesRoot()) : []) {
      await withBakeLock(stackDir, async () => {
        const dir = join(templatesRoot(), stackDir);
        let files: string[];
        try { files = readdirSync(dir); } catch { return; }
        const alive = refs.stackAlive(stackDir);
        const seen = new Map<string, number>();
        const ordered = files.filter((f) => !f.startsWith('.') && !f.endsWith('.retirement.json'))
          .map((f) => ({ f, m: (() => { try { return statSync(join(dir, f)).mtimeMs; } catch { return 0; } })() }))
          .sort((a, b) => b.m - a.m);
        for (const { f } of ordered) {
          const group = f.lastIndexOf('@') > 0 ? f.slice(0, f.lastIndexOf('@')) : '';
          const rank = seen.get(group) ?? 0;
          seen.set(group, rank + 1);
          let ns: string | undefined;
          if (f.endsWith('.baked')) {
            try { ns = parseBakedMarker(readFileSync(join(dir, f), 'utf8')).ns; } catch { ns = undefined; }
          }
          const keep = (alive && rank < Math.max(1, policy().templatesKeep)) || refs.referenced.has(`${stackDir}/${f}`) || existsSync(join(dir, '.retired-stack.json'));
          if (keep) {
            if (ns) markerNs.add(ns);
            continue;
          }
          const finding: (typeof findings)[number] = { kind: 'template', what: join(dir, f), detail: alive ? 'superseded, and no environment or copy was restored from it' : 'its stack can never be bound again (worktree gone, no rows)' };
          if (fix) {
            try {
              const marker = f.endsWith('.baked') ? parseBakedMarker(readFileSync(join(dir, f), 'utf8')) : null;
              if (marker?.drop) {
                const r = await runBounded(marker.drop, stateRoot(), cmdTimeoutS());
                if (r.code !== 0 || r.timedOut) throw new Error(`drop exited ${r.timedOut ? 'by timeout' : r.code}: ${r.output.slice(-200)}`);
              }
              rmSync(join(dir, f), { force: true });
              finding.fixed = true;
            } catch (err) {
              finding.error = String((err as Error).message ?? err);
              if (ns) markerNs.add(ns);
            }
          } else if (ns) markerNs.add(ns);
          findings.push(finding);
        }
      });
    }
    // 5. Server-side namespaces in runly's naming that nothing references, via each datastore's `list:` hook.
    //    Referenced: every live row's namespaces, the drop recipes a bind
    //    records BEFORE its restore creates the namespace, every copy (also
    //    one still `creating`), and every template marker.
    const referencedNs = new Set<string>([...markerNs, ...this.journal.allDbCopies().map((c) => c.ns)]);
    const referenceEnv = (e: EnvRow) => {
      for (const ns of Object.values(e.datastoreNs)) referencedNs.add(ns);
      for (const r of Object.values(e.dropRecipes ?? {})) if (r.ns) referencedNs.add(r.ns);
    };
    for (const e of this.journal.allEnvs()) referenceEnv(e);
    const sources = new Map<string, { stack: Stack; ds: string }>();
    const roots = new Set<string>([cwd, ...this.journal.allEnvs().map((e) => e.stackRoot), ...copies.map((c) => c.stackRoot)]);
    for (const root of roots) {
      try {
        const st = loadStack(root);
        for (const [ds, spec] of Object.entries(st.manifest.datastores ?? {})) if (spec.list && spec.drop) sources.set(`${spec.list}\0${spec.drop}`, { stack: st, ds });
      } catch { /* no readable manifest there */ }
    }
    const sanitize = (id: string) => id.replace(/[^A-Za-z0-9_]/g, '_');
    const prefixesOf = (id: string) => [`backlot_${sanitize(id)}_`, `backlot_tpl_${sanitize(id)}_`, `backlot_${sanitize(id)}_db_`];
    // A namespace cut to 63 bytes may have lost its stack id: those are
    // recorded with their stack when they are created (W4).
    const recorded = recordedNamespaces();
    const ownerOf = (ns: string): string | undefined => {
      const rec = recorded.get(ns);
      if (rec !== undefined) return rec;
      return [...knownStacks].find((id) => prefixesOf(id).some((p) => ns.startsWith(p)));
    };
    // In flight: a bind (busy env) or a copy being created or dropped. Their
    // namespaces are referenced above already; this also covers a row a
    // concurrent request wrote after the snapshot.
    const inFlight = () => [...this.busy].map((id) => `backlot_${sanitize(id)}_`);
    for (const { stack: st, ds } of sources.values()) {
      const spec = st.manifest.datastores?.[ds];
      if (!spec?.list || !spec.drop) continue;
      const drop = spec.drop;
      const r = await runBounded(spec.list, st.root, cmdTimeoutS());
      if (r.code !== 0 || r.timedOut) {
        findings.push({ kind: 'list-failed', what: `${st.manifest.name}:${ds}`, detail: `its list: hook failed (${r.timedOut ? 'timed out' : `exit ${r.code}`}) — namespaces not checked` });
        continue;
      }
      const names = r.output.split('\n').map((l) => l.trim()).filter((l) => /^backlot_[A-Za-z0-9_]+$/.test(l));
      for (const ns of new Set(names)) {
        if (referencedNs.has(ns)) continue;
        const owner = ownerOf(ns);
        const finding: (typeof findings)[number] = owner !== undefined
          ? { kind: 'namespace', what: ns, detail: `datastore '${ds}' lists it and no environment, copy or template references it` }
          : { kind: 'foreign-namespace', what: ns, detail: `in runly's naming, but of a stack this state root has no record of (another state root's?) — never touched` };
        if (fix && owner !== undefined) {
          // Decided again at the last moment, under the owner's bake lock: the
          // list ran seconds ago, and a bind, copy or bake may have claimed
          // the name since.
          await withBakeLock(owner, async () => {
            for (const e of this.journal.allEnvs()) referenceEnv(e);
            for (const c of this.journal.allDbCopies()) referencedNs.add(c.ns);
            for (const m of markersOf(owner)) referencedNs.add(m);
            if (referencedNs.has(ns) || inFlight().some((p) => ns.startsWith(p)) || [...this.dbBusy].some((name) => this.journal.getDbCopy(name)?.ns === ns)) {
              finding.detail += ' — claimed by an operation in flight, left alone';
              return;
            }
            const dr = await runBounded(template(drop, { ns }), st.root, cmdTimeoutS());
            if (dr.code === 0 && !dr.timedOut) {
              finding.fixed = true;
              forgetNamespace(ns);
            } else finding.error = `drop exited ${dr.timedOut ? 'by timeout' : dr.code}: ${dr.output.slice(-200)}`;
          });
        }
        findings.push(finding);
      }
    }
    // 6. Service processes whose environment is gone or should run nothing.
    if (procScanSupported()) {
      const live = new Set(this.journal.allEnvs().filter((e) => e.state === 'hot' || e.state === 'provisioning').map((e) => e.id));
      for (const id of this.busy) live.add(id);
      const tagged = scanTagged(stateRoot());
      const leasedPreviews = this.leasedPreviewPids(tagged);
      const orphans = tagged.filter((p) => !live.has(p.envId) && !leasedPreviews.has(p.pid));
      for (const o of orphans) findings.push({ kind: 'process', what: `pid ${o.pid}`, detail: `'${o.service}' of ${envIds.has(o.envId) ? 'environment' : 'gone environment'} ${o.envId}, tagged with this state root` });
      if (fix && orphans.length > 0) {
        const gc = await this.poolGc(false);
        const reclaimed = new Set(gc.reclaimed.map((r) => r.pid));
        for (const f of findings) if (f.kind === 'process') f.fixed = reclaimed.has(Number(f.what.slice(4)));
      }
    }
    // 7. Proxy listeners of environments the journal no longer has.
    for (const id of this.proxy.envIds()) {
      if (envIds.has(id)) continue;
      const f: (typeof findings)[number] = { kind: 'listener', what: id, detail: `public port(s) ${Object.values(this.proxy.stats(id)).map((t) => t.port).join(', ')} held for an environment that no longer exists` };
      if (fix) {
        this.proxy.closeEnv(id);
        f.fixed = true;
      }
      findings.push(f);
    }
    const actionable = findings.filter((f) => f.kind !== 'foreign-namespace');
    logEvent({ level: actionable.length ? 'warn' : 'info', kind: 'pool-doctor', detail: `${actionable.length} finding(s)${fix ? `, ${findings.filter((f) => f.fixed).length} fixed` : ' (dry run)'}` });
    return { fix, clean: actionable.length === 0, findings };
  }

  status() {
    const envs = this.journal.allEnvs().map((e) => {
      const lease = this.journal.leaseForEnv(e.id) ?? null;
      // Squatting was invisible: the lease showed a holder NAME with no way to
      // tell whether anyone was still behind it, so a crashed agent's
      // environment looked identical to a working one.
      const holderAlive =
        lease?.holderPid === undefined ? null : sameProcess(lease.holderPid, lease.holderStart);
      return {
        id: e.id, stack: e.stack, state: e.state, ports: e.ports, bindCount: e.bindCount,
        /** Proxy state and traffic per public port (decision 0033). */
        proxy: this.proxy.stats(e.id),
        /** Where its services run: the caller's worktree (decision 0032). */
        worktree: e.stackRoot,
        lease,
        /** null = every service (the default set); otherwise the services the lease wants up — [] after `runly down` (decision 0034). */
        activeServices: e.activeServices ?? null,
        idleMs: now() - e.lastUsedAt,
        /** null = the holder never identified itself, so liveness is unknowable. */
        holderAlive,
        /** Why this environment is still holding its services, in one word. */
        heat: e.state === 'hot' ? (now() - this.envActivityAt(e) > policy().serviceIdleMs ? 'stale' : 'active') : 'cold',
        /**
         * Will the next bind take this environment as-is?
         *
         * `heat: 'cold'` means quiesced — services stopped, everything else
         * intact — which is a HEALTHY free pool entry, not a stuck one. Read as
         * "dead", it sent an operator to `pool recycle` to unstick a pool that
         * was already fine, and that recycle took other people's live leases
         * with it. So state the conclusion instead of leaving it to be inferred.
         */
        available: !lease && e.state !== 'degraded' && e.state !== 'recycling',
        /** Plain language for the two fields above, so no one has to infer it. */
        summary: lease
          ? `leased by '${lease.holder}'${e.activeServices?.length === 0 ? ' (no services wanted)' : ''}${holderAlive === false ? ' (holder process is gone)' : ''}`
          : e.state === 'degraded'
            ? 'unusable — the next sweep reclaims it'
            : e.state === 'recycling'
              ? 'being torn down'
              : e.state === 'provisioning'
                ? 'being created'
                : e.state === 'hot'
                  ? 'free, services still running — the next bind takes it immediately'
                  : 'free and quiesced — the next bind takes it and restarts its services',
      };
    });
    const ports = { public: publicBlock(), internal: internalBlock(), tunnel: tunnelBlock(), ephemeral: ephemeralRange(), conflicts: blockConflicts() };
    const committed = this.budget.committed();
    const b = policy().budget;
    return {
      pid: process.pid,
      /**
       * Who restarts this daemon when it crashes (decision 0039): `systemd` or
       * `launchd` after `runly daemon install`, `autospawn` (the next CLI
       * command) otherwise.
       */
      supervisor: process.env.INVOCATION_ID ? 'systemd' : (process.env.XPC_SERVICE_NAME ?? '').startsWith('dev.runly.daemon') ? 'launchd' : 'autospawn',
      envs, poolMaxTotal: POOL_MAX_TOTAL(), ports,
      /** The server-wide load budget (decision 0036). */
      budget: { ...b, committedMemoryBytes: committed.memoryBytes, committedCpu: committed.cpu, committed: committed.items, waiting: this.budget.queueLength() },
      events: recentEvents(15),
    };
  }

  /** Who a restart would make rebind: every live lease, named. */
  leaseHolders(): Array<{ envId: string; holder: string; kind: string }> {
    return this.journal.allLeases().map((l) => ({ envId: l.envId, holder: l.holder, kind: l.kind }));
  }

  /**
   * What a `runly update` restart would cost, without doing it.
   *
   * Reported rather than inferred by the CLI because the two facts that decide
   * whether a restart is safe — which environments are BUSY, and who holds a
   * lease — only exist in the daemon's memory and journal.
   */
  updatePlan(cliVersion?: string) {
    const skew = cliVersion === undefined ? null : versionSkew(cliVersion, VERSION);
    return {
      daemon: VERSION,
      daemonBuild: BUILD,
      cli: cliVersion ?? null,
      daemonPid: process.pid,
      journalSchema: JOURNAL_SCHEMA_VERSION,
      skew,
      // An in-flight operation is the one thing a restart genuinely interrupts.
      busy: [...this.busy],
      // A lease is NOT an obstacle — see assertRestartable — but the holders
      // are reported so a caller on a shared box knows who has to rebind.
      leases: this.leaseHolders(),
    };
  }

  /**
   * Refuse a restart that would destroy work, and allow the one that costs only
   * a rebind.
   *
   * BUSY is the refusal. An `exec` runs detached so the command itself
   * survives the daemon, but the CALLER is blocked on this socket waiting for
   * its result — restarting hands it a dead connection and no result. Every other reclaim path already treats busy as inviolable
   * (claimForTeardown, both sweeper branches, pool gc, and shutdown's own reap
   * since 0.8.0), so this one does too.
   *
   * A LIVE LEASE is deliberately NOT a refusal. A restart stops services, keeps
   * the lease, and the holder's next verb rebinds — which is exactly what the
   * idle quiesce already does to leased environments without anyone's consent,
   * and what assertUsable already tells the holder to do ("run 'runly up' to
   * rebind"). Refusing here would mean an update on any busy shared box always
   * needs --force, and a flag you always pass is a flag that stops meaning
   * anything: that habituation is what made issue #40 destructive. Holders are
   * named in the plan instead.
   *
   * A DOWNGRADE is refused separately. Restarting from an older CLI replaces a
   * newer daemon with older code, which is the direction that strands state —
   * the journal stamp exists because of exactly that (JOURNAL_SCHEMA_VERSION).
   */
  assertRestartable(opts: { force: boolean; cliVersion?: string }): void {
    const { force, cliVersion } = opts;
    if (force) return;
    const busy = [...this.busy];
    if (busy.length > 0) {
      throw new BrokerError(
        'work-error',
        `an operation is in flight on ${busy.join(', ')} — restarting now would drop the caller waiting on it; ` +
          `retry once it settles, or pass --force if you mean to interrupt it`,
        'daemon',
      );
    }
    if (cliVersion !== undefined) {
      const order = compareVersions(cliVersion, VERSION);
      if (order !== undefined && order < 0) {
        throw new BrokerError(
          'work-error',
          `this CLI is runly ${cliVersion} but the running daemon is ${VERSION} — restarting would DOWNGRADE the daemon, ` +
            `which is the direction that can strand journal state; invoke the newer CLI, or pass --force if you mean to roll back`,
          'daemon',
        );
      }
    }
  }

  /**
   * doctor: actively check for the failure shapes the review surfaced —
   * orphaned ports, journal/reality pid divergence, envs stuck recycling, and a
   * CLI talking to a daemon that is not the installed build.
   */
  async doctor(cliVersion?: string) {
    const issues: Array<{ level: string; envId?: string; issue: string }> = [];
    // Skew first: it changes how every other finding should be read, since a
    // stale daemon's answers describe the old build's behaviour.
    const skew = cliVersion === undefined ? null : versionSkew(cliVersion, VERSION);
    if (skew) issues.push({ level: 'error', issue: skew.message });
    if (VERSION === 'unknown') {
      issues.push({
        level: 'warn',
        issue: `this build cannot read its own version (package.json missing or unreadable beside dist/) — skew with a CLI cannot be detected`,
      });
    }
    // Per configured publisher, never the default: `preview.publisher` is the
    // seam future adapters plug into, and checking cloudflared on behalf of a
    // stack that names another provider tells it to install a tool it does not
    // use. An unknown name throws a work-error from resolve, which is itself
    // worth reporting — but doctor must never fail on a typo'd manifest.
    const override = process.env.BACKLOT_PREVIEW_PUBLISHER?.trim();
    const previewPublishers = new Set<string>();
    for (const e of this.journal.allEnvs()) {
      try {
        const stack = loadStack(e.stackRoot);
        const spec = stack.manifest.preview;
        if (spec?.forbidden) continue;
        if (spec || override) previewPublishers.add(this.previewPublisherName(stack));
      } catch {
        /* unreadable manifest — reported elsewhere */
      }
    }
    if (override && previewPublishers.size === 0) previewPublishers.add(override);
    for (const name of previewPublishers) {
      try {
        resolvePreviewPublisher(name).checkPrerequisite();
      } catch (err) {
        issues.push({ level: 'error', issue: (err as BrokerError).message ?? String(err) });
      }
    }
    for (const env of this.journal.allEnvs()) {
      if (env.state === 'recycling') issues.push({ level: 'warn', envId: env.id, issue: 'stuck in recycling (a daemon likely died mid-teardown; restart reconciles)' });
      // Journal says these pids run — are they actually alive, and still ours?
      for (const [svc, rec] of Object.entries(env.servicePids)) {
        if (!isAlive(rec.pid)) {
          const groups = serviceGroups(rec).filter(groupAlive);
          if (groups.length > 0) {
            issues.push({ level: 'error', envId: env.id, issue: `service '${svc}' has a retained live process group ${groups.join(', ')} after recorded pid ${rec.pid} exited — ownership and application capacity remain retained until teardown is confirmed` });
          } else {
            issues.push({ level: 'error', envId: env.id, issue: `journal records pid ${rec.pid} for service '${svc}' but it is not running (recovery drift)` });
          }
        } else if (!sameProcess(rec.pid, rec.startTime)) {
          // Alive, but a DIFFERENT process now holds that pid. Signalling it
          // would hit a bystander, so surface it rather than reaping it.
          issues.push({ level: 'error', envId: env.id, issue: `pid ${rec.pid} recorded for service '${svc}' now belongs to another process (pid reuse) — 'runly pool gc' will re-derive ownership from process tags` });
        }
      }
      // (Port liveness is intentionally NOT probed here: a service bound to ::
      // vs a 127.0.0.1 probe gives false positives across IPv4/IPv6 dual-stack.
      // The pid-divergence check above is the reliable "is it alive" signal.)
    }
    // The inverse drift, and the one that actually leaks memory: a tagged
    // process is running that no live env accounts for. Only reported here —
    // doctor diagnoses, `pool gc` is the verb that acts.
    if (procScanSupported()) {
      const liveEnvs = new Set(
        this.journal.allEnvs().filter((e) => e.state === 'hot' || e.state === 'provisioning').map((e) => e.id),
      );
      for (const id of this.busy) liveEnvs.add(id);
      // A quiesced env is `warm`, and its lease-scoped preview tunnel outlives
      // that quiesce by design — so the tag scan sees a tagged process with no
      // 'live' env and used to call it orphaned, permanently, while naming a
      // remedy (`pool gc`) that skips exactly this pid. A lease accounts for it.
      const tagged = scanTagged(stateRoot());
      const leasedPreviews = this.leasedPreviewPids(tagged);
      const orphans = tagged.filter((p) => !liveEnvs.has(p.envId) && !leasedPreviews.has(p.pid));
      for (const o of orphans) {
        issues.push({ level: 'error', envId: o.envId, issue: `orphaned process ${o.pid} ('${o.service}') is running with no live environment — run 'runly pool gc' to reclaim it` });
      }
    }
    logEvent({ level: issues.length ? 'warn' : 'info', kind: 'doctor', detail: `${issues.length} issue(s)` });
    return { ok: issues.length === 0, issues, version: VERSION, journalSchema: JOURNAL_SCHEMA_VERSION, events: recentEvents(20) };
  }

  /**
   * Atomically claim an env for teardown UNDER THE POOL LOCK: re-read it, and
   * (unless force) refuse if it's leased or busy, then flip it to the
   * 'recycling' guard state so tryClaim/sweep skip it. Returns the row to tear
   * down, or null if it slipped away. The slow teardown then runs OUTSIDE the
   * lock, but no claim can touch a 'recycling' env.
   */
  private claimForTeardown(envId: string, force: boolean): Promise<EnvRow | null> {
    return this.poolLocked(() => {
      const env = this.journal.getEnv(envId);
      if (!env || env.state === 'recycling') return null;
      // An in-flight operation (busy) is NEVER interrupted — not even by
      // --force; force only bypasses the LEASE (the clean-slate button).
      if (this.busy.has(envId)) return null;
      if (!force && this.journal.leaseForEnv(envId)) return null;
      env.state = 'recycling';
      this.journal.saveEnv(env);
      return env;
    });
  }

  /**
   * Stop and reap this environment's services mid-bind, and journal the result
   * at once. The row is what capacity accounting reads: an application charge
   * retained for a conversion stands on `hot` or recorded pids, so leaving
   * either in the journal after the processes are gone kept a slot reserved for
   * nothing if the rest of the bind failed. Survivors stay recorded — and keep
   * the charge — because a pid nobody can confirm dead may still hold a port.
   * Re-reads the live row so a concurrent degrade is preserved and a recycled
   * row is never written back.
   */
  /**
   * Stop just the services an `up` is about to restart because their build
   * output changed (decision 0032); the others keep running. Same reap
   * contract as stopForBind — recorded pids, then a tag scan — but the scan
   * is limited to THESE services' tags: the env's other services carry the
   * same env tag and are still serving.
   */
  private async stopServicesForRestart(env: EnvRow, names: string[]): Promise<void> {
    const sup = this.supervisor(env);
    const survivors = await sup.stopSome(names);
    const wanted = new Set(names);
    const recorded = Object.fromEntries(Object.entries(env.servicePids).filter(([n]) => wanted.has(n)));
    let unreaped = await reapPids(mergeServicePids(recorded, survivors), this.reapServiceGroup);
    if (procScanSupported()) {
      const tagged = scanTagged(stateRoot());
      const leasedPreviews = this.leasedPreviewPids(tagged);
      const orphans = tagged.filter((p) => p.envId === env.id && p.service !== undefined && wanted.has(p.service) && !leasedPreviews.has(p.pid));
      if (orphans.length > 0) unreaped = await this.reapDiscoveredProcesses(orphans, unreaped);
    }
    const live = this.journal.getEnv(env.id);
    const pids = { ...sup.pids(), ...unreaped };
    if (live) {
      live.servicePids = pids;
      this.journal.saveEnv(live);
    }
    env.servicePids = pids;
    if (Object.keys(unreaped).length > 0) {
      throw new BrokerError('env-error', `environment ${env.id} still has unreaped processes of ${names.join(', ')} — retry once teardown can complete`, 'services');
    }
  }

  private async stopForBind(env: EnvRow): Promise<void> {
    const survivors = await this.supervisor(env).stopAll();
    this.supervisors.delete(env.id);
    const unreaped = await this.reapEnvProcesses(env, mergeServicePids(env.servicePids, survivors));
    const live = this.journal.getEnv(env.id);
    if (live) {
      if (live.state === 'hot') live.state = 'warm';
      live.servicePids = unreaped;
      this.journal.saveEnv(live);
      env.state = live.state;
    }
    env.servicePids = unreaped;
    if (Object.keys(unreaped).length > 0) {
      throw new BrokerError('env-error', `environment ${env.id} still has unreaped service processes — retry once teardown can complete`, 'services');
    }
  }

  /**
   * After a supervisor stopAll(), kill any process that survived or escaped the
   * group signal so the port is truly free before the port-check below.
   *
   * Two failure modes:
   *   (a) Recorded pid survived a previous kill (quiesce/teardown race): reapPids
   *       retries with fresh SIGTERM→SIGKILL on all platforms.
   *   (b) A service called setsid() / spawned a detached grandchild that inherited
   *       the BACKLOT tag but moved to a new process group, escaping the -pgid
   *       SIGKILL: scanTagged (Linux only) finds it by the tag in its environment
   *       and kills the new group.
   *
   * Without this, a warm env whose quiesce left survivors hands out a port that
   * is still bound — the bind then fails with "occupied by a foreign process"
   * instead of reclaiming the escapee.
   *
   * Returns the entries NOT confirmed dead (reapPids contract): callers must
   * keep those in the journal — a forgotten pid is an orphan nobody can ever
   * reclaim, and only Linux has the tag scan to fall back on.
   */
  private async reapEnvProcesses(env: EnvRow, pids?: Record<string, ServicePid>): Promise<Record<string, ServicePid>> {
    const recorded = pids ?? env.servicePids;
    let survivors: Record<string, ServicePid> = {};
    if (Object.keys(recorded).length > 0) {
      survivors = await reapPids(recorded, this.reapServiceGroup);
    }
    if (procScanSupported()) {
      // A preview tunnel carries this env's tag but belongs to the LEASE, not to
      // the service incarnation it publishes (decision 0027). Stopping services
      // — a rebind, a quiesce — must leave it alone, and the tag scan is the one
      // place that would otherwise shoot it on Linux while macOS kept it, which
      // is the platform split the reap must never have. Its owner reaps it when
      // the lease ends.
      const tagged = scanTagged(stateRoot());
      const leasedPreviews = this.leasedPreviewPids(tagged);
      const orphans = tagged.filter((p) => p.envId === env.id && !leasedPreviews.has(p.pid));
      if (orphans.length > 0) {
        survivors = await this.reapDiscoveredProcesses(orphans, survivors);
      }
    }
    return survivors;
  }

  private async reapDiscoveredProcesses(
    processes: Array<{ pid: number; startTime: number; service?: string }>,
    recorded: Record<string, ServicePid>,
  ): Promise<Record<string, ServicePid>> {
    const discovered = Object.fromEntries(processes.map(proc => [
      `${proc.service ?? 'cwd'}:${proc.pid}`,
      { pid: proc.pid, startTime: proc.startTime, pgid: sameProcess(proc.pid, proc.startTime) ? processGroup(proc.pid) ?? proc.pid : proc.pid },
    ]));
    const survivors = await reapPids(mergeServicePids(recorded, discovered), this.reapServiceGroup);
    return reapPids(survivors, this.reapServiceGroup);
  }

  /** Enforce the kill switch under the env lock before preset validation can fail. */
  private async enforceHolderPreviewForbidden(stack: Stack, holder: string, onProgress?: Progress): Promise<string | undefined> {
    if (!stack.manifest.preview?.forbidden) return undefined;
    const lease = this.journal.leaseForHolder(holder, stack.id);
    if (!lease) return undefined;
    return this.envLocked(lease.envId, async () => {
      const held = this.journal.leaseForHolder(holder, stack.id);
      if (!held || held.id !== lease.id) return undefined;
      const env = this.journal.getEnv(held.envId);
      if (!env) return undefined;
      return this.enforcePreviewForbidden(env, stack, onProgress ?? (() => undefined));
    });
  }

  /**
   * Tear down a live preview the moment the manifest forbids one.
   *
   * Unconditional and early, unlike the rest of the reconcile: this is the
   * security kill switch README and ADR 0027 present as taking effect, and it
   * would be worthless if a stack stayed published whenever the bind that read
   * the flag went on to fail.
   */
  private async enforcePreviewForbidden(env: EnvRow, stack: Stack, say: Progress): Promise<string | undefined> {
    if (!stack.manifest.preview?.forbidden) return undefined;
    const lease = this.journal.leaseForEnv(env.id);
    if (!lease?.previewPid || !lease.previewService) return undefined;
    const url = lease.previewUrl ?? 'the preview tunnel';
    const confirmed = await this.stopPreviewForLease(lease);
    const detail = confirmed
      ? `work-error: ${manifestFileOf(stack)} now sets preview.forbidden, and a stack that forbids preview must not stay published — ${url} has been torn down`
      : `work-error: ${manifestFileOf(stack)} now sets preview.forbidden but the tunnel could NOT be confirmed dead — ${url} may still be serving, unauthenticated`;
    logEvent({ level: 'error', kind: 'preview', envId: env.id, detail });
    say(detail);
    return detail;
  }

  /**
   * Reconcile a live preview against the environment this bind just produced.
   *
   * The tunnel outlives service restarts, so everything here is about what is
   * now BEHIND the unchanged public URL. Three outcomes invalidate it outright
   * and tear it down — the manifest started forbidding preview, the previewed
   * service is no longer wanted (`runly down`, decision 0034), or it moved to a different local
   * port (a renamed port key; existing keys are never reassigned, decision
   * 0004). A data reset does not: the tunnel keeps serving, which is precisely
   * why it has to be said out loud.
   *
   * Runs at the bind's EPILOGUE, once the shape it judges against is committed.
   * From the top of the bind it was reading a REQUESTED slice that the epilogue
   * had not written yet, so a bind that then failed its ready probe left the
   * tunnel torn down against a slice change that never happened — and dropped
   * the report with the thrown error. `preview.forbidden` is the exception and
   * is enforced early by `enforcePreviewForbidden`: it depends on the manifest,
   * not on the bind.
   *
   * Never throws. The `down` that stopped the service or the bind that wiped the data is a
   * legitimate operation and failing it would strand the caller in a loop (and
   * bump failStreak into a pristine escalation); the classified message is the
   * report, and it rides back on the bind's own result.
   *
   * `active` must be the DURABLE shape this environment is bound to, never the
   * supervisor's live pid map: a service in restart backoff is missing from
   * that map for a second and would be read as "left the slice", killing a
   * tunnel the restart makes correct again. `portsReallocated` is false on the
   * hot-reload refresh path — only a real bind fills `env.ports` for a renamed port
   * key, so before one runs the service is still listening where the tunnel
   * points and a mismatch means nothing yet.
   */
  private async reconcilePreviewForBind(
    env: EnvRow,
    stack: Stack,
    active: Set<string>,
    say: Progress,
    opts: { hygiene: Hygiene; portsReallocated: boolean },
  ): Promise<string | undefined> {
    const lease = this.journal.leaseForEnv(env.id);
    if (!lease?.previewPid || !lease.previewService) return undefined;
    const service = lease.previewService;
    const url = lease.previewUrl ?? 'the preview tunnel';
    const portKey = stack.manifest.services[service]?.port;
    const port = portKey ? env.ports[portKey] : undefined;

    const cause = stack.manifest.preview?.forbidden
      ? { klass: 'work-error', why: `${manifestFileOf(stack)} now sets preview.forbidden, and a stack that forbids preview must not stay published` }
      : !active.has(service)
        ? { klass: 'env-error', why: `service '${service}' is not in this bind's running set${active.size ? ` (${[...active].map((n) => `'${n}'`).join(', ')})` : ' (this lease runs no services)'}, so its preview would publish a port with nothing behind it for the rest of the lease` }
        : opts.portsReallocated && port !== lease.previewPort
          ? { klass: 'env-error', why: `service '${service}' moved from port ${lease.previewPort} to ${port ?? 'no port at all'}, so its preview tunnel is aimed at a stale port` }
          : null;

    if (cause) {
      const confirmed = await this.stopPreviewForLease(lease);
      const detail = confirmed
        ? `${cause.klass}: ${cause.why} — ${url} has been torn down; run 'runly preview ${service}' again for a new URL`
        : `${cause.klass}: ${cause.why}, and the tunnel could NOT be confirmed dead — ${url} may still be serving, unauthenticated`;
      logEvent({ level: 'error', kind: 'preview', envId: env.id, detail });
      say(detail);
      return detail;
    }
    if (opts.hygiene !== 'reuse') {
      const detail =
        `the preview tunnel for '${service}' is still published at ${url} — this ${opts.hygiene} bind replaced the data behind it,` +
        ` so that PUBLIC, unauthenticated URL now serves different content. Run 'runly preview stop' if that must not be visible.`;
      logEvent({ level: 'warn', kind: 'preview', envId: env.id, detail });
      say(detail);
      return detail;
    }
    return undefined;
  }

  /**
   * Last-resort reap of anything still LIVING IN this env's private directory,
   * by cwd — at teardown, when that directory is about to be deleted.
   *
   * Since decision 0032 services run in the caller's WORKTREE, not here, so
   * this no longer finds a service that scrubbed its tag: cwd in a worktree is
   * NOT an ownership signal (the agent's own shells and builds sit there), and
   * scanning it would kill a stranger's process — the one outcome this whole
   * module is written to avoid. The tag scan and recorded groups are what
   * remain for services; this covers anything left in the env directory
   * itself (a process started under the old projection, for one).
   */
  private async reapEnvTree(env: EnvRow, recorded: Record<string, ServicePid>): Promise<Record<string, ServicePid>> {
    if (!procScanSupported() || !this.isPrivateEnvDir(env)) return recorded;
    const inTree = scanByCwd(env.root);
    const survivors = await this.reapDiscoveredProcesses(inTree, recorded);
    if (inTree.length === 0) return survivors;
    const killed = inTree.filter((p) => !Object.values(survivors).some((rec) => rec.pid === p.pid));
    // Never silent: this path kills by location rather than by tag, so the
    // evidence for every one of those decisions has to be on the record.
    logEvent({
      level: 'info',
      kind: 'teardown',
      envId: env.id,
      detail:
        `${killed.length}/${inTree.length} untagged process(es) were still running inside the environment directory and were reclaimed by cwd` +
        ` (${inTree.map((p) => `${p.pid}:${p.cwd}`).join(', ')})`,
    });
    return survivors;
  }

  /** Slow teardown of an already-claimed ('recycling') env. */
  private async teardownClaimed(env: EnvRow): Promise<boolean> {
    // deleteEnv drops the lease row by raw SQL, taking the only record of its
    // preview tunnel with it — so the tunnel has to be reaped here, while it can
    // still be named. Teardown outranks the lease: --force is what took it.
    const lease = this.journal.leaseForEnv(env.id);
    if (lease?.previewPid) await this.stopPreviewForLease(lease);
    const survivors = await this.supervisor(env).stopAll();
    this.supervisors.delete(env.id);
    // After a daemon restart the in-memory supervisor is EMPTY, so stopAll is a
    // no-op and only the journal knows what is still running. Reap those too,
    // or teardown deletes the row and the processes become unattributable
    // except by tag.
    //
    // Recorded pids are the SERVICE pids only — a service's own children were
    // never on the books. Teardown used to stop there, so an escaped grandchild
    // (setsid, or a detached worker) outlived the whole teardown: the orphan
    // that accumulated into gigabytes of unattributable RSS. Sweep by tag, then
    // by cwd in the env's PRIVATE directory, which is about to be removed. The
    // worktree the services ran in is never cwd-scanned (see reapEnvTree).
    // Live supervisor LAST: if the journal and the supervisor disagree about a
    // service's pid (a restart landing between the onPidsChanged write and here),
    // the thing that just tried to kill it holds the newer number, and reaping
    // the stale one would leave the live process behind.
    const recorded = this.journal.getEnv(env.id)?.servicePids ?? env.servicePids;
    let unresolved = await this.reapEnvProcesses(env, mergeServicePids(recorded, survivors));
    const stopping = this.journal.getEnv(env.id);
    if (stopping) {
      stopping.servicePids = unresolved;
      this.journal.saveEnv(stopping);
    }
    unresolved = await this.reapEnvTree(env, unresolved);
    if (Object.keys(unresolved).length > 0) {
      const live = this.journal.getEnv(env.id);
      if (live) {
        live.state = 'warm';
        live.servicePids = unresolved;
        this.journal.saveEnv(live);
      }
      logEvent({
        level: 'warn',
        kind: 'teardown',
        envId: env.id,
        detail: `${Object.keys(unresolved).length} service process(es) outlived teardown — ownership and capacity retained; retry recycling once they can be reclaimed`,
      });
      return false;
    }
    // Drop the datastore namespaces. Each one created by 0.16 or later carries
    // its own drop on the row (decision 0037), so this needs neither the
    // manifest nor the worktree — both are commonly gone by now (a removed
    // worktree is one of the reasons we are here). Older rows fall back to
    // the manifest, best effort.
    const fresh = this.journal.getEnv(env.id) ?? env;
    const recipes: Record<string, DropRecipe> = { ...(fresh.dropRecipes ?? {}) };
    let stack: Stack | undefined;
    try {
      stack = loadStack(env.stackRoot);
    } catch {
      stack = undefined;
    }
    const dirs = this.envDirs(env.id);
    // Repo commands run where the environment ran — its worktree — unless
    // that is gone, when the state root is at least somewhere they can start.
    const cwdFor = (wanted?: string) => (wanted && existsSync(wanted) ? wanted : existsSync(env.stackRoot) ? env.stackRoot : stateRoot());
    for (const name of Object.keys(fresh.datastoreNs)) {
      const recipe = recipes[name];
      try {
        if (recipe) {
          await this.runDropRecipe(recipe, cwdFor(recipe.cwd));
          continue;
        }
        const spec = stack?.manifest.datastores?.[name];
        if (!spec || !stack) throw new Error('no drop recorded on the environment and no manifest to read one from');
        const h: DsHandle = { envId: env.id, cwd: cwdFor(), dataDir: dirs.data };
        await makeDatastore(name, spec, stack.id).drop(h);
      } catch (err) {
        // The env row is about to be deleted, taking the only record of this
        // namespace with it — so a swallowed failure leaks a server-side
        // database nothing can ever name again. Say so loudly enough to be
        // actionable ('runly pool doctor' finds it by its name).
        logEvent({
          level: 'error',
          kind: 'teardown',
          envId: env.id,
          detail: `datastore '${name}' namespace (${fresh.datastoreNs[name]}) was NOT dropped and is now orphaned on the server — 'runly pool doctor --fix' can drop it: ${String((err as Error).message ?? err)}`,
        });
      }
    }
    // The environment's PRIVATE directory goes; the worktree it ran in never
    // does (decision 0032). Both are recorded on the row, so check the one
    // against the other before an rm -rf rather than trust that they differ.
    if (this.isPrivateEnvDir(env)) rmSync(env.root, { recursive: true, force: true });
    else logEvent({ level: 'error', kind: 'teardown', envId: env.id, detail: `refused to delete ${env.root}: it is not a private environment directory under ${envsRoot()}, or it contains the worktree ${env.stackRoot}` });
    this.journal.deleteEnv(env.id);
    // Its public ports go back to the block only now, with the row that recorded them.
    this.proxy.closeEnv(env.id);
    if (lease) {
      this.leaseInputs.delete(lease.id);
      this.goneSince.delete(`lease:${lease.id}`);
    }
    this.appliedInputs.delete(env.id);
    this.appliedInputSpecs.delete(env.id);
    this.appliedManifests.delete(env.id);
    this.envManifests.delete(env.id);
    this.activityDirty.delete(env.id);
    this.activityFlushedAt.delete(env.id);
    for (const key of [...this.startedAt.keys()]) if (key.startsWith(`${env.id}\0`)) this.startedAt.delete(key);
    for (const key of [...this.idleStopped]) if (key.startsWith(`${env.id}\0`)) this.idleStopped.delete(key);
    for (const key of [...this.failedServices.keys()]) if (key.startsWith(`${env.id}\0`)) this.failedServices.delete(key);
    for (const key of [...this.idleStoppedAt.keys()]) if (key.startsWith(`${env.id}\0`)) this.idleStoppedAt.delete(key);
    for (const key of [...this.waking.keys()]) if (key.startsWith(`${env.id}\0`)) this.waking.delete(key);
    this.envChains.delete(env.id); // don't leak a settled chain for a dead id
    logEvent({ level: 'info', kind: 'teardown', envId: env.id, detail: `torn down: services, ${Object.keys(fresh.datastoreNs).length} datastore namespace(s), ports and lease` });
    return true;
  }

  /**
   * Drop one namespace the way its row recorded it (decision 0037): run the
   * templated drop command, or delete a file inside the state root. Throws
   * when the drop did not confirm.
   */
  private async runDropRecipe(recipe: DropRecipe, cwd: string): Promise<void> {
    if (recipe.cmd) {
      const r = await runBounded(recipe.cmd, cwd, cmdTimeoutS());
      if (r.timedOut || r.code !== 0) throw new Error(`drop command ${r.timedOut ? 'timed out' : `exited ${r.code}`}: ${r.output.slice(-300)}`);
    }
    if (recipe.path) {
      const rel = relative(stateRoot(), recipe.path);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refused to delete ${recipe.path}: it is not under the state root ${stateRoot()}`);
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${recipe.path}${suffix}`, { force: true });
    }
  }

  /**
   * Is `env.root` safe to delete? It must sit strictly inside the state root's
   * envs/ directory, and must not be (or contain) the worktree the
   * environment runs in — a corrupted row must never turn teardown into
   * `rm -rf` of someone's work.
   */
  private isPrivateEnvDir(env: EnvRow): boolean {
    const inside = (parent: string, child: string) => {
      const rel = relative(parent, child);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    };
    if (!inside(envsRoot(), env.root)) return false;
    return !(env.root === env.stackRoot || inside(env.root, env.stackRoot));
  }

  private async recycleOne(envId: string, force: boolean): Promise<'recycled' | 'unclaimed' | 'survivors'> {
    const claimed = await this.claimForTeardown(envId, force);
    if (!claimed) return 'unclaimed';
    return await this.teardownClaimed(claimed) ? 'recycled' : 'survivors';
  }

  /**
   * The clean-slate button, scoped.
   *
   * `envId` is an explicit statement of intent — THIS one, not the others — and
   * it used to be dropped on the floor, so aiming at one cold environment
   * recycled the whole pool and tore down siblings' live work. A named target
   * therefore never widens: an unknown id is a usage error, and a leased target
   * REFUSES rather than being silently skipped, because "nothing happened and
   * nothing said why" is what sends a caller reaching for force.
   *
   * `force` (--force, historically --all) is the only thing that ever reclaims a
   * leased environment; `busy` is never interrupted, not even by force.
   */
  async poolRecycle(opts: { envId?: string; force: boolean }) {
    const { envId, force } = opts;
    const skipped: Array<{ envId: string; reason: string }> = [];
    const survivorReason = (id: string) => `environment ${id} has unreaped service processes — ownership and capacity retained; run 'runly doctor' to inspect them, then retry recycling once they can be reclaimed`;
    if (envId) {
      const env = this.journal.getEnv(envId);
      if (!env) {
        const known = this.journal.allEnvs().map((e) => e.id);
        throw new BrokerError(
          'work-error',
          `no environment '${envId}'${known.length ? ` — this pool has ${known.join(', ')}` : ' — the pool is empty'}`,
          'pool',
        );
      }
      const lease = this.journal.leaseForEnv(envId);
      if (lease && !force) {
        throw new BrokerError(
          'work-error',
          `environment ${envId} is leased by '${lease.holder}' (${lease.kind}) — recycling it would destroy work in progress; pass --force if you mean to take it anyway`,
          'pool',
        );
      }
      const outcome = await this.recycleOne(envId, force);
      if (outcome === 'survivors') throw new BrokerError('env-error', survivorReason(envId), 'pool');
      if (outcome === 'unclaimed') {
        // claimForTeardown declines for three reasons, and only these are left
        // after the checks above: an operation in flight, a teardown already
        // under way, or a lease that appeared in the gap. Never claim which.
        throw new BrokerError(
          'work-error',
          `environment ${envId} could not be claimed — it is busy, already being torn down, or was just leased; retry once it settles`,
          'pool',
        );
      }
      logEvent({ level: 'info', kind: 'pool-recycle', detail: `recycled ${envId}${force ? ' (--force)' : ''}` });
      return { recycled: [envId], skipped };
    }
    const recycled: string[] = [];
    for (const env of this.journal.allEnvs()) {
      const outcome = await this.recycleOne(env.id, force);
      if (outcome === 'recycled') {
        recycled.push(env.id);
        continue;
      }
      if (outcome === 'survivors') {
        skipped.push({ envId: env.id, reason: survivorReason(env.id) });
        continue;
      }
      // Say what survived and why. A silent skip reads as "recycle did not
      // work", and the next thing a caller reaches for is force.
      const lease = this.journal.leaseForEnv(env.id);
      skipped.push({
        envId: env.id,
        reason: lease ? `leased by '${lease.holder}' (${lease.kind}) — pass --force to take it anyway` : 'an operation is in flight',
      });
    }
    logEvent({
      level: 'info',
      kind: 'pool-recycle',
      detail: `recycled ${recycled.length} env(s)${force ? ' (--force)' : ''}${skipped.length ? `, left ${skipped.length} alone` : ''}`,
    });
    return { recycled, skipped };
  }

  /** This worktree's degraded, idle environment(s), reaped so a claim can recreate one. */
  private async reapDegradedOwn(stack: Stack): Promise<boolean> {
    let reaped = false;
    for (const env of this.journal.envsForStack(stack.id)) {
      if (env.state !== 'degraded' || this.busy.has(env.id)) continue;
      if (await this.recycleOne(env.id, true) === 'recycled') reaped = true;
    }
    return reaped;
  }

  /**
   * One environment per worktree (decision 0032) holds for every environment
   * this daemon creates. A journal from an older runly can still hold several
   * for one stack; the unleased, idle ones beyond the one to keep are recycled
   * here, so the pool converges. A surplus environment that is still leased is
   * left to its holder until the lease ends.
   */
  private async drainSurplusEnvs(): Promise<void> {
    const byStack = new Map<string, EnvRow[]>();
    for (const env of this.journal.allEnvs()) byStack.set(env.stack, [...(byStack.get(env.stack) ?? []), env]);
    for (const rows of byStack.values()) {
      if (rows.length < 2) continue;
      const leased = rows.filter((e) => this.journal.leaseForEnv(e.id));
      // Keep every leased one; if none is leased, keep the most recently used.
      const keep = new Set(leased.length > 0 ? leased.map((e) => e.id) : [rows.reduce((a, b) => (a.lastUsedAt >= b.lastUsedAt ? a : b)).id]);
      for (const env of rows) {
        if (keep.has(env.id) || this.busy.has(env.id)) continue;
        if (await this.recycleOne(env.id, false) === 'recycled') {
          logEvent({ level: 'info', kind: 'pool-evict', envId: env.id, detail: `a second environment for one worktree (from an older runly) — recycled; a worktree has one environment (decision 0032)` });
        }
      }
    }
  }

  /** Reap the provably-dead (degraded) envs now, instead of waiting for the sweep. */
  async poolReconcile() {
    const reaped: string[] = [];
    for (const env of this.journal.allEnvs()) {
      if (env.state === 'degraded' && await this.recycleOne(env.id, true) === 'recycled') reaped.push(env.id);
    }
    logEvent({ level: 'info', kind: 'pool-reconcile', detail: `reaped ${reaped.length} degraded env(s)` });
    return { reaped };
  }

  // ---------------------------------------------------------------- lifecycle (decision 0035)

  /** The proxy saw a client byte: the clock moves in memory, and reaches the journal throttled. */
  private noteActivity(envId: string, key: string): void {
    const at = now();
    const dirty = this.activityDirty.get(envId) ?? {};
    dirty[key] = at;
    this.activityDirty.set(envId, dirty);
    if (at - (this.activityFlushedAt.get(envId) ?? 0) > 5_000) this.flushActivity(false, envId);
  }

  /** Persist unsaved activity clocks (all, from the sweeper; one env, throttled, from the hook). */
  private flushActivity(all: boolean, only?: string): void {
    for (const [envId, clocks] of [...this.activityDirty]) {
      if (!all && envId !== only) continue;
      this.activityDirty.delete(envId);
      this.activityFlushedAt.set(envId, now());
      try {
        this.journal.saveActivity(envId, clocks);
      } catch {
        /* the row may be gone */
      }
    }
  }

  /** When anyone last used this environment: a runly verb or a client byte on any of its ports. */
  private envActivityAt(env: EnvRow): number {
    let at = env.lastUsedAt;
    for (const v of Object.values(this.proxy.activity(env.id))) if (v !== null && v > at) at = v;
    for (const v of Object.values(env.activity ?? {})) if (v > at) at = v;
    return at;
  }

  /**
   * One running service's idle clock: the environment's last runly verb, the
   * last client byte through the service's own public port (any port's, for
   * a service with none), and its own start.
   */
  private serviceClock(env: EnvRow, service: string, spec: ServiceSpec | undefined): number {
    let at = Math.max(env.lastUsedAt, this.startedAt.get(`${env.id}\0${service}`) ?? 0);
    const clocks: Record<string, number | null> = { ...(env.activity ?? {}) };
    for (const [k, v] of Object.entries(this.proxy.activity(env.id))) if (v !== null && v > (clocks[k] ?? 0)) clocks[k] = v;
    for (const [k, v] of Object.entries(clocks)) {
      if (v === null) continue;
      if (spec?.port ? k === spec.port : true) at = Math.max(at, v);
    }
    return at;
  }

  /**
   * How long a running service of `env` may sit idle: its `idle:` (or the
   * default), capped for an UNLEASED environment — nobody can wake that one by
   * traffic — at BACKLOT_IDLE_TTL_MS (the pre-0.16 quiesce). `ps` shows the same.
   */
  private serviceIdleLimit(env: EnvRow, spec: ServiceSpec | undefined): number {
    const unleasedCap = this.journal.leaseForEnv(env.id) ? Infinity : policy().idleTtlMs;
    return Math.min(serviceIdleMs(spec), unleasedCap);
  }

  /** Stop the running services of `env` whose idle clock ran out. */
  private async stopIdleServices(env: EnvRow): Promise<void> {
    if (env.state !== 'hot') return;
    const sup = this.supervisors.get(env.id);
    if (!sup) return;
    const manifest = this.envManifests.get(env.id);
    // Nobody can wake an UNLEASED environment by traffic, so its services stop
    // after BACKLOT_IDLE_TTL_MS at the latest, whatever `idle:` says (the
    // pre-0.16 quiesce of an unleased environment).
    const due = (row: EnvRow) => Object.keys(sup.pids()).filter((name) => {
      const spec = manifest?.services[name];
      const limit = this.serviceIdleLimit(row, spec);
      return Number.isFinite(limit) && now() - this.serviceClock(row, name, spec) > limit;
    });
    if (due(env).length === 0) return;
    await this.envLocked(env.id, async () => {
      const fresh = this.journal.getEnv(env.id);
      if (!fresh || fresh.state !== 'hot') return;
      const names = due(fresh); // touched while we queued?
      if (names.length === 0) return;
      try {
        await this.stopServicesForRestart(fresh, names);
      } catch (err) {
        logEvent({ level: 'warn', kind: 'idle', envId: env.id, detail: `stopping idle ${names.join(', ')} left survivors: ${String((err as Error).message ?? err)}` });
        return;
      }
      for (const n of names) {
        this.idleStopped.add(`${env.id}\0${n}`);
        this.idleStoppedAt.set(`${env.id}\0${n}`, now());
      }
      const post = this.journal.getEnv(env.id);
      if (post) {
        if (Object.keys(sup.pids()).length === 0) post.state = 'warm';
        post.servicePids = sup.pids();
        this.journal.saveEnv(post);
      }
      logEvent({ level: 'info', kind: 'idle', envId: env.id, detail: `stopped idle ${names.map((n) => `'${n}'`).join(', ')} — lease, data and ports kept; the next connection or 'runly up' starts ${names.length === 1 ? 'it' : 'them'} again` });
    }, undefined, 'an idle stop');
  }

  /**
   * Is a tether gone (decision 0035)? A dead pid is believed only once it has
   * stayed dead for the grace (BACKLOT_TETHER_GRACE_MS, 1 minute); the first
   * sighting starts the clock, in memory — a daemon restart starts it again.
   */
  private tetherGone(key: string, pid: number, start?: number): boolean {
    if (!this.holderGone(pid, start)) {
      this.goneSince.delete(key);
      return false;
    }
    const since = this.goneSince.get(key) ?? now();
    this.goneSince.set(key, since);
    return now() - since >= policy().tetherGraceMs;
  }

  /**
   * The proxy's wake hook (decision 0035): a connection reached the public
   * port of a service that is not running. Starts it when this environment
   * holds a live lease and the lease wants that service (a `down`ed service
   * stays down); the proxy holds the connection meanwhile. Synchronous and
   * cheap: the start runs in the background.
   */
  private requestWake(envId: string, key: string): boolean {
    try {
      if (this.stopping) return false;
      const env = this.journal.getEnv(envId);
      if (!env || env.state === 'recycling' || env.state === 'degraded') return false;
      // A bind that failed is redone by `up`, not by traffic: its survivors
      // may still hold the service's resources, and its data may be half-made.
      if ((env.failStreak ?? 0) > 0) return false;
      const lease = this.journal.leaseForEnv(envId);
      if (!lease || lease.expiresAt <= now()) return false;
      const stack = loadStack(env.stackRoot);
      if (stack.id !== env.stack) return false;
      const name = Object.entries(stack.manifest.services).find(([, spec]) => spec.port === key)?.[0];
      if (!name || !this.desiredServices(stack, env).has(name)) return false;
      // A failed service is retried by `up`, not by traffic (decision 0039).
      if (this.failureOf(envId, name)) return false;
      const id = `${envId}\0${name}`;
      if (!this.waking.has(id)) {
        const p = this.wakeService(env.id, name)
          .catch((err) => logEvent({ level: 'warn', kind: 'wake', envId, detail: `starting '${name}' on demand failed: ${String((err as Error).message ?? err)}` }))
          .finally(() => this.waking.delete(id));
        this.waking.set(id, p);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start one wanted service — and the wanted, stopped members of its
   * depends_on closure — on demand. `up`'s start path for a single service:
   * appliances ensured, datastores kept, the load budget asked (bounded by
   * how long the proxy holds a connection), no rebuild unless needed (a
   * `when:` build whose inputs changed, or one that never succeeded here).
   */
  private async wakeService(envId: string, name: string): Promise<void> {
    const started = now();
    let closure = new Set<string>([name]);
    let keyOf: (n: string) => string | undefined = () => undefined;
    try {
      await this.envLocked(envId, async () => {
        const env = this.journal.getEnv(envId);
        const lease = this.journal.leaseForEnv(envId);
        if (this.stopping || !env || !lease || env.state === 'recycling' || env.state === 'degraded') throw new BrokerError('env-error', `environment ${envId} cannot be woken (no live lease, or being torn down)`, 'wake');
        const stack = loadStack(env.stackRoot);
        keyOf = (n) => stack.manifest.services[n]?.port;
        const sup = this.supervisor(env);
        const running = new Set(Object.keys(sup.pids()));
        if (running.has(name)) {
          // Started by an `up` while this waited: forward to it.
          const key = keyOf(name);
          const internal = key ? this.proxy.internalPortOf(envId, key) : undefined;
          if (key && internal !== undefined) this.proxy.up(envId, key, internal, name);
          return;
        }
        const wanted = this.desiredServices(stack, env);
        closure = new Set([...this.resolveServiceClosure(stack, [name])].filter((n) => wanted.has(n) && !running.has(n)));
        if (closure.size === 0) {
          // A `down` queued ahead of this wake took the service out of the
          // wanted set: nothing is to start. Close what the proxy holds now
          // and leave the environment's state alone — marking it `hot` with
          // nothing running held the client until the hold timeout.
          const key = keyOf(name);
          if (key && this.proxy.state(envId, key) !== 'up') this.proxy.down(envId, key);
          return;
        }
        await this.startStoppedLocked(stack, env, lease, closure, {
          label: `wake ${name} (${envId})`,
          source: 'wake',
          waitMs: Math.max(1000, HOLD_MS() - (now() - started) - 5_000),
        });
        logEvent({ level: 'info', kind: 'wake', envId, detail: `started ${[...closure].map((n) => `'${n}'`).join(', ')} on a connection to its public port (${formatDuration(now() - started)})` });
      }, undefined, 'a start on demand');
    } catch (err) {
      // Whatever the proxy holds for these services is closed now, not at the hold timeout.
      for (const n of closure) {
        const key = keyOf(n);
        if (key && this.proxy.state(envId, key) !== 'up') this.proxy.down(envId, key);
      }
      throw err;
    }
  }

  /**
   * Start `closure` — stopped services the lease wants — the way a wake does.
   * MUST run under the environment's lock. A wake never restores data: a
   * datastore that exists is kept as it is, so the trigger listing behind the
   * template keys is computed only for one that is missing.
   */
  private async startStoppedLocked(
    stack: Stack, env: EnvRow, lease: LeaseRow, closure: Set<string>,
    opts: { label: string; source: string; waitMs?: number; say?: Progress },
  ): Promise<void> {
    const sup = this.supervisor(env);
    const running = new Set(Object.keys(sup.pids()));
    const values = this.leaseInputs.get(lease.id)?.values ?? selectCallerEnv(stack.manifest, {});
    requireCallerEnv(stack.manifest, closure, values);
    const need = await this.needFor(stack, env, closure, closure, { rebuild: false, mode: 'wake' });
    // Resuming what ran a moment ago adds nothing the box did not just carry:
    // the CPU gate is skipped for it (the memory gates still apply).
    const recent = [...closure].every((n) => now() - (this.idleStoppedAt.get(`${env.id}\0${n}`) ?? -Infinity) < RECENT_RUN_MS);
    const reservation = await this.budget.admit(need, opts.label, { waitMs: opts.waitMs, source: opts.source, skipLoadGate: recent });
    try {
      const say: Progress = opts.say ?? (() => undefined);
      await this.ensureAppliances(stack, say, reservation);
      const missing = this.envDatastores(stack).filter((n) => !env.datastoreNs[n]);
      if (missing.length > 0) {
        const bakeKeys = templateBakeKeys(stack.manifest, stack.root, await triggerSet(stack.root, stack.manifest, worktreeStateDir(stack.id)));
        await this.prepareDatastores(stack, env, bakeKeys, missing.map((n) => ({ name: n, force: false })), say);
      }
      const ctx = this.templateCtx(stack, env);
      await this.treeLocked(stack.id, () => this.runBuilds(stack, env, closure, ctx, say, { rebuild: false, mode: 'wake' }));
      reservation.releaseBuild();
      await this.startServices(stack, env, new Set([...running, ...closure]), closure, { values }, say, 'stop-these', reservation);
    } finally {
      reservation.release();
    }
    const post = this.journal.getEnv(env.id);
    if (post) {
      post.state = 'hot';
      post.servicePids = sup.pids();
      this.journal.saveEnv(post);
    }
  }

  /**
   * `exec` and `token` run against the environment as the lease left it. A
   * service the idle clock stopped (decision 0035) is started first — under
   * the lock these verbs hold, where a connection-triggered wake would only
   * queue behind them until the proxy's hold ran out. What stopped for
   * another reason (a daemon restart) is refused as before: `runly up`
   * rebinds it, and a failed bind is redone by `up`, never by a verb.
   */
  private async resumeForVerb(env: EnvRow, verb: string): Promise<void> {
    const lease = this.journal.leaseForEnv(env.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'runly up' first`, 'lease');
    let stack: Stack;
    try {
      stack = loadStack(env.stackRoot);
    } catch {
      return; // the verb reports the manifest itself
    }
    const running = new Set(Object.keys(this.supervisor(env).pids()));
    // A failed service (decision 0039) is not resumed by a verb: `up` retries it.
    const stopped = [...this.desiredServices(stack, env)].filter((n) => !running.has(n) && !this.failureOf(env.id, n));
    if (stopped.length === 0) return;
    const unexplained = stopped.filter((n) => !this.idleStopped.has(`${env.id}\0${n}`));
    if (unexplained.length > 0 || (env.failStreak ?? 0) > 0) {
      throw new BrokerError(
        'env-error',
        (env.failStreak ?? 0) > 0
          ? `environment ${env.id} holds your lease but its last 'runly up' failed and ${stopped.map((n) => `'${n}'`).join(', ')} ${stopped.length === 1 ? 'is' : 'are'} not running — run 'runly up' before ${verb}`
          : `environment ${env.id} holds your lease but its services are not running (the daemon restarted) — run 'runly up' to rebind before exec/token`,
        'lease',
      );
    }
    const wanted = this.desiredServices(stack, env);
    const closure = new Set([...this.resolveServiceClosure(stack, stopped)].filter((n) => wanted.has(n) && !running.has(n)));
    await this.startStoppedLocked(stack, env, lease, closure, { label: `${verb} (${env.id})`, source: verb });
    logEvent({ level: 'info', kind: 'wake', envId: env.id, detail: `started idle-stopped ${[...closure].map((n) => `'${n}'`).join(', ')} for ${verb}` });
  }

  /**
   * A service the supervisor restarts after a crash (decision 0035): its
   * port HOLDS connections from the crash until the new process accepts on
   * its (unchanged) internal port, instead of refusing them.
   */
  private serviceCrashed(envId: string, service: string): void {
    const key = this.envManifests.get(envId)?.services[service]?.port;
    if (key && this.proxy.state(envId, key) === 'up') this.proxy.starting(envId, key, service);
  }

  private serviceRelaunched(envId: string, service: string): void {
    const spec = this.envManifests.get(envId)?.services[service];
    const key = spec?.port;
    if (!key) return;
    const internal = this.proxy.internalPortOf(envId, key);
    if (internal === undefined) return;
    const deadline = now() + (spec.ready?.timeout ?? 120) * 1000;
    const tick = async (): Promise<void> => {
      if (this.proxy.state(envId, key) !== 'starting') return; // stopped or rebound meanwhile
      if (await acceptsOn(internal, '127.0.0.1') || await acceptsOn(internal, '::1')) {
        if (this.proxy.state(envId, key) === 'starting' && this.proxy.internalPortOf(envId, key) === internal) this.proxy.up(envId, key, internal, service);
        return;
      }
      if (now() > deadline) {
        this.proxy.down(envId, key);
        return;
      }
      setTimeout(() => void tick(), 150).unref();
    };
    void tick();
  }

  private serviceGaveUp(envId: string, service: string): void {
    const key = this.envManifests.get(envId)?.services[service]?.port;
    if (key) this.proxy.down(envId, key);
  }

  /**
   * A service of a LEASED environment crash-looped past its restart budget
   * (decision 0039). It is stopped and reported as failed — `ps` and `ctx`
   * show `failed` with its last exit, `runly logs <svc>` says why — while the
   * environment, its data, its other services and its logs stay. Nothing
   * restarts it on its own (a wake skips it); the next `up` does.
   */
  private serviceFailed(envId: string, service: string, exit: ServiceExit): void {
    const key = `${envId}\0${service}`;
    this.failedServices.set(key, { ...exit, at: now() });
    const portKey = this.envManifests.get(envId)?.services[service]?.port;
    if (portKey) this.proxy.down(envId, portKey);
    logEvent({
      level: 'warn',
      kind: 'service-failed',
      envId,
      detail: `'${service}' ${describeExit(exit)} — stopped and marked failed; the environment, its data, its other services and its logs are kept. 'runly logs ${service}' shows why; the next 'runly up' starts it again`,
    });
    const sup = this.supervisors.get(envId);
    if (!sup) return;
    // What is left of it (its process group, tagged stragglers) is reaped
    // under the environment lock. A bind holding the lock now fails on its
    // own and stops everything first; then this finds nothing to do.
    void this.envLocked(envId, async () => {
      if (this.supervisors.get(envId) !== sup || !this.failedServices.has(key) || sup.pids()[service]) return;
      const env = this.journal.getEnv(envId);
      if (!env || env.state === 'recycling') return;
      await this.stopServicesForRestart(env, [service]);
      const post = this.journal.getEnv(envId);
      if (post && post.state === 'hot' && Object.keys(sup.pids()).length === 0) {
        post.state = 'warm';
        this.journal.saveEnv(post);
      }
    }, undefined, 'stopping a failed service').catch((err) =>
      logEvent({ level: 'warn', kind: 'service-failed', envId, detail: `stopping failed '${service}' left survivors: ${String((err as Error).message ?? err)}` }),
    );
  }

  /** How a failed service ended, or undefined (decision 0039). */
  private failureOf(envId: string, service: string): (ServiceExit & { at: number }) | undefined {
    return this.failedServices.get(`${envId}\0${service}`);
  }

  // ---------------------------------------------------------------- sweeper

  async sweep(): Promise<void> {
    // One sweep at a time: a tick that lands while the last one still awaits
    // a teardown or a drop would act on the same snapshot twice.
    if (this.sweeping || this.stopping) return;
    this.sweeping = true;
    try {
      await this.sweepOnce();
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOnce(): Promise<void> {
    const t = now();
    const gap = t - this.lastSweep;
    const interval = Number(process.env.BACKLOT_SWEEP_MS ?? 15_000);
    // Sleep pardon (decision 0009), two detectors:
    //
    // 1. darwin: the kernel's own record. kern.sleeptime/kern.waketime hold
    //    the timeval of the last sleep/wake transition — a wake newer than
    //    both the last pardoned wake and the previous sweep tick means the
    //    machine slept SINCE that tick, and the pardon gap is exactly
    //    waketime − sleeptime. This exists because the divergence detector
    //    below is INERT on Apple Silicon (confirmed by a real lid-close test,
    //    2026-07-19): mach_absolute_time keeps advancing through real sleep
    //    there, so wall and mono never diverge. A failed sysctl read yields
    //    null legs and simply falls through to detector 2.
    //
    // 2. All platforms: wall-vs-monotonic divergence. A long gap in
    //    wall-clock time can mean the machine suspended — or merely that the
    //    event loop was starved (a synchronous hash of a huge tree, heavy
    //    host load). Pardoning the second case pushes every lease and idle
    //    deadline out for a machine that never slept, so leases outlive
    //    their TTL and idle envs keep their memory. performance.now() does
    //    not advance while suspended on Linux, so wall-clock advancing far
    //    beyond it is the signal that distinguishes them.
    //
    // One sleep, one pardon: kernelSleepGap refuses a wake at/before the
    // previous sweep tick (so a gap detector 2 pardoned last sweep is stale
    // to detector 1), and detector 2 is skipped on a sweep where detector 1
    // fired (the same sleep produces both signals in the same sweep window).
    const monoGap = performance.now() - this.lastSweepMono;
    this.lastSweepMono = performance.now();
    let pardoned = false;
    if (process.platform === 'darwin') {
      const rec = readKernelSleepRecord();
      const kernelGap = kernelSleepGap({ ...rec, lastPardonedWake: this.lastPardonedWake, lastSweepWall: this.lastSweep });
      if (kernelGap !== null && rec.waketime !== null) {
        this.journal.pardon(kernelGap);
        this.lastPardonedWake = rec.waketime;
        pardoned = true;
        logEvent({
          level: 'info',
          kind: 'pardon',
          detail: `machine slept ${Math.round(kernelGap / 1000)}s — every lease/idle deadline shifted by the gap (detector: kern.sleeptime/kern.waketime)`,
        });
      }
    }
    const suspended = gap - monoGap > 2 * interval;
    if (!pardoned && gap > 3 * interval && suspended) {
      this.journal.pardon(gap - interval);
      logEvent({
        level: 'info',
        kind: 'pardon',
        detail: `machine slept ~${Math.round((gap - interval) / 1000)}s — every lease/idle deadline shifted by the gap (detector: wall-vs-monotonic)`,
      });
    }
    this.lastSweep = t;

    // Orphan reclaim (~1 min cadence): a consumer that died ungracefully can
    // strand a dev-server between daemon restarts, and each one is ~1 GB. Far
    // cheaper than a /proc scan every sweep, far sooner than the next restart.
    if (t - this.lastGc > Number(process.env.BACKLOT_GC_MS ?? 60_000)) {
      this.lastGc = t;
      try {
        await this.poolGc(false);
      } catch {
        /* best-effort */
      }
    }

    // Disk retention (~10 min cadence): nothing runly writes grows forever.
    if (t - this.lastRetention > Number(process.env.BACKLOT_RETENTION_MS ?? 10 * 60_000)) {
      this.lastRetention = t;
      try {
        const protectedStacks = new Set<string>();
        for (const env of this.journal.allEnvs()) {
          try {
            const stack = loadStack(env.stackRoot);
            this.adoptLegacyAliases(stack);
            if (this.journal.getEnv(env.id)?.stack !== stack.id) protectedStacks.add(env.stack);
          } catch { protectedStacks.add(env.stack); }
        }
        await retentionSweep(this.journal, policy(), protectedStacks);
      } catch {
        /* best-effort */
      }
    }

    // Activity the proxy saw since the last flush reaches the journal (decision 0035).
    this.flushActivity(true);
    // An appliance runly started and someone stopped since no longer costs anything.
    await this.pruneStartedAppliances();

    for (const snapshot of this.journal.allLeases()) {
      // allLeases() is ONE snapshot and this body awaits — endLease blocks in
      // killGroupVerified for seconds. In that window a holder can release and
      // rebind, or republish a preview, so a later entry may already describe a
      // lease that no longer exists. Acting on the snapshot killed the pid it
      // remembered and then deleted the row that named the LIVE one.
      const lease = this.journal.leaseForEnv(snapshot.envId);
      if (!lease || lease.id !== snapshot.id) continue;
      // A lease can name an env row that no longer exists: deleteEnv's two
      // deletes were not one transaction before, so a daemon SIGKILLed
      // between them left exactly this half-state (journals outlive
      // releases, so old torn writes and corruption still can). Nothing
      // resolves it — every read JOINs envs, so the row is invisible to
      // holders yet squats in the journal until its TTL, and pardon() keeps
      // shifting that deadline. Disk is truth: prune the corpse, and say so.
      if (!this.journal.getEnv(lease.envId)) {
        await this.endLease(lease);
        logEvent({
          level: 'warn',
          kind: 'lease',
          envId: lease.envId,
          detail: `lease ${lease.id} points at environment ${lease.envId}, which no longer exists — pruned (torn journal write)`,
        });
        continue;
      }
      // Never expire a lease whose env has an operation in flight (a long bind
      // under a tiny TTL must not lose its env mid-bind).
      if (this.busy.has(lease.envId)) continue;
      // A quick tunnel is best-effort: cloudflared drops it on network churn and
      // exits on its own, and nothing else looks while the daemon is up — so ctx
      // kept advertising a URL that had stopped answering an hour earlier, and
      // `preview stop` reported success for a corpse. Below the busy guard: a
      // publish in flight has already killed the pid this row still names.
      if (lease.previewPid && !sameProcess(lease.previewPid, lease.previewStart)) {
        const service = lease.previewService ?? 'unknown';
        this.journal.clearLeasePreview(lease.id, lease.previewPid);
        lease.previewPid = undefined;
        lease.previewStart = undefined;
        lease.previewUrl = undefined;
        lease.previewService = undefined;
        lease.previewPort = undefined;
        logEvent({
          level: 'warn',
          kind: 'preview',
          envId: lease.envId,
          detail: `the preview tunnel for '${service}' exited on its own — its URL is no longer published; run 'runly preview ${service}' again for a new one`,
        });
      }
      if (lease.holderPid !== undefined) {
        // The tether (decision 0035). The agent gone — believed only after the
        // grace, so a pid read racing an exec is not a death — means the
        // environment goes, all of it: services, data, tunnel, ports, lease.
        if (this.tetherGone(`lease:${lease.id}`, lease.holderPid, lease.holderStart)) {
          const outcome = await this.recycleOne(lease.envId, true);
          logEvent({
            level: outcome === 'recycled' ? 'info' : 'warn',
            kind: 'lease',
            envId: lease.envId,
            detail: outcome === 'recycled'
              ? `its tether (holder process ${lease.holderPid}) has been gone for ${formatDuration(policy().tetherGraceMs)} or more — the environment was torn down: services, data, preview, ports and lease`
              : `its tether (holder process ${lease.holderPid}) is gone, but the teardown did not complete (${outcome}) — retried by the next sweep`,
          });
          if (outcome === 'recycled') this.goneSince.delete(`lease:${lease.id}`);
          continue;
        }
        // While the agent lives, its lease lives (decision 0035): the TTL
        // only bounds a lease nobody tethered.
        if (sameProcess(lease.holderPid, lease.holderStart) && lease.expiresAt < now() + LEASE_TTL() / 2) {
          this.journal.saveLease({ ...lease, expiresAt: now() + LEASE_TTL() });
          continue;
        }
      }
      if (lease.expiresAt < now()) {
        await this.endLease(lease);
      }
    }
    // Database copies (decision 0034) go when their holder or worktree does —
    // the same signals the leases above answer to, with no TTL.
    await this.reapDbCopies();
    for (const env of this.journal.allEnvs()) {
      if (this.busy.has(env.id)) continue;
      // An environment whose WORKTREE is gone — deleted or moved, or (after an
      // identity-scheme change or a manifest rename) its root no longer
      // resolves to the recorded stack id — is torn down, leased or not
      // (decision 0035: a worktree removed takes everything with it). A
      // manifest that merely fails to PARSE is not proof (someone may be
      // mid-edit), so only a positive id mismatch or a missing root reaps.
      let orphanReason: string | null = null;
      if (!existsSync(env.stackRoot)) {
        orphanReason = `its worktree ${env.stackRoot} is gone`;
      } else {
        try {
          const current = loadStack(env.stackRoot);
          if (this.legacyAlias(env, current)) this.adoptLegacyAliases(current);
          else if (current.id !== env.stack) orphanReason = `its worktree ${env.stackRoot} now resolves to '${current.id}', not '${env.stack}'`;
        } catch {
          /* unreadable manifest — ambiguous, leave the env alone */
        }
      }
      if (orphanReason) {
        logEvent({ level: 'info', kind: 'retention', envId: env.id, detail: `${orphanReason} — the environment is torn down (services, data, preview, ports, lease)` });
        const outcome = await this.recycleOne(env.id, true);
        // A deleted worktree's own records (upkeep ledger, trigger cache, build
        // ledger) go with it once nothing names its stack (decision 0037).
        if (outcome === 'recycled' && !existsSync(env.stackRoot) && this.journal.envsForStack(env.stack).length === 0 &&
          !this.journal.allDbCopies().some((c) => c.stack === env.stack)) {
          rmSync(join(worktreesRoot(), env.stack), { recursive: true, force: true });
        }
        continue;
      }
      if (env.state === 'degraded') {
        // Only an UNLEASED environment is recycled for a crash loop (decision
        // 0039): a leased one keeps its data, services and logs, and its
        // holder's next `up` retries. (A leased environment is not marked
        // degraded any more; one an older daemon marked is left to its holder.)
        if (this.journal.leaseForEnv(env.id)) continue;
        await this.recycleOne(env.id, false);
        continue;
      }
      // Idle (decision 0035): each running service on its own clock — the
      // last client byte through its public port, the last runly verb on the
      // environment, its own start. Readiness probes bypass the proxy and
      // never count. The lease, the data and the ports stay; the next
      // connection starts it again.
      await this.stopIdleServices(env);
    }
    await this.drainSurplusEnvs();
    // Maintenance runs after ownership/expiry/reaping and does at most one
    // bounded external drop per sweep. Recovery never waits for it.
    await this.retireLegacyTemplateBatch();
  }

  async shutdown(): Promise<void> {
    // Nothing new starts once a shutdown begins: no wake on a connection, no
    // sweep, no public listener taking connections it can only hold. The
    // listeners used to stay open through the (seconds-long) service stop
    // below, so a connection in that window woke a service the stopping
    // daemon then had to chase.
    this.stopping = true;
    this.proxy.setWakeHook(undefined);
    this.proxy.closeAll();
    // Activity clocks survive a restart (decision 0035): whatever the throttle held back is written now.
    this.flushActivity(true);
    // Leases survive a daemon stop; their tunnels do not. Nothing supervises a
    // published, unauthenticated URL once this process is gone, and the reap can
    // no longer ride on the service reap below — the tunnel outlives service
    // restarts by design now.
    for (const lease of this.journal.allLeases()) {
      if (lease.previewPid) await this.stopPreviewForLease(lease);
    }
    const survivors = new Map<string, Record<string, ServicePid>>();
    for (const [id, sup] of this.supervisors) survivors.set(id, await sup.stopAll());
    for (const env of this.journal.allEnvs()) {
      // Reap EVERY env with processes still on the books, not just the hot ones.
      // A stopping daemon is the last thing that will look: there is no next gc
      // pass and no next bind, so a group-signal escapee left here survives
      // until someone notices the host swapping. A previously-quiesced (warm)
      // env can carry recorded survivors too, which is why this is not gated on
      // `hot`. reapEnvProcesses returns what it could NOT confirm dead, and
      // that — never an assumption — is what the next daemon life inherits.
      const recorded = mergeServicePids(env.servicePids, survivors.get(env.id));
      // …except an in-flight operation, which is never interrupted — the rule
      // claimForTeardown, the sweeper and pool gc all already keep. An `exec`
      // runs DETACHED so it can outlive the daemon, and it carries this env's
      // tag, so the tag scan inside reapEnvProcesses would kill the very
      // process the caller is still waiting on.
      const unreaped = this.busy.has(env.id) ? recorded : await this.reapEnvProcesses(env, recorded);
      const fresh = this.journal.getEnv(env.id);
      if (!fresh) continue; // recycled underneath us — nothing to write back
      if (fresh.state === 'hot') fresh.state = 'warm';
      fresh.servicePids = unreaped;
      this.journal.saveEnv(fresh);
    }
    // The listeners go with the process anyway; closing them explicitly lets
    // a successor daemon bind them the moment this one has stopped.
    this.proxy.closeAll();
  }
}

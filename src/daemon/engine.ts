/**
 * The engine: pool + lease + bind + run orchestration, owning all policy
 * (drivers own transport/storage; the manifest owns repo knowledge).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, readdirSync, lstatSync, existsSync, readFileSync, writeFileSync, renameSync, watch as fsWatch, constants as fsConstants } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { Journal, JOURNAL_SCHEMA_VERSION, type EnvRow, type LeaseRow } from '../core/journal.js';
import { BUILD, VERSION, compareVersions, versionSkew } from '../core/version.js';
import { canonicalDirectory, stackIdentity, retiredStackIdentity, loadStack, normalizeLogins, type Stack } from '../core/manifest.js';
import { hashOutputs } from '../core/worktree.js';
import { clearTreeLedger, pickEnvKeys, pickTreeKeys, readTreeLedger, worktreeStateDir, writeTreeLedger } from '../core/tree-ledger.js';
import { selectPresets } from '../core/presets.js';
import { runUpkeep, pendingUpkeep, templateBakeKeys, triggerSet, type UpkeepStep } from '../core/upkeep.js';
import { freePort, probeFree } from '../core/ports.js';
import { envsRoot, artifactsRoot, stateRoot, templatesRoot, retiredTemplatesRoot } from '../core/paths.js';
import { BrokerError, template, templateEnv, now, shortId, matchesAny, safeJoin } from '../core/util.js';
import { callerEnvSpec, requireCallerEnv, selectCallerEnv, serviceCallerEnv, validateCallerEnv } from '../core/caller-env.js';
import { cmdTimeoutS, runBounded, runBoundedIO, LONG_CMD_TIMEOUT_S } from '../core/exec.js';
import { makeDatastore, retireBakedTemplates, withBakeLock, tryWithBakeLock, type DsHandle } from '../drivers/datastores.js';
import { ensureAppliance, stopAppliance, probeTcp } from '../drivers/appliances.js';
import { DEFAULT_PREVIEW_PUBLISHER, resolvePreviewPublisher } from '../drivers/preview.js';
import { EnvSupervisor, killGroupVerified, reapPids, mergeServicePids, serviceGroups } from './supervisor.js';
import { groupAlive, isAlive, processGroup, procScanSupported, sameProcess, scanByCwd, scanTagged, serviceTag, startTime, type TaggedProc } from '../core/procscan.js';
import { policy } from '../core/policy.js';
import { kernelSleepGap, readKernelSleepRecord } from '../core/sleep.js';
import { retentionSweep } from '../core/retention.js';
import { logEvent, recentEvents } from '../core/events.js';
import { BindTrace, type BindDiagnostics } from '../core/diagnostics.js';
import type { Hygiene, LeaseKind, ServicePid } from '../core/types.js';

const POOL_MAX = () => policy().poolMax;
const POOL_MAX_TOTAL = () => policy().poolMaxTotal;
const POOL_MAX_DATA_ONLY = () => policy().poolMaxDataOnly;
const LEASE_TTL = (kind: LeaseKind) => (kind === 'session' ? policy().sessionTtlMs : policy().runTtlMs);
const IDLE_TTL = () => policy().idleTtlMs;
const LEASED_IDLE_TTL = () => policy().leasedIdleTtlMs;
const WAIT_MS = () => policy().waitMs;
const CHECK_TIMEOUT_S = 600;

/** Streamed bind phases → human progress on stderr (never on the --json stdout). */
export type Progress = (phase: string) => void;

/**
 * What one claim attempt found: an environment to bind, a deferral because the
 * holder's own environment has an operation in flight that its shape change
 * must wait for, or nothing (capacity, or not this caller's turn).
 */
type ClaimOutcome = { env: EnvRow; fresh: boolean } | { deferred: EnvRow; op: string } | null;

export interface UpOptions {
  /** Explicit datastore-to-preset overrides; continuing leases retain unmentioned choices. */
  presets?: unknown;
  cwd: string;
  /** Explicit refresh envelope; absent means retain this lease's in-memory inputs. */
  callerEnv?: unknown;
  holder?: string;
  hygiene?: Hygiene;
  kind?: LeaseKind;
  watch?: boolean;
  ttlMs?: number;
  /** Content operations keep the current live lease deadline; fresh claims use the default. */
  preserveLeaseDeadline?: boolean;
  /**
   * Bring up only these services (plus their transitive depends_on closure)
   * instead of the whole app — `runly up sherlock audit`. An empty array is
   * the explicit "whole app" the `up` verb always sends. Undefined is DISTINCT:
   * it means "keep the lease's current shape" and is what the internal
   * reset-data/watch/bind rebinds pass, so a slice survives a rebind rather than
   * silently re-expanding to the full app.
   */
  services?: string[];
  /**
   * Lease the DATASTORES ONLY — no services, no builds. `runly up --data-only`.
   *
   * The unit a test lane actually needs is "a warm, seeded database, leased per
   * consumer, reset on release", which is a strict subset of an environment. Without
   * this the only options were leasing a whole application environment (heavier than
   * a test lane needs, and it competes with the interactive leases people use to look
   * at the app) or building the same thing from scratch with Testcontainers — which
   * is what everybody did, at the cost of a container start plus a full restore per
   * test collection.
   *
   * Distinct from `services: []`, which has always meant "the whole app": an empty
   * SELECTION is not the same statement as an empty SHAPE. Undefined here means
   * "keep the lease's current shape", exactly as for `services`.
   */
  dataOnly?: boolean;
  /**
   * The CALLER's process, so its lease can be released when it dies.
   * The CLI exits per invocation, so this must be the long-lived agent's pid —
   * supplied via --holder-pid or BACKLOT_HOLDER_PID.
   */
  holderPid?: number;
  /** Set by the daemon per-request; emits progress frames back to the client. */
  onProgress?: Progress;
  /**
   * Rebuild and restart even when the running services look reusable. runly
   * keeps no identity of the worktree's code (decision 0032), so only the verb
   * can say that a change is to be applied: `sync` sets this.
   */
  restart?: boolean;
}

/**
 * Run a check/exec command as a PROCESS GROUP with a hard timeout — killing
 * only the `sh` wrapper would orphan grandchildren (a hung Playwright would
 * hold the environment busy forever).
 */
/**
 * Checks and exec run detached too, so they can outlive the daemon exactly as
 * services can. They carry the same tag, which is what lets `pool gc` find and
 * reclaim a hung check's group after an ungraceful exit.
 */
function runGroupCmd(
  cmd: string,
  cwd: string,
  envVars: NodeJS.ProcessEnv,
  timeoutS: number,
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise) => {
    const proc = spawn('sh', ['-c', cmd], { cwd, env: envVars, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let settled = false;
    // stdio 'pipe' means these streams exist on every successful spawn; on a
    // failed one there is no output to capture, so optional chaining is exact.
    proc.stdout?.on('data', (d) => (out = (out + d.toString()).slice(-8000)));
    proc.stderr?.on('data', (d) => (out = (out + d.toString()).slice(-8000)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = proc.pid;
      if (pid === undefined) {
        // The spawn failed — there is no process group, only the child object.
        proc.kill('SIGKILL');
        return;
      }
      try {
        process.kill(-pid, 'SIGKILL'); // the whole group
      } catch {
        proc.kill('SIGKILL');
      }
    }, timeoutS * 1000);
    timer.unref();
    const done = (r: { exitCode: number; output: string; timedOut: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(r);
    };
    // Without this, a spawn failure (EMFILE/EAGAIN) emits 'error' with no
    // 'exit' — the promise would never settle and the env lock would wedge
    // forever, starving that environment until a daemon restart.
    proc.on('error', (err) => done({ exitCode: 1, output: `${out}\nspawn error: ${err.message}`.slice(-4000), timedOut }));
    proc.on('exit', (code) => done({ exitCode: code ?? 1, output: out.slice(-4000), timedOut }));
  });
}

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

export class Engine {
  constructor(private readonly reapServiceGroup: typeof killGroupVerified = killGroupVerified) {}

  readonly journal = new Journal();
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
  /**
   * Claims handed out but whose bind has not yet taken the environment lock.
   * The lock marks `busy` only once its callback runs, several microtasks after
   * the claim resolved — a shape conversion chained right behind that claim
   * would otherwise rewrite the reservation of an environment about to start
   * services. Counted under the pool lock, released by `up` once its bind
   * holds the lock (or could not reach it).
   */
  private pendingBinds = new Map<string, number>();
  /** --watch: per-env worktree watchers ("verbs sync, watch streams", decision 0005). */
  private watchers = new Map<string, { close: () => void }>();
  /** Never persisted or returned. Lease IDs prevent reuse from inheriting another caller's inputs. */
  private leaseInputs = new Map<string, { values: Record<string, string>; revision: string }>();
  /** Opaque in-memory revisions only; no secret values or hashes in the journal. */
  private appliedInputs = new Map<string, string>();
  private appliedInputSpecs = new Map<string, string>();
  // Memory-only successful-bind configuration: a hot-reload refresh keeps the
  // services, so it cannot apply startup env/commands or other manifest configuration.
  private appliedManifests = new Map<string, string>();
  private inputRevision = 0;

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
    const jobs = this.journal.failStaleJobs();
    logEvent({
      level: stranded ? 'warn' : 'info',
      kind: 'recover',
      detail: `reconciled ${envs} env(s), ${jobs} stale job(s)${stranded ? `, ${stranded} service(s) survived the reap` : ''}`,
    });
    // Anything the journal never knew about — the owner died before the pids
    // were ever written, or the env row is long gone — is only findable by tag.
    const gc = await this.poolGc(false);
    if (gc.reclaimed.length) {
      logEvent({ level: 'warn', kind: 'gc', detail: `reclaimed ${gc.reclaimed.length} orphaned process(es) at startup` });
    }
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

  /**
   * `dataOnly` is fixed HERE, for the environment's whole life (decision 0025).
   * Making it a per-claim property is what let the separate data-only ceiling be
   * bypassed: the two shapes answer to different caps, and reuse is never
   * capacity-checked, so a claim that changed the shape moved the environment
   * between ceilings unmetered.
   */
  private async createEnv(stack: Stack, dataOnly: boolean): Promise<EnvRow> {
    // Monotonic, never-reused sequence — a reaped env's id can never collide
    // with a live one (the old length+1 scheme did, deterministically).
    const n = this.journal.nextEnvSeq(stack.id);
    const id = `${stack.id}-e${n}`;
    const dirs = this.envDirs(id);
    mkdirSync(dirs.data, { recursive: true });
    // freePort asks the OS for an unused port and immediately closes the
    // listener, so nothing stops the SAME port being handed to the next
    // environment moments later — two warm envs would then collide the first
    // time both went hot. Exclude everything already recorded pool-wide.
    const taken = new Set<number>();
    for (const e of this.journal.allEnvs()) for (const p of Object.values(e.ports)) taken.add(p);
    const ports: Record<string, number> = {};
    for (const [, spec] of Object.entries(stack.manifest.services)) {
      if (spec.port && !(spec.port in ports)) {
        let port = await freePort();
        for (let attempt = 0; attempt < 50 && taken.has(port); attempt++) port = await freePort();
        taken.add(port);
        ports[spec.port] = port;
      }
    }
    const env: EnvRow = {
      id, stack: stack.id, stackRoot: stack.root, state: 'warm', root: dirs.root,
      ports, datastoreNs: {}, fingerprints: {}, presets: {},
      bindCount: 0, createdAt: now(), lastUsedAt: now(), servicePids: {}, failStreak: 0,
      dataOnly,
    };
    this.journal.saveEnv(env);
    return env;
  }

  /** The operation in flight on an environment, or null when nothing owns it. */
  private inFlightOn(envId: string): string | null {
    if (this.busy.has(envId)) return this.busyOp.get(envId) ?? 'an operation';
    if ((this.pendingBinds.get(envId) ?? 0) > 0) return 'a bind that has been claimed and is about to start';
    return null;
  }

  private reserveBind(envId: string): void {
    this.pendingBinds.set(envId, (this.pendingBinds.get(envId) ?? 0) + 1);
  }

  private releaseBind(envId: string): void {
    const n = (this.pendingBinds.get(envId) ?? 0) - 1;
    if (n > 0) this.pendingBinds.set(envId, n);
    else this.pendingBinds.delete(envId);
  }

  /**
   * One atomic claim attempt — MUST run under the pool lock. `deferred` is not
   * a capacity shortfall: the holder's own environment is mid-operation and its
   * shape may not be rewritten until that finishes. Callers wait for it without
   * evicting or judging capacity, and every returned claim carries a bind
   * reservation that `up` must release.
   */
  private async tryClaim(stack: Stack, holder: string, kind: LeaseKind, hygiene: Hygiene, ttlMs: number, dataOnly: boolean, holderPid?: number, onlyMine = false, preserveLeaseDeadline = false): Promise<ClaimOutcome> {
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
        // Switching your own lease between shapes stays supported (decision
        // 0023) — but it is now a CAPACITY EVENT, because the two shapes answer
        // to different ceilings. Converting moves this environment from one
        // bucket to the other, and reuse is otherwise never capacity-checked, so
        // an unmetered conversion is exactly how the cheap data-only ceiling
        // could be spent as application capacity: take N catalog-priced
        // environments, then turn them into full stacks for free (decision 0025).
        // A queued bind may still start the previous shape. Do not rewrite its
        // reservation while that operation owns the environment lock.
        if ((env.dataOnly === true) !== dataOnly) {
          const op = this.inFlightOn(env.id);
          if (op !== null) return { deferred: env, op };
        }
        if ((env.dataOnly === true) !== dataOnly && !this.convertShape(env, dataOnly)) {
          throw new BrokerError(
            'env-error',
            this.capacityRefusal(stack, dataOnly, this.capacityBinding(stack.id, dataOnly) ?? 'machine', null) +
              ` (your lease on ${env.id} would have to change shape to ${dataOnly ? 'data-only' : 'an application environment'}, which is what needs the room.)`,
            'pool',
          );
        }
        this.journal.saveLease({ ...mine, hygiene, expiresAt: preserveLeaseDeadline && mine.expiresAt > now() ? mine.expiresAt : now() + ttlMs, ...holderIdentity(holderPid) });
        // A continuing lease keeps its shape: bindAndStart's undefined-request
        // path preserves env.activeServices for this same holder.
        this.reserveBind(env.id);
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
      .filter((e) => !this.journal.leaseForEnv(e.id) && e.state !== 'degraded' && e.state !== 'recycling' &&
        ((e.dataOnly === true) === dataOnly || this.inFlightOn(e.id) === null))
      // Matching SHAPE first, then heat. A data-only row handed to an ordinary
      // `up` is not wrong — it is a conversion, and conversions have to be paid
      // for (below) — but reaching for one while a matching environment sits free
      // would spend capacity for nothing.
      .sort(
        (a, b) =>
          (((a.dataOnly === true) === dataOnly ? 0 : 1) - ((b.dataOnly === true) === dataOnly ? 0 : 1)) ||
          ((a.state === 'hot' ? -1 : 1) - (b.state === 'hot' ? -1 : 1)),
      );
    let env = free[0];
    // A free environment of the OTHER shape may only be taken if the shape it
    // would move into has room — otherwise the conversion is unmetered capacity.
    if (env && (env.dataOnly === true) !== dataOnly && !this.convertShape(env, dataOnly)) env = undefined;
    // ONE environment per worktree (decision 0032). A stack is one physical
    // worktree, and every environment of it would run its services, builds and
    // checks over the same files — a rebuild by one replacing bin/ under the
    // other's running services. So a second environment is never created: a
    // claim on a stack that already has one waits for it (acquireQueued).
    if (!env && envs.length === 0 && this.capacityBinding(stack.id, dataOnly) === null) env = await this.createEnv(stack, dataOnly);
    if (env) {
      this.journal.saveLease({
        id: `l-${shortId()}`, envId: env.id, kind, holder, hygiene, expiresAt: now() + ttlMs,
        presets: selectPresets(stack.manifest, kind),
        ...holderIdentity(holderPid),
      });
      // fresh: true — a NEW owner. It must not inherit a previous holder's
      // leftover activeServices, so bindAndStart treats an unspecified request
      // on a fresh claim as the whole app. We do NOT rewrite activeServices
      // here: it may only change AFTER the bind reconciles reality (fast path /
      // epilogue), so an early bind failure can't strand the journal asserting
      // a shape that isn't running.
      this.reserveBind(env.id);
      return { env, fresh: true };
    }
    return null;
  }

  /**
   * Which ceiling refuses a NEW environment for this stack right now?
   *
   * Named explicitly because the two caps have different remedies and every
   * refusal used to quote the per-stack one: a caller told "raise
   * BACKLOT_POOL_MAX" while the machine-wide cap was what bound followed that
   * advice, saw nothing change, and could not have (#47). MUST run under the
   * pool lock.
   */
  private capacityBinding(stackId: string, dataOnly: boolean): 'machine' | 'data-only' | null {
    // Data-only environments are counted against their OWN machine-wide ceiling
    // and against neither application cap (decision 0025). poolMax/poolMaxTotal
    // are derived from cores and memory because they bound running services; a
    // data-only environment starts none, so charging it a stack-sized slot made a
    // test lane compete with the interactive leases people use to look at the app
    // — the contention `up --data-only` existed to remove (#48). There is no
    // per-stack data-only cap: a lane per agent on one stack is the normal case.
    if (dataOnly) {
      return this.dataOnlyEnvs().length >= POOL_MAX_DATA_ONLY() ? 'data-only' : null;
    }
    // No per-stack cap any more: a stack never has more than one environment
    // (decision 0032), so BACKLOT_POOL_MAX has nothing left to bound.
    void stackId;
    if (this.appEnvs().length >= POOL_MAX_TOTAL()) return 'machine';
    return null;
  }

  /**
   * Move an environment between the application and data-only buckets, if the
   * destination has room. Returns false — changing nothing — when it does not.
   *
   * Reserve the destination at claim time so concurrent claims see it. An
   * app-to-data conversion retains its application charge until services are
   * stopped: upkeep can fail before teardown. No rollback may release a slot
   * while another operation is still using it. MUST run under the pool lock.
   */
  private convertShape(env: EnvRow, dataOnly: boolean): boolean {
    if ((env.dataOnly === true) === dataOnly) return true;
    // An unfinished conversion already holds its application slot. Returning
    // to the application shape must not demand a second slot for the same row.
    if ((dataOnly || !this.usesApplicationCapacity(env)) && this.capacityBinding(env.stack, dataOnly) !== null) return false;
    env.dataOnly = dataOnly;
    const row = this.journal.getEnv(env.id);
    if (row) this.journal.saveEnv({ ...row, dataOnly });
    logEvent({
      level: 'info',
      kind: 'pool-shape',
      envId: env.id,
      detail: `reserved ${dataOnly ? 'data-only' : 'an application environment'} — counts against ${dataOnly ? 'BACKLOT_POOL_MAX_DATA_ONLY; application capacity remains reserved until services stop' : 'BACKLOT_POOL_MAX_TOTAL'}`,
    });
    return true;
  }

  /** Durable shape reserves capacity; running reality can retain it too. */
  private usesApplicationCapacity(env: EnvRow): boolean {
    return env.dataOnly !== true || env.state === 'hot' || Object.keys(env.servicePids).length > 0;
  }

  /** Application reservations, including unfinished conversions to data-only. */
  private appEnvs(stackId?: string): EnvRow[] {
    const rows = stackId === undefined ? this.journal.allEnvs() : this.journal.envsForStack(stackId);
    return rows.filter((e) => this.usesApplicationCapacity(e));
  }

  /** Data-only environments, machine-wide (they have no per-stack ceiling). */
  private dataOnlyEnvs(): EnvRow[] {
    return this.journal.allEnvs().filter((e) => e.dataOnly === true);
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
  private evictionCandidates(dataOnly: boolean): EnvRow[] {
    const floor = IDLE_TTL();
    return this.journal
      .allEnvs()
      .filter(
        (e) =>
          // An unfinished conversion can hold both reservations. Evicting it
          // releases whichever ceiling is currently binding.
          (dataOnly ? e.dataOnly === true : this.usesApplicationCapacity(e)) &&
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
  private async evictForMachineCapacity(stack: Stack, dataOnly: boolean): Promise<string | null> {
    // Only a MACHINE-WIDE ceiling is worth evicting for. A per-stack block is
    // this stack's own doing and giving up another stack's environment cannot
    // help it; the data-only ceiling evicts on the same rule, inside its bucket.
    const bound = await this.poolLocked(() => this.capacityBinding(stack.id, dataOnly));
    if (bound !== 'machine' && bound !== 'data-only') return null;
    const before = dataOnly ? `${this.dataOnlyEnvs().length}/${POOL_MAX_DATA_ONLY()} data-only` : `${this.appEnvs().length}/${POOL_MAX_TOTAL()} application`;
    for (const cand of this.evictionCandidates(dataOnly)) {
      const human = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.max(1, Math.round(ms / 1000))}s`);
      const idleFor = human(now() - cand.lastUsedAt);
      const wasState = cand.state;
      if (await this.recycleOne(cand.id, false) !== 'recycled') continue;
      logEvent({
        level: 'info',
        kind: 'pool-evict',
        envId: cand.id,
        detail:
          `evicted to free a ${dataOnly ? 'data-only' : 'machine-wide'} pool slot for stack '${stack.id}' — ` +
          `unleased and idle ${idleFor} (${wasState}, past the ${human(IDLE_TTL())} idle TTL), ` +
          `least recently used of ${this.evictionCandidates(dataOnly).length + 1} candidate(s); the pool held ${before}. ` +
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
  private structuralCapacityBlock(stack: Stack, dataOnly: boolean, deadline: number): { scope: 'worktree' | 'machine' | 'data-only'; detail: string } | null {
    const held = this.worktreeHold(stack, deadline);
    if (held !== undefined) return held === null ? null : { scope: 'worktree', detail: held };
    const bound = this.capacityBinding(stack.id, dataOnly);
    if (bound === null) return null; // room to grow
    if (bound === 'data-only') {
      // Same reasoning as the machine-wide case: this ceiling counts rows, so a
      // release cannot lower it. Only an eviction or a recycle does.
      const rows = this.dataOnlyEnvs();
      if (this.transientlyUnclaimable(rows) || this.evictionCandidates(true).length > 0) return null;
      return { scope: 'data-only', detail: rows.map((e) => `${e.id} (${this.notEvictableBecause(e)})`).join('; ') };
    }
    // The MACHINE-WIDE cap is what bound, and waiting cannot clear it: the
    // count is of env ROWS, and releasing a lease leaves the row behind. Only
    // an eviction, an orphan reap or a degraded reap ever lowers it (#47).
    const all = this.appEnvs();
    if (this.transientlyUnclaimable(all) || this.evictionCandidates(false).length > 0) return null;
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
  private capacityRefusal(stack: Stack, dataOnly: boolean, scope: 'worktree' | 'machine' | 'data-only', blocking: string | null): string {
    const total = this.appEnvs().length;
    const counts = `the machine holds ${total}/${POOL_MAX_TOTAL()} application environments (BACKLOT_POOL_MAX_TOTAL)`;
    const waited = blocking === null ? ` after waiting ${Math.round(WAIT_MS() / 1000)}s` : '';
    if (scope === 'data-only') {
      return (
        `pool at capacity${waited}: the DATA-ONLY cap is what refused — ${this.dataOnlyEnvs().length}/${POOL_MAX_DATA_ONLY()} data-only environments machine-wide (BACKLOT_POOL_MAX_DATA_ONLY). ` +
        `Data-only environments are counted separately from application ones, so ${counts} is not what stopped this. ` +
        `Releasing a lease will not help — the count is of environments, not leases — and nothing data-only was cold enough to evict.` +
        (blocking ? ` Holding: ${blocking}.` : '') +
        ` Raise BACKLOT_POOL_MAX_DATA_ONLY (it bounds disk, not CPU), or 'runly pool recycle <env-id>' a lane you no longer need.`
      );
    }
    if (scope === 'machine') {
      return (
        `pool at capacity${waited}: the MACHINE-WIDE cap is what refused — ${counts}. ` +
        `Releasing a lease will not help, because the machine-wide count is of environments, not leases: the row survives a release. ` +
        `Every environment on this box is either leased or too recently used to evict, so runly had nothing cold to give up.` +
        (blocking ? ` Holding: ${blocking}.` : '') +
        ` Raise BACKLOT_POOL_MAX_TOTAL if the host can take it, or 'runly pool recycle <env-id>' an environment you no longer need.`
      );
    }
    // scope === 'worktree'
    return (
      `this worktree's environment is held by another lease${waited}` +
      (blocking ? ` past the wait window: ${blocking}` : '') +
      `. A worktree has exactly one environment (decision 0032) — ${stack.root} — so a second holder waits for it instead of getting another. ` +
      `Use the holder that owns it (--holder), release that lease, or bind from a separate worktree.`
    );
  }

  /**
   * A bounded wait on the holder's OWN environment ran out. This is not a
   * capacity refusal — no ceiling bound, and no eviction could have helped —
   * so it names the operation and the environment instead of a cap.
   */
  private busyRefusal(env: EnvRow, op: string, dataOnly: boolean): BrokerError {
    return new BrokerError(
      'env-error',
      `environment ${env.id} is busy after waiting ${Math.round(WAIT_MS() / 1000)}s: ${op} is in flight on it, ` +
        `and your lease would have to change shape to ${dataOnly ? 'data-only' : 'an application environment'}, ` +
        `which cannot happen while that operation may still be using it as ${env.dataOnly === true ? 'data-only' : 'an application environment'}. ` +
        `Retry once it completes, or raise BACKLOT_WAIT_MS to wait longer.`,
      'pool',
    );
  }

  /** Queue at capacity WITHOUT holding the pool lock while sleeping. */
  private async acquireEnv(stack: Stack, holder: string, kind: LeaseKind, hygiene: Hygiene, ttlMs: number, dataOnly: boolean, holderPid?: number, preserveLeaseDeadline = false): Promise<{ env: EnvRow; fresh: boolean }> {
    const start = now();
    // A holder that already holds this stack's LIVE lease consumes no
    // capacity — rebinding only re-saves it (renewing the deadline for an
    // explicit `up`, preserving it for content operations). Sending it through
    // the queue stalled the normal edit-sync-retest loop behind strangers waiting for
    // expiry. Expiry is checked HERE, not just in the sweeper: a lapsed lease
    // survives in the journal until the next sweep, and refreshing that
    // corpse would jump a waiter queued on precisely its expiry. onlyMine
    // keeps the bypass honest: if the lease lapses mid-flight this claims
    // nothing and joins the queue like everyone else.
    const live = this.journal.leaseForHolder(holder, stack.id);
    if (live && live.expiresAt > now()) {
      // A deferral waits HERE, outside the queue: the holder consumes no
      // capacity and is only waiting on its own environment, so parking it at
      // the FIFO head would block every other claimant on this stack for
      // nothing. If the lease lapses meanwhile, onlyMine returns null and the
      // holder joins the queue like everyone else.
      for (;;) {
        const claimed = await this.poolLocked(() => this.tryClaim(stack, holder, kind, hygiene, ttlMs, dataOnly, holderPid, true, preserveLeaseDeadline));
        if (claimed === null) break;
        if ('env' in claimed) return claimed;
        if (now() - start > WAIT_MS()) throw this.busyRefusal(claimed.deferred, claimed.op, dataOnly);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    // FIFO ticket. Without ordering, every waiter polled independently and a
    // freed environment went to whoever happened to poll first — so an early
    // waiter could time out while later arrivals were served.
    const ticket = ++this.waitTicket;
    const queue = this.waiting.get(stack.id) ?? [];
    queue.push(ticket);
    this.waiting.set(stack.id, queue);
    try {
      return await this.acquireQueued(stack, holder, kind, hygiene, ttlMs, dataOnly, start, ticket, holderPid, preserveLeaseDeadline);
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
    dataOnly: boolean,
    start: number,
    ticket: number,
    holderPid?: number,
    preserveLeaseDeadline = false,
  ): Promise<{ env: EnvRow; fresh: boolean }> {
    for (;;) {
      // Only the head of THIS STACK's queue may claim; everyone else waits.
      const queue = this.waiting.get(stack.id);
      const myTurn = !queue || queue.length === 0 || queue[0] === ticket;
      const claimed = myTurn ? await this.poolLocked(() => this.tryClaim(stack, holder, kind, hygiene, ttlMs, dataOnly, holderPid, false, preserveLeaseDeadline)) : null;
      if (claimed && 'env' in claimed) return claimed;
      if (claimed) {
        // Deferred on the holder's own environment: no ceiling bound, so neither
        // eviction nor the structural check has anything true to say.
        if (now() - start > WAIT_MS()) throw this.busyRefusal(claimed.deferred, claimed.op, dataOnly);
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      // A machine-wide block never clears by waiting — the count is of env rows,
      // and a release leaves the row behind — so a host holding as many cold
      // worktrees as the heuristic allows locked out every new stack
      // indefinitely, while nothing was running (#46). Give up the
      // least-recently-used cold environment instead and claim its slot.
      if (myTurn && (await this.evictForMachineCapacity(stack, dataOnly))) continue;
      // This worktree's one environment is dead (a service flapped past its
      // budget). It used to sit beside a freshly created second one until the
      // sweeper reaped it; with one environment per worktree, waiting for the
      // sweep would stall every bind here for a sweep interval. Reap it now.
      if (myTurn && (await this.reapDegradedOwn(stack))) continue;
      // Refuse to burn the full wait on something that provably cannot resolve.
      const blocked = await this.poolLocked(() => this.structuralCapacityBlock(stack, dataOnly, now() + WAIT_MS()));
      if (blocked) {
        throw new BrokerError('env-error', this.capacityRefusal(stack, dataOnly, blocked.scope, blocked.detail), 'pool');
      }
      if (now() - start > WAIT_MS()) {
        const scope = (await this.poolLocked(() => (this.worktreeHold(stack, now()) !== undefined ? 'worktree' as const : this.capacityBinding(stack.id, dataOnly)))) ?? 'worktree';
        throw new BrokerError('env-error', this.capacityRefusal(stack, dataOnly, scope, null), 'pool');
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ---------------------------------------------------------------- bind

  private templateCtx(stack: Stack, env: EnvRow) {
    const services: Record<string, { url: string }> = {};
    for (const [name, spec] of Object.entries(stack.manifest.services)) {
      if (spec.port) services[name] = { url: `http://localhost:${env.ports[spec.port]}` };
    }
    const datastores: Record<string, { url: string; ns: string }> = {};
    const dirs = this.envDirs(env.id);
    const h: DsHandle = { envId: env.id, cwd: env.stackRoot, dataDir: dirs.data };
    for (const [name, spec] of Object.entries(stack.manifest.datastores ?? {})) {
      const ds = makeDatastore(name, spec, stack.id);
      datastores[name] = { url: ds.url(h), ns: ds.ns(h) };
    }
    return { ports: env.ports, services, datastores };
  }

  private supervisor(env: EnvRow): EnvSupervisor {
    let sup = this.supervisors.get(env.id);
    if (!sup) {
      const dirs = this.envDirs(env.id);
      sup = new EnvSupervisor(
        env.id, env.stackRoot, dirs.logs,
        () => {
          // Flapping service -> the environment is degraded: skipped by acquire,
          // auto-reaped by the sweeper (decision 0007).
          const fresh = this.journal.getEnv(env.id);
          if (fresh && fresh.state !== 'recycling') {
            fresh.state = 'degraded';
            this.journal.saveEnv(fresh);
            logEvent({ level: 'warn', kind: 'degraded', envId: env.id, detail: 'service flapped past its restart budget' });
          }
        },
        () => {
          // A pid changed (start/restart/exit): keep the journal truthful so
          // recovery reaps the right process, not a stale/innocent pid.
          const s = this.supervisors.get(env.id);
          if (s) this.journal.updateServicePids(env.id, s.pids());
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
        throw new BrokerError('work-error', `no service '${name}' in runly.yml (have: ${Object.keys(all).join(', ') || 'none'})`, 'manifest');
      }
      closure.add(name);
      for (const dep of spec.depends_on ?? []) visit(dep);
    };
    for (const n of names) visit(n);
    return closure;
  }

  private async bindAndStart(stack: Stack, envSnapshot: EnvRow, hygiene: Hygiene, kind: LeaseKind, watch: boolean, onProgress?: Progress, requestedServices?: string[], freshClaim = false, requestedDataOnly?: boolean, callerEnv?: unknown, requestedPresets?: unknown, restart = false): Promise<{ env: EnvRow; previewNotice?: string; bindDiagnostics: BindDiagnostics }> {
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
    const presetLease = this.journal.leaseForEnv(env.id);
    if (!presetLease) throw new BrokerError('env-error', 'lease ended before bind; run runly up again', 'lease');
    const presets = selectPresets(stack.manifest, kind, requestedPresets, presetLease.presets ?? (freshClaim ? undefined : env.presets));
    this.journal.saveLease({ ...presetLease, presets });
    const presetsChanged = Object.entries(presets).some(([name, preset]) => env.presets[name] !== preset);
    const presetSelectionChanged = Object.entries(presets).some(([name, preset]) => Object.hasOwn(env.presets, name) && env.presets[name] !== preset);
    // Which services this bind brings up. An explicit list wins: `up` sends []
    // (whole app) or a slice, `run` sends []. An undefined request means "no
    // caller preference": on a FRESH claim that is the whole app (a new owner
    // never inherits the previous holder's slice), and on a continuing lease
    // (reset-data/watch/bind on the same holder's env) it preserves the current
    // shape. Because the shape is only ever read from the journal — never
    // rewritten at claim time — an early bind failure leaves activeServices
    // matching whatever is still running. resolveServiceClosure owns the
    // empty->whole-app rule, so a preserved shape whose services were all removed
    // from the manifest falls back to full rather than starting none.
    const declaredServices = Object.keys(stack.manifest.services);
    const requestedNames =
      requestedServices !== undefined
        ? requestedServices
        : freshClaim
          ? []
          : env.activeServices?.filter((n) => n in stack.manifest.services) ?? [];
    // A data-only bind is the one shape `requestedNames` cannot express, because
    // an empty selection means the whole app — so it lives on the environment row.
    //
    // The ROW is now authoritative, not the request (decision 0025): the shape is
    // fixed at createEnv and the claim only ever hands back an environment that
    // already matches what was asked for (tryClaim filters by shape and refuses a
    // holder trying to convert its own lease). Deriving it per-bind is what made
    // the separate data-only ceiling bypassable, since the two shapes are counted
    // against different caps and reuse is never capacity-checked. A request that
    // disagrees with the row cannot reach here; asserting keeps it that way.
    const dataOnly = env.dataOnly === true;
    if (requestedDataOnly !== undefined && requestedDataOnly !== dataOnly) {
      throw new BrokerError(
        'infra-error',
        `internal: environment ${env.id} is ${dataOnly ? 'data-only' : 'an application environment'} but the bind requested the other shape — the claim should have refused this`,
        'pool',
      );
    }
    const active = dataOnly ? new Set<string>() : this.resolveServiceClosure(stack, requestedNames);
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
    const takenPorts = new Set<number>();
    for (const e of this.journal.allEnvs()) for (const p of Object.values(e.ports)) takenPorts.add(p);
    for (const spec of Object.values(stack.manifest.services)) {
      if (spec.port && !(spec.port in env.ports)) {
        let port = await freePort();
        for (let attempt = 0; attempt < 50 && takenPorts.has(port); attempt++) port = await freePort();
        takenPorts.add(port);
        env.ports[spec.port] = port;
        addedPort = true;
      }
    }
    if (addedPort) this.journal.saveEnv(env);
    if (hygiene === 'pristine') {
      say('preparing a pristine environment');
      await this.stopForBind(env);
      // The environment's PRIVATE state only. The worktree is the caller's and
      // is never deleted (decision 0032) — not its caches, not its build output.
      // What pristine can still honestly promise is that nothing is TRUSTED:
      // the worktree's upkeep ledger is cleared, so every upkeep rule runs
      // again in place (builds run on every bind anyway).
      rmSync(dirs.data, { recursive: true, force: true });
      rmSync(dirs.legacyTree, { recursive: true, force: true });
      mkdirSync(dirs.data, { recursive: true });
      env.fingerprints = {};
      env.presets = {};
      // Persist the cleared ledger NOW, not at the end of the bind. Appliances
      // and upkeep run before the epilogue, and a crash in
      // any of them used to leave the journal asserting fingerprints and presets
      // for state that no longer exists — so the next bind skipped work it had
      // to redo.
      this.journal.saveEnv(env);
      await this.treeLocked(stack.id, async () => this.treeLedgerSession(stack).clear(), (s) => say(`waiting for another bind in this worktree … ${s}s`));
    } else if (Object.keys(env.servicePids).length === 0 && existsSync(dirs.legacyTree)) {
      // A projection copy from an older daemon: nothing runs from it any more.
      rmSync(dirs.legacyTree, { recursive: true, force: true });
    }

    // Appliances first: shared backing servers must answer before anything
    // else is worth doing. Milliseconds when they're up; a one-time start
    // when they're not (decision 0018). Failures here are infra-errors.
    trace.phase('appliances');
    for (const [name, spec] of Object.entries(stack.manifest.appliances ?? {})) {
      const state = await ensureAppliance(name, spec, stack.root, say);
      if (state !== 'up') logEvent({ level: 'info', kind: 'appliance', detail: `'${name}' ${state} (${spec.probe})` });
    }

    // No copy: the services run in the worktree itself (decision 0032), and
    // runly keeps no identity of it. Upkeep reads exactly the files its rules'
    // `when:` globs match, compared with the worktree's ledger.
    trace.phase('upkeep');
    const waitTree = (s: number) => say(`waiting for another bind in this worktree … ${s}s`);
    const { upkeep, files } = await this.treeLocked(stack.id, async () => {
      // Read under the worktree lock: `runly warm` may be mid-install.
      const triggers = triggerSet(stack.root, stack.manifest, worktreeStateDir(stack.id));
      const ledger = this.treeLedgerSession(stack);
      const out = await runUpkeep(stack.root, triggers, stack.manifest, { ...pickEnvKeys(env.fingerprints), ...ledger.get() }, say, {
        commit: (fps) => ledger.commitRules(fps),
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
    for (const dsName of upkeep.rebakeTemplates) {
      const spec = stack.manifest.datastores?.[dsName];
      if (spec) await makeDatastore(dsName, spec, stack.id, bakeKeys[dsName]).rebake(stack.root);
    }

    // Fast path: services running and healthy in the requested shape, data
    // untouched, nothing asked for a restart -> reuse as-is, without building.
    // runly does not know whether the worktree's code changed since the
    // services started (decision 0032: no source identity); `sync` is the verb
    // that applies a change, and it always rebuilds and restarts (`restart`).
    // The running service-set must also equal the requested shape — otherwise a
    // full env would be reused for a `up sherlock` (no saving) and a subset env
    // for a full `up` (missing services). A mismatch falls through to a full
    // stop + build + start of exactly the requested slice.
    const runningServices = new Set(Object.keys(this.supervisor(env).pids()));
    const shapeMatches = runningServices.size === active.size && [...active].every((n) => runningServices.has(n));
    if (restart) trace.result.reasons.push('restart-requested');
    if (upkeep.ran.length > 0) trace.result.reasons.push('upkeep-required');
    if (env.state !== 'hot') trace.result.reasons.push('environment-not-running');
    if (!this.supervisor(env).allHealthyPids()) trace.result.reasons.push('service-process-unhealthy');
    if (!shapeMatches) trace.result.reasons.push('service-shape-changed');
    if (inputsChanged) trace.result.reasons.push('environment-inputs-changed');
    if (manifestChanged) trace.result.reasons.push('manifest-changed');
    if (presetSelectionChanged) trace.result.reasons.push('datastore-preset-changed');
    if (hygiene !== 'reuse') trace.result.reasons.push(`hygiene-${hygiene}`);
    const unchanged =
      !manifestChanged &&
      !inputsChanged &&
      !presetsChanged &&
      !restart &&
      upkeep.ran.length === 0 &&
      env.state === 'hot' &&
      this.supervisor(env).allHealthyPids() &&
      shapeMatches &&
      hygiene === 'reuse';
    // The environment keeps only its own half of the ledger (`@` built-ins);
    // the worktree's half (command rules) was written under the worktree lock.
    env.fingerprints = pickEnvKeys(upkeep.fingerprints);
    if (unchanged) {
      trace.result.reuse = 'reused';
      trace.phase('finalize');
      env.lastUsedAt = now();
      // Refresh from the LIVE supervisor before saving. A service that restarted
      // during this bind updated the journal through onPidsChanged, and writing
      // the pre-bind snapshot back put dead pids there — which recovery would
      // later signal, missing the real process.
      env.servicePids = this.supervisor(env).pids();
      // Record the shape here too. A fresh claim clears activeServices, but the
      // fast path can still reuse an env whose running set already equals the
      // request (up api -> release -> up api), so without this the journal would
      // say "whole app" while only the slice runs — ctx/exec would then advertise
      // a dead URL. shapeMatches guarantees active == the running set, so this is
      // always truthful.
      env.activeServices = active.size === declaredServices.length ? undefined : [...active];
      env.dataOnly = dataOnly;
      this.journal.saveEnv(env);
      return {
        env,
        previewNotice: forbiddenNotice ?? (await this.reconcilePreviewForBind(env, stack, active, say, { hygiene, portsReallocated: true })),
        bindDiagnostics: trace.finish(),
      };
    }

    // Services must not hold open handles across a data restore or code change.
    trace.phase('stop');
    await this.stopForBind(env);

    // Data state: create-or-restore per hygiene (probe first — infra-error, not code blame).
    trace.phase('data');
    const dsHandle: DsHandle = { envId: env.id, cwd: stack.root, dataDir: dirs.data };
    for (const [name, spec] of Object.entries(stack.manifest.datastores ?? {})) {
      const ds = makeDatastore(name, spec, stack.id, bakeKeys[name]);
      await ds.probe();
      const preset = presets[name];
      if (preset === undefined) {
        throw new BrokerError('env-error', `missing resolved preset selection for datastore '${name}'`, name);
      }
      const exists = Boolean(env.datastoreNs[name]);
      const force = env.presets[name] !== preset || hygiene !== 'reuse' || upkeep.rebakeTemplates.includes(name);
      if (force || !exists) say(`preparing datastore '${name}' (${preset})`);
      await ds.ensure(dsHandle, preset, force, exists);
      env.datastoreNs[name] = ds.ns(dsHandle);
      env.presets[name] = preset;
      // Report each completed restore truthfully even if a later store fails.
      // Merge into the live row so a supervisor update is not overwritten.
      const current = this.journal.getEnv(env.id);
      if (current) {
        current.datastoreNs = { ...env.datastoreNs };
        current.presets = { ...env.presets };
        this.journal.saveEnv(current);
      }
    }

    // Builds: every service this bind starts that declares one, every time
    // (decision 0032). runly keeps no build cache — MSBuild, pnpm and the
    // Angular CLI decide what is already up to date, and a no-op build of theirs
    // is cheap. A slice bind builds only its own services. Under the worktree
    // lock: `runly warm` builds into the same output.
    const ctx = this.templateCtx(stack, env);
    trace.phase('build');
    await this.treeLocked(stack.id, async () => {
      for (const [name, spec] of Object.entries(stack.manifest.services)) {
        if (!active.has(name)) continue; // don't build a slice we won't start
        if (!spec.build) continue;
        const buildStart = performance.now();
        await this.runServiceBuild(name, template(spec.build, ctx), stack.root, say);
        trace.result.builds.push({ service: name, durationMs: performance.now() - buildStart });
      }
    }, waitTree);

    // Start in dependency order, readiness-gated, fatal-log fast-fail.
    trace.phase('ready');
    const sup = this.supervisor(env);
    const started = new Set<string>();
    // Only the requested slice (already a depends_on closure, so every dep of a
    // member is also here and the topological order below still resolves).
    const entries = Object.entries(stack.manifest.services).filter(([n]) => active.has(n));
    while (started.size < entries.length) {
      const ready = entries.filter(([n, s]) => !started.has(n) && (s.depends_on ?? []).every((d) => started.has(d)));
      if (ready.length === 0) throw new BrokerError('work-error', 'depends_on cycle in runly.yml', 'manifest');
      for (const [name, spec] of ready) {
        if (spec.port) {
          // The allocation loop at the top of this bind fills every declared
          // port key, so a miss here is a corrupted port ledger — classify it
          // instead of crashing on the undefined a few lines down.
          const port = env.ports[spec.port];
          if (port === undefined) {
            throw new BrokerError('env-error', `environment ${env.id} has no port recorded for service '${name}' — the port ledger is inconsistent; try 'runly pool recycle ${env.id}'`, name);
          }
          // Grace window: the previous holder may be this env's own just-
          // signalled service still tearing down (SIGTERM handlers, FD
          // flushes). Only after the window is the port genuinely foreign.
          let free = false;
          for (let attempt = 0; attempt < 10 && !(free = await probeFree(port)); attempt++) {
            await new Promise((r) => setTimeout(r, 150));
          }
          if (!free) {
            // Try to name the holder so the error is actionable. After
            // reapEnvProcesses ran, any remaining tagged process survived our
            // SIGKILL (extremely unlikely) or is truly foreign (not from
            // runly). Either way, naming it beats a bare port number.
            let staleHint = '';
            if (procScanSupported()) {
              // Earlier iterations of this start loop already launched healthy
              // services carrying the same tag — don't name our own. Exclude
              // by group, not just leader pid: `sh -c` forks, so the real
              // server is a same-group sibling of the recorded leader.
              const own = new Set(Object.values(sup.pids()).map((r) => r.pid));
              const tagged = scanTagged(stateRoot());
              const leasedPreviews = this.leasedPreviewPids(tagged);
              const stale = tagged.filter(
                (p) => p.envId === env.id && !leasedPreviews.has(p.pid) && !own.has(p.pid) && !own.has(processGroup(p.pid) ?? -1),
              );
              if (stale.length > 0) {
                staleHint = ` — surviving process(es): ${stale.map((p) => `pid ${p.pid} (${p.service})`).join(', ')}; run 'runly pool gc' to reclaim`;
              }
            }
            throw new BrokerError(
              'env-error',
              // Name THIS environment in the remedy. A bare "try pool recycle"
              // was read as an instruction to recycle the pool, which on a
              // shared box tears down other people's live leases to fix one
              // stuck port.
              `port ${port} for service '${name}' is occupied${
                staleHint || ` by a foreign process — 'runly pool gc' reclaims strays, or 'runly pool recycle ${env.id}' rebuilds just this environment`
              }`,
              name,
            );
          }
        }
        // Template the COMMANDS too — ports/urls may ride in the run line itself
        // (e.g. `ng serve --port {{ports.web}}`), not only in env:.
        const resolved = {
          ...spec,
          run: template(spec.run, ctx),
          ...(spec.watch_run ? { watch_run: template(spec.watch_run, ctx) } : {}),
        };
        const callerValues = serviceCallerEnv(spec, inputs.values);
        const serviceEnv = { ...templateEnv(spec.env, ctx), ...callerValues };
        sup.start(name, resolved, serviceEnv, watch, Object.values(callerValues).filter((value): value is string => value !== undefined));
        const url = spec.port ? `http://localhost:${env.ports[spec.port]}` : undefined;
        say(`starting '${name}', waiting until ready`);
        const readyStart = now();
        const beat = setInterval(() => say(`waiting for '${name}' … ${Math.round((now() - readyStart) / 1000)}s`), 3000);
        beat.unref();
        try {
          await sup.waitReady(name, spec, url, serviceEnv);
          clearInterval(beat);
          say(`'${name}' ready`);
        } catch (err) {
          clearInterval(beat);
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
      // in the degraded window filter URLs by the wrong slice.
      const degradedShape = active.size === declaredServices.length ? undefined : [...active];
      this.journal.saveEnv({ ...current, servicePids: sup.pids(), activeServices: degradedShape, dataOnly, lastUsedAt: now() });
      throw new BrokerError('env-error', `environment ${env.id} degraded during bind — a service flapped past its restart budget`, 'pool');
    }
    // A data-only bind leaves nothing running, which is exactly what `warm`
    // means — services stopped, tree and datastore namespace intact. Publishing
    // it as `hot` would make the idle sweeper try to reclaim heat that was never
    // taken, and would tell a reader that services are up when none are.
    env.state = dataOnly ? 'warm' : 'hot';
    env.servicePids = sup.pids();
    // Remember the shape only when it is a genuine subset; a full app stays
    // undefined so a later manifest addition isn't frozen out by a stale list.
    env.activeServices = active.size === declaredServices.length ? undefined : [...active];
    env.dataOnly = dataOnly;
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

  /** Run one service's build in the worktree. MUST run under treeLocked. */
  private async runServiceBuild(name: string, cmd: string, root: string, say: Progress): Promise<void> {
    say(`building '${name}'`);
    const buildStart = now();
    const beat = setInterval(() => say(`building '${name}' … ${Math.round((now() - buildStart) / 1000)}s`), 5000);
    beat.unref();
    try {
      const buildTimeoutS = cmdTimeoutS(LONG_CMD_TIMEOUT_S);
      const r = await runBounded(cmd, root, buildTimeoutS);
      if (r.timedOut) {
        throw new BrokerError('work-error', `build for service '${name}' timed out after ${buildTimeoutS}s (process group killed; set BACKLOT_CMD_TIMEOUT_S if legitimate)`, name, r.output.slice(-800));
      }
      if (r.code !== 0) throw new BrokerError('work-error', `build failed for service '${name}'`, name, r.output.slice(-800));
    } finally {
      clearInterval(beat);
    }
  }

  // ---------------------------------------------------------------- watch

  /**
   * --watch: the daemon observes the CONSUMER's worktree (opt-in, per lease).
   * The services already run in it (decision 0032), so their own dev watchers
   * see every save directly; what this watcher adds is the part they cannot do —
   * noticing a save that trips an upkeep rule (a lockfile, a migration) and
   * taking the full bind for it, and recording the activity so the lease's
   * environment is not quiesced under a working agent. Stopped on release/
   * expiry/quiesce/recycle/shutdown.
   */
  private startWatch(envId: string, stack: Stack, cwd: string, holder: string): void {
    this.stopWatch(envId);
    let timer: NodeJS.Timeout | null = null;
    let watcher: ReturnType<typeof fsWatch>;
    // Builds and installs now write into the watched tree. Their output is
    // what `caches:` declares; an event there is never a save, and reacting to
    // every obj/ write of a build would refingerprint the worktree for nothing.
    const ignored = stack.manifest.caches ?? [];
    try {
      watcher = fsWatch(stack.root, { recursive: true }, (_event, filename) => {
        const f = String(filename ?? '');
        // `.startsWith('.git')` also matched .github/, .gitignore and
        // .gitlab-ci.yml, so edits to CI config and ignore rules never synced
        // under --watch. Match the .git DIRECTORY, not the prefix.
        if (f === '.git' || f.startsWith('.git/') || f.includes('/.git/') || f.startsWith('.backlot')) return;
        if (ignored.length > 0 && matchesAny(f, ignored)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void this.watchSave(envId, cwd, holder).catch(() => {
            /* a broken edit is reported on the next explicit verb; keep watching */
          });
        }, 300);
        timer.unref();
      });
    } catch {
      return; // recursive fs.watch unavailable — --watch degrades to verbs-only
    }
    // The try/catch above only covers synchronous construction. fs.watch also
    // emits 'error' asynchronously — inotify watch limits (ENOSPC), or the
    // watched tree being moved away — and an unhandled 'error' on an
    // EventEmitter takes the daemon down with it. Losing --watch for one
    // environment is a degradation; losing the daemon strands every one.
    watcher.on('error', (err) => {
      logEvent({ level: 'warn', kind: 'watch', envId, detail: `watcher stopped: ${String((err as Error).message ?? err)} — --watch is off for this environment; explicit verbs still sync` });
      this.stopWatch(envId);
    });
    this.watchers.set(envId, {
      close: () => {
        if (timer) clearTimeout(timer);
        watcher.close();
      },
    });
  }

  private stopWatch(envId: string): void {
    this.watchers.get(envId)?.close();
    this.watchers.delete(envId);
  }

  /**
   * One debounced save. The services' own dev watchers already reload it from
   * the worktree, so runly must not bounce them on save.
   *
   * DELIBERATE FALLBACK: a save that changes what an upkeep rule or
   * @rebake-template fingerprints (a lockfile, a migration) cannot be served by
   * the dev servers alone. That save is handed to the ordinary full bind path —
   * the rule runs, the rebake happens, services restart. Restarting is honest
   * there; silently skipping the rule would hand out an environment the
   * manifest itself says is stale.
   */
  private async watchSave(envId: string, cwd: string, holder: string): Promise<void> {
    const { outcome } = await this.refreshInPlace(envId, cwd, holder);
    if (outcome === 'refreshed') {
      logEvent({ level: 'info', kind: 'watch', envId, detail: 'worktree save seen — hot-reload services kept; they read the worktree themselves' });
    }
    if (outcome === 'fallback') {
      // The full bind also covers every state a refresh can't fix on its own:
      // a quiesced/degraded/recycled-away env, or a lapsed lease that must be
      // re-earned through the ordinary acquire path.
      await this.up({ cwd, holder, kind: 'session', hygiene: 'reuse', watch: true, preserveLeaseDeadline: true });
    }
  }

  /**
   * Keep the running hot-reload services — they read the worktree themselves —
   * after checking, under the env lock like every other mutation, that nothing
   * they cannot handle is due. Returns 'fallback' when the worktree needs the
   * full bind (a due upkeep rule, a changed manifest, an unhealthy service).
   */
  private async refreshInPlace(
    envId: string,
    cwd: string,
    holder: string,
  ): Promise<{ outcome: 'refreshed' | 'fallback' | 'skip'; previewNotice?: string; bindDiagnostics?: BindDiagnostics }> {
    const trace = new BindTrace();
    let forbiddenNotice: string | undefined;
    const fallback = () => ({ outcome: 'fallback' as const, previewNotice: forbiddenNotice, bindDiagnostics: trace.finish() });
    const stack = loadStack(cwd);
    trace.phase('queue');
    return this.envLocked(envId, async () => {
      trace.phase('prepare');
      const env = this.journal.getEnv(envId);
      // Teardown owns a recycling env and closes its watcher; do nothing.
      if (!env || env.state === 'recycling') return { outcome: 'skip' };
      // Only a LIVE lease still pointing at this env may mutate it from a
      // watch event; anything else re-earns an environment via acquire.
      const lease = this.journal.leaseForHolder(holder, stack.id);
      if (!lease || lease.envId !== envId || lease.expiresAt <= now()) return fallback();
      forbiddenNotice = await this.enforcePreviewForbidden(env, stack, () => undefined);
      const presets = selectPresets(stack.manifest, lease.kind, undefined, lease.presets ?? env.presets);
      if (Object.entries(presets).some(([name, preset]) => env.presets[name] !== preset)) return fallback();
      // Same trust conditions as bindAndStart's fast path: hot, all healthy.
      // A quiesced or half-dead env needs services started, not a record.
      if (env.state !== 'hot' || !this.supervisor(env).allHealthyPids()) return fallback();
      // Changing declarations must reconfigure the process even for a hot-reload
      // service: its own watcher reloads source, not its startup environment.
      if (JSON.stringify(stack.manifest) !== this.appliedManifests.get(env.id)) return fallback();

      // The fallback decision: would the worktree as it is now fire any upkeep
      // rule or template rebake? (Same trigger hashes runUpkeep would compare,
      // against the same merged ledger.)
      trace.phase('upkeep');
      const ledger = { ...pickEnvKeys(env.fingerprints), ...pickTreeKeys(readTreeLedger(stack.id)) };
      if (pendingUpkeep(stack.root, triggerSet(stack.root, stack.manifest, worktreeStateDir(stack.id)), stack.manifest, ledger).length > 0) {
        return fallback();
      }
      trace.result.upkeep.skipped = stack.manifest.upkeep?.length ?? 0;
      trace.phase('finalize');

      // Epilogue on a FRESH row (the onDegraded/onPidsChanged callbacks write
      // concurrently): record the activity.
      const fresh = this.journal.getEnv(env.id);
      if (!fresh || fresh.state !== 'hot') return fallback(); // degraded meanwhile
      fresh.lastUsedAt = now();
      this.journal.saveEnv(fresh);
      // Reconcile against the environment's durable shape, not the
      // supervisor's live pids: nothing here restarted a
      // service, so a pid missing during a restart backoff is not a slice change.
      const shape = fresh.dataOnly
        ? new Set<string>()
        : this.resolveServiceClosure(stack, fresh.activeServices?.filter((n) => n in stack.manifest.services) ?? []);
      const previewNotice = await this.reconcilePreviewForBind(fresh, stack, shape, () => undefined, {
        hygiene: 'reuse',
        portsReallocated: false,
      });
      // Content changes preserve the deadline. Re-read ownership after the
      // asynchronous reconcile: release may have ended this lease meanwhile.
      const held = this.journal.leaseForEnv(env.id);
      // Gone or re-claimed: there is no lease left to refresh, and reporting
      // 'refreshed' would hand the caller a context with `lease: null` and exit
      // 0 — their next exec/token then fails with "no active lease". Fall back
      // like every other case a refresh cannot honestly serve; `up` re-earns a
      // lease through the ordinary acquire path.
      if (!held || held.id !== lease.id || held.expiresAt <= now()) return fallback();
      this.journal.saveLease({ ...held, presets });
      trace.result.reuse = 'refreshed';
      trace.result.reasons = ['hot-reload-in-place'];
      return { outcome: 'refreshed', previewNotice: previewNotice ?? forbiddenNotice, bindDiagnostics: trace.finish() };
    }, undefined, 'a hot-reload refresh');

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
    const stack = loadStack(opts.cwd);
    const holder = this.callerHolder(opts.cwd, opts.holder, stack);
    const forbiddenNotice = await this.enforceHolderPreviewForbidden(stack, holder, opts.onProgress);
    selectPresets(stack.manifest, opts.kind ?? 'session', opts.presets);
    // Resolve a requested slice BEFORE acquiring an env: an unknown name is a
    // user typo, not a bind failure, so it must not reach bindAndStart's catch
    // (which bumps failStreak — two typos would escalate the next real bind to a
    // pristine data wipe) or churn a pooled env. bindAndStart resolves it again
    // authoritatively; this is just the early, side-effect-free guard.
    if (opts.services && opts.services.length > 0) this.resolveServiceClosure(stack, opts.services);
    if (opts.dataOnly) {
      // Naming services and asking for none is a contradiction, not a precedence
      // question — guess either way and the caller gets silently the other thing.
      if (opts.services && opts.services.length > 0) {
        throw new BrokerError(
          'work-error',
          `--data-only leases the datastores with no services, so it cannot be combined with a service list (${opts.services.join(', ')})`,
          'manifest',
        );
      }
      // Without a datastore there is nothing to lease, and the caller would get a
      // lease over an empty tree while believing they had a database.
      if (Object.keys(stack.manifest.datastores ?? {}).length === 0) {
        throw new BrokerError(
          'work-error',
          `--data-only needs at least one datastore, and runly.yml declares none — there is nothing to lease`,
          'manifest',
        );
      }
      // The CLI refuses this too, but the guards above are here precisely so that
      // every client of the RPC gets them; leaving one of the three behind in the
      // CLI would be an arbitrary gap. A watcher exists to reload services.
      if (opts.watch) {
        throw new BrokerError('work-error', `--watch has nothing to reload under --data-only, which runs no services`, 'manifest');
      }
    }
    // A lease pinned to a dead pid is released by the very next sweep, so it
    // would hand this caller's environment — and its seeded database — to
    // whoever binds next while the caller is still using it. The CLI refuses
    // this as a usage error; this guard covers every other client of the RPC.
    if (opts.holderPid !== undefined && !isAlive(opts.holderPid)) {
      throw new BrokerError(
        'work-error',
        `holder pid ${opts.holderPid} is not a live process — the lease would be reclaimable the moment it is created; use a TTL instead`,
        'lease',
      );
    }
    // Validate before claiming: missing input is caller configuration, not an
    // environment failure deserving hygiene escalation or a stranded lease.
    const suppliedInputs = opts.callerEnv === undefined ? undefined : validateCallerEnv(stack.manifest, opts.callerEnv);
    const existingLease = this.journal.leaseForHolder(holder, stack.id);
    const existingEnv = existingLease ? this.journal.getEnv(existingLease.envId) : undefined;
    const selectedInputs = (opts.dataOnly ?? existingEnv?.dataOnly) === true
      ? new Set<string>()
      : this.resolveServiceClosure(stack, opts.services ?? existingEnv?.activeServices?.filter((n) => n in stack.manifest.services) ?? []);
    requireCallerEnv(stack.manifest, selectedInputs, suppliedInputs ?? (existingLease ? this.leaseInputs.get(existingLease.id)?.values : undefined) ?? {});
    const kind = opts.kind ?? 'session';
    let hygiene = opts.hygiene ?? 'reuse';
    opts.onProgress?.(`acquiring this worktree's environment (machine ${this.appEnvs().length}/${POOL_MAX_TOTAL()})`);
    const queueStarted = performance.now();
    let queueMs = 0;
    const { env, fresh } = await this.acquireEnv(stack, holder, kind, hygiene, opts.ttlMs ?? LEASE_TTL(kind), opts.dataOnly === true, opts.holderPid, opts.preserveLeaseDeadline);
    // Auto-escalation (decision 0007): two consecutive bind failures on this
    // warm environment -> the next bind is pristine, whatever was asked.
    if (hygiene !== 'pristine' && env.failStreak >= 2) hygiene = 'pristine';
    let reserved = true;
    const bindStarted = () => {
      if (!reserved) return;
      reserved = false;
      this.releaseBind(env.id);
    };
    try {
      const { env: bound, previewNotice, bindDiagnostics } = await this.envLocked(
        env.id,
        () => {
          bindStarted();
          queueMs = performance.now() - queueStarted;
          return this.bindAndStart(stack, env, hygiene, kind, opts.watch ?? false, opts.onProgress, opts.services, fresh, opts.dataOnly, suppliedInputs, opts.presets, opts.restart === true);
        },
        (s) => opts.onProgress?.(`waiting for another operation on this environment … ${s}s`),
        'a bind',
      );
      if (opts.watch && kind === 'session' && !this.watchers.has(bound.id)) {
        this.startWatch(bound.id, stack, opts.cwd, holder);
      }
      bindDiagnostics.phasesMs.queue = queueMs;
      bindDiagnostics.durationMs = performance.now() - requestStarted;
      return { ...this.ctx(opts.cwd, holder, bound.id), previewNotice: previewNotice ?? forbiddenNotice, bindDiagnostics };
    } catch (err) {
      const fresh = this.journal.getEnv(env.id);
      if (fresh) {
        fresh.failStreak += 1;
        this.journal.saveEnv(fresh);
      }
      // A failed bind must not strand the lease for a run; sessions keep theirs
      // to iterate — including a session lease a `run` bound through.
      if (kind === 'run') {
        const lease = this.journal.leaseForHolder(holder, stack.id);
        if (lease && lease.kind === 'run') await this.endLease(lease);
      }
      throw err;
    } finally {
      bindStarted();
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
    this.touch(env.id); // asking for context means an agent is still working here
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
      previewUrls,
      /**
       * True when this lease is over the DATASTORES ONLY, so `urls` is empty by
       * design rather than because a service failed to come up — a distinction a
       * test fixture reading this blob otherwise cannot make.
       */
      dataOnly: env.dataOnly === true,
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
      datastores: Object.fromEntries(Object.entries(ctx.datastores).map(([n, d]) => [n, { url: d.url, ns: d.ns, preset: env.presets[n] }])),
      artifactsDir: join(artifactsRoot(), env.id),
      events: this.supervisors.get(env.id)?.events.slice(-20) ?? [],
    };
  }

  async run(opts: UpOptions & { check: string }) {
    const stack = loadStack(opts.cwd);
    const check = stack.manifest.checks?.[opts.check];
    if (!check) {
      throw new BrokerError('work-error', `no check '${opts.check}' in runly.yml (have: ${Object.keys(stack.manifest.checks ?? {}).join(', ') || 'none'})`, 'manifest');
    }
    // ONE environment per worktree (decision 0032, owner's call): a check runs
    // against the worktree's environment, never a second one beside it. When a
    // session holds it, the run binds THROUGH that session's lease — resetting
    // its data first (reset-data hygiene: a fresh clone from the template) and
    // keeping its deadline — and leaves the lease in place afterwards. There is
    // deliberately no flag to keep the session's data. With no session lease it
    // takes an ephemeral run lease, which it ends when the check is done; the
    // environment stays, hot, for the next bind. Another run's lease is not a
    // session to bind through: this run queues for the environment instead.
    const live = this.journal
      .envsForStack(stack.id)
      .map((e) => this.journal.leaseForEnv(e.id))
      .find((l): l is LeaseRow => l !== undefined && l !== null && l.kind !== 'run' && l.expiresAt > now());
    const holder = live ? live.holder : `run-${shortId()}`;
    const startedAt = now();
    // services: [] forces the whole app — a check runs against the full topology,
    // never the leftover shape of the session it binds through. Same reason for
    // dataOnly: false: a check silently running against an environment with no
    // services would be a wrong verdict.
    const context = await this.up({
      ...opts,
      holder,
      kind: 'run',
      hygiene: opts.hygiene ?? 'reset-data',
      services: [],
      dataOnly: false,
      ...(live ? { preserveLeaseDeadline: true, holderPid: undefined } : {}),
    });
    const env = this.journal.getEnv(context.envId);
    if (!env) {
      // Bound a moment ago, so only a concurrent forced recycle can take it.
      throw new BrokerError('env-error', `environment ${context.envId} was recycled between bind and check — retry the run`, 'pool');
    }
    const ctx = this.templateCtx(stack, env);
    // The check runs in the LIVE worktree (decision 0032): an edit made while it
    // runs is visible to it. What it changed among the declared outputs is
    // still reported, by comparing them around the check.
    const outputsBefore = hashOutputs(stack.root, stack.manifest.outputs ?? []);
    try {
      // envLocked: marks the env busy for the whole check so the sweeper can't
      // expire the run lease mid-check and hand the env to someone else. The
      // process-group timeout bounds how long that hold can last.
      const timeoutS = check.timeout ?? CHECK_TIMEOUT_S;
      opts.onProgress?.(`running check '${opts.check}'`);
      const runStart = now();
      const beat = setInterval(() => opts.onProgress?.(`running check '${opts.check}' … ${Math.round((now() - runStart) / 1000)}s`), 5000);
      beat.unref();
      const res = await this.envLocked(
        env.id,
        () => {
        this.assertUsable(env.id);
        return runGroupCmd(
          template(check.run, ctx),
          check.cwd ? safeJoin(stack.root, check.cwd, `check '${opts.check}' cwd`) : stack.root,
          { ...process.env, ...templateEnv(check.env, ctx), ...serviceTag(env.id, `check:${opts.check}`, stateRoot()) },
          timeoutS,
        );
        },
        (s) => opts.onProgress?.(`waiting for another operation on this environment … ${s}s`),
        `check '${opts.check}'`,
      ).finally(() => clearInterval(beat));
      const artifactsDir = this.collectArtifacts(env.id, stack.root, check.artifacts ?? [], runStart);
      const outputsAfter = hashOutputs(stack.root, stack.manifest.outputs ?? []);
      // A check that failed because the ENVIRONMENT fell over is not the repo's
      // code being wrong. Reporting work-error there is a silently wrong
      // verdict (architecture section 9) — an agent reads it as "my change
      // broke the test" and starts editing code to fix a dead dev-server.
      const envDied =
        res.exitCode !== 0 && !res.timedOut && !this.supervisor(env).allHealthyPids();
      const failClass: 'work-error' | 'env-error' = envDied ? 'env-error' : 'work-error';
      return {
        check: opts.check,
        ok: res.exitCode === 0 && !res.timedOut,
        exitCode: res.timedOut ? -1 : res.exitCode,
        failure:
          res.exitCode === 0 && !res.timedOut
            ? null
            : res.timedOut
              ? { class: 'work-error', message: `check '${opts.check}' timed out after ${timeoutS}s (process group killed; raise checks.${opts.check}.timeout if legitimate)`, logExcerpt: res.output.slice(-800) }
              : {
                  class: failClass,
                  message: envDied
                    ? `check '${opts.check}' failed (exit ${res.exitCode}) while a service was not running — the environment failed, not necessarily the code`
                    : `check '${opts.check}' failed (exit ${res.exitCode})`,
                  logExcerpt: res.output.slice(-800),
                },
        output: res.output,
        artifactsDir,
        outputsChanged: Object.keys(outputsAfter).filter((rel) => outputsAfter[rel] !== outputsBefore[rel]),
        envId: env.id,
        durationMs: now() - startedAt,
        bindDiagnostics: context.bindDiagnostics,
      };
    } finally {
      // Only our own ephemeral run lease — never the session it bound through.
      const lease = live ? undefined : this.journal.leaseForHolder(holder, stack.id);
      if (lease && lease.kind === 'run') await this.endLease(lease); // env stays hot for the next bind
    }
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
        const upkeep = await runUpkeep(stack.root, triggerSet(stack.root, stack.manifest, worktreeStateDir(stack.id)), stack.manifest, ledger.get(), say, {
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
      for (const [name, spec] of Object.entries(stack.manifest.services)) {
        if (!spec.build) continue;
        // No environment means no ports, URLs or datastores to fill in, and
        // running the line with a placeholder would build the wrong thing.
        if (/\{\{/.test(spec.build)) {
          steps.push({ kind: 'build', service: name, status: 'skipped', durationMs: 0, reason: 'its build line templates environment values; the next bind builds it' });
          continue;
        }
        const buildStart = performance.now();
        try {
          await this.runServiceBuild(name, spec.build, stack.root, say);
          steps.push({ kind: 'build', service: name, status: 'ran', durationMs: performance.now() - buildStart });
        } catch (err) {
          steps.push({ kind: 'build', service: name, status: 'failed', durationMs: performance.now() - buildStart });
          const e = err instanceof BrokerError ? err : new BrokerError('work-error', String((err as Error).message ?? err), name);
          failure = e.toJSON();
          return;
        }
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

  /**
   * Detached submit-and-poll runs (decision 0015): the verdict outlives the
   * client. Returns immediately with a jobId; the caller polls jobStatus.
   * Execution is handed back to the daemon's serialized queue by the server.
   */
  createJob(cwd: string, check: string): string {
    const id = `job-${shortId()}`;
    this.journal.saveJob({ id, stackCwd: cwd, check, state: 'pending' });
    return id;
  }

  async executeJob(id: string, opts: UpOptions & { check: string }): Promise<void> {
    this.journal.saveJob({ id, stackCwd: opts.cwd, check: opts.check, state: 'running' });
    try {
      const verdict = await this.run(opts);
      this.journal.saveJob({ id, stackCwd: opts.cwd, check: opts.check, state: 'done', verdict, finishedAt: now() });
    } catch (err) {
      const failure = err instanceof BrokerError ? err.toJSON() : { class: 'env-error', message: String((err as Error).message ?? err) };
      this.journal.saveJob({ id, stackCwd: opts.cwd, check: opts.check, state: 'done', verdict: { check: opts.check, ok: false, exitCode: -1, failure }, finishedAt: now() });
    }
  }

  jobStatus(id: string) {
    const job = this.journal.getJob(id);
    if (!job) throw new BrokerError('env-error', `no such job '${id}'`, 'job');
    return job;
  }

  /**
   * Copy what the check produced into the artifact store.
   *
   * The check ran in the caller's worktree, which also holds whatever earlier
   * runs — and the agent itself — left under the same paths. Only files written
   * since the check started are its artifacts; a stale test-results/ from an
   * hour ago is not this verdict's evidence. Each pattern is walked from its
   * literal prefix only, so a pattern under frontend/ never walks every obj/ of
   * the backend.
   */
  private collectArtifacts(envId: string, root: string, patterns: string[], since: number): string | null {
    if (patterns.length === 0) return null;
    const dest = join(artifactsRoot(), envId, `${now()}`);
    // Coarse filesystem timestamps (1s on some) may round a just-written file
    // to before the check began; a second of slack only risks a file the agent
    // wrote in the very instant the check started.
    const cutoff = since - 1000;
    const walk = (dir: string, prefix: string, out: Map<string, number>) => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name === 'node_modules' || name === '.git') continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        const full = join(dir, name);
        let st;
        try {
          st = lstatSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full, rel, out);
        else if (st.isFile()) out.set(rel, st.mtimeMs);
      }
    };
    const files = new Map<string, number>();
    for (const pattern of patterns) {
      const literal = pattern.replace(/^\.\//, '').split('/');
      const stop = literal.findIndex((seg) => /[*?[]/.test(seg));
      const base = (stop === -1 ? literal.slice(0, -1) : literal.slice(0, stop)).join('/');
      let start: string;
      try {
        start = base ? safeJoin(root, base, 'check artifacts') : root;
      } catch {
        continue;
      }
      walk(start, base, files);
    }
    const matched = [...files].filter(([f, mtime]) => mtime >= cutoff && matchesAny(f, patterns)).map(([f]) => f);
    if (matched.length === 0) return null;
    for (const rel of matched) {
      const dst = join(dest, rel);
      mkdirSync(join(dst, '..'), { recursive: true });
      copyFileSync(join(root, rel), dst, fsConstants.COPYFILE_FICLONE);
    }
    return dest;
  }

  /**
   * `sync`: make the lease reflect the worktree as it is now.
   *
   * Nothing is copied (decision 0032) — the services already run in the
   * worktree. When every service reloads source itself (`hot_reload`), the
   * lease is live and the change fires no upkeep rule, the new source is merely
   * recorded and the services are kept: their own watchers have already served
   * it. Under a non-watching process the edit is invisible until a restart, so
   * any undeclared service takes the full bind (rebuild, restart) — serving
   * stale code silently is the failure class this broker exists to prevent
   * (owner decision, 2026-07-20).
   */
  async syncLease(cwd: string, holder?: string, onProgress?: Progress) {
    const requestStarted = performance.now();
    let refreshDiagnostics: BindDiagnostics | undefined;
    let refreshNotice: string | undefined;
    const stack = loadStack(cwd);
    const h = this.callerHolder(cwd, holder, stack);
    const allReload = Object.values(stack.manifest.services).every((svc) => svc.hot_reload === true);
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (allReload && lease && lease.expiresAt > now()) {
      onProgress?.('checking the worktree (hot-reload services kept)');
      const refreshed = await this.refreshInPlace(lease.envId, cwd, h);
      if (refreshed.outcome === 'refreshed') {
        if (refreshed.bindDiagnostics) refreshed.bindDiagnostics.durationMs = performance.now() - requestStarted;
        return { ...this.ctx(cwd, h, lease.envId), previewNotice: refreshed.previewNotice, bindDiagnostics: refreshed.bindDiagnostics };
      }
      refreshDiagnostics = refreshed.bindDiagnostics;
      refreshNotice = refreshed.previewNotice;
    }
    // Anything a refresh can't honestly serve — pending upkeep/rebake, a
    // quiesced or degraded env, a lapsed lease — takes the full bind.
    const result = await this.up({ cwd, holder: h, kind: 'session', hygiene: 'reuse', onProgress, preserveLeaseDeadline: true, restart: true });
    result.previewNotice ??= refreshNotice;
    if (refreshDiagnostics) {
      // Include the attempt's time instead of hiding it.
      for (const key of Object.keys(refreshDiagnostics.phasesMs) as Array<keyof BindDiagnostics['phasesMs']>) {
        result.bindDiagnostics.phasesMs[key] += refreshDiagnostics.phasesMs[key];
      }
      result.bindDiagnostics.reasons.unshift('refresh-fallback');
    }
    result.bindDiagnostics.durationMs = performance.now() - requestStarted;
    return result;
  }

  jobList() {
    return { jobs: this.journal.listJobs(20) };
  }

  async resetData(cwd: string, holder?: string, onProgress?: Progress, presets?: unknown) {
    const stack = loadStack(cwd);
    const h = this.callerHolder(cwd, holder, stack);
    const noLease = () => new BrokerError('env-error', `no active lease — run 'runly up' first`, 'lease');
    const forbiddenNotice = await this.enforceHolderPreviewForbidden(stack, h, onProgress);
    selectPresets(stack.manifest, 'session', presets);
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
        return this.bindAndStart(stack, env, 'reset-data', held.kind, false, onProgress, undefined, false, undefined, undefined, presets);
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
   * already is). bindAndStart already re-checks; exec, token, and the check
   * phase did not.
   */
  /**
   * Record that an environment was USED, without extending its lease.
   *
   * lastUsedAt only moved on bind, so an agent that bound once and then ran
   * exec/logs/ctx for an hour looked completely idle — and would be quiesced by
   * the sweep below while actively working. Activity and ownership are
   * different questions and are now tracked separately.
   */
  private touch(envId: string): void {
    try {
      this.journal.touchEnv(envId);
    } catch {
      /* the row may have been recycled — nothing to record */
    }
  }

  private assertUsable(envId: string): EnvRow {
    const fresh = this.journal.getEnv(envId);
    if (!fresh || fresh.state === 'recycling') {
      throw new BrokerError('env-error', `environment ${envId} is being recycled — retry`, 'pool');
    }
    // A daemon restart downgrades every hot env to warm: the lease survives but
    // the services do not. exec/token then failed against a tree with nothing
    // running, and the command's own error ("connection refused") read as the
    // repo's fault with no hint that a rebind was all it needed.
    // …but a DATA-ONLY environment is warm by design: no services were ever
    // meant to run, and its tree and datastore namespace are exactly what the
    // holder leased. Refusing it here would break `exec` on the one lease shape
    // that has nothing else to offer.
    if (fresh.state === 'warm' && !fresh.dataOnly) {
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
    return this.envLocked(env.id, async () => {
      this.assertUsable(env.id);
      this.touch(env.id);
      // Bounded, detached, and tagged like a check: an exec blocking on stdin
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
    if (!spec) throw new BrokerError('work-error', `runly.yml declares no auth.token command`, 'manifest');
    const lease = this.journal.leaseForHolder(this.callerHolder(cwd, holder, stack), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'runly up' first`, 'lease');
    const env = this.envForLease(lease);
    const ctx = { ...this.templateCtx(stack, env), role };
    return this.envLocked(env.id, async () => {
      this.assertUsable(env.id);
      this.touch(env.id);
      const timeoutS = cmdTimeoutS();
      const r = await runBoundedIO(template(spec, ctx), stack.root, timeoutS);
      if (r.timedOut) {
        throw new BrokerError('work-error', `auth.token command timed out after ${timeoutS}s (process group killed)`, 'auth', r.stderr.slice(-400));
      }
      if (r.code !== 0) throw new BrokerError('work-error', `auth.token command failed`, 'auth', r.stderr.slice(-400));
      return { token: r.stdout.trim(), role };
    }, undefined, 'a token command');
  }

  logs(cwd: string, service: string, lines: number, holder?: string) {
    const stack = loadStack(cwd);
    // A name the manifest never declared is the caller's mistake — name the
    // services that exist, the way an unknown check does.
    if (!stack.manifest.services[service]) {
      throw new BrokerError('work-error', `no service '${service}' in runly.yml (have: ${Object.keys(stack.manifest.services).join(', ')})`, service);
    }
    const lease = this.journal.leaseForHolder(this.callerHolder(cwd, holder, stack), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'runly up' first`, 'lease');
    const env = this.envForLease(lease);
    this.touch(env.id);
    const logFile = join(this.envDirs(env.id).logs, `${service}.log`);
    // The log file is created lazily on the first byte of output, so a silent
    // service has none — that is an EMPTY log, not an env-error (BACKLOG P3).
    const content = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    return { service, lines: content.split('\n').slice(-lines).join('\n') };
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
        `this stack forbids public preview in runly.yml (preview.forbidden) — the manifest must not be published to the internet`,
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
    this.stopWatch(lease.envId);
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
    if (env.dataOnly) {
      throw new BrokerError('work-error', `preview has nothing to publish on a data-only lease — no services are running`, 'preview');
    }
    const spec = stack.manifest.services[service];
    if (!spec) {
      throw new BrokerError('work-error', `no service '${service}' in runly.yml`, 'manifest');
    }
    const activeSet = env.activeServices ? new Set(env.activeServices) : null;
    if (activeSet && !activeSet.has(service)) {
      throw new BrokerError(
        'work-error',
        `service '${service}' is not part of this lease's slice — only ${[...activeSet].map((s) => `'${s}'`).join(', ')} are up`,
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
      // a row an `up api` or `up --data-only` queued ahead of us has already
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
      throw new BrokerError('work-error', `no appliance '${name}' in runly.yml`, 'appliance');
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
    if (!spec) throw new BrokerError('work-error', `no appliance '${name}' in runly.yml`, 'appliance');
    await stopAppliance(name, spec, stack.root);
    logEvent({ level: 'info', kind: 'appliance', detail: `'${name}' stopped (${spec.probe})` });
    return { stopped: name };
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
        /** Where its services run: the caller's worktree (decision 0032). */
        worktree: e.stackRoot,
        lease,
        /** null = the whole app; otherwise the service slice this env is running. */
        activeServices: e.activeServices ?? null,
        idleMs: now() - e.lastUsedAt,
        /** null = the holder never identified itself, so liveness is unknowable. */
        holderAlive,
        /** Why this environment is still holding its services, in one word. */
        heat: e.state === 'hot' ? (now() - e.lastUsedAt > LEASED_IDLE_TTL() ? 'stale' : 'active') : 'cold',
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
        /** Leased for its datastores only — no services were ever meant to run. */
        dataOnly: e.dataOnly === true,
        /** Plain language for the two fields above, so no one has to infer it. */
        summary: lease
          ? `leased by '${lease.holder}'${e.dataOnly ? ' (data only — no services)' : ''}${holderAlive === false ? ' (holder process is gone)' : ''}`
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
    return { pid: process.pid, envs, poolMax: POOL_MAX(), poolMaxTotal: POOL_MAX_TOTAL(), events: recentEvents(15) };
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
   * BUSY is the refusal. A `run` is executed detached so the check itself
   * survives the daemon (see runGroupCmd), but the CALLER is blocked on this
   * socket waiting for a verdict — restarting hands it a dead connection and no
   * result. Every other reclaim path already treats busy as inviolable
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
        `an operation is in flight on ${busy.join(', ')} — restarting now would drop the caller waiting on its verdict; ` +
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
      ? `work-error: runly.yml now sets preview.forbidden, and a stack that forbids preview must not stay published — ${url} has been torn down`
      : `work-error: runly.yml now sets preview.forbidden but the tunnel could NOT be confirmed dead — ${url} may still be serving, unauthenticated`;
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
   * service is no longer in the running slice, or it moved to a different local
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
   * Never throws. The bind that narrowed the slice or wiped the data is a
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
      ? { klass: 'work-error', why: `runly.yml now sets preview.forbidden, and a stack that forbids preview must not stay published` }
      : !active.has(service)
        ? { klass: 'env-error', why: `service '${service}' is not in this bind's running set${active.size ? ` (${[...active].map((n) => `'${n}'`).join(', ')})` : ' (this lease is data-only)'}, so its preview would publish a port with nothing behind it for the rest of the lease` }
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
    this.stopWatch(env.id);
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
    // Drop server-side namespaces too (best effort — the manifest may be gone).
    try {
      const stack = loadStack(env.stackRoot);
      const dirs = this.envDirs(env.id);
      // Repo commands run where the environment ran — its worktree — unless
      // that is gone (an orphan reclaim), when the environment's own directory
      // is at least somewhere they can start.
      const h: DsHandle = { envId: env.id, cwd: existsSync(env.stackRoot) ? env.stackRoot : env.root, dataDir: dirs.data };
      for (const [name, spec] of Object.entries(stack.manifest.datastores ?? {})) {
        if (!env.datastoreNs[name]) continue;
        try {
          await makeDatastore(name, spec, stack.id).drop(h);
        } catch (err) {
          // The env row is about to be deleted, taking the only record of this
          // namespace with it — so a swallowed failure leaks a server-side
          // database nothing can ever name again. Say so loudly enough to be
          // actionable.
          logEvent({
            level: 'error',
            kind: 'teardown',
            envId: env.id,
            detail: `datastore '${name}' namespace was NOT dropped and is now orphaned on the server: ${String((err as Error).message ?? err)}`,
          });
        }
      }
    } catch {
      /* stack unloadable — local files still go */
    }
    // The environment's PRIVATE directory goes; the worktree it ran in never
    // does (decision 0032). Both are recorded on the row, so check the one
    // against the other before an rm -rf rather than trust that they differ.
    if (this.isPrivateEnvDir(env)) rmSync(env.root, { recursive: true, force: true });
    else logEvent({ level: 'error', kind: 'teardown', envId: env.id, detail: `refused to delete ${env.root}: it is not a private environment directory under ${envsRoot()}, or it contains the worktree ${env.stackRoot}` });
    this.journal.deleteEnv(env.id);
    if (lease) this.leaseInputs.delete(lease.id);
    this.appliedInputs.delete(env.id);
    this.appliedInputSpecs.delete(env.id);
    this.appliedManifests.delete(env.id);
    this.envChains.delete(env.id); // don't leak a settled chain for a dead id
    return true;
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

  // ---------------------------------------------------------------- sweeper

  async sweep(): Promise<void> {
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
      // A holder that named its process and is now gone releases IMMEDIATELY.
      // Waiting out the TTL meant a crashed agent's environment stayed leased —
      // and therefore un-poolable — for up to half an hour.
      if (lease.holderPid !== undefined && !sameProcess(lease.holderPid, lease.holderStart)) {
        await this.endLease(lease);
        logEvent({
          level: 'info',
          kind: 'lease',
          envId: lease.envId,
          detail: `holder process ${lease.holderPid} is gone — lease released early instead of waiting out its TTL`,
        });
        continue;
      }
      if (lease.expiresAt < now()) {
        await this.endLease(lease);
      }
    }
    for (const env of this.journal.allEnvs()) {
      if (this.busy.has(env.id)) continue;
      // An environment whose STACK can never be bound again — the repo was
      // deleted or moved, or (after an identity-scheme change or a manifest
      // rename) its root no longer resolves to the recorded stack id — is
      // pure leakage: invisible to any pool yet counted against
      // POOL_MAX_TOTAL and holding its ports. A manifest that merely fails to
      // PARSE is not proof of orphanhood (someone may be mid-edit), so only a
      // positive id mismatch or a missing root reaps.
      if (!this.journal.leaseForEnv(env.id)) {
        let orphanReason: string | null = null;
        if (!existsSync(env.stackRoot)) {
          orphanReason = `stack root ${env.stackRoot} is gone`;
        } else {
          try {
            const current = loadStack(env.stackRoot);
            if (this.legacyAlias(env, current)) this.adoptLegacyAliases(current);
            else if (current.id !== env.stack) orphanReason = `stack root ${env.stackRoot} now resolves to '${current.id}', not '${env.stack}'`;
          } catch {
            /* unreadable manifest — ambiguous, leave the env alone */
          }
        }
        if (orphanReason) {
          logEvent({ level: 'info', kind: 'retention', envId: env.id, detail: `${orphanReason} — reclaiming the environment` });
          await this.recycleOne(env.id, true);
          continue;
        }
      }
      if (env.state === 'degraded') {
        // Dead env — reap regardless of a stale lease (force), but never while an
        // op is in flight (claimForTeardown always respects busy). The holder's
        // stale lease is dropped with the env; its next `up` gets a fresh one.
        await this.recycleOne(env.id, true);
        continue;
      }
      // A lease no longer exempts an environment from reclaiming HEAT. Holding a
      // lease used to keep services (and their memory) alive for the whole TTL
      // even if nothing had touched the environment since the bind — which is
      // how a crashed agent kept multiple gigabytes for half an hour. The lease
      // still survives; only the services stop, and the next verb rebinds.
      const leased = this.journal.leaseForEnv(env.id);
      const idleFor = now() - env.lastUsedAt;
      const quiesceAfter = leased ? LEASED_IDLE_TTL() : IDLE_TTL();
      if (env.state === 'hot' && idleFor > quiesceAfter) {
        // Under the ENV LOCK, not a teardown claim (decision 0021): borrowing
        // the `recycling` state published a heat reclaim to the journal as a
        // teardown-in-progress, so a crash mid-quiesce made recovery finish
        // the "teardown" — deleting the env AND its live lease. Under the
        // lock, mid-quiesce state is plain `hot` with dead pids, which is the
        // ordinary crash-recovery case (reap, mark warm, keep the lease). The
        // lock also serializes this with binds, so the idle re-check below is
        // finally race-free against their epilogue's lastUsedAt writes — and
        // a bind queued behind us simply rebinds the warm env.
        await this.envLocked(env.id, async () => {
          const fresh = this.journal.getEnv(env.id);
          if (!fresh || fresh.state !== 'hot') return;
          if (now() - fresh.lastUsedAt <= quiesceAfter) return; // touched while we queued
          this.stopWatch(env.id);
          const survivors = await this.supervisor(fresh).stopAll();
          // stopAll() alone is NOT a stop: a service that called setsid() or
          // spawned a detached grandchild escaped the -pgid signal and keeps
          // its memory and its PORT. That used to be reconciled only by the
          // next bindAndStart on this same environment — a bind that may never
          // come, since a quiesced env can sit cold for hours. The observable
          // result was hundreds of orphaned service children with a deleted cwd
          // holding gigabytes, and cold pool entries whose port was still bound
          // so the next bind failed with "occupied by a foreign process".
          const unreaped = await this.reapEnvProcesses(fresh, mergeServicePids(fresh.servicePids, survivors));
          this.supervisors.delete(env.id);
          const post = this.journal.getEnv(env.id);
          if (post) {
            post.state = 'warm';
            // Anything that outlived SIGKILL stays recorded, so the next gc pass
            // (or a later restart) can still find it instead of losing it.
            post.servicePids = unreaped;
            this.journal.saveEnv(post);
            if (leased) {
              logEvent({
                level: 'info',
                kind: 'quiesce',
                envId: env.id,
                detail: `idle ${Math.round(idleFor / 60_000)}m while leased by '${leased.holder}' — services stopped, lease kept; the next verb rebinds`,
              });
            }
          }
        }, undefined, 'an idle quiesce');
      }
    }
    await this.drainSurplusEnvs();
    // Maintenance runs after ownership/expiry/reaping and does at most one
    // bounded external drop per sweep. Recovery never waits for it.
    await this.retireLegacyTemplateBatch();
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.watchers.keys()]) this.stopWatch(id);
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
      // claimForTeardown, the sweeper and pool gc all already keep. A check runs
      // DETACHED so it can outlive the daemon (see runGroupCmd), and it carries
      // this env's tag, so the tag scan inside reapEnvProcesses would kill the
      // very process the caller is still waiting on a verdict from.
      const unreaped = this.busy.has(env.id) ? recorded : await this.reapEnvProcesses(env, recorded);
      const fresh = this.journal.getEnv(env.id);
      if (!fresh) continue; // recycled underneath us — nothing to write back
      if (fresh.state === 'hot') fresh.state = 'warm';
      fresh.servicePids = unreaped;
      this.journal.saveEnv(fresh);
    }
  }
}

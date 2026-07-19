/**
 * The engine: pool + lease + bind + run orchestration, owning all policy
 * (drivers own transport/storage; the manifest owns repo knowledge).
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, copyFileSync, readdirSync, statSync, existsSync, readFileSync, watch as fsWatch, constants as fsConstants } from 'node:fs';
import { join, resolve } from 'node:path';
import { Journal, type EnvRow, type LeaseRow } from '../core/journal.js';
import { loadStack, defaultPreset, type Stack } from '../core/manifest.js';
import { changedOutputs, pullOutputs } from '../core/sync.js';
import { syncIntoEnvThreaded } from '../core/sync-thread.js';
import { runUpkeep, pendingUpkeep, templateBakeKeys } from '../core/upkeep.js';
import { freePort, probeFree } from '../core/ports.js';
import { envsRoot, artifactsRoot, stateRoot } from '../core/paths.js';
import { BrokerError, template, templateEnv, now, shortId, matchesAny, safeJoin } from '../core/util.js';
import { cmdTimeoutS, runBounded, runBoundedIO, LONG_CMD_TIMEOUT_S } from '../core/exec.js';
import { makeDatastore, type DsHandle } from '../drivers/datastores.js';
import { ensureAppliance, stopAppliance, probeTcp } from '../drivers/appliances.js';
import { EnvSupervisor, killGroupVerified, reapPids } from './supervisor.js';
import { isAlive, procScanSupported, sameProcess, scanTagged, serviceTag, startTime } from '../core/procscan.js';
import { policy } from '../core/policy.js';
import { retentionSweep } from '../core/retention.js';
import { logEvent, recentEvents } from '../core/events.js';
import type { Hygiene, LeaseKind, ServicePid } from '../core/types.js';

const POOL_MAX = () => policy().poolMax;
const POOL_MAX_TOTAL = () => policy().poolMaxTotal;
const LEASE_TTL = (kind: LeaseKind) => (kind === 'session' ? policy().sessionTtlMs : policy().runTtlMs);
const IDLE_TTL = () => policy().idleTtlMs;
const LEASED_IDLE_TTL = () => policy().leasedIdleTtlMs;
const WAIT_MS = () => policy().waitMs;
const CHECK_TIMEOUT_S = 600;

/** Streamed bind phases → human progress on stderr (never on the --json stdout). */
export type Progress = (phase: string) => void;

export interface UpOptions {
  cwd: string;
  holder?: string;
  hygiene?: Hygiene;
  kind?: LeaseKind;
  watch?: boolean;
  ttlMs?: number;
  /** Bind from this directory instead of the worktree (bind --ref extraction). */
  sourceRoot?: string;
  /**
   * The CALLER's process, so its lease can be released when it dies.
   * The CLI exits per invocation, so this must be the long-lived agent's pid —
   * supplied via --holder-pid or BACKLOT_HOLDER_PID, and by the MCP adapter
   * automatically since that process outlives its tool calls.
   */
  holderPid?: number;
  /** Set by the daemon per-request; emits progress frames back to the client. */
  onProgress?: Progress;
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
  readonly journal = new Journal();
  private supervisors = new Map<string, EnvSupervisor>();
  private lastSweep = now();
  private lastRetention = now();
  private lastGc = now();
  private lastSweepMono = performance.now();
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
  /** Envs with an operation in flight — the sweeper must not expire/quiesce these. */
  readonly busy = new Set<string>();
  /** --watch: per-env worktree watchers ("verbs sync, watch streams", decision 0005). */
  private watchers = new Map<string, { close: () => void }>();

  private poolLocked<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.poolChain.then(fn, fn);
    this.poolChain = next.catch(() => undefined);
    return next;
  }

  private envLocked<T>(envId: string, fn: () => Promise<T>, onWait?: (elapsedS: number) => void): Promise<T> {
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
      try {
        return await fn();
      } finally {
        this.busy.delete(envId);
      }
    };
    const next = chain.then(run, run);
    this.envChains.set(envId, next.catch(() => undefined));
    return next;
  }

  /** Recovery (decision 0009): reap recorded PIDs from a previous daemon life; hot -> warm. */
  async recover(): Promise<void> {
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
      this.journal.saveEnv(env);
      envs++;
    }
    const jobs = this.journal.failStaleJobs();
    logEvent({
      level: stranded ? 'warn' : 'info',
      kind: 'recover',
      detail: `reconciled ${envs} env(s), ${jobs} stale job(s)${stranded ? `, ${stranded} service(s) survived the reap` : ''}`,
    });
    // Anything the journal never knew about — the owner died before the pids
    // were ever written, or the env row is long gone — is only findable by tag.
    const gc = await this.poolGc();
    if (gc.reclaimed.length) {
      logEvent({ level: 'warn', kind: 'gc', detail: `reclaimed ${gc.reclaimed.length} orphaned process(es) at startup` });
    }
  }

  /**
   * Reclaim backlot-spawned processes that no live environment accounts for.
   *
   * A process is an orphan when it carries this state root's tag but its env
   * either no longer exists in the journal, or exists in a state that must have
   * no services running (warm/recycling). Anything belonging to a hot env, or
   * to an env with an operation in flight, is left strictly alone — a bind
   * racing the sweep must not have its dev-server shot out from under it.
   */
  async poolGc(): Promise<{ supported: boolean; reclaimed: Array<{ pid: number; envId: string; service: string }>; skipped: number }> {
    if (!procScanSupported()) return { supported: false, reclaimed: [], skipped: 0 };
    const tagged = scanTagged(stateRoot());
    if (tagged.length === 0) return { supported: true, reclaimed: [], skipped: 0 };

    // Snapshot which envs may legitimately own a running process right now.
    const live = new Set<string>();
    for (const env of this.journal.allEnvs()) {
      if (env.state === 'hot' || env.state === 'provisioning' || this.busy.has(env.id)) live.add(env.id);
    }
    for (const id of this.busy) live.add(id);

    const reclaimed: Array<{ pid: number; envId: string; service: string }> = [];
    let skipped = 0;
    for (const proc of tagged) {
      if (live.has(proc.envId)) {
        skipped++;
        continue;
      }
      // Pin identity to the exact process the scan saw: between the scan and
      // this kill the pid could have exited and been reused.
      const dead = await killGroupVerified(proc.pid, proc.startTime);
      if (dead) reclaimed.push({ pid: proc.pid, envId: proc.envId, service: proc.service });
    }
    if (reclaimed.length) {
      // A reclaimed process may have been the one the journal was still
      // tracking — drop those records so doctor() doesn't report drift.
      for (const env of this.journal.allEnvs()) {
        const keep = Object.fromEntries(
          Object.entries(env.servicePids).filter(([, rec]) => !reclaimed.some((r) => r.pid === rec.pid)),
        );
        if (Object.keys(keep).length !== Object.keys(env.servicePids).length) {
          env.servicePids = keep;
          this.journal.saveEnv(env);
        }
      }
      logEvent({ level: 'info', kind: 'gc', detail: `reclaimed ${reclaimed.length} orphaned process(es)` });
    }
    return { supported: true, reclaimed, skipped };
  }

  // ---------------------------------------------------------------- pool

  private envDirs(id: string) {
    const root = join(envsRoot(), id);
    return { root, tree: join(root, 'tree'), data: join(root, 'data'), logs: join(root, 'logs') };
  }

  private async createEnv(stack: Stack): Promise<EnvRow> {
    // Monotonic, never-reused sequence — a reaped env's id can never collide
    // with a live one (the old length+1 scheme did, deterministically).
    const n = this.journal.nextEnvSeq(stack.id);
    const id = `${stack.id}-e${n}`;
    const dirs = this.envDirs(id);
    mkdirSync(dirs.tree, { recursive: true });
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
    };
    this.journal.saveEnv(env);
    return env;
  }

  /** One atomic claim attempt — MUST run under the pool lock. */
  private async tryClaim(stack: Stack, holder: string, kind: LeaseKind, hygiene: Hygiene, ttlMs: number, holderPid?: number, onlyMine = false): Promise<EnvRow | null> {
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
        this.journal.saveLease({ ...mine, hygiene, expiresAt: now() + ttlMs, ...holderIdentity(holderPid) });
        return env;
      }
      this.journal.deleteLease(mine.id);
    }
    // The queue-bypass path may ONLY refresh an existing lease — claiming free
    // capacity here would jump the FIFO the waiters are queued on.
    if (onlyMine) return null;
    const envs = this.journal.envsForStack(stack.id);
    const free = envs
      .filter((e) => !this.journal.leaseForEnv(e.id) && e.state !== 'degraded' && e.state !== 'recycling')
      .sort((a, b) => (a.state === 'hot' ? -1 : 1) - (b.state === 'hot' ? -1 : 1));
    let env = free[0];
    // Two ceilings: this stack's, and the machine's across every stack.
    const total = this.journal.allEnvs().length;
    if (!env && envs.length < POOL_MAX() && total < POOL_MAX_TOTAL()) env = await this.createEnv(stack);
    if (env) {
      this.journal.saveLease({
        id: `l-${shortId()}`, envId: env.id, kind, holder, hygiene, expiresAt: now() + ttlMs,
        ...holderIdentity(holderPid),
      });
      return env;
    }
    return null;
  }

  /**
   * Is the pool full of environments whose leases outlast our whole wait?
   *
   * If so, queueing cannot possibly succeed, and reporting "waited 60s" blames
   * a timing problem that does not exist. This is the shape a session `up`
   * followed by a `run` hits on a one-environment pool: `run` always mints its
   * own ephemeral holder, so it needs a SECOND environment that the pool is not
   * allowed to create. MUST run under the pool lock.
   */
  private structuralCapacityBlock(stack: Stack, deadline: number): string | null {
    const envs = this.journal.envsForStack(stack.id);
    const total = this.journal.allEnvs().length;
    if (envs.length < POOL_MAX() && total < POOL_MAX_TOTAL()) return null; // room to grow
    // A machine-wide block can clear when ANOTHER stack releases, so only a
    // per-stack block is structural.
    if (envs.length < POOL_MAX()) return null;
    const holders: string[] = [];
    for (const env of envs) {
      // These resolve on their own — the sweeper reaps them and frees capacity.
      if (env.state === 'degraded' || env.state === 'recycling') return null;
      const lease = this.journal.leaseForEnv(env.id);
      if (!lease) return null; // a free env exists; this is a transient race
      if (lease.expiresAt <= deadline) return null; // it will expire in time
      holders.push(`${env.id} held by '${lease.holder}' (${lease.kind}, ${Math.round((lease.expiresAt - now()) / 60_000)}m left)`);
    }
    return holders.join('; ');
  }

  /** Queue at capacity WITHOUT holding the pool lock while sleeping. */
  private async acquireEnv(stack: Stack, holder: string, kind: LeaseKind, hygiene: Hygiene, ttlMs: number, holderPid?: number): Promise<EnvRow> {
    const start = now();
    // A holder that already holds this stack's LIVE lease consumes no
    // capacity — rebinding only refreshes it. Sending it through the queue
    // stalled the normal edit-sync-retest loop behind strangers waiting for
    // expiry. Expiry is checked HERE, not just in the sweeper: a lapsed lease
    // survives in the journal until the next sweep, and refreshing that
    // corpse would jump a waiter queued on precisely its expiry. onlyMine
    // keeps the bypass honest: if the lease lapses mid-flight this claims
    // nothing and joins the queue like everyone else.
    const live = this.journal.leaseForHolder(holder, stack.id);
    if (live && live.expiresAt > now()) {
      const env = await this.poolLocked(() => this.tryClaim(stack, holder, kind, hygiene, ttlMs, holderPid, true));
      if (env) return env;
    }
    // FIFO ticket. Without ordering, every waiter polled independently and a
    // freed environment went to whoever happened to poll first — so an early
    // waiter could time out while later arrivals were served.
    const ticket = ++this.waitTicket;
    const queue = this.waiting.get(stack.id) ?? [];
    queue.push(ticket);
    this.waiting.set(stack.id, queue);
    try {
      return await this.acquireQueued(stack, holder, kind, hygiene, ttlMs, start, ticket, holderPid);
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
  ): Promise<EnvRow> {
    for (;;) {
      // Only the head of THIS STACK's queue may claim; everyone else waits.
      const queue = this.waiting.get(stack.id);
      const myTurn = !queue || queue.length === 0 || queue[0] === ticket;
      const env = myTurn ? await this.poolLocked(() => this.tryClaim(stack, holder, kind, hygiene, ttlMs, holderPid)) : null;
      if (env) return env;
      // Refuse to burn the full wait on something that provably cannot resolve.
      const blocked = await this.poolLocked(() => this.structuralCapacityBlock(stack, now() + WAIT_MS()));
      if (blocked) {
        throw new BrokerError(
          'env-error',
          `pool at capacity (${POOL_MAX()}/${POOL_MAX()} for this stack, ${this.journal.allEnvs().length}/${POOL_MAX_TOTAL()} machine-wide) and every environment is leased past the wait window — queueing cannot succeed. Blocking: ${blocked}. ` +
            `A 'run' always takes its own environment, so a session lease plus a run needs BACKLOT_POOL_MAX >= 2 (currently ${POOL_MAX()}). ` +
            `Raise BACKLOT_POOL_MAX, or release the blocking lease first.`,
          'pool',
        );
      }
      if (now() - start > WAIT_MS()) {
        throw new BrokerError('env-error', `pool at capacity (${POOL_MAX()}/${POOL_MAX()}) — waited ${Math.round(WAIT_MS() / 1000)}s; release a lease or raise BACKLOT_POOL_MAX`, 'pool');
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
    const h: DsHandle = { envId: env.id, envTree: dirs.tree, dataDir: dirs.data };
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
        env.id, dirs.tree, dirs.logs,
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

  private async bindAndStart(stack: Stack, envSnapshot: EnvRow, hygiene: Hygiene, kind: LeaseKind, watch: boolean, sourceRoot?: string, onProgress?: Progress): Promise<EnvRow> {
    const say = onProgress ?? (() => undefined);
    // Re-read under the env lock: the snapshot captured during acquire may be
    // stale (a concurrent degrade/pid update landed). Everything below mutates
    // and saves THIS fresh row, so no epilogue can clobber another verb's write.
    const env = this.journal.getEnv(envSnapshot.id) ?? envSnapshot;
    if (env.state === 'recycling') {
      throw new BrokerError('env-error', `environment ${env.id} is being recycled — retry`, 'pool');
    }
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
      await this.supervisor(env).stopAll();
      this.supervisors.delete(env.id);
      rmSync(dirs.tree, { recursive: true, force: true });
      rmSync(dirs.data, { recursive: true, force: true });
      mkdirSync(dirs.tree, { recursive: true });
      mkdirSync(dirs.data, { recursive: true });
      env.fingerprints = {};
      env.presets = {};
      // Persist the cleared ledger NOW, not at the end of the bind. Appliances,
      // sync and upkeep all run before the epilogue, and a crash in any of them
      // used to leave the journal asserting fingerprints and presets for state
      // that no longer exists on disk — so the next bind skipped work it had to
      // redo.
      this.journal.saveEnv(env);
    }

    // Appliances first: shared backing servers must answer before anything
    // else is worth doing. Milliseconds when they're up; a one-time start
    // when they're not (decision 0018). Failures here are infra-errors.
    for (const [name, spec] of Object.entries(stack.manifest.appliances ?? {})) {
      const state = await ensureAppliance(name, spec, stack.root, say);
      if (state !== 'up') logEvent({ level: 'info', kind: 'appliance', detail: `'${name}' ${state} (${spec.probe})` });
    }

    say('syncing worktree');
    // reset-data and pristine mean "clean slate", so they also sweep env-side
    // droppings; a plain reuse bind keeps them (and keeps its build artifacts).
    // On a worker thread: the enumerate/hash/copy of a big bind used to block
    // the daemon's event loop, stalling every concurrent verb behind it.
    const sync = await syncIntoEnvThreaded(sourceRoot ?? stack.root, dirs.tree, stack.manifest, hygiene !== 'reuse');
    say(`synced ${sync.files.length} files (${sync.copied} changed, ${sync.deleted} removed)`);
    if (sync.sweptDroppings > 0) {
      // The sweep removed files no sync produced — possibly the very output
      // (an undeclared node_modules, generated code) the ledger is vouching
      // for. An unverifiable ledger re-runs upkeep rather than booting
      // services against half a tree; declaring the output under caches:
      // keeps both the files and the fast path.
      env.fingerprints = {};
    }
    const upkeep = await runUpkeep(dirs.tree, sync.files, stack.manifest, env.fingerprints);
    // Content-derived template identity (vetbill-1i49): divergent
    // migrations/seeds in this tree yield a different bake key and thus a
    // disjoint template name — two envs of the same stack can no longer
    // silently share a template with the wrong schema.
    const bakeKeys = templateBakeKeys(stack.manifest, dirs.tree, sync.files);
    for (const r of upkeep.ran) say(`upkeep: ${r.run}`);
    for (const dsName of upkeep.rebakeTemplates) {
      const spec = stack.manifest.datastores?.[dsName];
      if (spec) await makeDatastore(dsName, spec, stack.id, bakeKeys[dsName]).rebake(stack.root);
    }

    // Fast path: identical source, services healthy, data untouched -> reuse as-is.
    const unchanged =
      env.fingerprints['@source'] === sync.sourceHash &&
      upkeep.ran.length === 0 &&
      env.state === 'hot' &&
      this.supervisor(env).allHealthyPids() &&
      hygiene === 'reuse';
    env.fingerprints = { ...upkeep.fingerprints };
    if (unchanged) {
      env.fingerprints['@source'] = sync.sourceHash;
      env.lastUsedAt = now();
      // Refresh from the LIVE supervisor before saving. A service that restarted
      // during this bind updated the journal through onPidsChanged, and writing
      // the pre-bind snapshot back put dead pids there — which recovery would
      // later signal, missing the real process.
      env.servicePids = this.supervisor(env).pids();
      this.journal.saveEnv(env);
      return env;
    }

    // Services must not hold open handles across a data restore or code change.
    await this.supervisor(env).stopAll();
    this.supervisors.delete(env.id);

    // Data state: create-or-restore per hygiene (probe first — infra-error, not code blame).
    const dsHandle: DsHandle = { envId: env.id, envTree: dirs.tree, dataDir: dirs.data };
    for (const [name, spec] of Object.entries(stack.manifest.datastores ?? {})) {
      const ds = makeDatastore(name, spec, stack.id, bakeKeys[name]);
      await ds.probe();
      const preset = defaultPreset(spec, kind);
      const exists = Boolean(env.datastoreNs[name]);
      const force = env.presets[name] !== preset || hygiene !== 'reuse' || upkeep.rebakeTemplates.includes(name);
      if (force || !exists) say(`preparing datastore '${name}' (${preset})`);
      await ds.ensure(dsHandle, preset, force, exists);
      env.datastoreNs[name] = ds.ns(dsHandle);
      env.presets[name] = preset;
    }

    // Builds: only when the source actually changed (fingerprint '@source').
    const ctx = this.templateCtx(stack, env);
    if (env.fingerprints['@source'] !== sync.sourceHash) {
      for (const [name, spec] of Object.entries(stack.manifest.services)) {
        const build = spec.build;
        if (!build) continue;
        say(`building '${name}'`);
        const buildStart = now();
        const beat = setInterval(() => say(`building '${name}' … ${Math.round((now() - buildStart) / 1000)}s`), 5000);
        beat.unref();
        try {
          const buildTimeoutS = cmdTimeoutS(LONG_CMD_TIMEOUT_S);
          const r = await runBounded(template(build, ctx), dirs.tree, buildTimeoutS);
          if (r.timedOut) {
            throw new BrokerError('work-error', `build for service '${name}' timed out after ${buildTimeoutS}s (process group killed; set BACKLOT_CMD_TIMEOUT_S if legitimate)`, name, r.output.slice(-800));
          }
          if (r.code !== 0) throw new BrokerError('work-error', `build failed for service '${name}'`, name, r.output.slice(-800));
        } finally {
          clearInterval(beat);
        }
      }
    }
    env.fingerprints['@source'] = sync.sourceHash;

    // Start in dependency order, readiness-gated, fatal-log fast-fail.
    const sup = this.supervisor(env);
    const started = new Set<string>();
    const entries = Object.entries(stack.manifest.services);
    while (started.size < entries.length) {
      const ready = entries.filter(([n, s]) => !started.has(n) && (s.depends_on ?? []).every((d) => started.has(d)));
      if (ready.length === 0) throw new BrokerError('work-error', 'depends_on cycle in backlot.yml', 'manifest');
      for (const [name, spec] of ready) {
        if (spec.port) {
          // The allocation loop at the top of this bind fills every declared
          // port key, so a miss here is a corrupted port ledger — classify it
          // instead of crashing on the undefined a few lines down.
          const port = env.ports[spec.port];
          if (port === undefined) {
            throw new BrokerError('env-error', `environment ${env.id} has no port recorded for service '${name}' — the port ledger is inconsistent; try 'backlot pool recycle'`, name);
          }
          // Grace window: the previous holder may be this env's own just-
          // signalled service still tearing down (SIGTERM handlers, FD
          // flushes). Only after the window is the port genuinely foreign.
          let free = false;
          for (let attempt = 0; attempt < 10 && !(free = await probeFree(port)); attempt++) {
            await new Promise((r) => setTimeout(r, 150));
          }
          if (!free) {
            throw new BrokerError('env-error', `port ${port} for service '${name}' is occupied by a foreign process — try 'backlot pool recycle'`, name);
          }
        }
        // Template the COMMANDS too — ports/urls may ride in the run line itself
        // (e.g. `ng serve --port {{ports.web}}`), not only in env:.
        const resolved = {
          ...spec,
          run: template(spec.run, ctx),
          ...(spec.watch_run ? { watch_run: template(spec.watch_run, ctx) } : {}),
        };
        sup.start(name, resolved, templateEnv(spec.env, ctx), watch);
        const url = spec.port ? `http://localhost:${env.ports[spec.port]}` : undefined;
        say(`starting '${name}', waiting until ready`);
        const readyStart = now();
        const beat = setInterval(() => say(`waiting for '${name}' … ${Math.round((now() - readyStart) / 1000)}s`), 3000);
        beat.unref();
        try {
          await sup.waitReady(name, spec, url, templateEnv(spec.env, ctx));
          clearInterval(beat);
          say(`'${name}' ready`);
        } catch (err) {
          clearInterval(beat);
          const survivors = await sup.stopAll();
          this.supervisors.delete(env.id);
          // Same stale-snapshot rule as the epilogue: preserve a concurrent
          // degrade, and never write back a row that has been recycled away.
          const live = this.journal.getEnv(env.id);
          if (live) {
            live.state = live.state === 'degraded' ? 'degraded' : 'warm';
            live.servicePids = survivors;
            this.journal.saveEnv(live);
          }
          throw err;
        }
        started.add(name);
      }
    }

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
      this.journal.saveEnv({ ...current, servicePids: sup.pids(), lastUsedAt: now() });
      throw new BrokerError('env-error', `environment ${env.id} degraded during bind — a service flapped past its restart budget`, 'pool');
    }
    env.state = 'hot';
    env.servicePids = sup.pids();
    env.bindCount += 1;
    env.lastUsedAt = now();
    env.failStreak = 0; // a successful bind clears the escalation counter
    this.journal.saveEnv(env);
    return env;
  }

  // ---------------------------------------------------------------- watch

  /**
   * --watch: the daemon observes the CONSUMER's worktree (opt-in, per lease)
   * and auto-syncs debounced. The environment's own dev servers then pick up
   * the projected change — two-stage reload. Stopped on release/expiry/
   * quiesce/recycle/shutdown.
   */
  private startWatch(envId: string, stackRoot: string, cwd: string, holder: string): void {
    this.stopWatch(envId);
    let timer: NodeJS.Timeout | null = null;
    let watcher: ReturnType<typeof fsWatch>;
    try {
      watcher = fsWatch(stackRoot, { recursive: true }, (_event, filename) => {
        const f = String(filename ?? '');
        // `.startsWith('.git')` also matched .github/, .gitignore and
        // .gitlab-ci.yml, so edits to CI config and ignore rules never synced
        // under --watch. Match the .git DIRECTORY, not the prefix.
        if (f === '.git' || f.startsWith('.git/') || f.includes('/.git/') || f.startsWith('.backlot')) return;
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
   * One debounced save — the two-stage reload (architecture.md §6). Stage 1
   * projects the changed files into the env tree source-only; stage 2 belongs
   * to the services' own dev watchers (watch_run), so backlot must not bounce
   * services on save.
   *
   * DELIBERATE FALLBACK: a save that changes what an upkeep rule or
   * @rebake-template fingerprints (a lockfile, a migration) cannot be served by
   * projection alone. That save is handed to the ordinary full bind path — the
   * rule runs, the rebake happens, services restart. Restarting is honest
   * there; silently skipping the rule would hand out an environment the
   * manifest itself says is stale.
   */
  private async watchSave(envId: string, cwd: string, holder: string): Promise<void> {
    const outcome = await this.watchProject(envId, cwd, holder);
    if (outcome === 'fallback') {
      // The full bind also covers every state projection can't fix on its own:
      // a quiesced/degraded/recycled-away env, or a lapsed lease that must be
      // re-earned through the ordinary acquire path.
      await this.up({ cwd, holder, kind: 'session', hygiene: 'reuse', watch: true });
    }
  }

  /**
   * Stage 1: source-only projection, under the env lock like every other
   * mutation (the envChains serialization keeps a concurrent manual verb from
   * interleaving). Returns 'fallback' when this save needs the full bind.
   */
  private async watchProject(envId: string, cwd: string, holder: string): Promise<'projected' | 'fallback' | 'skip'> {
    const stack = loadStack(cwd);
    return this.envLocked(envId, async () => {
      const env = this.journal.getEnv(envId);
      // Teardown owns a recycling env and closes its watcher; do nothing.
      if (!env || env.state === 'recycling') return 'skip';
      // Only a LIVE lease still pointing at this env may mutate it from a
      // watch event; anything else re-earns an environment via acquire.
      const lease = this.journal.leaseForHolder(holder, stack.id);
      if (!lease || lease.envId !== envId || lease.expiresAt <= now()) return 'fallback';
      // Same trust conditions as bindAndStart's fast path: hot, all healthy.
      // A quiesced or half-dead env needs services started, not just files.
      if (env.state !== 'hot' || !this.supervisor(env).allHealthyPids()) return 'fallback';

      const dirs = this.envDirs(env.id);
      // The one sync implementation (constraint: no second copy path).
      // cleanUntracked stays FALSE: a watch save must never sweep the env's
      // undeclared build artifacts.
      const sync = await syncIntoEnvThreaded(stack.root, dirs.tree, stack.manifest, false);
      // The fallback decision: would this tree fire any upkeep rule or
      // template rebake? (Same trigger hashes runUpkeep would compare.)
      if (pendingUpkeep(dirs.tree, sync.files, stack.manifest, env.fingerprints).length > 0) {
        return 'fallback';
      }

      // Epilogue on a FRESH row (the onDegraded/onPidsChanged callbacks write
      // concurrently): record the new source identity and the activity.
      const fresh = this.journal.getEnv(env.id);
      if (!fresh || fresh.state !== 'hot') return 'fallback'; // degraded mid-projection
      fresh.fingerprints['@source'] = sync.sourceHash;
      fresh.lastUsedAt = now();
      this.journal.saveEnv(fresh);
      // Watch activity refreshes the lease (§6) — exactly what the old
      // full-bind watch path did via tryClaim's re-save.
      this.journal.saveLease({ ...lease, expiresAt: now() + LEASE_TTL(lease.kind) });
      if (sync.copied > 0 || sync.deleted > 0) {
        logEvent({
          level: 'info', kind: 'watch', envId: env.id,
          detail: `projected ${sync.copied} changed, ${sync.deleted} removed — services kept (two-stage reload)`,
        });
      }
      return 'projected';
    });
  }

  // ---------------------------------------------------------------- verbs

  async up(opts: UpOptions) {
    const stack = loadStack(opts.cwd);
    const holder = opts.holder ?? resolve(opts.cwd);
    const kind = opts.kind ?? 'session';
    let hygiene = opts.hygiene ?? 'reuse';
    opts.onProgress?.(`acquiring an environment (pool ${this.journal.envsForStack(stack.id).length}/${POOL_MAX()})`);
    const env = await this.acquireEnv(stack, holder, kind, hygiene, opts.ttlMs ?? LEASE_TTL(kind), opts.holderPid);
    // Auto-escalation (decision 0007): two consecutive bind failures on this
    // warm environment -> the next bind is pristine, whatever was asked.
    if (hygiene !== 'pristine' && env.failStreak >= 2) hygiene = 'pristine';
    try {
      const bound = await this.envLocked(
        env.id,
        () => this.bindAndStart(stack, env, hygiene, kind, opts.watch ?? false, opts.sourceRoot, opts.onProgress),
        (s) => opts.onProgress?.(`waiting for another operation on this environment … ${s}s`),
      );
      if (opts.watch && kind === 'session' && !this.watchers.has(bound.id)) {
        this.startWatch(bound.id, stack.root, opts.cwd, holder);
      }
      return this.ctx(opts.cwd, holder, bound.id);
    } catch (err) {
      const fresh = this.journal.getEnv(env.id);
      if (fresh) {
        fresh.failStreak += 1;
        this.journal.saveEnv(fresh);
      }
      // A failed bind must not strand the lease for a run; sessions keep theirs to iterate.
      if (kind === 'run') {
        const lease = this.journal.leaseForHolder(holder, stack.id);
        if (lease) this.journal.deleteLease(lease.id);
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
        `your lease points at environment ${lease.envId}, which no longer exists (it was recycled) — run 'backlot up' to bind a fresh one`,
        'lease',
      );
    }
    return env;
  }

  ctx(cwd: string, holder?: string, envId?: string) {
    const stack = loadStack(cwd);
    const h = holder ?? resolve(cwd);
    const lease = this.journal.leaseForHolder(h, stack.id);
    const targetId = envId ?? lease?.envId;
    if (!targetId) {
      throw new BrokerError('env-error', `no active lease for this worktree — run 'backlot up' first`, 'lease');
    }
    const env = this.journal.getEnv(targetId);
    if (!env) {
      throw new BrokerError('env-error', `environment ${targetId} no longer exists (it was recycled) — run 'backlot up' to bind a fresh one`, 'lease');
    }
    this.touch(env.id); // asking for context means an agent is still working here
    const ctx = this.templateCtx(stack, env);
    const urls: Record<string, string> = {};
    for (const [name, s] of Object.entries(ctx.services)) urls[name] = s.url;
    return {
      stack: stack.manifest.name,
      envId: env.id,
      state: env.state,
      lease: lease ? { id: lease.id, kind: lease.kind, hygiene: lease.hygiene, expiresAt: lease.expiresAt } : null,
      urls,
      logins: stack.manifest.auth?.logins ?? null,
      tokenCommand: stack.manifest.auth?.token ?? null,
      datastores: Object.fromEntries(Object.entries(ctx.datastores).map(([n, d]) => [n, { url: d.url, ns: d.ns }])),
      artifactsDir: join(artifactsRoot(), env.id),
      events: this.supervisors.get(env.id)?.events.slice(-20) ?? [],
    };
  }

  async run(opts: UpOptions & { check: string; pull?: boolean }) {
    const stack = loadStack(opts.cwd);
    const check = stack.manifest.checks?.[opts.check];
    if (!check) {
      throw new BrokerError('work-error', `no check '${opts.check}' in backlot.yml (have: ${Object.keys(stack.manifest.checks ?? {}).join(', ') || 'none'})`, 'manifest');
    }
    // A run ALWAYS gets its own ephemeral holder — never the caller's session
    // holder — so `run` can't reset-data-wipe or delete a live `up` session
    // that happens to share a --holder. Its lease is uniquely ours to delete.
    const holder = `run-${shortId()}`;
    const startedAt = now();
    const context = await this.up({ ...opts, holder, kind: 'run', hygiene: opts.hygiene ?? 'reset-data' });
    const env = this.journal.getEnv(context.envId);
    if (!env) {
      // Bound a moment ago, so only a concurrent forced recycle can take it.
      throw new BrokerError('env-error', `environment ${context.envId} was recycled between bind and check — retry the run`, 'pool');
    }
    const dirs = this.envDirs(env.id);
    const ctx = this.templateCtx(stack, env);
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
          check.cwd ? safeJoin(dirs.tree, check.cwd, `check '${opts.check}' cwd`) : dirs.tree,
          { ...process.env, ...templateEnv(check.env, ctx), ...serviceTag(env.id, `check:${opts.check}`, stateRoot()) },
          timeoutS,
        );
        },
        (s) => opts.onProgress?.(`waiting for another operation on this environment … ${s}s`),
      ).finally(() => clearInterval(beat));
      const artifactsDir = this.collectArtifacts(env.id, dirs.tree, check.artifacts ?? []);
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
        outputsChanged: changedOutputs(stack.root, dirs.tree, stack.manifest),
        // The write-back must happen HERE, while the run still holds its own
        // ephemeral lease. Doing it from the CLI afterwards targeted the
        // CALLER's holder — a different environment, or none at all — so
        // `run --pull` either pulled from the wrong lease or silently no-oped.
        pulled: opts.pull ? pullOutputs(stack.root, dirs.tree, stack.manifest) : undefined,
        envId: env.id,
        durationMs: now() - startedAt,
      };
    } finally {
      // Only our own ephemeral run lease — guaranteed kind 'run' — is deleted.
      const lease = this.journal.leaseForHolder(holder, stack.id);
      if (lease && lease.kind === 'run') this.journal.deleteLease(lease.id); // env stays hot in the pool
    }
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

  private collectArtifacts(envId: string, tree: string, patterns: string[]): string | null {
    if (patterns.length === 0) return null;
    const dest = join(artifactsRoot(), envId, `${now()}`);
    const walk = (dir: string, prefix = ''): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === '.git') continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full, rel));
        else out.push(rel);
      }
      return out;
    };
    const matched = walk(tree).filter((f) => matchesAny(f, patterns));
    if (matched.length === 0) return null;
    for (const rel of matched) {
      const dst = join(dest, rel);
      mkdirSync(join(dst, '..'), { recursive: true });
      copyFileSync(join(tree, rel), dst, fsConstants.COPYFILE_FICLONE);
    }
    return dest;
  }

  async syncLease(cwd: string, holder?: string, onProgress?: Progress) {
    // Rebind the existing lease with current hygiene = reuse semantics.
    return this.up({ cwd, holder: holder ?? resolve(cwd), kind: 'session', hygiene: 'reuse', onProgress });
  }

  /** bind --ref: project a COMMITTED ref (not the worktree state) into the env. */
  async bindRef(cwd: string, ref: string, holder?: string) {
    const stack = loadStack(cwd);
    let sha: string;
    try {
      sha = execFileSync('git', ['-C', stack.root, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
    } catch {
      throw new BrokerError('work-error', `'${ref}' is not a commit in this repository`, 'bind');
    }
    const tmp = mkdtempSync(join(tmpdir(), 'backlot-ref-'));
    try {
      // Bounded AND off the sync path for the same reason as the worker: a
      // large archive extraction must not hold the event loop.
      const r = await runBounded(`git -C "${stack.root}" archive ${sha} | tar -x -C "${tmp}"`, stack.root, cmdTimeoutS(LONG_CMD_TIMEOUT_S));
      if (r.timedOut || r.code !== 0) {
        throw new BrokerError('work-error', `git archive of ${sha} failed${r.timedOut ? ' (timed out)' : ''}`, 'bind', r.output.slice(-400));
      }
      return await this.up({ cwd, holder: holder ?? resolve(cwd), kind: 'session', hygiene: 'reuse', sourceRoot: tmp });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  jobList() {
    return { jobs: this.journal.listJobs(20) };
  }

  async resetData(cwd: string, holder?: string, onProgress?: Progress) {
    const stack = loadStack(cwd);
    const h = holder ?? resolve(cwd);
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'backlot up' first`, 'lease');
    this.journal.saveLease({ ...lease, hygiene: 'reset-data', expiresAt: now() + LEASE_TTL(lease.kind) });
    const env = this.envForLease(lease);
    await this.envLocked(
      env.id,
      () => this.bindAndStart(stack, env, 'reset-data', lease.kind, false, undefined, onProgress),
      (s) => onProgress?.(`waiting for another operation on this environment … ${s}s`),
    );
    return this.ctx(cwd, h);
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
    if (fresh.state === 'warm') {
      throw new BrokerError(
        'env-error',
        `environment ${envId} holds your lease but its services are not running (the daemon restarted) — run 'backlot up' to rebind before exec/token`,
        'lease',
      );
    }
    return fresh;
  }

  async exec(cwd: string, cmd: string, holder?: string) {
    const stack = loadStack(cwd);
    const h = holder ?? resolve(cwd);
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'backlot up' first`, 'lease');
    const env = this.envForLease(lease);
    const dirs = this.envDirs(env.id);
    const ctx = this.templateCtx(stack, env);
    const extra: Record<string, string> = { BACKLOT_ENV_ID: env.id };
    for (const [name, port] of Object.entries(env.ports)) extra[`BACKLOT_PORT_${name.toUpperCase()}`] = String(port);
    for (const [name, s] of Object.entries(ctx.services)) extra[`BACKLOT_URL_${name.toUpperCase()}`] = s.url;
    for (const [name, d] of Object.entries(ctx.datastores)) extra[`BACKLOT_DS_${name.toUpperCase()}`] = d.url;
    return this.envLocked(env.id, async () => {
      this.assertUsable(env.id);
      this.touch(env.id);
      // Bounded, detached, and tagged like a check: an exec blocking on stdin
      // held the env's busy bit forever, and its untagged children were
      // invisible to `pool gc` after a daemon crash.
      const timeoutS = cmdTimeoutS(LONG_CMD_TIMEOUT_S);
      const r = await runBoundedIO(cmd, dirs.tree, timeoutS, {
        ...process.env,
        ...extra,
        ...serviceTag(env.id, 'exec', stateRoot()),
      });
      if (r.timedOut) {
        throw new BrokerError('work-error', `exec timed out after ${timeoutS}s (process group killed; set BACKLOT_CMD_TIMEOUT_S if legitimate)`, 'exec', r.stderr.slice(-800));
      }
      return { exitCode: r.code, stdout: r.stdout.slice(-8000), stderr: r.stderr.slice(-8000) };
    });
  }

  /** Resolve auth.token with {{role}} and run it in the env tree. */
  async token(cwd: string, role: string, holder?: string) {
    const stack = loadStack(cwd);
    const spec = stack.manifest.auth?.token;
    if (!spec) throw new BrokerError('work-error', `backlot.yml declares no auth.token command`, 'manifest');
    const lease = this.journal.leaseForHolder(holder ?? resolve(cwd), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'backlot up' first`, 'lease');
    const env = this.envForLease(lease);
    const dirs = this.envDirs(env.id);
    const ctx = { ...this.templateCtx(stack, env), role };
    return this.envLocked(env.id, async () => {
      this.assertUsable(env.id);
      this.touch(env.id);
      const timeoutS = cmdTimeoutS();
      const r = await runBoundedIO(template(spec, ctx), dirs.tree, timeoutS);
      if (r.timedOut) {
        throw new BrokerError('work-error', `auth.token command timed out after ${timeoutS}s (process group killed)`, 'auth', r.stderr.slice(-400));
      }
      if (r.code !== 0) throw new BrokerError('work-error', `auth.token command failed`, 'auth', r.stderr.slice(-400));
      return { token: r.stdout.trim(), role };
    });
  }

  logs(cwd: string, service: string, lines: number, holder?: string) {
    const stack = loadStack(cwd);
    // A name the manifest never declared is the caller's mistake — name the
    // services that exist, the way an unknown check does.
    if (!stack.manifest.services[service]) {
      throw new BrokerError('work-error', `no service '${service}' in backlot.yml (have: ${Object.keys(stack.manifest.services).join(', ')})`, service);
    }
    const lease = this.journal.leaseForHolder(holder ?? resolve(cwd), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'backlot up' first`, 'lease');
    const env = this.envForLease(lease);
    this.touch(env.id);
    const logFile = join(this.envDirs(env.id).logs, `${service}.log`);
    // The log file is created lazily on the first byte of output, so a silent
    // service has none — that is an EMPTY log, not an env-error (BACKLOG P3).
    const content = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
    return { service, lines: content.split('\n').slice(-lines).join('\n') };
  }

  pull(cwd: string, holder?: string) {
    const stack = loadStack(cwd);
    const lease = this.journal.leaseForHolder(holder ?? resolve(cwd), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'backlot up' first`, 'lease');
    const env = this.envForLease(lease);
    this.touch(env.id);
    return { pulled: pullOutputs(stack.root, this.envDirs(env.id).tree, stack.manifest) };
  }

  async release(cwd: string, holder?: string) {
    const stack = loadStack(cwd);
    const lease = this.journal.leaseForHolder(holder ?? resolve(cwd), stack.id);
    if (!lease) return { released: false };
    this.journal.deleteLease(lease.id);
    this.stopWatch(lease.envId);
    return { released: true, envId: lease.envId };
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
      throw new BrokerError('work-error', `no appliance '${name}' in backlot.yml`, 'appliance');
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
    if (!spec) throw new BrokerError('work-error', `no appliance '${name}' in backlot.yml`, 'appliance');
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
        lease,
        idleMs: now() - e.lastUsedAt,
        /** null = the holder never identified itself, so liveness is unknowable. */
        holderAlive,
        /** Why this environment is still holding its services, in one word. */
        heat: e.state === 'hot' ? (now() - e.lastUsedAt > LEASED_IDLE_TTL() ? 'stale' : 'active') : 'cold',
      };
    });
    return { pid: process.pid, envs, poolMax: POOL_MAX(), poolMaxTotal: POOL_MAX_TOTAL(), events: recentEvents(15) };
  }

  /**
   * doctor: actively check for the failure shapes the review surfaced —
   * orphaned ports, journal/reality pid divergence, envs stuck recycling.
   */
  async doctor() {
    const issues: Array<{ level: string; envId?: string; issue: string }> = [];
    for (const env of this.journal.allEnvs()) {
      if (env.state === 'recycling') issues.push({ level: 'warn', envId: env.id, issue: 'stuck in recycling (a daemon likely died mid-teardown; restart reconciles)' });
      // Journal says these pids run — are they actually alive, and still ours?
      for (const [svc, rec] of Object.entries(env.servicePids)) {
        if (!isAlive(rec.pid)) {
          issues.push({ level: 'error', envId: env.id, issue: `journal records pid ${rec.pid} for service '${svc}' but it is not running (recovery drift)` });
        } else if (!sameProcess(rec.pid, rec.startTime)) {
          // Alive, but a DIFFERENT process now holds that pid. Signalling it
          // would hit a bystander, so surface it rather than reaping it.
          issues.push({ level: 'error', envId: env.id, issue: `pid ${rec.pid} recorded for service '${svc}' now belongs to another process (pid reuse) — 'backlot pool gc' will re-derive ownership from process tags` });
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
      const orphans = scanTagged(stateRoot()).filter((p) => !liveEnvs.has(p.envId));
      for (const o of orphans) {
        issues.push({ level: 'error', envId: o.envId, issue: `orphaned process ${o.pid} ('${o.service}') is running with no live environment — run 'backlot pool gc' to reclaim it` });
      }
    }
    logEvent({ level: issues.length ? 'warn' : 'info', kind: 'doctor', detail: `${issues.length} issue(s)` });
    return { ok: issues.length === 0, issues, events: recentEvents(20) };
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

  /** Slow teardown of an already-claimed ('recycling') env. */
  private async teardownClaimed(env: EnvRow): Promise<void> {
    this.stopWatch(env.id);
    const survivors = await this.supervisor(env).stopAll();
    this.supervisors.delete(env.id);
    // After a daemon restart the in-memory supervisor is EMPTY, so stopAll is a
    // no-op and only the journal knows what is still running. Reap those too,
    // or teardown deletes the row and the processes become unattributable
    // except by tag.
    const recorded = this.journal.getEnv(env.id)?.servicePids ?? env.servicePids;
    const stillRecorded = Object.keys(recorded).length > 0 ? await reapPids(recorded) : {};
    const unresolved = { ...survivors, ...stillRecorded };
    if (Object.keys(unresolved).length > 0) {
      logEvent({
        level: 'warn',
        kind: 'teardown',
        envId: env.id,
        detail: `${Object.keys(unresolved).length} service process(es) outlived teardown — 'backlot pool gc' reclaims them by tag`,
      });
    }
    // Drop server-side namespaces too (best effort — the manifest may be gone).
    try {
      const stack = loadStack(env.stackRoot);
      const dirs = this.envDirs(env.id);
      const h: DsHandle = { envId: env.id, envTree: dirs.tree, dataDir: dirs.data };
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
    rmSync(env.root, { recursive: true, force: true });
    this.journal.deleteEnv(env.id);
    this.envChains.delete(env.id); // don't leak a settled chain for a dead id
  }

  private async recycleOne(envId: string, force: boolean): Promise<boolean> {
    const claimed = await this.claimForTeardown(envId, force);
    if (!claimed) return false;
    await this.teardownClaimed(claimed);
    return true;
  }

  async poolRecycle(all: boolean) {
    const recycled: string[] = [];
    for (const env of this.journal.allEnvs()) {
      if (await this.recycleOne(env.id, all)) recycled.push(env.id);
    }
    logEvent({ level: 'info', kind: 'pool-recycle', detail: `recycled ${recycled.length} env(s)${all ? ' (--all)' : ''}` });
    return { recycled };
  }

  /** Reap the provably-dead (degraded) envs now, instead of waiting for the sweep. */
  async poolReconcile() {
    const reaped: string[] = [];
    for (const env of this.journal.allEnvs()) {
      if (env.state === 'degraded' && (await this.recycleOne(env.id, true))) reaped.push(env.id);
    }
    logEvent({ level: 'info', kind: 'pool-reconcile', detail: `reaped ${reaped.length} degraded env(s)` });
    return { reaped };
  }

  // ---------------------------------------------------------------- sweeper

  async sweep(): Promise<void> {
    const t = now();
    const gap = t - this.lastSweep;
    const interval = Number(process.env.BACKLOT_SWEEP_MS ?? 15_000);
    // Sleep pardon (decision 0009). A long gap in wall-clock time can mean the
    // machine suspended — or merely that the event loop was starved (a
    // synchronous hash of a huge tree, heavy host load). Pardoning the second
    // case pushes every lease and idle deadline out for a machine that never
    // slept, so leases outlive their TTL and idle envs keep their memory.
    //
    // performance.now() is MONOTONIC and does not advance while suspended, so
    // wall-clock advancing far beyond it is the signal that distinguishes them.
    const monoGap = performance.now() - this.lastSweepMono;
    this.lastSweepMono = performance.now();
    const suspended = gap - monoGap > 2 * interval;
    if (gap > 3 * interval && suspended) this.journal.pardon(gap - interval);
    this.lastSweep = t;

    // Orphan reclaim (~1 min cadence): a consumer that died ungracefully can
    // strand a dev-server between daemon restarts, and each one is ~1 GB. Far
    // cheaper than a /proc scan every sweep, far sooner than the next restart.
    if (t - this.lastGc > Number(process.env.BACKLOT_GC_MS ?? 60_000)) {
      this.lastGc = t;
      try {
        await this.poolGc();
      } catch {
        /* best-effort */
      }
    }

    // Disk retention (~10 min cadence): nothing backlot writes grows forever.
    if (t - this.lastRetention > Number(process.env.BACKLOT_RETENTION_MS ?? 10 * 60_000)) {
      this.lastRetention = t;
      try {
        await retentionSweep(this.journal, policy());
      } catch {
        /* best-effort */
      }
    }

    for (const lease of this.journal.allLeases()) {
      // A lease can name an env row that no longer exists: deleteEnv's two
      // deletes were not one transaction before, so a daemon SIGKILLed
      // between them left exactly this half-state (journals outlive
      // releases, so old torn writes and corruption still can). Nothing
      // resolves it — every read JOINs envs, so the row is invisible to
      // holders yet squats in the journal until its TTL, and pardon() keeps
      // shifting that deadline. Disk is truth: prune the corpse, and say so.
      if (!this.journal.getEnv(lease.envId)) {
        this.journal.deleteLease(lease.id);
        this.stopWatch(lease.envId);
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
      // A holder that named its process and is now gone releases IMMEDIATELY.
      // Waiting out the TTL meant a crashed agent's environment stayed leased —
      // and therefore un-poolable — for up to half an hour.
      if (lease.holderPid !== undefined && !sameProcess(lease.holderPid, lease.holderStart)) {
        this.journal.deleteLease(lease.id);
        this.stopWatch(lease.envId);
        logEvent({
          level: 'info',
          kind: 'lease',
          envId: lease.envId,
          detail: `holder process ${lease.holderPid} is gone — lease released early instead of waiting out its TTL`,
        });
        continue;
      }
      if (lease.expiresAt < now()) {
        this.journal.deleteLease(lease.id);
        this.stopWatch(lease.envId);
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
            const currentId = loadStack(env.stackRoot).id;
            if (currentId !== env.stack) orphanReason = `stack root ${env.stackRoot} now resolves to '${currentId}', not '${env.stack}'`;
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
          this.supervisors.delete(env.id);
          const post = this.journal.getEnv(env.id);
          if (post) {
            post.state = 'warm';
            // Anything that outlived SIGKILL stays recorded, so the next gc pass
            // (or a later restart) can still find it instead of losing it.
            post.servicePids = survivors;
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
        });
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.watchers.keys()]) this.stopWatch(id);
    const survivors = new Map<string, Record<string, ServicePid>>();
    for (const [id, sup] of this.supervisors) survivors.set(id, await sup.stopAll());
    for (const env of this.journal.allEnvs()) {
      if (env.state === 'hot') {
        env.state = 'warm';
        // Record, never assume: a service that survived our own SIGKILL must
        // remain findable by the next daemon life.
        env.servicePids = survivors.get(env.id) ?? {};
        this.journal.saveEnv(env);
      }
    }
  }
}

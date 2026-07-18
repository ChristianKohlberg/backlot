/**
 * The engine: pool + lease + bind + run orchestration, owning all policy
 * (drivers own transport/storage; the manifest owns repo knowledge).
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdirSync, rmSync, copyFileSync, readdirSync, statSync, existsSync, readFileSync, watch as fsWatch, constants as fsConstants } from 'node:fs';
import { join, resolve } from 'node:path';
import { Journal, type EnvRow } from '../core/journal.js';
import { loadStack, defaultPreset, type Stack } from '../core/manifest.js';
import { syncIntoEnv, changedOutputs, pullOutputs } from '../core/sync.js';
import { runUpkeep, templateBakeKeys } from '../core/upkeep.js';
import { freePort, probeFree } from '../core/ports.js';
import { envsRoot, artifactsRoot, stateRoot } from '../core/paths.js';
import { BrokerError, template, templateEnv, now, shortId, matchesAny, safeJoin } from '../core/util.js';
import { makeDatastore, type DsHandle } from '../drivers/datastores.js';
import { ensureAppliance, stopAppliance, probeTcp } from '../drivers/appliances.js';
import { EnvSupervisor, killGroupVerified, reapPids } from './supervisor.js';
import { isAlive, procScanSupported, sameProcess, scanTagged, serviceTag } from '../core/procscan.js';
import { policy } from '../core/policy.js';
import { retentionSweep } from '../core/retention.js';
import { logEvent, recentEvents } from '../core/events.js';
import type { Hygiene, LeaseKind, ServicePid } from '../core/types.js';

const POOL_MAX = () => policy().poolMax;
const LEASE_TTL = (kind: LeaseKind) => (kind === 'session' ? policy().sessionTtlMs : policy().runTtlMs);
const IDLE_TTL = () => policy().idleTtlMs;
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
    proc.stdout!.on('data', (d) => (out = (out + d.toString()).slice(-8000)));
    proc.stderr!.on('data', (d) => (out = (out + d.toString()).slice(-8000)));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-proc.pid!, 'SIGKILL'); // the whole group
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

export class Engine {
  readonly journal = new Journal();
  private supervisors = new Map<string, EnvSupervisor>();
  private lastSweep = now();
  private lastRetention = now();
  private lastGc = now();

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

  private envLocked<T>(envId: string, fn: () => Promise<T>): Promise<T> {
    const chain = this.envChains.get(envId) ?? Promise.resolve();
    const next = chain.then(
      async () => {
        this.busy.add(envId);
        try {
          return await fn();
        } finally {
          this.busy.delete(envId);
        }
      },
      async () => {
        this.busy.add(envId);
        try {
          return await fn();
        } finally {
          this.busy.delete(envId);
        }
      },
    );
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
      // A 'recycling' env from a crashed daemon never finished teardown — finish it.
      if (env.state === 'recycling') {
        void this.teardownClaimed(env).catch(() => undefined);
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
    const ports: Record<string, number> = {};
    for (const [, spec] of Object.entries(stack.manifest.services)) {
      if (spec.port && !(spec.port in ports)) ports[spec.port] = await freePort();
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
  private async tryClaim(stack: Stack, holder: string, kind: LeaseKind, hygiene: Hygiene, ttlMs: number): Promise<EnvRow | null> {
    // A holder keeps its env: rebinding your own lease is the normal loop —
    // unless that env is being torn down or has flapped, in which case drop the
    // stale lease and fall through to a fresh claim.
    const mine = this.journal.leaseForHolder(holder, stack.id);
    if (mine) {
      const env = this.journal.getEnv(mine.envId);
      if (env && env.state !== 'recycling' && env.state !== 'degraded') {
        this.journal.saveLease({ ...mine, hygiene, expiresAt: now() + ttlMs });
        return env;
      }
      this.journal.deleteLease(mine.id);
    }
    const envs = this.journal.envsForStack(stack.id);
    const free = envs
      .filter((e) => !this.journal.leaseForEnv(e.id) && e.state !== 'degraded' && e.state !== 'recycling')
      .sort((a, b) => (a.state === 'hot' ? -1 : 1) - (b.state === 'hot' ? -1 : 1));
    let env = free[0];
    if (!env && envs.length < POOL_MAX()) env = await this.createEnv(stack);
    if (env) {
      this.journal.saveLease({ id: `l-${shortId()}`, envId: env.id, kind, holder, hygiene, expiresAt: now() + ttlMs });
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
    if (envs.length < POOL_MAX()) return null; // room to grow
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
  private async acquireEnv(stack: Stack, holder: string, kind: LeaseKind, hygiene: Hygiene, ttlMs: number): Promise<EnvRow> {
    const start = now();
    for (;;) {
      const env = await this.poolLocked(() => this.tryClaim(stack, holder, kind, hygiene, ttlMs));
      if (env) return env;
      // Refuse to burn the full wait on something that provably cannot resolve.
      const blocked = await this.poolLocked(() => this.structuralCapacityBlock(stack, now() + WAIT_MS()));
      if (blocked) {
        throw new BrokerError(
          'env-error',
          `pool at capacity (${POOL_MAX()}/${POOL_MAX()}) and every environment is leased past the wait window — queueing cannot succeed. Blocking: ${blocked}. ` +
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
    const sync = syncIntoEnv(sourceRoot ?? stack.root, dirs.tree, stack.manifest, hygiene !== 'reuse');
    say(`synced ${sync.files.length} files (${sync.copied} changed, ${sync.deleted} removed)`);
    const upkeep = await runUpkeep(dirs.tree, sync.files, stack.manifest, env.fingerprints);
    // Content-derived template identity (vetbill-1i49): divergent
    // migrations/seeds in this tree yield a different bake key and thus a
    // disjoint template name — two envs of the same stack can no longer
    // silently share a template with the wrong schema.
    const bakeKeys = templateBakeKeys(stack.manifest, dirs.tree, sync.files);
    for (const r of upkeep.ran) say(`upkeep: ${r.run}`);
    for (const dsName of upkeep.rebakeTemplates) {
      const spec = stack.manifest.datastores?.[dsName];
      if (spec) await makeDatastore(dsName, spec, stack.id, bakeKeys[dsName]).rebake();
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
        if (!spec.build) continue;
        say(`building '${name}'`);
        const buildStart = now();
        const beat = setInterval(() => say(`building '${name}' … ${Math.round((now() - buildStart) / 1000)}s`), 5000);
        beat.unref();
        try {
          await new Promise<void>((resolvePromise, reject) => {
            execFile('sh', ['-c', template(spec.build!, ctx)], { cwd: dirs.tree, maxBuffer: 32 * 1024 * 1024 }, (err, _o, stderr) => {
              if (err) reject(new BrokerError('work-error', `build failed for service '${name}'`, name, String(stderr).slice(0, 800)));
              else resolvePromise();
            });
          });
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
      if (ready.length === 0) throw new BrokerError('work-error', 'depends_on cycle in stack.yaml', 'manifest');
      for (const [name, spec] of ready) {
        if (spec.port) {
          const port = env.ports[spec.port]!;
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
        if (f.startsWith('.git') || f.includes('/.git/') || f.startsWith('.backlot')) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void this.up({ cwd, holder, kind: 'session', hygiene: 'reuse', watch: true }).catch(() => {
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

  // ---------------------------------------------------------------- verbs

  async up(opts: UpOptions) {
    const stack = loadStack(opts.cwd);
    const holder = opts.holder ?? resolve(opts.cwd);
    const kind = opts.kind ?? 'session';
    let hygiene = opts.hygiene ?? 'reuse';
    opts.onProgress?.(`acquiring an environment (pool ${this.journal.envsForStack(stack.id).length}/${POOL_MAX()})`);
    const env = await this.acquireEnv(stack, holder, kind, hygiene, opts.ttlMs ?? LEASE_TTL(kind));
    // Auto-escalation (decision 0007): two consecutive bind failures on this
    // warm environment -> the next bind is pristine, whatever was asked.
    if (hygiene !== 'pristine' && env.failStreak >= 2) hygiene = 'pristine';
    try {
      const bound = await this.envLocked(env.id, () => this.bindAndStart(stack, env, hygiene, kind, opts.watch ?? false, opts.sourceRoot, opts.onProgress));
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

  ctx(cwd: string, holder?: string, envId?: string) {
    const stack = loadStack(cwd);
    const h = holder ?? resolve(cwd);
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease && !envId) {
      throw new BrokerError('env-error', `no active lease for this worktree — run 'backlot up' first`, 'lease');
    }
    const env = this.journal.getEnv(envId ?? lease!.envId)!;
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

  async run(opts: UpOptions & { check: string }) {
    const stack = loadStack(opts.cwd);
    const check = stack.manifest.checks?.[opts.check];
    if (!check) {
      throw new BrokerError('work-error', `no check '${opts.check}' in stack.yaml (have: ${Object.keys(stack.manifest.checks ?? {}).join(', ') || 'none'})`, 'manifest');
    }
    // A run ALWAYS gets its own ephemeral holder — never the caller's session
    // holder — so `run` can't reset-data-wipe or delete a live `up` session
    // that happens to share a --holder. Its lease is uniquely ours to delete.
    const holder = `run-${shortId()}`;
    const startedAt = now();
    const context = await this.up({ ...opts, holder, kind: 'run', hygiene: opts.hygiene ?? 'reset-data' });
    const env = this.journal.getEnv(context.envId)!;
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
      const res = await this.envLocked(env.id, () => {
        this.assertUsable(env.id);
        return runGroupCmd(
          template(check.run, ctx),
          check.cwd ? safeJoin(dirs.tree, check.cwd, `check '${opts.check}' cwd`) : dirs.tree,
          { ...process.env, ...templateEnv(check.env, ctx), ...serviceTag(env.id, `check:${opts.check}`, stateRoot()) },
          timeoutS,
        );
      }).finally(() => clearInterval(beat));
      const artifactsDir = this.collectArtifacts(env.id, dirs.tree, check.artifacts ?? []);
      return {
        check: opts.check,
        ok: res.exitCode === 0 && !res.timedOut,
        exitCode: res.timedOut ? -1 : res.exitCode,
        failure:
          res.exitCode === 0 && !res.timedOut
            ? null
            : res.timedOut
              ? { class: 'work-error', message: `check '${opts.check}' timed out after ${timeoutS}s (process group killed; raise checks.${opts.check}.timeout if legitimate)`, logExcerpt: res.output.slice(-800) }
              : { class: 'work-error', message: `check '${opts.check}' failed (exit ${res.exitCode})`, logExcerpt: res.output.slice(-800) },
        output: res.output,
        artifactsDir,
        outputsChanged: changedOutputs(stack.root, dirs.tree, stack.manifest),
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
      execFileSync('sh', ['-c', `git -C "${stack.root}" archive ${sha} | tar -x -C "${tmp}"`]);
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
    const env = this.journal.getEnv(lease.envId)!;
    await this.envLocked(env.id, () => this.bindAndStart(stack, env, 'reset-data', lease.kind, false, undefined, onProgress));
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
  private assertUsable(envId: string): EnvRow {
    const fresh = this.journal.getEnv(envId);
    if (!fresh || fresh.state === 'recycling') {
      throw new BrokerError('env-error', `environment ${envId} is being recycled — retry`, 'pool');
    }
    return fresh;
  }

  async exec(cwd: string, cmd: string, holder?: string) {
    const stack = loadStack(cwd);
    const h = holder ?? resolve(cwd);
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'backlot up' first`, 'lease');
    const env = this.journal.getEnv(lease.envId)!;
    const dirs = this.envDirs(env.id);
    const ctx = this.templateCtx(stack, env);
    const extra: Record<string, string> = { BACKLOT_ENV_ID: env.id };
    for (const [name, port] of Object.entries(env.ports)) extra[`BACKLOT_PORT_${name.toUpperCase()}`] = String(port);
    for (const [name, s] of Object.entries(ctx.services)) extra[`BACKLOT_URL_${name.toUpperCase()}`] = s.url;
    for (const [name, d] of Object.entries(ctx.datastores)) extra[`BACKLOT_DS_${name.toUpperCase()}`] = d.url;
    return this.envLocked(env.id, () => {
      this.assertUsable(env.id);
      return new Promise((resolvePromise) => {
        execFile('sh', ['-c', cmd], { cwd: dirs.tree, env: { ...process.env, ...extra }, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
          resolvePromise({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout).slice(-8000), stderr: String(stderr).slice(-8000) }),
        );
      });
    });
  }

  /** Resolve auth.token with {{role}} and run it in the env tree. */
  async token(cwd: string, role: string, holder?: string) {
    const stack = loadStack(cwd);
    const spec = stack.manifest.auth?.token;
    if (!spec) throw new BrokerError('work-error', `stack.yaml declares no auth.token command`, 'manifest');
    const lease = this.journal.leaseForHolder(holder ?? resolve(cwd), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'backlot up' first`, 'lease');
    const env = this.journal.getEnv(lease.envId)!;
    const dirs = this.envDirs(env.id);
    const ctx = { ...this.templateCtx(stack, env), role };
    return this.envLocked(env.id, () => {
      this.assertUsable(env.id);
      return new Promise((resolvePromise, reject) => {
        execFile('sh', ['-c', template(spec, ctx)], { cwd: dirs.tree, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) reject(new BrokerError('work-error', `auth.token command failed`, 'auth', String(stderr).slice(0, 400)));
          else resolvePromise({ token: String(stdout).trim(), role });
        });
      });
    });
  }

  logs(cwd: string, service: string, lines: number, holder?: string) {
    const stack = loadStack(cwd);
    const lease = this.journal.leaseForHolder(holder ?? resolve(cwd), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'backlot up' first`, 'lease');
    const env = this.journal.getEnv(lease.envId)!;
    const logFile = join(this.envDirs(env.id).logs, `${service}.log`);
    if (!existsSync(logFile)) throw new BrokerError('env-error', `no logs for service '${service}'`, service);
    const content = readFileSync(logFile, 'utf8');
    return { service, lines: content.split('\n').slice(-lines).join('\n') };
  }

  pull(cwd: string, holder?: string) {
    const stack = loadStack(cwd);
    const lease = this.journal.leaseForHolder(holder ?? resolve(cwd), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'backlot up' first`, 'lease');
    const env = this.journal.getEnv(lease.envId)!;
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
      throw new BrokerError('work-error', `no appliance '${name}' in stack.yaml`, 'appliance');
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
    if (!spec) throw new BrokerError('work-error', `no appliance '${name}' in stack.yaml`, 'appliance');
    await stopAppliance(name, spec, stack.root);
    logEvent({ level: 'info', kind: 'appliance', detail: `'${name}' stopped (${spec.probe})` });
    return { stopped: name };
  }

  status() {
    const envs = this.journal.allEnvs().map((e) => ({
      id: e.id, stack: e.stack, state: e.state, ports: e.ports, bindCount: e.bindCount,
      lease: this.journal.leaseForEnv(e.id) ?? null,
      idleMs: now() - e.lastUsedAt,
    }));
    return { pid: process.pid, envs, poolMax: POOL_MAX(), events: recentEvents(15) };
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
        if (env.datastoreNs[name]) await makeDatastore(name, spec, stack.id).drop(h);
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
    if (gap > 3 * interval) this.journal.pardon(gap - interval); // sleep pardon (decision 0009)
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
      // Never expire a lease whose env has an operation in flight (a long bind
      // under a tiny TTL must not lose its env mid-bind).
      if (lease.expiresAt < now() && !this.busy.has(lease.envId)) {
        this.journal.deleteLease(lease.id);
        this.stopWatch(lease.envId);
      }
    }
    for (const env of this.journal.allEnvs()) {
      if (this.busy.has(env.id)) continue;
      if (env.state === 'degraded') {
        // Dead env — reap regardless of a stale lease (force), but never while an
        // op is in flight (claimForTeardown always respects busy). The holder's
        // stale lease is dropped with the env; its next `up` gets a fresh one.
        await this.recycleOne(env.id, true);
        continue;
      }
      if (env.state === 'hot' && !this.journal.leaseForEnv(env.id) && now() - env.lastUsedAt > IDLE_TTL()) {
        // Claim under the pool lock so a concurrent bind can't lease this env
        // between the idle check and the service kill (dead-URL race).
        const claimed = await this.claimForTeardown(env.id, false);
        if (!claimed) continue;
        this.stopWatch(env.id);
        const survivors = await this.supervisor(claimed).stopAll();
        this.supervisors.delete(env.id);
        const fresh = this.journal.getEnv(env.id);
        if (fresh) {
          fresh.state = 'warm';
          // Anything that outlived SIGKILL stays recorded, so the next gc pass
          // (or a later restart) can still find it instead of losing it.
          fresh.servicePids = survivors;
          this.journal.saveEnv(fresh);
        }
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

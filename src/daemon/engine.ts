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
import { runUpkeep } from '../core/upkeep.js';
import { freePort, probeFree } from '../core/ports.js';
import { envsRoot, artifactsRoot } from '../core/paths.js';
import { BrokerError, template, templateEnv, now, shortId, matchesAny } from '../core/util.js';
import { makeDatastore, type DsHandle } from '../drivers/datastores.js';
import { EnvSupervisor, reapPids } from './supervisor.js';
import { policy } from '../core/policy.js';
import { retentionSweep } from '../core/retention.js';
import { logEvent, recentEvents } from '../core/events.js';
import type { Hygiene, LeaseKind } from '../core/types.js';

const POOL_MAX = () => policy().poolMax;
const LEASE_TTL = (kind: LeaseKind) => (kind === 'session' ? policy().sessionTtlMs : policy().runTtlMs);
const IDLE_TTL = () => policy().idleTtlMs;
const WAIT_MS = () => policy().waitMs;
const CHECK_TIMEOUT_S = 600;

export interface UpOptions {
  cwd: string;
  holder?: string;
  hygiene?: Hygiene;
  kind?: LeaseKind;
  watch?: boolean;
  ttlMs?: number;
  /** Bind from this directory instead of the worktree (bind --ref extraction). */
  sourceRoot?: string;
}

/**
 * Run a check/exec command as a PROCESS GROUP with a hard timeout — killing
 * only the `sh` wrapper would orphan grandchildren (a hung Playwright would
 * hold the environment busy forever).
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
  recover(): void {
    let envs = 0;
    for (const env of this.journal.allEnvs()) {
      if (Object.keys(env.servicePids).length > 0) reapPids(env.servicePids);
      // A 'recycling' env from a crashed daemon never finished teardown — finish it.
      if (env.state === 'recycling') {
        void this.teardownClaimed(env).catch(() => undefined);
        continue;
      }
      if (env.state === 'hot' || env.state === 'degraded') env.state = 'warm';
      env.servicePids = {};
      this.journal.saveEnv(env);
      envs++;
    }
    const jobs = this.journal.failStaleJobs();
    logEvent({ level: 'info', kind: 'recover', detail: `reconciled ${envs} env(s), ${jobs} stale job(s)` });
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

  /** Queue at capacity WITHOUT holding the pool lock while sleeping. */
  private async acquireEnv(stack: Stack, holder: string, kind: LeaseKind, hygiene: Hygiene, ttlMs: number): Promise<EnvRow> {
    const start = now();
    for (;;) {
      const env = await this.poolLocked(() => this.tryClaim(stack, holder, kind, hygiene, ttlMs));
      if (env) return env;
      if (now() - start > WAIT_MS()) {
        throw new BrokerError('env-error', `pool at capacity (${POOL_MAX()}/${POOL_MAX()}) — waited ${Math.round(WAIT_MS() / 1000)}s; release a lease or raise INFRONT_POOL_MAX`, 'pool');
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

  private async bindAndStart(stack: Stack, envSnapshot: EnvRow, hygiene: Hygiene, kind: LeaseKind, watch: boolean, sourceRoot?: string): Promise<EnvRow> {
    // Re-read under the env lock: the snapshot captured during acquire may be
    // stale (a concurrent degrade/pid update landed). Everything below mutates
    // and saves THIS fresh row, so no epilogue can clobber another verb's write.
    const env = this.journal.getEnv(envSnapshot.id) ?? envSnapshot;
    if (env.state === 'recycling') {
      throw new BrokerError('env-error', `environment ${env.id} is being recycled — retry`, 'pool');
    }
    const dirs = this.envDirs(env.id);
    if (hygiene === 'pristine') {
      await this.supervisor(env).stopAll();
      this.supervisors.delete(env.id);
      rmSync(dirs.tree, { recursive: true, force: true });
      rmSync(dirs.data, { recursive: true, force: true });
      mkdirSync(dirs.tree, { recursive: true });
      mkdirSync(dirs.data, { recursive: true });
      env.fingerprints = {};
      env.presets = {};
    }

    const sync = syncIntoEnv(sourceRoot ?? stack.root, dirs.tree, stack.manifest);
    const upkeep = await runUpkeep(dirs.tree, sync.files, stack.manifest, env.fingerprints);
    for (const dsName of upkeep.rebakeTemplates) {
      const spec = stack.manifest.datastores?.[dsName];
      if (spec) makeDatastore(dsName, spec, stack.id).rebake();
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
      const ds = makeDatastore(name, spec, stack.id);
      await ds.probe();
      const preset = defaultPreset(spec, kind);
      const exists = Boolean(env.datastoreNs[name]);
      const force = env.presets[name] !== preset || hygiene !== 'reuse' || upkeep.rebakeTemplates.includes(name);
      await ds.ensure(dsHandle, preset, force, exists);
      env.datastoreNs[name] = ds.ns(dsHandle);
      env.presets[name] = preset;
    }

    // Builds: only when the source actually changed (fingerprint '@source').
    const ctx = this.templateCtx(stack, env);
    if (env.fingerprints['@source'] !== sync.sourceHash) {
      for (const [name, spec] of Object.entries(stack.manifest.services)) {
        if (!spec.build) continue;
        await new Promise<void>((resolvePromise, reject) => {
          execFile('sh', ['-c', template(spec.build!, ctx)], { cwd: dirs.tree, maxBuffer: 32 * 1024 * 1024 }, (err, _o, stderr) => {
            if (err) reject(new BrokerError('work-error', `build failed for service '${name}'`, name, String(stderr).slice(0, 800)));
            else resolvePromise();
          });
        });
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
          if (!(await probeFree(port))) {
            throw new BrokerError('env-error', `port ${port} for service '${name}' is occupied by a foreign process — try 'infront pool recycle'`, name);
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
        try {
          await sup.waitReady(name, spec, url, templateEnv(spec.env, ctx));
        } catch (err) {
          await sup.stopAll();
          this.supervisors.delete(env.id);
          env.state = 'warm';
          env.servicePids = {};
          this.journal.saveEnv(env);
          throw err;
        }
        started.add(name);
      }
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
        if (f.startsWith('.git') || f.includes('/.git/') || f.startsWith('.infront')) return;
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
    const env = await this.acquireEnv(stack, holder, kind, hygiene, opts.ttlMs ?? LEASE_TTL(kind));
    // Auto-escalation (decision 0007): two consecutive bind failures on this
    // warm environment -> the next bind is pristine, whatever was asked.
    if (hygiene !== 'pristine' && env.failStreak >= 2) hygiene = 'pristine';
    try {
      const bound = await this.envLocked(env.id, () => this.bindAndStart(stack, env, hygiene, kind, opts.watch ?? false, opts.sourceRoot));
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
      throw new BrokerError('env-error', `no active lease for this worktree — run 'infront up' first`, 'lease');
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
      const res = await this.envLocked(env.id, () =>
        runGroupCmd(
          template(check.run, ctx),
          check.cwd ? join(dirs.tree, check.cwd) : dirs.tree,
          { ...process.env, ...templateEnv(check.env, ctx) },
          timeoutS,
        ),
      );
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

  async syncLease(cwd: string, holder?: string) {
    // Rebind the existing lease with current hygiene = reuse semantics.
    return this.up({ cwd, holder: holder ?? resolve(cwd), kind: 'session', hygiene: 'reuse' });
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
    const tmp = mkdtempSync(join(tmpdir(), 'infront-ref-'));
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

  async resetData(cwd: string, holder?: string) {
    const stack = loadStack(cwd);
    const h = holder ?? resolve(cwd);
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'infront up' first`, 'lease');
    this.journal.saveLease({ ...lease, hygiene: 'reset-data', expiresAt: now() + LEASE_TTL(lease.kind) });
    const env = this.journal.getEnv(lease.envId)!;
    await this.envLocked(env.id, () => this.bindAndStart(stack, env, 'reset-data', lease.kind, false));
    return this.ctx(cwd, h);
  }

  async exec(cwd: string, cmd: string, holder?: string) {
    const stack = loadStack(cwd);
    const h = holder ?? resolve(cwd);
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'infront up' first`, 'lease');
    const env = this.journal.getEnv(lease.envId)!;
    const dirs = this.envDirs(env.id);
    const ctx = this.templateCtx(stack, env);
    const extra: Record<string, string> = { INFRONT_ENV_ID: env.id };
    for (const [name, port] of Object.entries(env.ports)) extra[`INFRONT_PORT_${name.toUpperCase()}`] = String(port);
    for (const [name, s] of Object.entries(ctx.services)) extra[`INFRONT_URL_${name.toUpperCase()}`] = s.url;
    for (const [name, d] of Object.entries(ctx.datastores)) extra[`INFRONT_DS_${name.toUpperCase()}`] = d.url;
    return this.envLocked(env.id, () =>
      new Promise((resolvePromise) => {
        execFile('sh', ['-c', cmd], { cwd: dirs.tree, env: { ...process.env, ...extra }, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
          resolvePromise({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout).slice(-8000), stderr: String(stderr).slice(-8000) }),
        );
      }),
    );
  }

  /** Resolve auth.token with {{role}} and run it in the env tree. */
  async token(cwd: string, role: string, holder?: string) {
    const stack = loadStack(cwd);
    const spec = stack.manifest.auth?.token;
    if (!spec) throw new BrokerError('work-error', `stack.yaml declares no auth.token command`, 'manifest');
    const lease = this.journal.leaseForHolder(holder ?? resolve(cwd), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'infront up' first`, 'lease');
    const env = this.journal.getEnv(lease.envId)!;
    const dirs = this.envDirs(env.id);
    const ctx = { ...this.templateCtx(stack, env), role };
    return this.envLocked(env.id, () =>
      new Promise((resolvePromise, reject) => {
        execFile('sh', ['-c', template(spec, ctx)], { cwd: dirs.tree, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) reject(new BrokerError('work-error', `auth.token command failed`, 'auth', String(stderr).slice(0, 400)));
          else resolvePromise({ token: String(stdout).trim(), role });
        });
      }),
    );
  }

  logs(cwd: string, service: string, lines: number, holder?: string) {
    const stack = loadStack(cwd);
    const lease = this.journal.leaseForHolder(holder ?? resolve(cwd), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'infront up' first`, 'lease');
    const env = this.journal.getEnv(lease.envId)!;
    const logFile = join(this.envDirs(env.id).logs, `${service}.log`);
    if (!existsSync(logFile)) throw new BrokerError('env-error', `no logs for service '${service}'`, service);
    const content = readFileSync(logFile, 'utf8');
    return { service, lines: content.split('\n').slice(-lines).join('\n') };
  }

  pull(cwd: string, holder?: string) {
    const stack = loadStack(cwd);
    const lease = this.journal.leaseForHolder(holder ?? resolve(cwd), stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'infront up' first`, 'lease');
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
      // Journal says these pids run — are they actually alive?
      for (const [svc, pid] of Object.entries(env.servicePids)) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
        if (!alive) issues.push({ level: 'error', envId: env.id, issue: `journal records pid ${pid} for service '${svc}' but it is not running (recovery drift)` });
      }
      // (Port liveness is intentionally NOT probed here: a service bound to ::
      // vs a 127.0.0.1 probe gives false positives across IPv4/IPv6 dual-stack.
      // The pid-divergence check above is the reliable "is it alive" signal.)
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
    await this.supervisor(env).stopAll();
    this.supervisors.delete(env.id);
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
    const interval = Number(process.env.INFRONT_SWEEP_MS ?? 15_000);
    if (gap > 3 * interval) this.journal.pardon(gap - interval); // sleep pardon (decision 0009)
    this.lastSweep = t;

    // Disk retention (~10 min cadence): nothing infront writes grows forever.
    if (t - this.lastRetention > Number(process.env.INFRONT_RETENTION_MS ?? 10 * 60_000)) {
      this.lastRetention = t;
      try {
        retentionSweep(this.journal, policy());
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
        await this.supervisor(claimed).stopAll();
        this.supervisors.delete(env.id);
        const fresh = this.journal.getEnv(env.id);
        if (fresh) {
          fresh.state = 'warm';
          fresh.servicePids = {};
          this.journal.saveEnv(fresh);
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.watchers.keys()]) this.stopWatch(id);
    for (const sup of this.supervisors.values()) await sup.stopAll();
    for (const env of this.journal.allEnvs()) {
      if (env.state === 'hot') {
        env.state = 'warm';
        env.servicePids = {};
        this.journal.saveEnv(env);
      }
    }
  }
}

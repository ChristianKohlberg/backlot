/**
 * The engine: pool + lease + bind + run orchestration, owning all policy
 * (drivers own transport/storage; the manifest owns repo knowledge).
 */
import { execFile } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Journal, type EnvRow } from '../core/journal.js';
import { loadStack, defaultPreset, type Stack } from '../core/manifest.js';
import { syncIntoEnv, changedOutputs, pullOutputs } from '../core/sync.js';
import { runUpkeep } from '../core/upkeep.js';
import { freePort, probeFree } from '../core/ports.js';
import { envsRoot, artifactsRoot } from '../core/paths.js';
import { BrokerError, template, templateEnv, now, shortId, matchesAny } from '../core/util.js';
import { makeDatastore } from '../drivers/datastore-sqlite.js';
import { EnvSupervisor, reapPids } from './supervisor.js';
import type { Hygiene, LeaseKind } from '../core/types.js';

const POOL_MAX = () => Number(process.env.INFRONT_POOL_MAX ?? 3);
const LEASE_TTL = (kind: LeaseKind) =>
  Number(process.env.INFRONT_LEASE_TTL_MS ?? (kind === 'session' ? 30 * 60_000 : 10 * 60_000));
const IDLE_TTL = () => Number(process.env.INFRONT_IDLE_TTL_MS ?? 30 * 60_000);
const WAIT_MS = () => Number(process.env.INFRONT_WAIT_MS ?? 60_000);

export interface UpOptions {
  cwd: string;
  holder?: string;
  hygiene?: Hygiene;
  kind?: LeaseKind;
  watch?: boolean;
  ttlMs?: number;
}

export class Engine {
  readonly journal = new Journal();
  private supervisors = new Map<string, EnvSupervisor>();
  private lastSweep = now();

  /** Recovery (decision 0009): reap recorded PIDs from a previous daemon life; hot -> warm. */
  recover(): void {
    for (const env of this.journal.allEnvs()) {
      if (Object.keys(env.servicePids).length > 0) reapPids(env.servicePids);
      if (env.state === 'hot') env.state = 'warm';
      env.servicePids = {};
      this.journal.saveEnv(env);
    }
  }

  // ---------------------------------------------------------------- pool

  private envDirs(id: string) {
    const root = join(envsRoot(), id);
    return { root, tree: join(root, 'tree'), data: join(root, 'data'), logs: join(root, 'logs') };
  }

  private async createEnv(stack: Stack): Promise<EnvRow> {
    const n = this.journal.envsForStack(stack.id).length + 1;
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
      bindCount: 0, createdAt: now(), lastUsedAt: now(), servicePids: {},
    };
    this.journal.saveEnv(env);
    return env;
  }

  private async acquireEnv(stack: Stack, holder: string, kind: LeaseKind, hygiene: Hygiene, ttlMs: number): Promise<EnvRow> {
    const start = now();
    for (;;) {
      // A holder keeps its env: rebinding your own lease is the normal loop.
      const mine = this.journal.leaseForHolder(holder, stack.id);
      if (mine) {
        this.journal.saveLease({ ...mine, hygiene, expiresAt: now() + ttlMs });
        return this.journal.getEnv(mine.envId)!;
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
      if (now() - start > WAIT_MS()) {
        throw new BrokerError('env-error', `pool at capacity (${envs.length}/${POOL_MAX()}) — waited ${Math.round(WAIT_MS() / 1000)}s; release a lease or raise INFRONT_POOL_MAX`, 'pool');
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
    const datastores: Record<string, { url: string }> = {};
    const dirs = this.envDirs(env.id);
    for (const [name, spec] of Object.entries(stack.manifest.datastores ?? {})) {
      datastores[name] = { url: makeDatastore(name, spec, stack.id).url(dirs.data) };
    }
    return { ports: env.ports, services, datastores };
  }

  private supervisor(env: EnvRow): EnvSupervisor {
    let sup = this.supervisors.get(env.id);
    if (!sup) {
      const dirs = this.envDirs(env.id);
      sup = new EnvSupervisor(env.id, dirs.tree, dirs.logs);
      this.supervisors.set(env.id, sup);
    }
    return sup;
  }

  private async bindAndStart(stack: Stack, env: EnvRow, hygiene: Hygiene, kind: LeaseKind, watch: boolean): Promise<EnvRow> {
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

    const sync = syncIntoEnv(stack.root, dirs.tree, stack.manifest);
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

    // Data state: create-or-restore per hygiene.
    for (const [name, spec] of Object.entries(stack.manifest.datastores ?? {})) {
      const ds = makeDatastore(name, spec, stack.id);
      const preset = defaultPreset(spec, kind);
      const missing = !existsSync(ds.url(dirs.data));
      const presetChanged = env.presets[name] !== preset;
      if (missing || presetChanged || hygiene !== 'reuse' || upkeep.rebakeTemplates.includes(name)) {
        const bound = await ds.create(dirs.tree, dirs.data, preset);
        env.datastoreNs[name] = bound.url;
        env.presets[name] = preset;
      }
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
        sup.start(name, spec, templateEnv(spec.env, ctx), watch);
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
    this.journal.saveEnv(env);
    return env;
  }

  // ---------------------------------------------------------------- verbs

  async up(opts: UpOptions) {
    const stack = loadStack(opts.cwd);
    const holder = opts.holder ?? resolve(opts.cwd);
    const kind = opts.kind ?? 'session';
    const hygiene = opts.hygiene ?? 'reuse';
    const env = await this.acquireEnv(stack, holder, kind, hygiene, opts.ttlMs ?? LEASE_TTL(kind));
    try {
      const bound = await this.bindAndStart(stack, env, hygiene, kind, opts.watch ?? false);
      return this.ctx(opts.cwd, holder, bound.id);
    } catch (err) {
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
      datastores: Object.fromEntries(Object.entries(ctx.datastores).map(([n, d]) => [n, { url: d.url }])),
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
    const holder = opts.holder ?? `run-${shortId()}`;
    const startedAt = now();
    const context = await this.up({ ...opts, holder, kind: 'run', hygiene: opts.hygiene ?? 'reset-data' });
    const env = this.journal.getEnv(context.envId)!;
    const dirs = this.envDirs(env.id);
    const ctx = this.templateCtx(stack, env);
    try {
      const res = await new Promise<{ exitCode: number; output: string }>((resolvePromise) => {
        execFile(
          'sh', ['-c', template(check.run, ctx)],
          { cwd: check.cwd ? join(dirs.tree, check.cwd) : dirs.tree, env: { ...process.env, ...templateEnv(check.env, ctx) }, maxBuffer: 32 * 1024 * 1024 },
          (err, stdout, stderr) => resolvePromise({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, output: `${stdout}${stderr}`.slice(-4000) }),
        );
      });
      const artifactsDir = this.collectArtifacts(env.id, dirs.tree, check.artifacts ?? []);
      return {
        check: opts.check,
        ok: res.exitCode === 0,
        exitCode: res.exitCode,
        failure: res.exitCode === 0 ? null : { class: 'work-error', message: `check '${opts.check}' failed (exit ${res.exitCode})`, logExcerpt: res.output.slice(-800) },
        output: res.output,
        artifactsDir,
        outputsChanged: changedOutputs(stack.root, dirs.tree, stack.manifest),
        envId: env.id,
        durationMs: now() - startedAt,
      };
    } finally {
      const lease = this.journal.leaseForHolder(holder, stack.id);
      if (lease) this.journal.deleteLease(lease.id); // env stays hot in the pool
    }
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
      copyFileSync(join(tree, rel), dst);
    }
    return dest;
  }

  async syncLease(cwd: string, holder?: string) {
    // Rebind the existing lease with current hygiene = reuse semantics.
    return this.up({ cwd, holder: holder ?? resolve(cwd), kind: 'session', hygiene: 'reuse' });
  }

  async resetData(cwd: string, holder?: string) {
    const stack = loadStack(cwd);
    const h = holder ?? resolve(cwd);
    const lease = this.journal.leaseForHolder(h, stack.id);
    if (!lease) throw new BrokerError('env-error', `no active lease — run 'infront up' first`, 'lease');
    this.journal.saveLease({ ...lease, hygiene: 'reset-data', expiresAt: now() + LEASE_TTL(lease.kind) });
    const env = this.journal.getEnv(lease.envId)!;
    await this.bindAndStart(stack, env, 'reset-data', lease.kind, false);
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
    return new Promise((resolvePromise) => {
      execFile('sh', ['-c', cmd], { cwd: dirs.tree, env: { ...process.env, ...extra }, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
        resolvePromise({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout).slice(-8000), stderr: String(stderr).slice(-8000) }),
      );
    });
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
    return { released: true, envId: lease.envId };
  }

  status() {
    const envs = this.journal.allEnvs().map((e) => ({
      id: e.id, stack: e.stack, state: e.state, ports: e.ports, bindCount: e.bindCount,
      lease: this.journal.leaseForEnv(e.id) ?? null,
      idleMs: now() - e.lastUsedAt,
    }));
    return { pid: process.pid, envs, poolMax: POOL_MAX() };
  }

  async poolRecycle(all: boolean) {
    const recycled: string[] = [];
    for (const env of this.journal.allEnvs()) {
      const leased = this.journal.leaseForEnv(env.id);
      if (leased && !all) continue;
      await this.supervisor(env).stopAll();
      this.supervisors.delete(env.id);
      rmSync(env.root, { recursive: true, force: true });
      this.journal.deleteEnv(env.id);
      recycled.push(env.id);
    }
    return { recycled };
  }

  // ---------------------------------------------------------------- sweeper

  async sweep(): Promise<void> {
    const t = now();
    const gap = t - this.lastSweep;
    const interval = Number(process.env.INFRONT_SWEEP_MS ?? 15_000);
    if (gap > 3 * interval) this.journal.pardon(gap - interval); // sleep pardon (decision 0009)
    this.lastSweep = t;

    for (const lease of this.journal.allLeases()) {
      if (lease.expiresAt < now()) this.journal.deleteLease(lease.id); // env returns to pool WARM-hot
    }
    for (const env of this.journal.allEnvs()) {
      if (env.state === 'hot' && !this.journal.leaseForEnv(env.id) && now() - env.lastUsedAt > IDLE_TTL()) {
        await this.supervisor(env).stopAll();
        this.supervisors.delete(env.id);
        env.state = 'warm';
        env.servicePids = {};
        this.journal.saveEnv(env);
      }
    }
  }

  async shutdown(): Promise<void> {
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

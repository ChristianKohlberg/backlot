/**
 * The per-machine journal: disk is truth, daemon memory is a cache
 * (decision 0009). node:sqlite — zero native deps.
 */
import { DatabaseSync } from 'node:sqlite';
import { journalPath } from './paths.js';
import type { EnvState, Hygiene, LeaseKind } from './types.js';

export interface EnvRow {
  id: string;
  stack: string;
  stackRoot: string;
  state: EnvState;
  root: string;
  ports: Record<string, number>;
  datastoreNs: Record<string, string>;
  fingerprints: Record<string, string>;
  presets: Record<string, string>;
  bindCount: number;
  createdAt: number;
  lastUsedAt: number;
  servicePids: Record<string, number>;
  /** Consecutive bind failures — >= 2 auto-escalates the next bind to pristine (decision 0007). */
  failStreak: number;
}

export interface LeaseRow {
  id: string;
  envId: string;
  kind: LeaseKind;
  holder: string;
  hygiene: Hygiene;
  expiresAt: number;
}

export class Journal {
  private db: DatabaseSync;

  constructor(path = journalPath()) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS envs (
        id TEXT PRIMARY KEY, stack TEXT NOT NULL, stack_root TEXT NOT NULL,
        state TEXT NOT NULL, root TEXT NOT NULL,
        ports TEXT NOT NULL DEFAULT '{}', datastore_ns TEXT NOT NULL DEFAULT '{}',
        fingerprints TEXT NOT NULL DEFAULT '{}', presets TEXT NOT NULL DEFAULT '{}',
        bind_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
        service_pids TEXT NOT NULL DEFAULT '{}',
        fail_streak INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY, env_id TEXT NOT NULL, kind TEXT NOT NULL,
        holder TEXT NOT NULL, hygiene TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, stack_cwd TEXT NOT NULL, check_name TEXT NOT NULL,
        state TEXT NOT NULL, verdict TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
      );
    `);
    // Migration for journals created before fail_streak existed.
    try {
      this.db.exec("ALTER TABLE envs ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already exists */
    }
  }

  private rowToEnv(r: Record<string, unknown>): EnvRow {
    return {
      id: r.id as string,
      stack: r.stack as string,
      stackRoot: r.stack_root as string,
      state: r.state as EnvState,
      root: r.root as string,
      ports: JSON.parse(r.ports as string),
      datastoreNs: JSON.parse(r.datastore_ns as string),
      fingerprints: JSON.parse(r.fingerprints as string),
      presets: JSON.parse(r.presets as string),
      bindCount: r.bind_count as number,
      createdAt: r.created_at as number,
      lastUsedAt: r.last_used_at as number,
      servicePids: JSON.parse(r.service_pids as string),
      failStreak: (r.fail_streak as number) ?? 0,
    };
  }

  saveEnv(e: EnvRow): void {
    this.db
      .prepare(
        `INSERT INTO envs (id, stack, stack_root, state, root, ports, datastore_ns, fingerprints, presets, bind_count, created_at, last_used_at, service_pids, fail_streak)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, ports=excluded.ports,
           datastore_ns=excluded.datastore_ns, fingerprints=excluded.fingerprints,
           presets=excluded.presets, bind_count=excluded.bind_count,
           last_used_at=excluded.last_used_at, service_pids=excluded.service_pids,
           fail_streak=excluded.fail_streak`,
      )
      .run(
        e.id, e.stack, e.stackRoot, e.state, e.root,
        JSON.stringify(e.ports), JSON.stringify(e.datastoreNs), JSON.stringify(e.fingerprints),
        JSON.stringify(e.presets), e.bindCount, e.createdAt, e.lastUsedAt, JSON.stringify(e.servicePids),
        e.failStreak,
      );
  }

  getEnv(id: string): EnvRow | undefined {
    const r = this.db.prepare('SELECT * FROM envs WHERE id = ?').get(id);
    return r ? this.rowToEnv(r as Record<string, unknown>) : undefined;
  }

  envsForStack(stack: string): EnvRow[] {
    return (this.db.prepare('SELECT * FROM envs WHERE stack = ? ORDER BY id').all(stack) as Record<string, unknown>[]).map(
      (r) => this.rowToEnv(r),
    );
  }

  allEnvs(): EnvRow[] {
    return (this.db.prepare('SELECT * FROM envs ORDER BY id').all() as Record<string, unknown>[]).map((r) =>
      this.rowToEnv(r),
    );
  }

  deleteEnv(id: string): void {
    this.db.prepare('DELETE FROM envs WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM leases WHERE env_id = ?').run(id);
  }

  saveLease(l: LeaseRow): void {
    this.db
      .prepare(
        `INSERT INTO leases (id, env_id, kind, holder, hygiene, expires_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at, hygiene=excluded.hygiene`,
      )
      .run(l.id, l.envId, l.kind, l.holder, l.hygiene, l.expiresAt);
  }

  private rowToLease(r: Record<string, unknown>): LeaseRow {
    return {
      id: r.id as string,
      envId: r.env_id as string,
      kind: r.kind as LeaseKind,
      holder: r.holder as string,
      hygiene: r.hygiene as Hygiene,
      expiresAt: r.expires_at as number,
    };
  }

  leaseForHolder(holder: string, stack: string): LeaseRow | undefined {
    const r = this.db
      .prepare(
        `SELECT l.* FROM leases l JOIN envs e ON e.id = l.env_id WHERE l.holder = ? AND e.stack = ?`,
      )
      .get(holder, stack);
    return r ? this.rowToLease(r as Record<string, unknown>) : undefined;
  }

  leaseForEnv(envId: string): LeaseRow | undefined {
    const r = this.db.prepare('SELECT * FROM leases WHERE env_id = ?').get(envId);
    return r ? this.rowToLease(r as Record<string, unknown>) : undefined;
  }

  allLeases(): LeaseRow[] {
    return (this.db.prepare('SELECT * FROM leases').all() as Record<string, unknown>[]).map((r) =>
      this.rowToLease(r),
    );
  }

  deleteLease(id: string): void {
    this.db.prepare('DELETE FROM leases WHERE id = ?').run(id);
  }

  saveJob(job: { id: string; stackCwd: string; check: string; state: string; verdict?: unknown; finishedAt?: number }): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, stack_cwd, check_name, state, verdict, created_at, finished_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, verdict=excluded.verdict, finished_at=excluded.finished_at`,
      )
      .run(job.id, job.stackCwd, job.check, job.state, job.verdict ? JSON.stringify(job.verdict) : null, Date.now(), job.finishedAt ?? null);
  }

  getJob(id: string): { id: string; check: string; state: string; verdict: unknown; createdAt: number; finishedAt: number | null } | undefined {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: r.id as string,
      check: r.check_name as string,
      state: r.state as string,
      verdict: r.verdict ? JSON.parse(r.verdict as string) : null,
      createdAt: r.created_at as number,
      finishedAt: (r.finished_at as number) ?? null,
    };
  }

  /** Shift every deadline by `ms` — the sleep pardon (decision 0009). */
  pardon(ms: number): void {
    this.db.prepare('UPDATE leases SET expires_at = expires_at + ?').run(ms);
    this.db.prepare('UPDATE envs SET last_used_at = last_used_at + ?').run(ms);
  }
}

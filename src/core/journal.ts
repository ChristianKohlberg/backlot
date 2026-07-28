/**
 * The per-machine journal: disk is truth, daemon memory is a cache
 * (decision 0009). node:sqlite — zero native deps.
 */
import { DatabaseSync } from 'node:sqlite';
import { journalPath } from './paths.js';
import { BrokerError } from './util.js';
import type { EnvState, Hygiene, LeaseKind, ServicePid } from './types.js';

/**
 * The journal schema this build understands, stamped into `PRAGMA user_version`.
 *
 * Bump it when a change makes an OLDER daemon misread this journal — not for
 * every additive column. The additive migrations below are deliberately not
 * bumps: an old daemon selecting a known subset of columns reads a newer
 * journal correctly.
 *
 * What this exists to stop is the DOWNGRADE, which has already cost once. The
 * sha256 env-id migration stranded pre-upgrade rows that then counted against
 * POOL_MAX_TOTAL and held their ports forever (BACKLOG.md), because nothing on
 * disk said which build wrote them. A running example of the same shape:
 * `data_only` defaults to 0, so a 0.7.0 daemon re-binding a 0.8.0 data-only
 * environment reads "not data-only" and boots the whole application into a
 * test lane's database. Disk is truth (decision 0009), so the truth has to say
 * what wrote it.
 */
export const JOURNAL_SCHEMA_VERSION = 1;

/**
 * service_pids was once `{"web": 1234}` and is now
 * `{"web": {"pid":1234,"startTime":99}}`. Journals outlive releases, so read
 * both shapes; a bare number simply has no identity pin (see ServicePid).
 */
function parseServicePids(raw: string): Record<string, ServicePid> {
  const out: Record<string, ServicePid> = {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'number') out[name] = { pid: v };
    else if (v && typeof v === 'object' && typeof (v as ServicePid).pid === 'number') {
      out[name] = { pid: (v as ServicePid).pid, startTime: (v as ServicePid).startTime };
    }
  }
  return out;
}

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
  servicePids: Record<string, ServicePid>;
  /** Consecutive bind failures — >= 2 auto-escalates the next bind to pristine (decision 0007). */
  failStreak: number;
  /**
   * The services this environment currently has up, when that is a SUBSET of
   * the manifest — `backlot up sherlock` starts only that slice plus its
   * transitive depends_on closure. Undefined means the whole app is up (the
   * default). reset-data/watch rebinds read this to preserve the lease's shape;
   * a fresh `up` re-declares it.
   */
  activeServices?: string[];
  /**
   * This environment was bound for its DATASTORES ONLY — no services, by design.
   *
   * `activeServices: []` cannot express this: an empty selection has always meant
   * "the whole app" (see `resolveServiceClosure`), so without a separate flag a
   * shape-preserving rebind — `reset-data` on a data lease is the one that
   * matters — would read the empty shape and boot the entire stack. A fresh claim
   * never inherits it; only the request sets it.
   */
  dataOnly?: boolean;
}

export interface LeaseRow {
  id: string;
  envId: string;
  kind: LeaseKind;
  holder: string;
  hygiene: Hygiene;
  expiresAt: number;
  /**
   * The holder's process, when the caller supplied one.
   *
   * `holder` is a NAME (a worktree path by default) and nothing about a name
   * can die — so an agent that crashed held its environment until the TTL
   * expired, exempt from idle reclamation the whole time. A pid pinned by its
   * start time can be checked, so a dead holder's lease is released in seconds.
   */
  holderPid?: number;
  holderStart?: number;
}

export class Journal {
  private db: DatabaseSync;

  constructor(path = journalPath()) {
    this.db = new DatabaseSync(path);
    // Concurrent readers exist (tests and tools open the journal directly while
    // the daemon runs), and without a busy timeout any overlap is an immediate
    // SQLITE_BUSY rather than a short wait. Set before the first read below.
    this.db.exec('PRAGMA busy_timeout = 5000');
    // Refuse a journal from the FUTURE before touching it. A newer backlot may
    // have written rows whose semantics this build does not know, and the
    // failure mode is silent: we would read a default where the newer build
    // stored meaning, then write that misreading back as truth. Checked before
    // any DDL so a journal we do not understand is never modified at all.
    const stamped = Number(
      (this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0,
    );
    if (stamped > JOURNAL_SCHEMA_VERSION) {
      throw new BrokerError(
        'infra-error',
        `journal at ${path} was written by a newer backlot (schema ${stamped}; this build understands ${JOURNAL_SCHEMA_VERSION}) — ` +
          `run the newer backlot, upgrade this one, or point BACKLOT_STATE_DIR at a different state root`,
        'journal',
      );
    }
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
        fail_streak INTEGER NOT NULL DEFAULT 0,
        active_services TEXT
      );
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY, env_id TEXT NOT NULL, kind TEXT NOT NULL,
        holder TEXT NOT NULL, hygiene TEXT NOT NULL, expires_at INTEGER NOT NULL,
        holder_pid INTEGER, holder_start INTEGER
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, stack_cwd TEXT NOT NULL, check_name TEXT NOT NULL,
        state TEXT NOT NULL, verdict TEXT, created_at INTEGER NOT NULL, finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS counters (
        stack TEXT PRIMARY KEY, next_env INTEGER NOT NULL DEFAULT 1
      );
    `);
    // Migrations for journals created before holder identity existed.
    for (const col of ['holder_pid INTEGER', 'holder_start INTEGER']) {
      try {
        this.db.exec(`ALTER TABLE leases ADD COLUMN ${col}`);
      } catch (err) {
        if (!/duplicate column name/i.test(String((err as Error).message ?? err))) throw err;
      }
    }
    // Migration for journals created before fail_streak existed. Swallowing
    // EVERY error here hid real failures (a corrupt journal, a locked file) as
    // "column already exists", so the daemon carried on against a schema it did
    // not actually have. Only the duplicate-column case is benign.
    try {
      this.db.exec('ALTER TABLE envs ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0');
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
    // Migration for journals created before selective service startup. NULL
    // (the default for existing rows) means "the whole app is up".
    try {
      this.db.exec('ALTER TABLE envs ADD COLUMN active_services TEXT');
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
    // Migration for journals created before data-only binds. 0 (the default for
    // existing rows) is correct: every environment that already existed was
    // bound with its services.
    try {
      this.db.exec('ALTER TABLE envs ADD COLUMN data_only INTEGER NOT NULL DEFAULT 0');
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (!/duplicate column name/i.test(msg)) throw err;
    }
    // Stamp LAST: every migration above has run, so the stamp means "this
    // journal has the schema that number describes" rather than "a build with
    // that number opened it". 0 covers both a fresh journal and one written
    // before stamping existed, and the idempotent ALTERs above bring either to
    // 1 — so there is nothing to do for it beyond recording the fact.
    if (stamped < JOURNAL_SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION}`);
  }

  /**
   * One real sqlite transaction around a multi-statement write. Each of these
   * sequences used to be N independent writes, so a daemon SIGKILLed between
   * them left a half-state on disk — deleteEnv's env-gone-lease-left was the
   * reviewed case. The sweeper tolerates those half-states (journals outlive
   * releases); this stops new ones being minted. BEGIN IMMEDIATE takes the
   * write lock up front, so the sequence can't interleave with the concurrent
   * writers that busy_timeout exists for either.
   */
  private withTx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* sqlite may already have rolled back on error */
      }
      throw err;
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
      servicePids: parseServicePids(r.service_pids as string),
      failStreak: (r.fail_streak as number) ?? 0,
      activeServices: r.active_services ? (JSON.parse(r.active_services as string) as string[]) : undefined,
      dataOnly: Boolean(r.data_only),
    };
  }

  saveEnv(e: EnvRow): void {
    this.db
      .prepare(
        `INSERT INTO envs (id, stack, stack_root, state, root, ports, datastore_ns, fingerprints, presets, bind_count, created_at, last_used_at, service_pids, fail_streak, active_services, data_only)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, ports=excluded.ports,
           datastore_ns=excluded.datastore_ns, fingerprints=excluded.fingerprints,
           presets=excluded.presets, bind_count=excluded.bind_count,
           last_used_at=excluded.last_used_at, service_pids=excluded.service_pids,
           fail_streak=excluded.fail_streak, active_services=excluded.active_services,
           data_only=excluded.data_only`,
      )
      .run(
        e.id, e.stack, e.stackRoot, e.state, e.root,
        JSON.stringify(e.ports), JSON.stringify(e.datastoreNs), JSON.stringify(e.fingerprints),
        JSON.stringify(e.presets), e.bindCount, e.createdAt, e.lastUsedAt, JSON.stringify(e.servicePids),
        e.failStreak, e.activeServices ? JSON.stringify(e.activeServices) : null, e.dataOnly ? 1 : 0,
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
    // Atomic: a kill between these two deletes left a lease naming an env row
    // that no longer existed (the sweeper prunes that half-state as backstop).
    this.withTx(() => {
      this.db.prepare('DELETE FROM envs WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM leases WHERE env_id = ?').run(id);
    });
  }

  /**
   * A per-stack env sequence that NEVER reuses a number, even after envs are
   * reaped — so a recycled env's id can't collide with a live one. Monotonic
   * in the journal, survives daemon restarts.
   */
  nextEnvSeq(stack: string): number {
    // Atomic read-modify-write: a foreign writer landing between the SELECT
    // and the UPDATE would hand the same "never reused" number out twice.
    return this.withTx(() => {
      this.db.prepare('INSERT INTO counters (stack, next_env) VALUES (?, 1) ON CONFLICT(stack) DO NOTHING').run(stack);
      const row = this.db.prepare('SELECT next_env FROM counters WHERE stack = ?').get(stack) as { next_env: number };
      const seq = row.next_env;
      this.db.prepare('UPDATE counters SET next_env = next_env + 1 WHERE stack = ?').run(stack);
      return seq;
    });
  }

  /** Activity, NOT lease renewal: keeps idle reclamation honest without extending ownership. */
  touchEnv(id: string): void {
    this.db.prepare('UPDATE envs SET last_used_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /** Update just the recorded service pids (auto-restart keeps recovery honest). */
  updateServicePids(id: string, pids: Record<string, ServicePid>): void {
    this.db.prepare('UPDATE envs SET service_pids = ? WHERE id = ?').run(JSON.stringify(pids), id);
  }

  saveLease(l: LeaseRow): void {
    this.db
      .prepare(
        `INSERT INTO leases (id, env_id, kind, holder, hygiene, expires_at, holder_pid, holder_start)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at, hygiene=excluded.hygiene,
           holder_pid=excluded.holder_pid, holder_start=excluded.holder_start`,
      )
      .run(l.id, l.envId, l.kind, l.holder, l.hygiene, l.expiresAt, l.holderPid ?? null, l.holderStart ?? null);
  }

  private rowToLease(r: Record<string, unknown>): LeaseRow {
    return {
      id: r.id as string,
      envId: r.env_id as string,
      kind: r.kind as LeaseKind,
      holder: r.holder as string,
      hygiene: r.hygiene as Hygiene,
      expiresAt: r.expires_at as number,
      holderPid: (r.holder_pid as number | null) ?? undefined,
      holderStart: (r.holder_start as number | null) ?? undefined,
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

  listJobs(limit = 20): Array<{ id: string; check: string; state: string; ok: boolean | null; createdAt: number; finishedAt: number | null }> {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      check: r.check_name as string,
      state: r.state as string,
      ok: r.verdict ? Boolean((JSON.parse(r.verdict as string) as { ok?: boolean }).ok) : null,
      createdAt: r.created_at as number,
      finishedAt: (r.finished_at as number) ?? null,
    }));
  }

  /** Recovery: a job left 'running'/'pending' by a dead daemon can never finish. */
  failStaleJobs(): number {
    const stale = this.db.prepare("SELECT id, check_name, stack_cwd FROM jobs WHERE state != 'done'").all() as Array<{ id: string; check_name: string; stack_cwd: string }>;
    for (const j of stale) {
      this.saveJob({
        id: j.id, stackCwd: j.stack_cwd, check: j.check_name, state: 'done',
        verdict: { check: j.check_name, ok: false, exitCode: -1, failure: { class: 'env-error', message: 'daemon restarted while this run was in flight — result lost' } },
        finishedAt: Date.now(),
      });
    }
    return stale.length;
  }

  /** Retention: done jobs finished before the cutoff leave the journal. */
  pruneJobs(cutoffMs: number): number {
    const res = this.db.prepare("DELETE FROM jobs WHERE state = 'done' AND finished_at IS NOT NULL AND finished_at < ?").run(cutoffMs);
    return Number(res.changes ?? 0);
  }

  /** Shift every deadline by `ms` — the sleep pardon (decision 0009). */
  pardon(ms: number): void {
    // Atomic: a kill between these left leases pardoned but idle clocks not,
    // so a machine that slept woke to premature quiesces.
    this.withTx(() => {
      this.db.prepare('UPDATE leases SET expires_at = expires_at + ?').run(ms);
      this.db.prepare('UPDATE envs SET last_used_at = last_used_at + ?').run(ms);
    });
  }
}

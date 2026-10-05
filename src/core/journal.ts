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
 * every additive column: a bump is unnecessary when an old daemon selecting
 * a known subset of columns still reads the journal correctly.
 *
 * Schema 2 separates lease-intended presets (`leases.presets`) from completed
 * restores (`envs.presets`). Older daemons would inherit actual data as intent
 * after a failed bind or pristine wipe. Existing leases migrate from their
 * environment's recorded choices; tests/preset-selection.test.ts covers the
 * retry and restart invariant.
 *
 * Schema 3's survivor-group compatibility barrier is documented in
 * docs/architecture.md#journal-upgrade-barrier.
 *
 * Schema 4 (decision 0034): `active_services = '[]'` means "no services are
 * wanted" (an older daemon reads an empty list as the whole app and would boot
 * it), the `db_copies` table holds database copies an older daemon would never
 * reap, and data-only environments are migrated away at the first recovery.
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
export const JOURNAL_SCHEMA_VERSION = 4;

/**
 * service_pids was once `{"web": 1234}` and is now
 * `{"web": {"pid":1234,"startTime":99}}`. Journals outlive releases, so read
 * both shapes; a bare number simply has no identity pin (see ServicePid).
 */
function parseJson<T>(raw: unknown): T | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

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
      out[name] = { pid: (v as ServicePid).pid, startTime: (v as ServicePid).startTime,
        ...(typeof (v as ServicePid).pgid === 'number' ? { pgid: (v as ServicePid).pgid } : {}),
        ...(Array.isArray((v as ServicePid).pgids) ? { pgids: (v as ServicePid).pgids!.filter(g => Number.isSafeInteger(g) && g > 0) } : {}) };
    }
  }
  return out;
}

export interface EnvRow {
  id: string;
  stack: string;
  stackRoot: string;
  /** Retains the old default-holder spelling without rewriting opaque holder IDs. */
  legacyStackRoot?: string;
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
   * The services this environment's lease WANTS up (decision 0034): `up`
   * adds to it, `down` takes away. Undefined means every service the
   * manifest declares (so a service added to the manifest later is included);
   * `[]` means none — the shape `down` with no names leaves. The running set
   * is the supervisor's; this is the intent a quiesce or a daemon restart
   * keeps, and the next `up` restores.
   */
  activeServices?: string[];
  /**
   * Read only to migrate it away: an older runly bound environments for their
   * datastores alone (`up --data-only`, decisions 0023/0025, removed by 0034).
   * Recovery turns a leased one into an environment with no services wanted
   * and recycles an unleased one; nothing else reads it.
   */
  dataOnly?: boolean;
  /**
   * When each public port last carried a client byte (decision 0035), by port
   * key. Persisted (throttled) so a daemon restart does not reset every idle
   * clock to "active"; the proxy's in-memory counters start from it.
   */
  activity?: Record<string, number>;
  /**
   * How to drop each datastore namespace this environment holds, recorded
   * when it is created (decision 0037): the templated drop command and where
   * to run it, or the file to delete. Teardown needs neither the manifest nor
   * the worktree — both may be gone by the time it runs.
   */
  dropRecipes?: Record<string, DropRecipe>;
  /** The template each datastore was last restored from (decision 0037: templates are kept by reference). */
  templates?: Record<string, string>;
}

/** Everything needed to drop one namespace without the manifest (decision 0037). */
export interface DropRecipe {
  cmd?: string;
  cwd?: string;
  /** A file (sqlite) to delete instead, with its -wal/-shm/-journal sidecars. */
  path?: string;
}

export interface LeaseRow {
  presets?: Record<string, string>;
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
  /** Active lease-scoped public preview tunnel, when `runly preview` is running. */
  previewService?: string;
  previewUrl?: string;
  previewPid?: number;
  previewStart?: number;
  /** Local port the tunnel was published against, so a rebind can spot drift. */
  previewPort?: number;
}

/**
 * A database copy made by `runly db new|with` (decision 0034): a fresh restore
 * from the same template an environment's datastore uses, with no lease, ports
 * or services. Everything needed to DROP it is on the row — the command, where
 * to run it, the files to remove — so it can be reaped after the worktree that
 * made it is gone.
 */
export interface DbCopyRow {
  name: string;
  stack: string;
  stackRoot: string;
  datastore: string;
  preset: string;
  ns: string;
  url: string;
  /** `creating` until the restore finished; `dropping` once a drop started (or failed). */
  state: 'creating' | 'ready' | 'dropping';
  /** The caller's worktree, the same holder name `up` uses. */
  holder: string;
  /** The agent tether, when the caller named one (`--holder-pid`, BACKLOT_HOLDER_PID, or `db with`'s own CLI). */
  holderPid?: number;
  holderStart?: number;
  /** The already-templated drop command (command-family drivers). */
  dropCmd?: string;
  /** Where it runs: the worktree, or the state root when that is gone. */
  dropCwd?: string;
  /** What to delete instead (sqlite): the copy's own directory under the state root. */
  dropPath?: string;
  createdAt: number;
  dropAttempts: number;
  nextDropAt: number;
  /** The template it was restored from (`<stack>/<marker>`), so retention keeps it (decision 0037). */
  template?: string;
}

export class Journal {
  private db: DatabaseSync;

  constructor(path = journalPath()) {
    this.db = new DatabaseSync(path);
    // Concurrent readers exist (tests and tools open the journal directly while
    // the daemon runs), and without a busy timeout any overlap is an immediate
    // SQLITE_BUSY rather than a short wait. Set before the first read below.
    this.db.exec('PRAGMA busy_timeout = 5000');
    // Refuse a journal from the FUTURE before touching it. A newer runly may
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
        `journal at ${path} was written by a newer runly (schema ${stamped}; this build understands ${JOURNAL_SCHEMA_VERSION}) — ` +
          `run the newer runly, upgrade this one, or point BACKLOT_STATE_DIR at a different state root`,
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
      CREATE TABLE IF NOT EXISTS counters (
        stack TEXT PRIMARY KEY, next_env INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS db_copies (
        name TEXT PRIMARY KEY, stack TEXT NOT NULL, stack_root TEXT NOT NULL,
        datastore TEXT NOT NULL, preset TEXT NOT NULL, ns TEXT NOT NULL, url TEXT NOT NULL,
        state TEXT NOT NULL, holder TEXT NOT NULL, holder_pid INTEGER, holder_start INTEGER,
        drop_cmd TEXT, drop_cwd TEXT, drop_path TEXT,
        created_at INTEGER NOT NULL, drop_attempts INTEGER NOT NULL DEFAULT 0,
        next_drop_at INTEGER NOT NULL DEFAULT 0
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
    for (const col of ['preview_service TEXT', 'preview_url TEXT', 'preview_pid INTEGER', 'preview_start INTEGER', 'preview_port INTEGER']) {
      try {
        this.db.exec(`ALTER TABLE leases ADD COLUMN ${col}`);
      } catch (err) {
        if (!/duplicate column name/i.test(String((err as Error).message ?? err))) throw err;
      }
    }
    try {
      this.db.exec('ALTER TABLE leases ADD COLUMN presets TEXT');
      this.db.exec("UPDATE leases SET presets = COALESCE((SELECT presets FROM envs WHERE envs.id = leases.env_id), '{}')");
    } catch (err) {
      if (!/duplicate column name/i.test(String((err as Error).message ?? err))) throw err;
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
    try {
      this.db.exec('ALTER TABLE envs ADD COLUMN legacy_stack_root TEXT');
    } catch (err) {
      if (!/duplicate column name/i.test(String((err as Error).message ?? err))) throw err;
    }
    // 0.16 (decisions 0035, 0037): additive — an older daemon ignores them and
    // reads everything else correctly, so they are no schema bump.
    for (const [table, col] of [['envs', 'activity TEXT'], ['envs', 'drop_recipes TEXT'], ['envs', 'templates TEXT'], ['db_copies', 'template TEXT']] as const) {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
      } catch (err) {
        if (!/duplicate column name/i.test(String((err as Error).message ?? err))) throw err;
      }
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
      legacyStackRoot: (r.legacy_stack_root as string | null) ?? undefined,
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
      activity: parseJson(r.activity),
      dropRecipes: parseJson(r.drop_recipes),
      templates: parseJson(r.templates),
    };
  }

  saveEnv(e: EnvRow): void {
    this.db
      .prepare(
        `INSERT INTO envs (id, stack, stack_root, state, root, ports, datastore_ns, fingerprints, presets, bind_count, created_at, last_used_at, service_pids, fail_streak, active_services, data_only, drop_recipes, templates)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET state=excluded.state, ports=excluded.ports,
           datastore_ns=excluded.datastore_ns, fingerprints=excluded.fingerprints,
           presets=excluded.presets, bind_count=excluded.bind_count,
           last_used_at=excluded.last_used_at, service_pids=excluded.service_pids,
           fail_streak=excluded.fail_streak, active_services=excluded.active_services,
           data_only=excluded.data_only,
           drop_recipes=COALESCE(excluded.drop_recipes, envs.drop_recipes),
           templates=COALESCE(excluded.templates, envs.templates)`,
      )
      .run(
        e.id, e.stack, e.stackRoot, e.state, e.root,
        JSON.stringify(e.ports), JSON.stringify(e.datastoreNs), JSON.stringify(e.fingerprints),
        JSON.stringify(e.presets), e.bindCount, e.createdAt, e.lastUsedAt, JSON.stringify(e.servicePids),
        e.failStreak, e.activeServices ? JSON.stringify(e.activeServices) : null, e.dataOnly ? 1 : 0,
        e.dropRecipes ? JSON.stringify(e.dropRecipes) : null, e.templates ? JSON.stringify(e.templates) : null,
      );
  }

  /**
   * Record the proxy's activity clocks (decision 0035). Its own statement, so
   * a snapshot saved by a verb can never roll them back, and merged so a
   * clock only moves forward.
   */
  saveActivity(id: string, activity: Record<string, number>): void {
    const row = this.db.prepare('SELECT activity FROM envs WHERE id = ?').get(id) as { activity?: string | null } | undefined;
    if (!row) return;
    const merged: Record<string, number> = { ...(parseJson<Record<string, number>>(row.activity) ?? {}) };
    for (const [k, v] of Object.entries(activity)) merged[k] = Math.max(merged[k] ?? 0, v);
    this.db.prepare('UPDATE envs SET activity = ? WHERE id = ?').run(JSON.stringify(merged), id);
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

  /** Normalize identity metadata atomically; env IDs, namespaces, leases and counters stay intact. */
  canonicalizeStacks(changes: Array<{ id: string; stack: string; root: string }>): void {
    this.withTx(() => {
      const update = this.db.prepare(`UPDATE envs SET stack = ?,
        legacy_stack_root = COALESCE(legacy_stack_root, CASE WHEN stack_root != ? THEN stack_root END),
        stack_root = ? WHERE id = ?`);
      for (const change of changes) update.run(change.stack, change.root, change.root, change.id);
    });
  }

  private rowToDbCopy(r: Record<string, unknown>): DbCopyRow {
    return {
      name: r.name as string,
      stack: r.stack as string,
      stackRoot: r.stack_root as string,
      datastore: r.datastore as string,
      preset: r.preset as string,
      ns: r.ns as string,
      url: r.url as string,
      state: r.state as DbCopyRow['state'],
      holder: r.holder as string,
      holderPid: (r.holder_pid as number | null) ?? undefined,
      holderStart: (r.holder_start as number | null) ?? undefined,
      dropCmd: (r.drop_cmd as string | null) ?? undefined,
      dropCwd: (r.drop_cwd as string | null) ?? undefined,
      dropPath: (r.drop_path as string | null) ?? undefined,
      createdAt: r.created_at as number,
      dropAttempts: (r.drop_attempts as number) ?? 0,
      nextDropAt: (r.next_drop_at as number) ?? 0,
      template: (r.template as string | null) ?? undefined,
    };
  }

  saveDbCopy(c: DbCopyRow): void {
    this.db
      .prepare(
        `INSERT INTO db_copies (name, stack, stack_root, datastore, preset, ns, url, state, holder, holder_pid, holder_start,
           drop_cmd, drop_cwd, drop_path, created_at, drop_attempts, next_drop_at, template)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET state=excluded.state, drop_attempts=excluded.drop_attempts,
           next_drop_at=excluded.next_drop_at, template=COALESCE(excluded.template, db_copies.template)`,
      )
      .run(
        c.name, c.stack, c.stackRoot, c.datastore, c.preset, c.ns, c.url, c.state, c.holder,
        c.holderPid ?? null, c.holderStart ?? null, c.dropCmd ?? null, c.dropCwd ?? null, c.dropPath ?? null,
        c.createdAt, c.dropAttempts, c.nextDropAt, c.template ?? null,
      );
  }

  getDbCopy(name: string): DbCopyRow | undefined {
    const r = this.db.prepare('SELECT * FROM db_copies WHERE name = ?').get(name);
    return r ? this.rowToDbCopy(r as Record<string, unknown>) : undefined;
  }

  allDbCopies(): DbCopyRow[] {
    return (this.db.prepare('SELECT * FROM db_copies ORDER BY created_at, name').all() as Record<string, unknown>[]).map((r) =>
      this.rowToDbCopy(r),
    );
  }

  deleteDbCopy(name: string): void {
    this.db.prepare('DELETE FROM db_copies WHERE name = ?').run(name);
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
        `INSERT INTO leases (id, env_id, kind, holder, hygiene, expires_at, holder_pid, holder_start,
           preview_service, preview_url, preview_pid, preview_start, preview_port, presets)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at, hygiene=excluded.hygiene,
           holder_pid=excluded.holder_pid, holder_start=excluded.holder_start,
           preview_service=excluded.preview_service, preview_url=excluded.preview_url,
           preview_pid=excluded.preview_pid, preview_start=excluded.preview_start,
           preview_port=excluded.preview_port, presets=excluded.presets`,
      )
      .run(
        l.id,
        l.envId,
        l.kind,
        l.holder,
        l.hygiene,
        l.expiresAt,
        l.holderPid ?? null,
        l.holderStart ?? null,
        l.previewService ?? null,
        l.previewUrl ?? null,
        l.previewPid ?? null,
        l.previewStart ?? null,
        l.previewPort ?? null,
        l.presets === undefined ? null : JSON.stringify(l.presets),
      );
  }

  /**
   * Forget a lease's preview tunnel — compare-and-swap on the pid.
   *
   * Every caller reached here holding a lease SNAPSHOT, so an unconditional
   * clear let a slow one wipe the record of a tunnel someone else had already
   * published in its place. That pid is then unnameable, and an unnameable
   * preview pid is a public, unauthenticated URL that serves forever. Passing
   * the pid that was actually stopped makes a stale caller a no-op; the
   * pid-less form is only for a row that is being deleted outright.
   */
  clearLeasePreview(id: string, stoppedPid?: number): void {
    const cols = 'preview_service=NULL, preview_url=NULL, preview_pid=NULL, preview_start=NULL, preview_port=NULL';
    if (stoppedPid === undefined) {
      this.db.prepare(`UPDATE leases SET ${cols} WHERE id=?`).run(id);
      return;
    }
    this.db.prepare(`UPDATE leases SET ${cols} WHERE id=? AND preview_pid=?`).run(id, stoppedPid);
  }

  private rowToLease(r: Record<string, unknown>): LeaseRow {
    return {
      id: r.id as string,
      envId: r.env_id as string,
      presets: r.presets == null ? undefined : JSON.parse(r.presets as string),
      kind: r.kind as LeaseKind,
      holder: r.holder as string,
      hygiene: r.hygiene as Hygiene,
      expiresAt: r.expires_at as number,
      holderPid: (r.holder_pid as number | null) ?? undefined,
      holderStart: (r.holder_start as number | null) ?? undefined,
      previewService: (r.preview_service as string | null) ?? undefined,
      previewUrl: (r.preview_url as string | null) ?? undefined,
      previewPid: (r.preview_pid as number | null) ?? undefined,
      previewStart: (r.preview_start as number | null) ?? undefined,
      previewPort: (r.preview_port as number | null) ?? undefined,
    };
  }

  leaseForHolder(holder: string, stack: string): LeaseRow | undefined {
    const rows = this.db.prepare(
      `SELECT l.* FROM leases l JOIN envs e ON e.id = l.env_id WHERE l.holder = ? AND e.stack = ?`,
    ).all(holder, stack) as Record<string, unknown>[];
    if (rows.length > 1) {
      throw new BrokerError(
        'env-error',
        `ambiguous leases for holder '${holder}': ${rows.map((r) => r.env_id).join(', ')}; inspect 'runly status', then retire one with 'runly pool recycle <envId> --force' — that destroys the selected environment and its data and ends its lease`,
        'lease',
      );
    }
    return rows[0] ? this.rowToLease(rows[0]) : undefined;
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

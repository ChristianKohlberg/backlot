/**
 * Datastore drivers (see docs/driver-spec.md).
 *
 * Two families:
 *  - sqlite: fully engine-native — the ns IS a file; template restore is a copy.
 *  - command (postgres/mssql/mysql/redis): ALL mechanics are repo-declared
 *    commands ({{ns}}/{{preset}}/{{template}} resolved by the engine). backlot
 *    embeds no database clients — the anti-scope ("orchestrate, don't
 *    reimplement") applied to data.
 *
 * Template model: bake once per seed-content hash into a template ns, then
 * restore per environment (postgres: `createdb -T`; mssql: the repo's
 * backup/restore script). Templates are machine-global and immutable-keyed
 * (decision 0006/0008).
 */
import {
  copyFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { templatesRoot } from '../core/paths.js';
import { sha256, template, BrokerError } from '../core/util.js';
import { runBounded, DEFAULT_CMD_TIMEOUT_S } from '../core/exec.js';
import type { DatastoreSpec } from '../core/manifest.js';

export interface DsHandle {
  envId: string;
  envTree: string;
  dataDir: string;
}

export interface DsDriver {
  readonly name: string;
  /** The ns for an environment: sqlite = file path; server = SQL-safe db name. */
  ns(h: DsHandle): string;
  /** The connection string services/checks receive. */
  url(h: DsHandle): string;
  /** infra-error (never code blame) when the external server is unreachable. */
  probe(): Promise<void>;
  /** Create/restore the namespace at the preset. force = recreate even if present. */
  ensure(h: DsHandle, preset: string, force: boolean, exists: boolean): Promise<void>;
  /** Best-effort removal (recycle). */
  drop(h: DsHandle): Promise<void>;
  /** @rebake-template: invalidate baked templates (and drop their server-side DBs). */
  rebake(cwd?: string): void | Promise<void>;
}

const sh = async (cmd: string, cwd: string, errCtx: string): Promise<void> => {
  const r = await runBounded(cmd, cwd);
  if (r.timedOut) {
    // A hung command is an environment problem, not the repo's code being
    // wrong — and it must be reported, never waited on forever.
    throw new BrokerError(
      'env-error',
      `${errCtx}: command did not finish within ${DEFAULT_CMD_TIMEOUT_S}s and was killed`,
      'datastore',
      r.output.slice(-800),
    );
  }
  if (r.code !== 0) throw new BrokerError('work-error', errCtx, 'datastore', r.output.slice(-800));
};

/** Best-effort variant: failures are expected (clean-slate drops) and ignored. */
const shQuiet = async (cmd: string, cwd: string): Promise<void> => {
  await runBounded(cmd, cwd);
};

/**
 * In-process bake serialization (vetbill-1i49). All binds flow through the
 * single daemon, so a keyed promise chain is a complete lock: two envs of the
 * same stack binding concurrently used to race the marker check and bake the
 * shared template twice (raw "being accessed by other users" errors, or the
 * loser restoring the winner's half-baked schema).
 */
const bakeLocks = new Map<string, Promise<unknown>>();
export async function withBakeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = bakeLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn); // run after predecessor, success or failure
  bakeLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (bakeLocks.get(key) === run) bakeLocks.delete(key);
  }
}

/**
 * Baked-template markers are self-describing (vetbill-1i49): they carry the
 * server-side template ns AND the already-templated drop command, so
 * retention/rebake can DROP the actual database when the marker is pruned —
 * previously only the marker file was deleted and `backlot_tpl_*` databases
 * leaked on the appliance forever. Legacy markers (bare ns string) still
 * parse; they just can't be dropped server-side.
 */
export interface BakedMarker {
  v: 1;
  ns: string;
  drop: string | null;
}

export function parseBakedMarker(content: string): BakedMarker {
  try {
    const parsed = JSON.parse(content) as BakedMarker;
    if (parsed && parsed.v === 1 && typeof parsed.ns === 'string') return parsed;
  } catch {
    /* legacy: bare ns string */
  }
  return { v: 1, ns: content.trim(), drop: null };
}

/** Drop every marker's server-side template DB in `dir`, best-effort. */
export async function dropBakedTemplates(dir: string, cwd: string): Promise<number> {
  let dropped = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const f of entries) {
    if (!f.endsWith('.baked')) continue;
    try {
      const marker = parseBakedMarker(readFileSync(join(dir, f), 'utf8'));
      if (marker.drop) {
        await shQuiet(marker.drop, cwd);
        dropped++;
      }
    } catch {
      /* unreadable marker — file prune below still applies */
    }
  }
  return dropped;
}

// ---------------------------------------------------------------- sqlite

class SqliteDs implements DsDriver {
  constructor(
    readonly name: string,
    private readonly spec: DatastoreSpec,
    private readonly stackId: string,
    private readonly bakeKey?: string,
  ) {}

  /** Template identity: create command + content bake key (vetbill-1i49). */
  private contentKey(): string {
    const base = this.spec.create ?? '';
    return sha256(this.bakeKey ? `${base}\n@bake:${this.bakeKey}` : base);
  }

  ns(h: DsHandle): string {
    // The datastore KEY becomes a filename; a key with `/` or `..` must not
    // escape dataDir (the command-family sibling already sanitizes — this
    // closes the same hole here). Reject rather than mangle so a bad key is loud.
    if (/[/\\]|\.\./.test(this.name)) {
      throw new BrokerError('work-error', `sqlite datastore key '${this.name}' must not contain '/', '\\', or '..'`, 'manifest');
    }
    return join(h.dataDir, `${this.name}.db`);
  }
  url(h: DsHandle): string {
    return this.ns(h);
  }
  async probe(): Promise<void> {
    /* in-process — nothing external */
  }

  private tplPath(preset: string): string {
    const dir = join(templatesRoot(), this.stackId);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${this.name}-${preset}@${this.contentKey().slice(0, 12)}.db`);
  }

  private async runCreate(envTree: string, ns: string, preset: string): Promise<void> {
    if (!this.spec.create) throw new BrokerError('work-error', `datastore '${this.name}' has no create: command`, 'datastore');
    await sh(template(this.spec.create, { ns, preset }), envTree, `seed failed for '${this.name}' preset '${preset}'`);
  }

  async ensure(h: DsHandle, preset: string, force: boolean, exists: boolean): Promise<void> {
    mkdirSync(h.dataDir, { recursive: true });
    const dbPath = this.ns(h);
    if (exists && !force && existsSync(dbPath)) return;
    if (this.spec.template === true) {
      const tpl = this.tplPath(preset);
      // Serialize the bake: concurrent binds must not both run create against
      // the same template file (vetbill-1i49).
      await withBakeLock(tpl, async () => {
        if (!existsSync(tpl)) await this.runCreate(h.envTree, tpl, preset); // bake once
      });
      // The sidecars MUST go before the .db is replaced. SQLite in WAL mode
      // recovers `-wal` frames onto whatever database file it finds, so a
      // leftover WAL from the previous lease would be replayed over the fresh
      // template — resurrecting the old lease's rows inside a supposedly reset
      // store, or corrupting it outright.
      dropSidecars(dbPath);
      copyFileSync(tpl, dbPath, fsConstants.COPYFILE_FICLONE); // restore = CoW clone where the fs supports it
    } else {
      dropSidecars(dbPath);
      await this.runCreate(h.envTree, dbPath, preset);
    }
  }

  async drop(h: DsHandle): Promise<void> {
    const db = this.ns(h);
    rmSync(db, { force: true });
    dropSidecars(db); // an orphaned -wal outlives its database and poisons the next one
  }
  rebake(_cwd?: string): void {
    rmSync(join(templatesRoot(), this.stackId), { recursive: true, force: true });
  }
}

/**
 * SQLite writes alongside the database: `<db>-wal` (journal) and `<db>-shm`
 * (shared index), plus `-journal` in rollback mode. They are only meaningful
 * with the exact database they were written for, so any operation that
 * replaces or removes the .db must remove them in the same breath.
 */
function dropSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
}

// ---------------------------------------------------------------- command family

class CommandDs implements DsDriver {
  constructor(
    readonly name: string,
    private readonly spec: DatastoreSpec,
    private readonly stackId: string,
    private readonly bakeKey?: string,
  ) {
    if (!spec.url) {
      throw new BrokerError('work-error', `datastore '${name}' (driver ${spec.driver}) needs a url: template with {{ns}}`, 'manifest');
    }
  }

  get capabilities(): { template: boolean; ephemeral: boolean } {
    return { template: Boolean(this.spec.template_restore), ephemeral: this.spec.ephemeral === true };
  }

  ns(h: DsHandle): string {
    // The datastore NAME belongs in the namespace. Without it, two datastores
    // of the same driver in one stack (say `app` and `audit` on one postgres)
    // resolve to the identical database: the second one's clean-slate drop
    // destroys the first's freshly seeded data, and both services are handed
    // the same url.
    return `backlot_${h.envId}_${this.name}`.replace(/[^A-Za-z0-9_]/g, '_');
  }
  url(h: DsHandle): string {
    return template(this.spec.url!, { ns: this.ns(h) });
  }

  async probe(): Promise<void> {
    if (!this.spec.probe) return;
    const [host, portStr] = this.spec.probe.split(':');
    const port = Number(portStr);
    await new Promise<void>((resolve, reject) => {
      const sock = connect({ host: host || 'localhost', port, timeout: 3000 });
      sock.once('connect', () => {
        sock.end();
        resolve();
      });
      const fail = () =>
        reject(
          new BrokerError('infra-error', `datastore '${this.name}' unreachable at ${this.spec.probe} — is the server running?`, 'datastore'),
        );
      sock.once('error', fail);
      sock.once('timeout', fail);
    });
  }

  /**
   * Template identity: create command + content bake key (vetbill-1i49).
   * Without a bake key (no @rebake-template rule) names match the historical
   * scheme, so existing baked templates stay valid.
   */
  private contentKey(): string {
    const base = this.spec.create ?? '';
    return sha256(this.bakeKey ? `${base}\n@bake:${this.bakeKey}` : base);
  }
  private templateNs(preset: string): string {
    const hash = this.contentKey().slice(0, 8);
    const raw = `backlot_tpl_${this.stackId}_${preset}_${hash}`.replace(/[^A-Za-z0-9_]/g, '_');
    // Postgres truncates identifiers at 63 bytes, and the DISAMBIGUATING hash
    // is at the end — so a long stack id silently cut it off and two different
    // templates collapsed onto one database. Trim the stack/preset middle
    // instead, and always keep the hash.
    const LIMIT = 63;
    if (raw.length <= LIMIT) return raw;
    const suffix = `_${hash}`;
    return raw.slice(0, LIMIT - suffix.length) + suffix;
  }
  private bakedMarker(preset: string): string {
    const dir = join(templatesRoot(), this.stackId);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${this.name}-${preset}@${this.contentKey().slice(0, 12)}.baked`);
  }

  async ensure(h: DsHandle, preset: string, force: boolean, exists: boolean): Promise<void> {
    const nsE = this.ns(h);
    if (this.spec.ephemeral) {
      // Ephemeral (redis-class): no presets, no templates — reset = the drop:
      // command as a flush; create (optional) runs only on first bind.
      if (force && exists && this.spec.drop) {
        // For an ephemeral store the drop command IS the reset. Swallowing its
        // failure handed the caller an environment that reported reset-data
        // hygiene while still holding the previous lease's keys.
        await sh(template(this.spec.drop, { ns: nsE }), h.envTree, `flush failed for ephemeral '${this.name}' — the store was NOT reset`);
      }
      if (!exists && this.spec.create) {
        await sh(template(this.spec.create, { ns: nsE, preset }), h.envTree, `create failed for ephemeral '${this.name}'`);
      }
      return;
    }
    if (exists && !force) return;
    if (!this.spec.create) throw new BrokerError('work-error', `datastore '${this.name}' has no create: command`, 'datastore');
    const create = this.spec.create; // narrowed copy for the closure below
    const ns = this.ns(h);
    if (this.spec.drop) await shQuiet(template(this.spec.drop, { ns }), h.envTree); // clean slate, best-effort
    if (this.spec.template_restore) {
      const tpl = this.templateNs(preset);
      // Serialize bake-check + bake + mark per template (vetbill-1i49):
      // concurrent binds used to race the marker and bake the shared
      // template twice; the loser could restore a half-baked schema.
      await withBakeLock(tpl, async () => {
        if (existsSync(this.bakedMarker(preset))) return;
        await shQuiet(this.spec.drop ? template(this.spec.drop, { ns: tpl }) : 'true', h.envTree);
        await sh(template(create, { ns: tpl, preset }), h.envTree, `template bake failed for '${this.name}' preset '${preset}'`);
        const marker: BakedMarker = {
          v: 1,
          ns: tpl,
          drop: this.spec.drop ? template(this.spec.drop, { ns: tpl }) : null,
        };
        writeFileSync(this.bakedMarker(preset), JSON.stringify(marker));
      });
      const restore = () =>
        sh(template(this.spec.template_restore!, { template: tpl, ns }), h.envTree, `template restore failed for '${this.name}' preset '${preset}'`);
      try {
        await restore();
      } catch (err) {
        // The marker is LOCAL; the template database lives on the server. Wipe
        // the appliance (docker rm -f, volume prune) and the marker still
        // claims a template that no longer exists, so every future bind fails
        // forever — blaming the repo's restore command for an infrastructure
        // event. Drop the stale marker, bake once more, and retry.
        rmSync(this.bakedMarker(preset), { force: true });
        await withBakeLock(tpl, async () => {
          if (existsSync(this.bakedMarker(preset))) return;
          await shQuiet(this.spec.drop ? template(this.spec.drop, { ns: tpl }) : 'true', h.envTree);
          await sh(template(create, { ns: tpl, preset }), h.envTree, `template rebake failed for '${this.name}' preset '${preset}' (after a failed restore: ${(err as Error).message})`);
          const marker: BakedMarker = {
            v: 1,
            ns: tpl,
            drop: this.spec.drop ? template(this.spec.drop, { ns: tpl }) : null,
          };
          writeFileSync(this.bakedMarker(preset), JSON.stringify(marker));
        });
        await restore(); // a second failure is genuinely the repo's problem
      }
    } else {
      await sh(template(this.spec.create, { ns, preset }), h.envTree, `seed failed for '${this.name}' preset '${preset}'`);
    }
  }

  async drop(h: DsHandle): Promise<void> {
    if (this.spec.drop) await shQuiet(template(this.spec.drop, { ns: this.ns(h) }), h.envTree);
  }
  async rebake(cwd?: string): Promise<void> {
    // Drop the server-side template DBs recorded in the markers before
    // deleting the marker dir — otherwise `backlot_tpl_*` databases leak on
    // the appliance forever (vetbill-1i49).
    //
    // The drop command comes from the MANIFEST and is written to run in the
    // repo (it may invoke a repo-local script or a relative tool). Running it
    // in templatesRoot() made it fail, and shQuiet swallows failures — so the
    // leak fix silently did nothing. Fall back only when no root is known.
    const dir = join(templatesRoot(), this.stackId);
    await dropBakedTemplates(dir, cwd ?? templatesRoot());
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- factory

export function makeDatastore(name: string, spec: DatastoreSpec, stackId: string, bakeKey?: string): DsDriver {
  // The datastore KEY becomes part of a filename (sqlite database, .baked
  // marker), so a key with a separator or `..` would escape the state root.
  // Checked here for EVERY driver: the command family builds marker paths too,
  // and only the sqlite driver used to guard this.
  if (/[/\\]|(^|[/\\])\.\.($|[/\\])/.test(name)) {
    throw new BrokerError('work-error', `datastore key '${name}' must not contain path separators or '..'`, 'manifest');
  }
  switch (spec.driver) {
    case 'sqlite':
      return new SqliteDs(name, spec, stackId, bakeKey);
    case 'postgres':
    case 'mssql':
    case 'mysql':
    case 'redis':
      return new CommandDs(name, spec, stackId, bakeKey);
    default:
      throw new BrokerError('work-error', `unknown datastore driver '${(spec as { driver: string }).driver}'`, 'manifest');
  }
}

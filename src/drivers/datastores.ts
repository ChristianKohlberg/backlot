/**
 * Datastore drivers (see docs/driver-spec.md).
 *
 * Two families:
 *  - sqlite: fully engine-native — the ns IS a file; template restore is a copy.
 *  - command (postgres/mssql/mysql/redis): ALL mechanics are repo-declared
 *    commands ({{ns}}/{{preset}}/{{template}} resolved by the engine). runly
 *    embeds no database clients — the anti-scope ("orchestrate, don't
 *    reimplement") applied to data.
 *
 * Template model: bake once per seed-content hash into a template ns, then
 * restore per environment (postgres: `createdb -T`; mssql: the repo's
 * backup/restore script). Templates are machine-global and immutable-keyed
 * (decision 0006/0008). A content-keyed template (one with an
 * `@rebake-template` key) is shared by every worktree of the same manifest
 * name on this daemon (decision 0044): it lives under `<name>@shared/`
 * instead of `<stack id>/`.
 */
import {
  copyFileSync,
  mkdirSync,
  statSync,
  utimesSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  constants as fsConstants,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { connect } from 'node:net';
import { templatesRoot } from '../core/paths.js';
import { recordNamespace } from '../core/namespaces.js';
import { sha256, template, BrokerError, commandFailure } from '../core/util.js';
import { runBounded, DEFAULT_CMD_TIMEOUT_S } from '../core/exec.js';
import { defaultPreset, type DatastoreSpec } from '../core/manifest.js';
import { logEvent } from '../core/events.js';

/** Every preset a datastore can hold (its catalog, or the default alone). */
function presetNames(spec: DatastoreSpec): string[] {
  return [...new Set([...(spec.presets ?? []), defaultPreset(spec), 'default'])];
}

export interface DsHandle {
  envId: string;
  /**
   * Where the datastore's repo commands (create/drop/template_restore) run:
   * the caller's worktree, which is where the environment runs (decision
   * 0032). Teardown falls back to the environment's own directory when the
   * worktree is already gone.
   */
  cwd: string;
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
  /**
   * The drop as data, for a row that must be reapable without the manifest
   * (a `runly db` copy, decision 0034): the already-templated command for a
   * server datastore, or null when the namespace is a file under the state
   * root (sqlite) — removing that is the engine's to do.
   */
  dropCommand(h: DsHandle): string | null;
  /** True when the namespace is a local file (sqlite), false for a server database. */
  readonly fileBased: boolean;
  /**
   * How to drop this namespace later without the manifest (decision 0037):
   * the templated command and where to run it, or the file to delete.
   */
  dropRecipe(h: DsHandle): { cmd?: string; cwd?: string; path?: string; ns?: string };
  /**
   * The template a restore at `preset` uses, as `<stack>/<marker file>` under
   * the templates root, or null when this datastore bakes none. Retention
   * keeps a template while a row references it (decision 0037).
   */
  templateRef(preset: string): string | null;
  /**
   * Drop this datastore's CURRENT templates (every preset, the current
   * template key) and their server-side databases, so the next restore bakes
   * afresh. Only `--pristine` asks for this (decision 0039): a template whose
   * key matches was baked from the same create command and trigger content,
   * so an `@rebake-template` rule that fires only says which template is
   * current — it never rebakes one that already exists.
   */
  rebake(cwd?: string): void | Promise<void>;
  /** Is the template a restore at `preset` would use already baked? Always false without templates. */
  templateBaked(preset: string): boolean;
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
  if (r.code !== 0) throw commandFailure(errCtx, 'datastore', r.output);
};

/** Best-effort variant: failures are expected (clean-slate drops) and ignored. */
const shQuiet = async (cmd: string, cwd: string): Promise<void> => {
  await runBounded(cmd, cwd);
};

/**
 * In-process template locking (vetbill-1i49). All binds and copies flow
 * through the single daemon, so an in-memory lock is complete.
 *
 * Two levels of readers-writer locks. Per STACK: what walks or drops a whole
 * stack's templates — retention, `pool doctor` — takes it exclusive
 * (`withBakeLock(stack)`); every operation on ONE datastore's templates takes
 * it shared. Per DATASTORE (`<stack>/<datastore>`, inside the stack lock):
 * WRITERS (`withDatastoreLock(…, true)`) change what a template is — a bake, a
 * rebake; READERS restore FROM one, side by side. So the datastores of one
 * environment bake and restore in parallel, and a restore takes no exclusive
 * lock at all while its template exists (decision 0039, 0.19).
 * Before 0.18 a restore held nothing: a sibling's rebake, prune or failed
 * restore could drop the template database while it was being copied, the
 * restore failed, and its own fallback rebake then dropped the template under
 * the next restore — one parallel `--reset-data` cascaded into a rebake of
 * every template. Requests are served in arrival order, so a waiting bake is
 * not starved by a stream of restores, and a restore never sees a half-baked
 * template.
 */
interface TemplateLock {
  readers: number;
  writer: boolean;
  queue: Array<{ write: boolean; go: () => void }>;
}
const templateLocks = new Map<string, TemplateLock>();

function lockOf(key: string): TemplateLock {
  let l = templateLocks.get(key);
  if (!l) {
    l = { readers: 0, writer: false, queue: [] };
    templateLocks.set(key, l);
  }
  return l;
}

function pump(key: string, l: TemplateLock): void {
  while (l.queue.length > 0) {
    const next = l.queue[0]!;
    if (next.write ? l.writer || l.readers > 0 : l.writer) break;
    l.queue.shift();
    if (next.write) l.writer = true;
    else l.readers++;
    next.go();
    if (next.write) break;
  }
  if (!l.writer && l.readers === 0 && l.queue.length === 0) templateLocks.delete(key);
}

async function withTemplateLock<T>(key: string, write: boolean, fn: () => Promise<T>): Promise<T> {
  const l = lockOf(key);
  await new Promise<void>((go) => {
    l.queue.push({ write, go });
    pump(key, l);
  });
  try {
    return await fn();
  } finally {
    if (write) l.writer = false;
    else l.readers--;
    pump(key, l);
  }
}

/** Exclusive: bake, rebake, prune or drop the stack's templates. */
export function withBakeLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withTemplateLock(key, true, fn);
}

/** Shared: restore from one of the stack's templates; no writer runs meanwhile. */
export function withTemplateRead<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return withTemplateLock(key, false, fn);
}

/**
 * One datastore's templates: the stack lock shared, then this datastore's lock
 * — exclusive (`write`) to bake or drop one, shared to restore from one. The
 * order is always stack, then datastore, and nothing waits for the stack lock
 * while holding a datastore lock, so the two levels cannot deadlock.
 */
export function withDatastoreLock<T>(stackId: string, ds: string, write: boolean, fn: () => Promise<T>): Promise<T> {
  return withTemplateLock(stackId, false, () => withTemplateLock(`${stackId}/${ds}`, write, fn));
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
  /** The datastore it was baked for (0.18+), so a rebake drops only that datastore's. */
  ds?: string;
  /**
   * When, and by which bake (0.19): two bakes of one key write different
   * markers, so a restore that failed can tell a sibling's rebake from the
   * template it failed on — the content alone is deterministic.
   */
  bakedAt?: number;
  nonce?: string;
  /** In `<name>@shared/` (0.20, decision 0044). */
  shared?: boolean;
  /** A `--pristine` bake private to one worktree of a shared datastore (0.20). */
  private?: boolean;
  /** The stack dir a shared marker was adopted from, naming its database (0.20). */
  adoptedFrom?: string;
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

export function hasOtherTemplateOwner(full: string, ns: string): boolean {
  if (!ns) return true;
  const roots = [dirname(dirname(full))];
  try {
    for (const root of roots) {
      let entries;
      try { entries = readdirSync(root, { withFileTypes: true }); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(root, entry.name);
        for (const file of readdirSync(dir)) {
          const candidate = join(dir, file);
          if (!file.endsWith('.baked') || candidate === full) continue;
          const owner = parseBakedMarker(readFileSync(candidate, 'utf8'));
          if (!owner.ns || owner.ns === ns) return true;
        }
      }
    }
  } catch { return true; }
  return false;
}

/**
 * Shared templates (decision 0044). A template whose key folds in the content
 * of its `@rebake-template` trigger files is a function of (manifest name,
 * datastore, preset, create command, trigger content) — never of the worktree
 * path — so every worktree of one manifest name on this daemon can restore
 * from the same one. They live in `<name>@shared/` next to the per-stack dirs
 * (`<name>-<8 chars>`); a manifest name cannot contain `@`, so the two never
 * collide.
 */
export const SHARED_TEMPLATE_SUFFIX = '@shared';
export const sharedTemplateDir = (project: string): string => `${project}${SHARED_TEMPLATE_SUFFIX}`;
export const isSharedTemplateDir = (dir: string): boolean => dir.endsWith(SHARED_TEMPLATE_SUFFIX);
/** The manifest name a templates dir belongs to: `<name>@shared`, or a stack id `<name>-<8-char hash>`. */
export function templateProject(dir: string): string {
  return isSharedTemplateDir(dir) ? dir.slice(0, -SHARED_TEMPLATE_SUFFIX.length) : dir.slice(0, -9);
}
/**
 * A template baked by `--pristine` for one worktree of a shared datastore
 * (decision 0044): `<ds>-<preset>@<key>.own.<ext>` in the stack's own dir. It
 * outranks the shared one for that worktree while it exists, and retention
 * keeps it only while a row references it.
 */
export const PRIVATE_TEMPLATE_TAG = '.own';
export const isPrivateTemplateFile = (file: string): boolean => {
  const at = file.lastIndexOf('@');
  return at > 0 && file.slice(at).includes(`${PRIVATE_TEMPLATE_TAG}.`);
};

/** How a datastore's templates are scoped. */
export interface TemplateScope {
  /** Content bake key: the `@rebake-template` trigger content (vetbill-1i49). */
  bakeKey?: string;
  /**
   * The manifest name. With a bake key and without `share_templates: false`,
   * the templates are shared by every worktree of this name (decision 0044).
   * Omitted: per stack, as before 0.20.
   */
  project?: string;
  /** `--pristine` on a shared datastore: bake a template private to this worktree instead of dropping the shared one. */
  privateBake?: boolean;
}

/** Where one template lives: `<dir>/<file>` under the templates root. */
interface TemplateSlot {
  dir: string;
  file: string;
  private: boolean;
  shared: boolean;
}

/**
 * The template slots of one datastore: where a restore at `preset` reads from
 * and a bake writes to. Shared datastores read a private (pristine) template
 * of this worktree first, else the shared one.
 */
class TemplateSlots {
  constructor(
    private readonly name: string,
    private readonly stackId: string,
    private readonly scope: TemplateScope,
    private readonly sharing: boolean,
    private readonly ext: string,
    private readonly key12: () => string,
  ) {}

  get shared(): boolean {
    return this.sharing;
  }

  file(preset: string, priv = false): string {
    return `${this.name}-${preset}@${this.key12()}${priv ? PRIVATE_TEMPLATE_TAG : ''}${this.ext}`;
  }

  path(slot: TemplateSlot): string {
    return join(templatesRoot(), slot.dir, slot.file);
  }

  resolve(preset: string): TemplateSlot {
    if (!this.sharing) return { dir: this.stackId, file: this.file(preset), private: false, shared: false };
    const own: TemplateSlot = { dir: this.stackId, file: this.file(preset, true), private: true, shared: false };
    if (this.scope.privateBake || existsSync(this.path(own))) return own;
    return { dir: sharedTemplateDir(this.scope.project!), file: this.file(preset), private: false, shared: true };
  }

  /**
   * Migration (decision 0044): before a shared template is baked, a
   * per-worktree template of the same project with the same file name — the
   * same datastore, preset and key, so the same inputs — is adopted instead:
   * the newest one is copied (a marker: its JSON, naming the existing
   * database; a sqlite file: a clone), keeping its mtime so it does not jump
   * retention's queue. The original stays where it is; retention collects it
   * once nothing references it (a duplicate of a shared template is never
   * "current"). Returns the source dir, or null when there was nothing to adopt.
   */
  adoptable(slot: TemplateSlot): { dir: string; full: string; mtime: number } | null {
    if (!slot.shared) return null;
    const project = this.scope.project!;
    let best: { dir: string; full: string; mtime: number } | null = null;
    let dirs: string[] = [];
    try {
      dirs = readdirSync(templatesRoot());
    } catch {
      return null;
    }
    for (const dir of dirs) {
      if (isSharedTemplateDir(dir) || dir.length !== project.length + 9 || !dir.startsWith(`${project}-`)) continue;
      const full = join(templatesRoot(), dir, slot.file);
      try {
        const mtime = statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { dir, full, mtime };
      } catch {
        /* not baked there */
      }
    }
    return best;
  }
}

/** Whether a datastore's templates are shared across worktrees (decision 0044). */
export function sharesTemplates(spec: DatastoreSpec, scope: TemplateScope): boolean {
  return scope.project !== undefined && scope.bakeKey !== undefined && spec.share_templates !== false;
}

/**
 * Record which worktree a stack's templates were baked for (`.root` next to
 * them, 0.19), so retention can tell a stack whose worktree is gone from one
 * that merely has no environment right now — after its worktree records were
 * pruned, nothing else said.
 */
function recordTemplateRoot(stackId: string, root: string): void {
  const file = join(templatesRoot(), stackId, '.root');
  try {
    if (readFileSync(file, 'utf8').trim() === root) return;
  } catch {
    /* first bake of this stack */
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${root}\n`);
}

// ---------------------------------------------------------------- sqlite

class SqliteDs implements DsDriver {
  readonly fileBased = true;
  private readonly slots: TemplateSlots;
  constructor(
    readonly name: string,
    private readonly spec: DatastoreSpec,
    private readonly stackId: string,
    private readonly scope: TemplateScope = {},
  ) {
    this.slots = new TemplateSlots(name, stackId, scope, sharesTemplates(spec, scope), '.db', () => this.contentKey().slice(0, 12));
  }

  /** Template identity: create command + content bake key (vetbill-1i49). */
  private contentKey(): string {
    const base = this.spec.create ?? '';
    return sha256(this.scope.bakeKey ? `${base}\n@bake:${this.scope.bakeKey}` : base);
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

  templateRef(preset: string): string | null {
    if (this.spec.template !== true) return null;
    const slot = this.slots.resolve(preset);
    return `${slot.dir}/${slot.file}`;
  }

  dropRecipe(h: DsHandle): { path: string } {
    return { path: this.ns(h) };
  }

  private async runCreate(cwd: string, ns: string, preset: string): Promise<void> {
    if (!this.spec.create) throw new BrokerError('work-error', `datastore '${this.name}' has no create: command`, 'datastore');
    await sh(template(this.spec.create, { ns, preset }), cwd, `seed failed for '${this.name}' preset '${preset}'`);
  }

  async ensure(h: DsHandle, preset: string, force: boolean, exists: boolean): Promise<void> {
    mkdirSync(h.dataDir, { recursive: true });
    const dbPath = this.ns(h);
    if (exists && !force && existsSync(dbPath)) return;
    if (this.spec.template === true) {
      const slot = this.slots.resolve(preset);
      const tpl = this.slots.path(slot);
      mkdirSync(dirname(tpl), { recursive: true });
      // Serialize bake AND restore-copy against rebake, on the template's
      // dir key (the stack, or `<name>@shared` — decision 0044): rebake
      // deletes templates, so the copy below must not overlap one.
      for (let attempt = 0; ; attempt++) {
        // Double-checked: the exclusive lock only when there is a bake to do.
        // One bake per key across every worktree sharing it: the others wait
        // here and then restore.
        if (!existsSync(tpl)) {
          await withDatastoreLock(slot.dir, this.name, true, async () => {
            if (existsSync(tpl)) return;
            recordTemplateRoot(slot.dir, h.cwd);
            const adopt = this.slots.adoptable(slot);
            if (adopt) {
              try {
                copyFileSync(adopt.full, tpl, fsConstants.COPYFILE_FICLONE);
                utimesSync(tpl, new Date(), new Date(adopt.mtime));
                logEvent({ level: 'info', kind: 'template', envId: h.envId, detail: `adopted template ${adopt.dir}/${slot.file} of '${this.name}' (${preset}) as the shared one — no bake` });
                return;
              } catch {
                rmSync(tpl, { force: true }); // retired meanwhile: bake instead
              }
            }
            await this.runCreate(h.cwd, tpl, preset); // bake once
          });
        }
        // Restores share the lock: several copies at once, but never while a
        // writer replaces or deletes the template.
        const copied = await withDatastoreLock(slot.dir, this.name, false, async () => {
          if (!existsSync(tpl)) return false; // retired between the bake and here: bake again
          // The sidecars MUST go before the .db is replaced. SQLite in WAL mode
          // recovers `-wal` frames onto whatever database file it finds, so a
          // leftover WAL from the previous lease would be replayed over the fresh
          // template — resurrecting the old lease's rows inside a supposedly reset
          // store, or corrupting it outright.
          dropSidecars(dbPath);
          copyFileSync(tpl, dbPath, fsConstants.COPYFILE_FICLONE); // restore = CoW clone where the fs supports it
          return true;
        });
        if (copied) return;
        if (attempt >= 2) throw new BrokerError('env-error', `template for '${this.name}' preset '${preset}' kept disappearing before it could be restored`, 'datastore');
      }
    } else {
      dropSidecars(dbPath);
      await this.runCreate(h.cwd, dbPath, preset);
    }
  }

  dropCommand(_h: DsHandle): string | null {
    return null;
  }

  async drop(h: DsHandle): Promise<void> {
    const db = this.ns(h);
    rmSync(db, { force: true });
    dropSidecars(db); // an orphaned -wal outlives its database and poisons the next one
  }
  templateBaked(preset: string): boolean {
    return this.spec.template === true && existsSync(this.slots.path(this.slots.resolve(preset)));
  }

  rebake(_cwd?: string): Promise<void> {
    // Exclusive on this datastore: it must wait out any in-flight bake or
    // restore. Only THIS datastore's current templates go — every other
    // datastore's, and older keys (retention collects those), stay. A shared
    // datastore drops only this worktree's private templates: the shared one
    // serves other worktrees, and the bake that follows is private (0044).
    const priv = this.slots.shared;
    return withDatastoreLock(this.stackId, this.name, true, async () => {
      for (const preset of presetNames(this.spec)) rmSync(join(templatesRoot(), this.stackId, this.slots.file(preset, priv)), { force: true });
    });
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
  readonly fileBased = false;
  private readonly slots: TemplateSlots;
  constructor(
    readonly name: string,
    private readonly spec: DatastoreSpec,
    private readonly stackId: string,
    private readonly scope: TemplateScope = {},
  ) {
    if (!spec.url) {
      throw new BrokerError('work-error', `datastore '${name}' (driver ${spec.driver}) needs a url: template with {{ns}}`, 'manifest');
    }
    this.slots = new TemplateSlots(name, stackId, scope, sharesTemplates(spec, scope), '.baked', () => this.contentKey().slice(0, 12));
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
    const raw = `backlot_${h.envId}_${this.name}`.replace(/[^A-Za-z0-9_]/g, '_');
    // Postgres truncates identifiers at 63 bytes, and the disambiguating name
    // sits at the END — same defense as templateNs(): trim the middle, keep a
    // hash of the full identity so long names never collapse onto one db.
    const LIMIT = 63;
    if (raw.length <= LIMIT) return raw;
    const suffix = `_${sha256(raw).slice(0, 8)}`;
    return raw.slice(0, LIMIT - suffix.length) + suffix;
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
    return sha256(this.scope.bakeKey ? `${base}\n@bake:${this.scope.bakeKey}` : base);
  }
  /**
   * The database a bake into `slot` creates: `backlot_tpl_<dir>_<preset>_<hash>`,
   * where `<dir>` is the stack id, or `<name>@shared` for a shared template —
   * never one worktree's id (decision 0044). A private (pristine) template
   * carries `own`. `fresh` appends a nonce: a bake never drops a database
   * another marker still names (an adopted template keeps its old name).
   */
  private templateNs(slot: TemplateSlot, preset: string, fresh = false): string {
    const hash = this.contentKey().slice(0, 8);
    const nonce = fresh ? `_${Math.random().toString(36).slice(2, 8)}` : '';
    const raw = `backlot_tpl_${slot.dir}_${slot.private ? 'own_' : ''}${preset}_${hash}${nonce}`.replace(/[^A-Za-z0-9_]/g, '_');
    // Postgres truncates identifiers at 63 bytes, and the DISAMBIGUATING hash
    // is at the end — so a long stack id silently cut it off and two different
    // templates collapsed onto one database. Trim the stack/preset middle
    // instead, and always keep the hash.
    const LIMIT = 63;
    if (raw.length <= LIMIT) return raw;
    const suffix = `_${hash}${nonce}`;
    return raw.slice(0, LIMIT - suffix.length) + suffix;
  }

  templateRef(preset: string): string | null {
    if (!this.spec.template_restore || this.spec.ephemeral) return null;
    const slot = this.slots.resolve(preset);
    return `${slot.dir}/${slot.file}`;
  }

  dropRecipe(h: DsHandle): { cmd?: string; cwd?: string; ns?: string } {
    // `ns` rides along so `pool doctor` counts the namespace as referenced
    // from the moment the drop is recorded — before the restore creates it.
    return this.spec.drop ? { cmd: template(this.spec.drop, { ns: this.ns(h) }), cwd: h.cwd, ns: this.ns(h) } : { ns: this.ns(h) };
  }

  async ensure(h: DsHandle, preset: string, force: boolean, exists: boolean): Promise<void> {
    const nsE = this.ns(h);
    recordNamespace(nsE, this.stackId);
    if (this.spec.ephemeral) {
      // Ephemeral (redis-class): no presets, no templates — reset = the drop:
      // command as a flush; create (optional) runs only on first bind.
      if (force && exists && this.spec.drop) {
        // For an ephemeral store the drop command IS the reset. Swallowing its
        // failure handed the caller an environment that reported reset-data
        // hygiene while still holding the previous lease's keys.
        await sh(template(this.spec.drop, { ns: nsE }), h.cwd, `flush failed for ephemeral '${this.name}' — the store was NOT reset`);
      }
      if (!exists && this.spec.create) {
        await sh(template(this.spec.create, { ns: nsE, preset }), h.cwd, `create failed for ephemeral '${this.name}'`);
      }
      return;
    }
    if (exists && !force) return;
    if (!this.spec.create) throw new BrokerError('work-error', `datastore '${this.name}' has no create: command`, 'datastore');
    const create = this.spec.create; // narrowed copy for the closure below
    const ns = this.ns(h);
    if (this.spec.drop) await shQuiet(template(this.spec.drop, { ns }), h.cwd); // clean slate, best-effort
    if (this.spec.template_restore) {
      // Where this restore reads from (decision 0044): this worktree's
      // private template, the shared one, or the stack's own. The lock is
      // keyed by that dir, so every worktree sharing a template bakes it once
      // and restores from it side by side.
      const slot = this.slots.resolve(preset);
      const lockDir = slot.dir;
      const marker = this.slots.path(slot);
      mkdirSync(dirname(marker), { recursive: true });
      const bake = async (why?: string) => {
        // The database this marker names now, if any: a rebake reuses it
        // unless another marker names it too (an adopted template's other
        // copy) — then it bakes into a fresh name and leaves that one alone.
        let current: string | undefined;
        try {
          current = parseBakedMarker(readFileSync(marker, 'utf8')).ns || undefined;
        } catch {
          current = undefined;
        }
        let tpl = current ?? this.templateNs(slot, preset);
        if (hasOtherTemplateOwner(marker, tpl)) tpl = this.templateNs(slot, preset, true);
        recordNamespace(tpl, slot.dir);
        if (why) logEvent({ level: 'warn', kind: 'template', envId: h.envId, detail: `rebaking template ${tpl} of '${this.name}' (${preset}): ${why}` });
        recordTemplateRoot(slot.dir, h.cwd);
        await shQuiet(this.spec.drop ? template(this.spec.drop, { ns: tpl }) : 'true', h.cwd);
        await sh(template(create, { ns: tpl, preset }), h.cwd, `template bake failed for '${this.name}' preset '${preset}'${why ? ` (${why})` : ''}`);
        const baked: BakedMarker = {
          v: 1,
          ns: tpl,
          drop: this.spec.drop ? template(this.spec.drop, { ns: tpl }) : null,
          ds: this.name,
          bakedAt: Date.now(),
          nonce: Math.random().toString(36).slice(2, 10),
          ...(slot.shared ? { shared: true } : {}),
          ...(slot.private ? { private: true } : {}),
        };
        writeFileSync(marker, JSON.stringify(baked));
      };
      // Migration (decision 0044): a per-worktree template with the same
      // file name was baked from the same inputs — adopt it instead of baking.
      const adopt = (): boolean => {
        const src = this.slots.adoptable(slot);
        if (!src) return false;
        try {
          const legacy = parseBakedMarker(readFileSync(src.full, 'utf8'));
          if (!legacy.ns) return false;
          const adopted: BakedMarker = { ...legacy, ds: legacy.ds ?? this.name, shared: true, adoptedFrom: src.dir };
          writeFileSync(marker, JSON.stringify(adopted));
          utimesSync(marker, new Date(), new Date(src.mtime));
          logEvent({ level: 'info', kind: 'template', envId: h.envId, detail: `adopted template ${legacy.ns} (${src.dir}) of '${this.name}' (${preset}) as the shared one — no bake` });
          return true;
        } catch {
          return false;
        }
      };
      // One restore under the SHARED lock: no bake, rebake, prune or failed
      // sibling can drop the template while it is copied. `gone` = the marker
      // was retired between the bake and the restore. A retry first drops
      // what the failed attempt may have left (a half-created database makes
      // RESTORE / CREATE DATABASE fail on "already exists").
      let tried = false;
      const restore = (): Promise<{ ok: true } | { gone: true } | { err: Error; seen: string }> =>
        withDatastoreLock(lockDir, this.name, false, async () => {
          let seen: string;
          try {
            seen = readFileSync(marker, 'utf8');
          } catch {
            return { gone: true as const };
          }
          // The marker names the database: an adopted or nonce-named template
          // is not where the current naming would put it.
          const tpl = parseBakedMarker(seen).ns || this.templateNs(slot, preset);
          if (tried && this.spec.drop) await shQuiet(template(this.spec.drop, { ns }), h.cwd);
          tried = true;
          try {
            await sh(template(this.spec.template_restore!, { template: tpl, ns }), h.cwd, `template restore failed for '${this.name}' preset '${preset}'`);
            return { ok: true as const };
          } catch (err) {
            return { err: err as Error, seen };
          }
        });
      let failure: { err: Error; seen: string } | null = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        // Bake under the exclusive lock, once per template key (decision
        // 0039): a marker whose key matches IS the current template. Checked
        // twice, so a restore of an existing template never waits for (or
        // blocks) anyone with an exclusive lock.
        if (!existsSync(marker)) {
          await withDatastoreLock(lockDir, this.name, true, async () => {
            if (!existsSync(marker) && !adopt()) await bake();
          });
        }
        const r = await restore();
        if ('ok' in r) return;
        if ('gone' in r) continue;
        const tplOf = parseBakedMarker(r.seen).ns;
        const detail = `${r.err.message}${r.err instanceof BrokerError && r.err.logExcerpt ? `: ${r.err.logExcerpt.trim().split('\n').slice(-3).join(' | ').slice(-400)}` : ''}`;
        if (failure === null) {
          // The first failure is retried as it is: a transient error (a lock
          // wait in the repo's restore script, a busy server) must not cost a
          // bake. It is never silent any more.
          logEvent({ level: 'warn', kind: 'template', envId: h.envId, detail: `restoring '${this.name}' (${preset}) from template ${tplOf} into ${ns} failed — retrying the restore: ${detail}` });
          failure = r;
          continue;
        }
        // Failed twice from a template that is still on record. The marker is
        // LOCAL and the template database lives on the server: wipe the
        // appliance (docker rm -f, volume prune) and the marker still claims a
        // template that no longer exists, so every bind would fail forever.
        // Rebake it — unless another restore already did (the marker changed).
        const lastErr = r.err;
        await withDatastoreLock(lockDir, this.name, true, async () => {
          let now: string | null = null;
          try {
            now = readFileSync(marker, 'utf8');
          } catch {
            now = null;
          }
          if (now !== null && now !== r.seen) return; // rebaked by someone else meanwhile
          await bake(`two restores from it failed, last: ${detail}`);
        });
        const again = await restore();
        if ('ok' in again) return;
        if ('gone' in again) continue;
        throw new BrokerError('work-error', `template restore failed for '${this.name}' preset '${preset}', also after a rebake (before it: ${lastErr.message})`, 'datastore', again.err instanceof BrokerError ? again.err.logExcerpt : undefined);
      }
      throw new BrokerError('env-error', `template for '${this.name}' preset '${preset}' kept disappearing before it could be restored`, 'datastore');
    } else {
      await sh(template(this.spec.create, { ns, preset }), h.cwd, `seed failed for '${this.name}' preset '${preset}'`);
    }
  }

  dropCommand(h: DsHandle): string | null {
    return this.spec.drop ? template(this.spec.drop, { ns: this.ns(h) }) : null;
  }

  async drop(h: DsHandle): Promise<void> {
    if (this.spec.drop) await shQuiet(template(this.spec.drop, { ns: this.ns(h) }), h.cwd);
  }
  templateBaked(preset: string): boolean {
    return Boolean(this.spec.template_restore) && !this.spec.ephemeral && existsSync(this.slots.path(this.slots.resolve(preset)));
  }

  async rebake(cwd?: string): Promise<void> {
    // Drop the server-side template DBs recorded in the markers before
    // deleting the markers — otherwise `backlot_tpl_*` databases leak on the
    // appliance forever (vetbill-1i49).
    //
    // The drop command comes from the MANIFEST and is written to run in the
    // repo (it may invoke a repo-local script or a relative tool). Running it
    // in templatesRoot() made it fail, and shQuiet swallows failures — so the
    // leak fix silently did nothing. Fall back only when no root is known.
    //
    // Exclusive on this datastore: waits out its in-flight bakes and restores.
    // Only THIS datastore's current templates go (decision 0039); the others,
    // and older keys of this one (retention collects those), stay. A shared
    // datastore drops only this worktree's PRIVATE templates (decision 0044):
    // the shared one serves the other worktrees, and the bake that follows
    // `--pristine` is a private one.
    const priv = this.slots.shared;
    await withDatastoreLock(this.stackId, this.name, true, async () => {
      const dir = join(templatesRoot(), this.stackId);
      const key = `@${this.contentKey().slice(0, 12)}${priv ? PRIVATE_TEMPLATE_TAG : ''}.baked`;
      const catalog = new Set(presetNames(this.spec));
      let files: string[] = [];
      try {
        files = readdirSync(dir).filter((f) => f.startsWith(`${this.name}-`) && f.endsWith(key));
      } catch {
        return;
      }
      for (const f of files) {
        const file = join(dir, f);
        let baked: BakedMarker | null = null;
        try {
          baked = parseBakedMarker(readFileSync(file, 'utf8'));
        } catch {
          baked = null; // unreadable: removing it is all that is left to do
        }
        // A marker names its datastore since 0.18; an older one is this
        // datastore's when its preset is one this datastore offers.
        const preset = f.slice(this.name.length + 1, -key.length);
        if (baked?.ds !== undefined ? baked.ds !== this.name : !catalog.has(preset)) continue;
        if (baked?.drop && !hasOtherTemplateOwner(file, baked.ns)) await shQuiet(baked.drop, cwd ?? templatesRoot());
        rmSync(file, { force: true });
      }
    });
  }
}

// ---------------------------------------------------------------- factory

/**
 * `scope` is the template scope; a bare string is the bake key alone (per
 * stack, as before 0.20 — unit tests and callers that only read the url).
 */
export function makeDatastore(name: string, spec: DatastoreSpec, stackId: string, scope?: string | TemplateScope): DsDriver {
  const sc: TemplateScope = typeof scope === 'string' ? { bakeKey: scope } : (scope ?? {});
  // The datastore KEY becomes part of a filename (sqlite database, .baked
  // marker), so a key with a separator or `..` would escape the state root.
  // Checked here for EVERY driver: the command family builds marker paths too,
  // and only the sqlite driver used to guard this.
  if (/[/\\]|(^|[/\\])\.\.($|[/\\])/.test(name)) {
    throw new BrokerError('work-error', `datastore key '${name}' must not contain path separators or '..'`, 'manifest');
  }
  switch (spec.driver) {
    case 'sqlite':
      return new SqliteDs(name, spec, stackId, sc);
    case 'postgres':
    case 'mssql':
    case 'mysql':
    case 'redis':
      return new CommandDs(name, spec, stackId, sc);
    default:
      throw new BrokerError('work-error', `unknown datastore driver '${(spec as { driver: string }).driver}'`, 'manifest');
  }
}

/**
 * Datastore drivers (see docs/driver-spec.md).
 *
 * Two families:
 *  - sqlite: fully engine-native — the ns IS a file; template restore is a copy.
 *  - command (postgres/mssql/mysql/redis): ALL mechanics are repo-declared
 *    commands ({{ns}}/{{preset}}/{{template}} resolved by the engine). infront
 *    embeds no database clients — the anti-scope ("orchestrate, don't
 *    reimplement") applied to data.
 *
 * Template model: bake once per seed-content hash into a template ns, then
 * restore per environment (postgres: `createdb -T`; mssql: the repo's
 * backup/restore script). Templates are machine-global and immutable-keyed
 * (decision 0006/0008).
 */
import { copyFileSync, mkdirSync, rmSync, existsSync, writeFileSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { templatesRoot } from '../core/paths.js';
import { sha256, template, BrokerError } from '../core/util.js';
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
  /** @rebake-template: invalidate baked templates. */
  rebake(): void;
}

const sh = (cmd: string, cwd: string, errCtx: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('sh', ['-c', cmd], { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) reject(new BrokerError('work-error', errCtx, 'datastore', String(stderr).slice(0, 800)));
      else resolve();
    });
  });

const shQuiet = (cmd: string, cwd: string): Promise<void> =>
  new Promise((resolve) => {
    execFile('sh', ['-c', cmd], { cwd, maxBuffer: 16 * 1024 * 1024 }, () => resolve());
  });

// ---------------------------------------------------------------- sqlite

class SqliteDs implements DsDriver {
  constructor(
    readonly name: string,
    private readonly spec: DatastoreSpec,
    private readonly stackId: string,
  ) {}

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
    return join(dir, `${this.name}-${preset}@${sha256(this.spec.create ?? '').slice(0, 12)}.db`);
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
      if (!existsSync(tpl)) await this.runCreate(h.envTree, tpl, preset); // bake once
      copyFileSync(tpl, dbPath, fsConstants.COPYFILE_FICLONE); // restore = CoW clone where the fs supports it
    } else {
      await this.runCreate(h.envTree, dbPath, preset);
    }
  }

  async drop(h: DsHandle): Promise<void> {
    rmSync(this.ns(h), { force: true });
  }
  rebake(): void {
    rmSync(join(templatesRoot(), this.stackId), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- command family

class CommandDs implements DsDriver {
  constructor(
    readonly name: string,
    private readonly spec: DatastoreSpec,
    private readonly stackId: string,
  ) {
    if (!spec.url) {
      throw new BrokerError('work-error', `datastore '${name}' (driver ${spec.driver}) needs a url: template with {{ns}}`, 'manifest');
    }
  }

  get capabilities(): { template: boolean; ephemeral: boolean } {
    return { template: Boolean(this.spec.template_restore), ephemeral: this.spec.ephemeral === true };
  }

  ns(h: DsHandle): string {
    return `infront_${h.envId}`.replace(/[^A-Za-z0-9_]/g, '_');
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

  private templateNs(preset: string): string {
    return `infront_tpl_${this.stackId}_${preset}_${sha256(this.spec.create ?? '').slice(0, 8)}`.replace(/[^A-Za-z0-9_]/g, '_');
  }
  private bakedMarker(preset: string): string {
    const dir = join(templatesRoot(), this.stackId);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${this.name}-${preset}@${sha256(this.spec.create ?? '').slice(0, 12)}.baked`);
  }

  async ensure(h: DsHandle, preset: string, force: boolean, exists: boolean): Promise<void> {
    const nsE = this.ns(h);
    if (this.spec.ephemeral) {
      // Ephemeral (redis-class): no presets, no templates — reset = the drop:
      // command as a flush; create (optional) runs only on first bind.
      if (force && exists && this.spec.drop) await shQuiet(template(this.spec.drop, { ns: nsE }), h.envTree);
      if (!exists && this.spec.create) {
        await sh(template(this.spec.create, { ns: nsE, preset }), h.envTree, `create failed for ephemeral '${this.name}'`);
      }
      return;
    }
    if (exists && !force) return;
    if (!this.spec.create) throw new BrokerError('work-error', `datastore '${this.name}' has no create: command`, 'datastore');
    const ns = this.ns(h);
    if (this.spec.drop) await shQuiet(template(this.spec.drop, { ns }), h.envTree); // clean slate, best-effort
    if (this.spec.template_restore) {
      const tpl = this.templateNs(preset);
      if (!existsSync(this.bakedMarker(preset))) {
        await shQuiet(this.spec.drop ? template(this.spec.drop, { ns: tpl }) : 'true', h.envTree);
        await sh(template(this.spec.create, { ns: tpl, preset }), h.envTree, `template bake failed for '${this.name}' preset '${preset}'`);
        writeFileSync(this.bakedMarker(preset), tpl);
      }
      await sh(template(this.spec.template_restore, { template: tpl, ns }), h.envTree, `template restore failed for '${this.name}' preset '${preset}'`);
    } else {
      await sh(template(this.spec.create, { ns, preset }), h.envTree, `seed failed for '${this.name}' preset '${preset}'`);
    }
  }

  async drop(h: DsHandle): Promise<void> {
    if (this.spec.drop) await shQuiet(template(this.spec.drop, { ns: this.ns(h) }), h.envTree);
  }
  rebake(): void {
    rmSync(join(templatesRoot(), this.stackId), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- factory

export function makeDatastore(name: string, spec: DatastoreSpec, stackId: string): DsDriver {
  switch (spec.driver) {
    case 'sqlite':
      return new SqliteDs(name, spec, stackId);
    case 'postgres':
    case 'mssql':
    case 'mysql':
    case 'redis':
      return new CommandDs(name, spec, stackId);
    default:
      throw new BrokerError('work-error', `unknown datastore driver '${(spec as { driver: string }).driver}'`, 'manifest');
  }
}

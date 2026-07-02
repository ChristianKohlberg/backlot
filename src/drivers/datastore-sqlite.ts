/**
 * sqlite datastore driver: the zero-infrastructure reference implementation.
 * A namespace is a file under the environment's data dir; template bake/restore
 * is a file copy keyed by preset + create-command hash (decision 0006/0008).
 */
import { copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { templatesRoot } from '../core/paths.js';
import { sha256, template, BrokerError } from '../core/util.js';
import type { DatastoreSpec } from '../core/manifest.js';

export interface DatastoreBinding {
  name: string;
  url: string;
}

export class SqliteDatastore {
  constructor(
    private readonly name: string,
    private readonly spec: DatastoreSpec,
    private readonly stackId: string,
  ) {}

  get capabilities(): { template: boolean; ephemeral: boolean } {
    return { template: this.spec.template === true, ephemeral: false };
  }

  /** ns for sqlite = the db file path inside the env's data dir. */
  url(dataDir: string): string {
    return join(dataDir, `${this.name}.db`);
  }

  async probe(): Promise<void> {
    // sqlite is in-process — nothing external to probe.
  }

  private seedKey(preset: string): string {
    return `${this.name}-${preset}@${sha256(this.spec.create ?? '').slice(0, 12)}`;
  }

  private templatePath(preset: string): string {
    const dir = join(templatesRoot(), this.stackId);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${this.seedKey(preset)}.db`);
  }

  private runCreate(envTree: string, dbPath: string, preset: string): Promise<void> {
    const cmd = this.spec.create;
    if (!cmd) throw new BrokerError('work-error', `datastore '${this.name}' has no create: command`, 'datastore');
    const resolved = template(cmd, { ns: dbPath, preset });
    return new Promise((resolve, reject) => {
      execFile('sh', ['-c', resolved], { cwd: envTree, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
        if (err) {
          reject(
            new BrokerError('work-error', `seed failed for '${this.name}' preset '${preset}'`, 'datastore', String(stderr).slice(0, 800)),
          );
        } else resolve();
      });
    });
  }

  /** Create/restore the namespace at the given preset. Template-first. */
  async create(envTree: string, dataDir: string, preset: string): Promise<DatastoreBinding> {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = this.url(dataDir);
    if (this.capabilities.template) {
      const tpl = this.templatePath(preset);
      if (!existsSync(tpl)) {
        await this.runCreate(envTree, tpl, preset); // bake once per seed-content hash
      }
      copyFileSync(tpl, dbPath); // restore = file copy: seconds, deterministic
    } else {
      await this.runCreate(envTree, dbPath, preset);
    }
    return { name: this.name, url: dbPath };
  }

  drop(dataDir: string): void {
    rmSync(this.url(dataDir), { force: true });
  }

  /** @rebake-template: invalidate baked templates so the next create re-seeds. */
  rebake(): void {
    rmSync(join(templatesRoot(), this.stackId), { recursive: true, force: true });
  }
}

export function makeDatastore(name: string, spec: DatastoreSpec, stackId: string): SqliteDatastore {
  if (spec.driver !== 'sqlite') {
    throw new BrokerError(
      'infra-error',
      `datastore driver '${spec.driver}' is not implemented yet (v0.1 ships sqlite; postgres/mssql land in 0.2)`,
      'datastore',
    );
  }
  return new SqliteDatastore(name, spec, stackId);
}

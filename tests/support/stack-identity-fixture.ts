/** Shared fixture of the physical-stack-identity tests (stack-identity*.test.ts). */
import { expect } from 'vitest';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../../src/core/journal.js';
import { disposeStateSync } from './leaks.js';


export const CLI = join(import.meta.dirname, '..', '..', 'dist/cli/index.js');
export type Context = { datastores: Record<string, { url: string }>; envId: string; urls: Record<string, string>; error?: { message: string }; lease: { id: string } };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const legacyIdentity = (alias: string, name = 'identity') => `${name}-${createHash('sha256').update(alias).digest('base64url').slice(0, 8)}`;
/**
 * A second environment for tests that rebuild an OLDER journal, which could
 * hold several environments for one worktree. This daemon never creates that
 * (decision 0032: one environment per worktree), so the second one is bound
 * from a copy of the worktree and then rewritten into the legacy shape.
 */
export const secondWorktree = (f: { root: string; wt: string }) => {
  const copy = join(f.root, 'copy');
  if (!existsSync(copy)) cpSync(f.wt, copy, { recursive: true });
  return copy;
};
export const notesIn = (url: string) => {
  const db = new DatabaseSync(url);
  try { return db.prepare('SELECT note FROM notes').all(); } finally { db.close(); }
};
export function fixture(sweepMs = 60000, name = 'identity') {
  // macOS's tmpdir can itself be an alias (/var -> /private/var). Only
  // `alias` below should carry a lexical identity; `wt` must be physical.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'backlot-identity-')));
  const wt = join(root, 'real'); mkdirSync(wt);
  const alias = join(root, 'alias'); symlinkSync(wt, alias, 'dir');
  const state = join(root, 'state');
  writeFileSync(join(wt, 'backlot.yml'), `name: ${name}\nservices:\n  web:\n    run: node server.mjs\n    port: http\n    env: {PORT: "{{ports.http}}"}\n    ready: {http: /, timeout: 10}\ndatastores:\n  main: {driver: sqlite, create: 'node seed.mjs {{ns}}', presets: [default]}\n`);
  writeFileSync(join(wt, 'seed.mjs'), "import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.argv[2]);db.exec('CREATE TABLE IF NOT EXISTS notes (note TEXT)');db.close();");
  writeFileSync(join(wt, 'server.mjs'), "import{createServer}from'node:http';createServer((q,r)=>r.end('ok')).listen(+process.env.PORT,'127.0.0.1');");
  const env: NodeJS.ProcessEnv = { ...process.env, BACKLOT_STATE_DIR: state, BACKLOT_HOLDER_PID: '', BACKLOT_SWEEP_MS: String(sweepMs) };
  const cli = async (args: string[], cwd = wt) => {
    const result = await new Promise<Context>((resolve, reject) => {
      execFile(process.execPath, [CLI, ...args, '--json'], { cwd, env }, (err, out, stderr) => {
        try { resolve(JSON.parse(out)); } catch { reject(new Error(String(err) + stderr + out)); }
      });
    });
    if (args[0] === 'daemon' && args[1] === 'stop' && !result.error) {
      // The reply precedes shutdown. Wait for teardown and election-lock
      // release before editing the journal or starting the replacement daemon.
      await expect.poll(() => !existsSync(join(state, 'daemon.sock')) && !existsSync(join(state, 'daemon.lock')),
        { timeout: 15000 }).toBe(true);
    }
    return result;
  };
  const at = (verb: string, cwd: string, holder?: string) => cli([verb, ...(holder === undefined ? [] : ['--holder', holder])], cwd);
  return { root, wt, alias, state, cli, at, env, name, cleanup: async () => {
    await cli(['pool', 'recycle', '--force']); await cli(['daemon', 'stop']); disposeStateSync(root);
  } };
}

/** Persist `envId` the way a pre-canonicalization daemon journaled it: lexical identity under the alias spelling. */
export function journalAsLegacyAlias(f: ReturnType<typeof fixture>, envId: string, keepLease: boolean): Journal {
  const journal = new Journal(join(f.state, 'journal.db'));
  const saved = journal.getEnv(envId)!;
  const lease = journal.leaseForEnv(envId);
  journal.deleteEnv(saved.id);
  journal.saveEnv({ ...saved, stack: legacyIdentity(f.alias, f.name), stackRoot: f.alias });
  if (keepLease && lease) journal.saveLease(lease);
  return journal;
}

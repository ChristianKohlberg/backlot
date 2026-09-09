import { expect, it } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../src/core/journal.js';

const CLI = join(import.meta.dirname, '..', 'dist/cli/index.js');
const MCP = join(import.meta.dirname, '..', 'dist/mcp/index.js');
type Context = { datastores: Record<string, { url: string }>; envId: string; urls: Record<string, string>; error?: { message: string }; lease: { id: string } };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'backlot-identity-'));
  const wt = join(root, 'real'); mkdirSync(wt);
  const alias = join(root, 'alias'); symlinkSync(wt, alias, 'dir');
  const state = join(root, 'state');
  writeFileSync(join(wt, 'backlot.yml'), `name: identity\nservices:\n  web:\n    run: node server.mjs\n    port: http\n    env: {PORT: "{{ports.http}}"}\n    ready: {http: /, timeout: 10}\ndatastores:\n  main: {driver: sqlite, create: 'node seed.mjs {{ns}}', presets: [default]}\n`);
  writeFileSync(join(wt, 'seed.mjs'), "import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.argv[2]);db.exec('CREATE TABLE IF NOT EXISTS notes (note TEXT)');db.close();");
  writeFileSync(join(wt, 'server.mjs'), "import{createServer}from'node:http';createServer((q,r)=>r.end('ok')).listen(+process.env.PORT,'127.0.0.1');");
  const env = { ...process.env, BACKLOT_STATE_DIR: state, BACKLOT_HOLDER_PID: '', BACKLOT_SWEEP_MS: '60000' };
  const cli = (args: string[]) => new Promise<Context>((resolve, reject) => {
    execFile(process.execPath, [CLI, ...args, '--json'], { cwd: wt, env }, (err, out, stderr) => {
      try { resolve(JSON.parse(out)); } catch { reject(new Error(String(err) + stderr + out)); }
    });
  });
  const mcp = (verb: string, cwd: string, holder?: string) => new Promise<Context>((resolve, reject) => {
    const p = spawn(process.execPath, [MCP], { cwd: wt, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { p.kill(); reject(new Error('MCP timeout')); }, 15000);
    let text = '';
    p.stdout.on('data', (chunk) => {
      text += String(chunk);
      const line = text.split('\n')[0];
      if (!text.includes('\n')) return;
      clearTimeout(timer); p.kill();
      try { resolve(JSON.parse(JSON.parse(line).result.content[0].text)); } catch (err) { reject(err); }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `backlot_${verb}`, arguments: { cwd, holder, holderPid: process.pid } } }) + '\n');
  });
  return { root, wt, alias, state, cli, mcp, cleanup: async () => {
    await cli(['pool', 'recycle', '--force']); await cli(['daemon', 'stop']); rmSync(root, { recursive: true, force: true });
  } };
}

it('canonical CLI and symlink MCP share one lease for the same holder', async () => {
  const f = fixture();
  try {
    const first = await f.cli(['up', '--holder', 'owner']);
    const context = await f.mcp('ctx', f.alias, 'owner');
    expect(context.error).toBeUndefined();
    expect(context.envId).toBe(first.envId);
    const again = await f.mcp('up', f.alias, 'owner');
    expect(again.envId).toBe(first.envId);
    expect(again.urls).toEqual(first.urls);
    expect(again.lease.id).toBe(first.lease.id);
  } finally { await f.cleanup(); }
}, 30000);

for (const oldDefault of [false, true]) {
  it(`migrates a legacy alias stack without changing data or ownership (${oldDefault ? 'legacy path holder' : 'explicit holder'})`, async () => {
    const f = fixture();
    const holder = oldDefault ? f.alias : 'owner';
    try {
      const first = await f.cli(['up', '--holder', holder]);
      const store = new DatabaseSync(first.datastores.main.url);
      store.prepare('INSERT INTO notes VALUES (?)').run('user data survives migration');
      store.close();
      await f.cli(['daemon', 'stop']);
      const journal = new Journal(join(f.state, 'journal.db'));
      const saved = journal.getEnv(first.envId)!;
      const lease = journal.leaseForEnv(first.envId)!;
      const marker = join(saved.root, 'data', 'user-data.txt');
      writeFileSync(marker, 'preserve my data');
      // Reconstruct the durable identity written by a pre-canonicalization daemon.
      const legacyId = `identity-${createHash('sha256').update(f.alias).digest('base64url').slice(0, 8)}`;
      journal.deleteEnv(saved.id);
      journal.saveEnv({ ...saved, stack: legacyId, stackRoot: f.alias });
      journal.saveLease(lease);
      if (oldDefault) {
        const implicit = await f.cli(['up']);
        expect(implicit.error?.message).toMatch(/holder/);
        const context = await f.cli(['ctx']);
        expect(context.error?.message).toMatch(/holder/);
      }
      const context = await f.cli(['ctx', '--holder', holder]);
      expect(context.error).toBeUndefined();
      expect(context.envId).toBe(first.envId);
      expect(context.urls).toEqual(first.urls);
      expect(context.lease.id).toBe(first.lease.id);
      expect(context.datastores.main.url).toBe(first.datastores.main.url);
      const preserved = new DatabaseSync(context.datastores.main.url);
      expect(preserved.prepare('SELECT note FROM notes').all()).toEqual([{ note: 'user data survives migration' }]);
      preserved.close();
      expect(readFileSync(marker, 'utf8')).toBe('preserve my data');
      const migrated = journal.getEnv(first.envId)!;
      expect(migrated.datastoreNs).toEqual(saved.datastoreNs);
      expect(journal.allEnvs()).toHaveLength(1);
      await f.cli(['release', '--holder', holder]);
      expect(journal.leaseForEnv(first.envId)).toBeUndefined();
    } finally { await f.cleanup(); }
  }, 30000);
}


it('new implicit holders also canonicalize, while distinct Git worktrees stay separate', async () => {
  const f = fixture();
  try {
    execFileSync('git', ['init', '-q'], { cwd: f.wt });
    execFileSync('git', ['add', '.'], { cwd: f.wt });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: f.wt });
    const other = join(f.root, 'other-worktree');
    execFileSync('git', ['worktree', 'add', '--detach', other], { cwd: f.wt, stdio: 'ignore' });
    const first = await f.cli(['up']);
    expect((await f.mcp('ctx', f.alias)).envId).toBe(first.envId);
    const distinct = await f.mcp('up', other);
    expect(distinct.error).toBeUndefined();
    expect(distinct.envId).not.toBe(first.envId);
    expect(distinct.urls).not.toEqual(first.urls);
  } finally { await f.cleanup(); }
}, 30000);

it('converged same-holder legacy leases refuse ambiguity without deleting either environment', async () => {
  const f = fixture();
  try {
    const first = await f.cli(['up', '--holder', 'owner']);
    const second = await f.cli(['up', '--holder', 'other']);
    await f.cli(['daemon', 'stop']);
    const journal = new Journal(join(f.state, 'journal.db'));
    const saved = journal.getEnv(second.envId)!;
    const lease = journal.leaseForEnv(second.envId)!;
    journal.deleteEnv(saved.id);
    journal.saveEnv({ ...saved, stackRoot: f.alias, stack: `identity-${createHash('sha256').update(f.alias).digest('base64url').slice(0, 8)}` });
    journal.saveLease({ ...lease, holder: 'owner' });
    const result = await f.cli(['up', '--holder', 'owner']);
    expect(result.error?.message).toMatch(/ambiguous/);
    expect(result.error?.message).toContain(first.envId);
    expect(result.error?.message).toContain(second.envId);
    expect(journal.allEnvs()).toHaveLength(2);
    expect(journal.allLeases()).toHaveLength(2);
  } finally { await f.cleanup(); }
}, 30000);

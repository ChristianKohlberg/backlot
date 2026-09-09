import { expect, it } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../src/core/journal.js';
import { retireBakedTemplates } from '../src/drivers/datastores.js';
import { pruneTemplates } from '../src/core/retention.js';
import type { Policy } from '../src/core/policy.js';

const CLI = join(import.meta.dirname, '..', 'dist/cli/index.js');
const MCP = join(import.meta.dirname, '..', 'dist/mcp/index.js');
type Context = { datastores: Record<string, { url: string }>; envId: string; urls: Record<string, string>; error?: { message: string }; lease: { id: string } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const legacyIdentity = (alias: string, name = 'identity') => `${name}-${createHash('sha256').update(alias).digest('base64url').slice(0, 8)}`;
const notesIn = (url: string) => {
  const db = new DatabaseSync(url);
  try { return db.prepare('SELECT note FROM notes').all(); } finally { db.close(); }
};
function fixture(sweepMs = 60000, name = 'identity') {
  const root = mkdtempSync(join(tmpdir(), 'backlot-identity-'));
  const wt = join(root, 'real'); mkdirSync(wt);
  const alias = join(root, 'alias'); symlinkSync(wt, alias, 'dir');
  const state = join(root, 'state');
  writeFileSync(join(wt, 'backlot.yml'), `name: ${name}\nservices:\n  web:\n    run: node server.mjs\n    port: http\n    env: {PORT: "{{ports.http}}"}\n    ready: {http: /, timeout: 10}\ndatastores:\n  main: {driver: sqlite, create: 'node seed.mjs {{ns}}', presets: [default]}\n`);
  writeFileSync(join(wt, 'seed.mjs'), "import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(process.argv[2]);db.exec('CREATE TABLE IF NOT EXISTS notes (note TEXT)');db.close();");
  writeFileSync(join(wt, 'server.mjs'), "import{createServer}from'node:http';createServer((q,r)=>r.end('ok')).listen(+process.env.PORT,'127.0.0.1');");
  const env: NodeJS.ProcessEnv = { ...process.env, BACKLOT_STATE_DIR: state, BACKLOT_HOLDER_PID: '', BACKLOT_SWEEP_MS: String(sweepMs) };
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
  return { root, wt, alias, state, cli, mcp, env, name, cleanup: async () => {
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

/** Persist `envId` the way a pre-canonicalization daemon journaled it: lexical identity under the alias spelling. */
function journalAsLegacyAlias(f: ReturnType<typeof fixture>, envId: string, keepLease: boolean): Journal {
  const journal = new Journal(join(f.state, 'journal.db'));
  const saved = journal.getEnv(envId)!;
  const lease = journal.leaseForEnv(envId);
  journal.deleteEnv(saved.id);
  journal.saveEnv({ ...saved, stack: legacyIdentity(f.alias, f.name), stackRoot: f.alias });
  if (keepLease && lease) journal.saveLease(lease);
  return journal;
}

it('a manifest unreadable at daemon start defers migration; the sweeper migrates instead of reclaiming', async () => {
  const f = fixture(300);
  const manifest = join(f.wt, 'backlot.yml');
  const good = readFileSync(manifest, 'utf8');
  try {
    const first = await f.cli(['up', '--holder', 'owner']);
    const store = new DatabaseSync(first.datastores.main.url);
    store.prepare('INSERT INTO notes VALUES (?)').run('survives a deferred migration');
    store.close();
    await f.cli(['release', '--holder', 'owner']);
    await f.cli(['daemon', 'stop']);
    const journal = journalAsLegacyAlias(f, first.envId, false);
    writeFileSync(manifest, 'name: [broken\n');
    await f.cli(['status']); // autospawn: recovery sees an unreadable manifest
    await sleep(1000); // several sweeps judge the row while it is unreadable
    expect(journal.getEnv(first.envId)?.stack).toBe(legacyIdentity(f.alias));
    writeFileSync(manifest, good);
    await sleep(1200); // the first sweeps after the repair
    const migrated = journal.getEnv(first.envId);
    expect(migrated).toBeDefined();
    expect(migrated!.stack).not.toBe(legacyIdentity(f.alias));
    expect(migrated!.stackRoot).toBe(f.wt);
    expect(migrated!.legacyStackRoot).toBe(f.alias);
    const again = await f.cli(['up', '--holder', 'owner']);
    expect(again.error).toBeUndefined();
    expect(again.envId).toBe(first.envId);
    expect(notesIn(again.datastores.main.url)).toEqual([{ note: 'survives a deferred migration' }]);
    expect(journal.allEnvs()).toHaveLength(1);
  } finally { await f.cleanup(); }
}, 40000);

for (const oldDefault of [false, true]) {
  it(`a lease whose manifest was unreadable at daemon start is reused after repair, never duplicated (${oldDefault ? 'legacy path holder' : 'explicit holder'})`, async () => {
    const f = fixture();
    const holder = oldDefault ? f.alias : 'owner';
    const manifest = join(f.wt, 'backlot.yml');
    const good = readFileSync(manifest, 'utf8');
    try {
      const first = await f.cli(['up', '--holder', holder]);
      const store = new DatabaseSync(first.datastores.main.url);
      store.prepare('INSERT INTO notes VALUES (?)').run('leased data survives');
      store.close();
      await f.cli(['daemon', 'stop']);
      const journal = journalAsLegacyAlias(f, first.envId, true);
      writeFileSync(manifest, 'name: [broken\n');
      await f.cli(['status']);
      writeFileSync(manifest, good);
      if (oldDefault) {
        const implicit = await f.mcp('up', f.wt);
        expect(implicit.error?.message).toContain(`pass holder ${JSON.stringify(f.alias)} (--holder on the CLI)`);
        expect(journal.allEnvs()).toHaveLength(1);
      }
      const again = await f.cli(['up', '--holder', holder]);
      expect(again.error).toBeUndefined();
      expect(again.envId).toBe(first.envId);
      expect(again.lease.id).toBe(first.lease.id);
      expect(again.urls).toEqual(first.urls);
      expect(notesIn(again.datastores.main.url)).toEqual([{ note: 'leased data survives' }]);
      expect(journal.allEnvs()).toHaveLength(1);
      expect(journal.getEnv(first.envId)!.legacyStackRoot).toBe(f.alias);
      await f.cli(['release', '--holder', holder]);
      expect(journal.leaseForEnv(first.envId)).toBeUndefined();
    } finally { await f.cleanup(); }
  }, 40000);
}

it('templates keyed by the retired identity are dropped through their own markers, retrying until the drop succeeds', async () => {
  const f = fixture(300);
  try {
    const first = await f.cli(['up', '--holder', 'owner']);
    await f.cli(['release', '--holder', 'owner']);
    await f.cli(['daemon', 'stop']);
    const journal = journalAsLegacyAlias(f, first.envId, false);
    const retiredDir = join(f.state, 'templates', legacyIdentity(f.alias));
    mkdirSync(retiredDir, { recursive: true });
    writeFileSync(join(retiredDir, 'main-default@stale.db'), 'stale sqlite template');
    const applianceUp = join(f.root, 'appliance-up');
    const droppedAt = join(f.root, 'dropped');
    writeFileSync(join(retiredDir, 'main-default@stale.baked'), JSON.stringify({ v: 1, ns: 'backlot_tpl_stale', drop: `test -e '${applianceUp}' && touch '${droppedAt}'` }));
    await f.cli(['status']); // recovery migrates; retirement is deferred to maintenance
    await sleep(1000);
    expect(journal.getEnv(first.envId)!.legacyStackRoot).toBe(f.alias);
    expect(existsSync(droppedAt)).toBe(false);
    expect(existsSync(join(retiredDir, 'main-default@stale.baked'))).toBe(true); // deferred: the drop failed
    writeFileSync(applianceUp, '');
    await f.cli(['pool', 'gc']);
    expect(existsSync(droppedAt)).toBe(true);
    expect(existsSync(retiredDir)).toBe(false);
    const again = await f.cli(['up', '--holder', 'owner']);
    expect(again.envId).toBe(first.envId);
    expect(existsSync(again.datastores.main.url)).toBe(true);
    expect(journal.allEnvs()).toHaveLength(1);
  } finally { await f.cleanup(); }
}, 40000);


it('an existing canonical default lease remains reachable beside a migrated alias default lease', async () => {
  const f = fixture();
  try {
    const canonical = await f.cli(['up']);
    const alias = await f.cli(['up', '--holder', f.alias]);
    await f.cli(['daemon', 'stop']);
    const journal = journalAsLegacyAlias(f, alias.envId, true);
    const result = await f.cli(['up']);
    expect(result.error).toBeUndefined();
    expect(result.envId).toBe(canonical.envId);
    expect(result.urls).toEqual(canonical.urls);
    expect(result.lease.id).toBe(canonical.lease.id);
    expect(journal.allEnvs()).toHaveLength(2);
    expect(journal.leaseForEnv(alias.envId)?.holder).toBe(f.alias);
  } finally { await f.cleanup(); }
}, 30000);

it('recovery never runs a retired drop; failed drops retain actionable bounded retry records', async () => {
  const f = fixture();
  try {
    const first = await f.cli(['up', '--holder', 'owner']);
    await f.cli(['daemon', 'stop']);
    journalAsLegacyAlias(f, first.envId, true);
    const dir = join(f.state, 'templates', legacyIdentity(f.alias));
    mkdirSync(dir, { recursive: true });
    const count = join(f.root, 'drop-attempts');
    const marker = join(dir, 'main-default@missing.baked');
    writeFileSync(marker, JSON.stringify({ v: 1, ns: 'already-missing', drop: `echo attempt >> '${count}'; false` }));
    const context = await f.cli(['ctx', '--holder', 'owner']);
    expect(context.envId).toBe(first.envId);
    expect(existsSync(count), 'recovery must not run external template drops').toBe(false);
    for (let i = 0; i < 3; i++) await f.cli(['pool', 'gc']);
    expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(3);
    const failure = JSON.parse(readFileSync(`${marker}.retirement.json`, 'utf8'));
    expect(failure.attempts).toBe(3);
    expect(failure.state).toBe('needs-attention');
    expect(failure.message).toContain('pool gc');
    expect(existsSync(marker), 'unconfirmed drop must keep ownership metadata').toBe(true);
    const automatic = await retireBakedTemplates(dir, f.wt);
    expect(automatic.attempted).toBe(0);
    expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(3);
    await f.cli(['daemon', 'stop']);
    await f.cli(['ctx', '--holder', 'owner']);
    expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(3);
    await f.cli(['pool', 'recycle', '--force']);
    expect(existsSync(marker), 'retirement ownership outlives its last env').toBe(true);
    // The operator fixes the command to be idempotent for an already absent DB.
    writeFileSync(marker, JSON.stringify({ v: 1, ns: 'already-missing', drop: 'true' }));
    await f.cli(['pool', 'gc']);
    expect(existsSync(dir)).toBe(false);
  } finally { await f.cleanup(); }
}, 30000);


it('retirement bounds a hanging drop and processes only one marker per maintenance batch', async () => {
  const f = fixture();
  try {
    const first = await f.cli(['up', '--holder', 'owner']);
    await f.cli(['daemon', 'stop']);
    journalAsLegacyAlias(f, first.envId, true);
    const dir = join(f.state, 'templates', legacyIdentity(f.alias));
    mkdirSync(dir, { recursive: true });
    const hanging = join(dir, 'a-hang.baked');
    const second = join(dir, 'b-next.baked');
    writeFileSync(hanging, JSON.stringify({ v: 1, ns: 'hanging', drop: 'node -e "setInterval(()=>{},1000)"' }));
    writeFileSync(second, JSON.stringify({ v: 1, ns: 'next', drop: 'true' }));
    await f.cli(['ctx', '--holder', 'owner']);
    expect(existsSync(`${hanging}.retirement.json`)).toBe(false);
    // Completion itself proves the hanging command has a bounded maintenance timeout.
    await f.cli(['pool', 'gc']);
    expect(JSON.parse(readFileSync(`${hanging}.retirement.json`, 'utf8')).attempts).toBe(1);
    expect(existsSync(second), 'only one external command may run in a batch').toBe(true);
  } finally { await f.cleanup(); }
}, 15000);


it('periodic automatic GC respects three failed attempts and backoff', async () => {
  const f = fixture();
  try {
    const first = await f.cli(['up', '--holder', 'owner']);
    await f.cli(['daemon', 'stop']);
    journalAsLegacyAlias(f, first.envId, true);
    const dir = join(f.state, 'templates', legacyIdentity(f.alias));
    mkdirSync(dir, { recursive: true });
    const count = join(f.root, 'attempts');
    const marker = join(dir, 'failed.baked');
    writeFileSync(marker, JSON.stringify({ v: 1, ns: 'failed', drop: `echo attempt >> '${count}'; false` }));
    await f.cli(['status']);
    for (let i = 0; i < 3; i++) await f.cli(['pool', 'gc']);
    const failure = readFileSync(`${marker}.retirement.json`, 'utf8');
    expect(JSON.parse(failure).attempts).toBe(3);
    await f.cli(['daemon', 'stop']);
    f.env.BACKLOT_SWEEP_MS = '100';
    f.env.BACKLOT_GC_MS = '1';
    await f.cli(['status']);
    await sleep(1000);
    expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(3);
    expect(readFileSync(`${marker}.retirement.json`, 'utf8')).toBe(failure);
    await f.cli(['pool', 'gc']);
    expect(readFileSync(count, 'utf8').trim().split('\n')).toHaveLength(4);
  } finally { await f.cleanup(); }
}, 30000);

it('ordinary retention preserves retired markers and all cleanup records beyond templatesKeep', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlot-retired-retention-'));
  try {
    const dir = join(root, 'legacy');
    mkdirSync(dir);
    const dropped = join(root, 'dropped');
    const records: Record<string, string> = { '.retired-stack.json': JSON.stringify({ stack: 'canonical' }) };
    for (let i = 0; i < 8; i++) {
      records[`${i}.baked`] = JSON.stringify({ v: 1, ns: `template_${i}`, drop: `touch '${dropped}'; false` });
      records[`${i}.baked.retirement.json`] = JSON.stringify({ attempts: 3, state: 'needs-attention' });
    }
    for (const [file, content] of Object.entries(records)) writeFileSync(join(dir, file), content);
    expect(await pruneTemplates({ templatesKeep: 1 } as Policy, root)).toBe(0);
    expect(existsSync(dropped)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(Object.keys(records).sort());
    for (const [file, content] of Object.entries(records)) expect(readFileSync(join(dir, file), 'utf8')).toBe(content);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('retirement preserves a live template shared by long canonical and legacy stack names', async () => {
  const f = fixture(60000, 'a'.repeat(42));
  try {
    const appliance = join(f.root, 'appliance');
    mkdirSync(appliance);
    writeFileSync(join(f.wt, 'backlot.yml'), JSON.stringify({
      name: f.name,
      services: { web: { run: 'node server.mjs', port: 'http', env: { PORT: '{{ports.http}}' }, ready: { http: '/', timeout: 10 } } },
      datastores: { main: {
        driver: 'postgres', url: `${appliance}/{{ns}}`, presets: ['default'],
        create: `echo seeded > '${appliance}/{{ns}}'`,
        drop: `rm -f '${appliance}/{{ns}}'`,
        template_restore: `cp '${appliance}/{{template}}' '${appliance}/{{ns}}'`,
      } },
    }));
    const first = await f.cli(['up', '--holder', 'owner']);
    expect(first.error).toBeUndefined();
    await f.cli(['daemon', 'stop']);
    const journal = journalAsLegacyAlias(f, first.envId, true);
    const root = join(f.state, 'templates');
    const canonicalDir = join(root, legacyIdentity(f.wt, f.name));
    const retiredDir = join(root, legacyIdentity(f.alias, f.name));
    renameSync(canonicalDir, retiredDir);
    expect((await f.cli(['ctx', '--holder', 'owner'])).envId).toBe(first.envId);
    expect(journal.getEnv(first.envId)!.stack).toBe(legacyIdentity(f.wt, f.name));
    const second = await f.cli(['up', '--holder', 'other']);
    expect(second.error).toBeUndefined();
    const file = readdirSync(canonicalDir).find((f) => f.endsWith('.baked'))!;
    const canonical = readFileSync(join(canonicalDir, file), 'utf8');
    const retired = readFileSync(join(retiredDir, file), 'utf8');
    const ns = JSON.parse(canonical).ns;
    expect(JSON.parse(retired).ns).toBe(ns);
    expect(ns).toHaveLength(63);
    const failure = join(retiredDir, `${file}.retirement.json`);
    writeFileSync(failure, JSON.stringify({ attempts: 3, state: 'needs-attention' }));
    await f.cli(['pool', 'gc']);
    expect(readFileSync(join(appliance, ns), 'utf8')).toBe('seeded\n');
    expect(readFileSync(join(retiredDir, file), 'utf8')).toBe(retired);
    expect(JSON.parse(readFileSync(failure, 'utf8')).attempts).toBe(3);
    expect(readFileSync(join(canonicalDir, file), 'utf8')).toBe(canonical);
    expect(readFileSync(first.datastores.main.url, 'utf8')).toBe('seeded\n');
    expect(readFileSync(second.datastores.main.url, 'utf8')).toBe('seeded\n');
  } finally { await f.cleanup(); }
}, 30000);

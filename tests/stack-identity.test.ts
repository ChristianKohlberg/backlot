/** Physical stack identity: canonical paths, legacy aliases and holders (part 1; templates and retirement are stack-identity-retirement.test.ts). */
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../src/core/journal.js';
import { fixture, journalAsLegacyAlias, legacyIdentity, notesIn, secondWorktree, sleep } from './support/stack-identity-fixture.js';


it('canonical CLI and symlink CLI share one lease for the same holder', async () => {
  const f = fixture();
  try {
    const first = await f.cli(['up', '--holder', 'owner']);
    const context = await f.at('ctx', f.alias, 'owner');
    expect(context.error).toBeUndefined();
    expect(context.envId).toBe(first.envId);
    const again = await f.at('up', f.alias, 'owner');
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
    expect((await f.at('ctx', f.alias)).envId).toBe(first.envId);
    const distinct = await f.at('up', other);
    expect(distinct.error).toBeUndefined();
    expect(distinct.envId).not.toBe(first.envId);
    expect(distinct.urls).not.toEqual(first.urls);
  } finally { await f.cleanup(); }
}, 30000);

it('converged same-holder legacy leases refuse ambiguity without deleting either environment', async () => {
  const f = fixture();
  try {
    const first = await f.cli(['up', '--holder', 'owner']);
    const second = await f.at('up', secondWorktree(f), 'other');
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
        const implicit = await f.at('up', f.wt);
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
    let retiredDir = join(f.state, 'templates', legacyIdentity(f.alias));
    mkdirSync(retiredDir, { recursive: true });
    writeFileSync(join(retiredDir, 'main-default@stale.db'), 'stale sqlite template');
    const applianceUp = join(f.root, 'appliance-up');
    const droppedAt = join(f.root, 'dropped');
    writeFileSync(join(retiredDir, 'main-default@stale.baked'), JSON.stringify({ v: 1, ns: 'backlot_tpl_stale', drop: `test -e '${applianceUp}' && touch '${droppedAt}'` }));
    await f.cli(['status']); // recovery migrates; retirement is deferred to maintenance
    retiredDir = join(f.state, 'retired-templates', legacyIdentity(f.alias));
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
    const alias = await f.at('up', secondWorktree(f), f.alias);
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


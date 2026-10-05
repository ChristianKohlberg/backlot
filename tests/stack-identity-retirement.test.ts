/** Physical stack identity: retired templates, retention and cleanup records (part 2 of stack-identity.test.ts, split so both run in parallel). */
import ts from 'typescript';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../src/core/journal.js';
import { retireBakedTemplates } from '../src/drivers/datastores.js';
import { pruneTemplates } from '../src/core/retention.js';
import type { Policy } from '../src/core/policy.js';
import { disposeStateSync } from './support/leaks.js';
import { fixture, journalAsLegacyAlias, legacyIdentity, notesIn, sleep } from './support/stack-identity-fixture.js';

it('recovery never runs a retired drop; failed drops retain actionable bounded retry records', async () => {
  const f = fixture();
  try {
    const first = await f.cli(['up', '--holder', 'owner']);
    await f.cli(['daemon', 'stop']);
    journalAsLegacyAlias(f, first.envId, true);
    let dir = join(f.state, 'templates', legacyIdentity(f.alias));
    mkdirSync(dir, { recursive: true });
    const count = join(f.root, 'drop-attempts');
    let marker = join(dir, 'main-default@missing.baked');
    writeFileSync(marker, JSON.stringify({ v: 1, ns: 'already-missing', drop: `echo attempt >> '${count}'; false` }));
    const context = await f.cli(['ctx', '--holder', 'owner']);
    dir = join(f.state, 'retired-templates', legacyIdentity(f.alias));
    marker = join(dir, 'main-default@missing.baked');
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
    let dir = join(f.state, 'templates', legacyIdentity(f.alias));
    mkdirSync(dir, { recursive: true });
    let hanging = join(dir, 'a-hang.baked');
    let second = join(dir, 'b-next.baked');
    writeFileSync(hanging, JSON.stringify({ v: 1, ns: 'hanging', drop: 'node -e "setInterval(()=>{},1000)"' }));
    writeFileSync(second, JSON.stringify({ v: 1, ns: 'next', drop: 'true' }));
    await f.cli(['ctx', '--holder', 'owner']);
    dir = join(f.state, 'retired-templates', legacyIdentity(f.alias));
    hanging = join(dir, 'a-hang.baked');
    second = join(dir, 'b-next.baked');
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
    let dir = join(f.state, 'templates', legacyIdentity(f.alias));
    mkdirSync(dir, { recursive: true });
    const count = join(f.root, 'attempts');
    let marker = join(dir, 'failed.baked');
    writeFileSync(marker, JSON.stringify({ v: 1, ns: 'failed', drop: `echo attempt >> '${count}'; false` }));
    await f.cli(['status']);
    dir = join(f.state, 'retired-templates', legacyIdentity(f.alias));
    marker = join(dir, 'failed.baked');
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
  } finally { disposeStateSync(root); }
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
    let retiredDir = join(root, legacyIdentity(f.alias, f.name));
    renameSync(canonicalDir, retiredDir);
    expect((await f.cli(['ctx', '--holder', 'owner'])).envId).toBe(first.envId);
    retiredDir = join(f.state, 'retired-templates', legacyIdentity(f.alias, f.name));
    expect(journal.getEnv(first.envId)!.stack).toBe(legacyIdentity(f.wt, f.name));
    // A fresh data reset restores through the canonical template.
    const second = await f.cli(['reset-data', '--holder', 'owner']);
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
    expect(await pruneTemplates({ templatesKeep: 0 } as Policy, root)).toBe(0);
    expect(readFileSync(join(canonicalDir, file), 'utf8')).toBe(canonical);
    expect(readFileSync(first.datastores.main.url, 'utf8')).toBe('seeded\n');
    expect(readFileSync(second.datastores.main.url, 'utf8')).toBe('seeded\n');
  } finally { await f.cleanup(); }
}, 30000);

for (const missingLink of [false, true]) {
  it(`legacy nested symlink holders refuse implicit duplication (${missingLink ? 'unresolvable mapping' : 'physical match'})`, async () => {
    const f = fixture();
    try {
      const sub = join(f.wt, 'sub');
      mkdirSync(sub);
      const link = join(f.wt, 'link');
      symlinkSync(sub, link, 'dir');
      const holder = join(f.alias, 'link');
      const first = await f.cli(['up', '--holder', holder]);
      const db = new DatabaseSync(first.datastores.main.url);
      db.prepare('INSERT INTO notes VALUES (?)').run('nested holder data');
      db.close();
      await f.cli(['daemon', 'stop']);
      const journal = journalAsLegacyAlias(f, first.envId, true);
      if (missingLink) rmSync(link);
      const result = await f.at('up', sub);
      expect(result.error?.message).toContain(`pass holder ${JSON.stringify(holder)} (--holder on the CLI)`);
      expect(journal.allEnvs()).toHaveLength(1);
      expect(journal.allLeases()).toHaveLength(1);
      const retained = await f.at('ctx', sub, holder);
      expect(retained.envId).toBe(first.envId);
      expect(retained.lease.id).toBe(first.lease.id);
      expect(retained.urls).toEqual(first.urls);
      expect(journal.leaseForEnv(first.envId)!.holder).toBe(holder);
      expect(notesIn(retained.datastores.main.url)).toEqual([{ note: 'nested holder data' }]);
    } finally { await f.cleanup(); }
  }, 30000);
}

for (const repaired of [false, true]) {
  it(`retention protects deferred legacy cleanup ownership (${repaired ? 'repaired before retention' : 'still invalid'})`, async () => {
    const f = fixture();
    const manifest = join(f.wt, 'backlot.yml');
    const good = readFileSync(manifest, 'utf8');
    try {
      const first = await f.cli(['up', '--holder', 'owner']);
      await f.cli(['daemon', 'stop']);
      const journal = journalAsLegacyAlias(f, first.envId, true);
      let dir = join(f.state, 'templates', legacyIdentity(f.alias));
      mkdirSync(dir, { recursive: true });
      const attempts = join(f.root, 'unexpected-drops');
      const records: Record<string, string> = {};
      for (let i = 0; i < 8; i++) {
        records[`${i}.baked`] = JSON.stringify({ v: 1, ns: `deferred_${i}`, drop: `echo attempt >> '${attempts}'; false` });
        records[`${i}.baked.retirement.json`] = JSON.stringify({ attempts: 3, nextAttemptAt: 0, state: 'needs-attention' });
      }
      for (const [file, content] of Object.entries(records)) writeFileSync(join(dir, file), content);
      writeFileSync(manifest, 'name: [broken\n');
      f.env.BACKLOT_SWEEP_MS = '1500';
      f.env.BACKLOT_RETENTION_MS = '1';
      f.env.BACKLOT_TEMPLATES_KEEP = '1';
      await f.cli(['status']);
      expect(journal.getEnv(first.envId)!.stack).toBe(legacyIdentity(f.alias));
      if (repaired) writeFileSync(manifest, good);
      await sleep(2200);
      if (repaired) dir = join(f.state, 'retired-templates', legacyIdentity(f.alias));
      expect(existsSync(attempts)).toBe(false);
      for (const [file, content] of Object.entries(records)) expect(readFileSync(join(dir, file), 'utf8')).toBe(content);
      expect(existsSync(join(dir, '.retired-stack.json'))).toBe(repaired);
      expect(journal.getEnv(first.envId)!.stack).toBe(legacyIdentity(repaired ? f.wt : f.alias));
      expect(journal.allEnvs()).toHaveLength(1);
      expect(journal.leaseForEnv(first.envId)!.id).toBe(first.lease.id);
    } finally {
      writeFileSync(manifest, good);
      await f.cleanup();
    }
  }, 30000);
}


it('canonical stack rows recognize a legacy holder whose subdirectory alone was symlinked', async () => {
  const f = fixture();
  try {
    const sub = join(f.wt, 'sub');
    mkdirSync(sub);
    const holder = join(f.wt, 'link');
    symlinkSync(sub, holder, 'dir');
    const first = await f.at('up', holder, holder);
    expect(first.error).toBeUndefined();
    const db = new DatabaseSync(first.datastores.main.url);
    db.prepare('INSERT INTO notes VALUES (?)').run('canonical legacy owner');
    db.close();
    await f.cli(['daemon', 'stop']);
    const journal = new Journal(join(f.state, 'journal.db'));
    expect(journal.getEnv(first.envId)!.legacyStackRoot).toBeFalsy();
    const implicit = await f.at('up', sub);
    expect(implicit.error?.message).toContain(`pass holder ${JSON.stringify(holder)} (--holder on the CLI)`);
    expect(journal.allEnvs()).toHaveLength(1);
    expect(journal.leaseForEnv(first.envId)!.holder).toBe(holder);
    const retained = await f.at('ctx', sub, holder);
    expect(retained.envId).toBe(first.envId);
    expect(retained.lease.id).toBe(first.lease.id);
    expect(notesIn(retained.datastores.main.url)).toEqual([{ note: 'canonical legacy owner' }]);
    // One environment per worktree (decision 0032): a different holder of the
    // same worktree is refused rather than handed a second environment.
    const canonical = await f.at('up', sub, sub);
    expect(canonical.error?.message).toMatch(/exactly one environment/);
    expect(journal.allEnvs()).toHaveLength(1);
    expect(journal.leaseForEnv(first.envId)!.holder).toBe(holder);
  } finally { await f.cleanup(); }
}, 30000);

it('baseline ordinary retention cannot reach migrated retirement records or resources', async () => {
  const f = fixture();
  const executable = join(import.meta.dirname, '..', 'dist', 'core', `.old-retention-${process.pid}.js`);
  try {
    const first = await f.cli(['up', '--holder', 'owner']);
    await f.cli(['daemon', 'stop']);
    journalAsLegacyAlias(f, first.envId, true);
    const legacy = join(f.state, 'templates', legacyIdentity(f.alias));
    mkdirSync(legacy, { recursive: true });
    const resource = join(f.root, 'external-template');
    writeFileSync(resource, 'live resource');
    for (let i = 0; i < 8; i++) {
      writeFileSync(join(legacy, `${i}.baked`), JSON.stringify({ v: 1, ns: `obsolete_${i}`, drop: `rm -f '${resource}'; false` }));
      writeFileSync(join(legacy, `${i}.baked.retirement.json`), JSON.stringify({ attempts: 3, state: 'needs-attention' }));
    }
    await f.cli(['status']);
    await f.cli(['daemon', 'stop']);
    const retired = join(f.state, 'retired-templates', legacyIdentity(f.alias));
    expect(existsSync(legacy)).toBe(false);
    const records = Object.fromEntries(readdirSync(retired).map((name) => [name, readFileSync(join(retired, name), 'utf8')]));
    expect(records['.retired-stack.json']).toBeDefined();
    const ordinary = join(f.state, 'templates', 'ordinary');
    mkdirSync(ordinary, { recursive: true });
    writeFileSync(join(ordinary, 'stale.db'), 'ordinary retention control');
    const baseline = readFileSync(join(import.meta.dirname, 'fixtures', 'baseline-retention.ts'), 'utf8');
    writeFileSync(executable, ts.transpileModule(baseline, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText);
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const {pruneTemplates} = await import(${JSON.stringify(pathToFileURL(executable).href)}); console.log(await pruneTemplates({templatesKeep:0}));`], { cwd: f.wt, env: f.env, encoding: 'utf8' });
    expect(Number(output.trim())).toBe(1);
    expect(existsSync(join(ordinary, 'stale.db'))).toBe(false);
    expect(readFileSync(resource, 'utf8')).toBe('live resource');
    expect(readdirSync(retired).sort()).toEqual(Object.keys(records).sort());
    for (const [name, content] of Object.entries(records)) expect(readFileSync(join(retired, name), 'utf8')).toBe(content);
  } finally {
    rmSync(executable, { force: true });
    await f.cleanup();
  }
}, 30000);


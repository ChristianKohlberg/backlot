/**
 * Template identity, bake serialization, and server-side template GC
 * (vetbill-1i49).
 *
 * Previously: the baked-template name hashed only the static create: command
 * (identical on every branch), the marker check was un-serialized (two
 * concurrent binds could bake the shared template twice), and pruning
 * deleted marker FILES while the `backlot_tpl_*` databases leaked on the
 * appliance forever.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.js';
import { templateBakeKeys, triggerHash } from '../src/core/upkeep.js';
import {
  makeDatastore,
  parseBakedMarker,
  withBakeLock,
  type DsHandle,
} from '../src/drivers/datastores.js';
import { pruneTemplates } from '../src/core/retention.js';
import { policy } from '../src/core/policy.js';
import type { Manifest, DatastoreSpec } from '../src/core/manifest.js';

let state: { dir: string; cleanup: () => void };
let tree: { dir: string; cleanup: () => void };

beforeEach(() => {
  state = tempDir('tpl-state');
  tree = tempDir('tpl-tree');
  process.env.BACKLOT_STATE_DIR = state.dir;
});

afterEach(() => {
  delete process.env.BACKLOT_STATE_DIR;
  state.cleanup();
  tree.cleanup();
});

const manifestWith = (upkeep: Array<{ when: string; run: string }>): Manifest =>
  ({ name: 't', services: {}, upkeep }) as unknown as Manifest;

const writeTreeFile = (rel: string, content: string): void => {
  const full = join(tree.dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
};

describe('templateBakeKeys', () => {
  it('derives a key per @rebake-template target from matched file content', () => {
    writeTreeFile('migrations/001.sql', 'CREATE TABLE a;');
    const manifest = manifestWith([
      { when: 'migrations/**', run: '@rebake-template main' },
      { when: 'src/**', run: 'echo unrelated' },
    ]);
    const keys = templateBakeKeys(manifest, tree.dir, ['migrations/001.sql', 'src/x.ts']);
    expect(Object.keys(keys)).toEqual(['main']);
    expect(keys.main).toMatch(/^[0-9a-f]{12}$/);
  });

  it('changes when a matched file changes content — and only then', () => {
    writeTreeFile('migrations/001.sql', 'CREATE TABLE a;');
    writeTreeFile('other.txt', 'noise');
    const manifest = manifestWith([{ when: 'migrations/**', run: '@rebake-template main' }]);
    const files = ['migrations/001.sql', 'other.txt'];

    const before = templateBakeKeys(manifest, tree.dir, files);
    writeTreeFile('other.txt', 'different noise');
    expect(templateBakeKeys(manifest, tree.dir, files)).toEqual(before);
    writeTreeFile('migrations/001.sql', 'CREATE TABLE b;');
    expect(templateBakeKeys(manifest, tree.dir, files)).not.toEqual(before);
  });

  it('defaults the target to main and combines multiple rules deterministically', () => {
    writeTreeFile('m/001.sql', 'x');
    writeTreeFile('seed.sql', 'y');
    const a = templateBakeKeys(
      manifestWith([
        { when: 'm/**', run: '@rebake-template' },
        { when: 'seed.sql', run: '@rebake-template main' },
      ]),
      tree.dir,
      ['m/001.sql', 'seed.sql'],
    );
    const b = templateBakeKeys(
      manifestWith([
        { when: 'seed.sql', run: '@rebake-template main' },
        { when: 'm/**', run: '@rebake-template' },
      ]),
      tree.dir,
      ['m/001.sql', 'seed.sql'],
    );
    expect(a).toEqual(b); // rule order must not matter
  });

  it('exposes triggerHash for rule-level content hashing', () => {
    writeTreeFile('f.sql', 'v1');
    const h1 = triggerHash(tree.dir, ['f.sql'], 'f.sql');
    writeTreeFile('f.sql', 'v2');
    expect(triggerHash(tree.dir, ['f.sql'], 'f.sql')).not.toBe(h1);
  });
});

describe('template identity in datastore drivers', () => {
  const spec: DatastoreSpec = {
    driver: 'postgres',
    url: 'postgres://x/{{ns}}',
    create: 'echo create {{ns}}',
    drop: 'echo drop {{ns}}',
    template_restore: 'echo restore {{template}} {{ns}}',
  } as unknown as DatastoreSpec;

  const handle = (envId: string): DsHandle => ({ envId, envTree: tree.dir, dataDir: tree.dir });

  const markerDirFor = (stackId: string): string =>
    join(state.dir, 'templates', stackId);

  it('different bake keys produce disjoint templates; absent key keeps the historical name', async () => {
    // Bake with key A, key B, and no key — three distinct marker files.
    await makeDatastore('db', spec, 'stack1', 'aaaaaaaaaaaa').ensure(handle('e1'), 'dev', true, false);
    await makeDatastore('db', spec, 'stack1', 'bbbbbbbbbbbb').ensure(handle('e2'), 'dev', true, false);
    await makeDatastore('db', spec, 'stack1').ensure(handle('e3'), 'dev', true, false);

    const markers = readdirSync(markerDirFor('stack1')).filter((f) => f.endsWith('.baked'));
    expect(markers).toHaveLength(3);
    const nss = markers.map((f) => parseBakedMarker(readFileSync(join(markerDirFor('stack1'), f), 'utf8')).ns);
    expect(new Set(nss).size).toBe(3);
  });

  it('same bake key reuses the existing bake (marker gate holds)', async () => {
    await makeDatastore('db', spec, 'stack2', 'cccccccccccc').ensure(handle('e1'), 'dev', true, false);
    await makeDatastore('db', spec, 'stack2', 'cccccccccccc').ensure(handle('e2'), 'dev', true, false);
    const markers = readdirSync(markerDirFor('stack2')).filter((f) => f.endsWith('.baked'));
    expect(markers).toHaveLength(1);
  });

  it('markers are self-describing JSON carrying ns and templated drop command', async () => {
    await makeDatastore('db', spec, 'stack3', 'dddddddddddd').ensure(handle('e1'), 'dev', true, false);
    const dir = markerDirFor('stack3');
    const [markerFile] = readdirSync(dir).filter((f) => f.endsWith('.baked'));
    const marker = parseBakedMarker(readFileSync(join(dir, markerFile), 'utf8'));
    expect(marker.v).toBe(1);
    expect(marker.ns).toMatch(/^backlot_tpl_stack3_dev_[0-9a-f_]{8}$/);
    expect(marker.drop).toBe(`echo drop ${marker.ns}`);
  });

  it('legacy bare-string markers still parse (drop unavailable)', () => {
    const legacy = parseBakedMarker('backlot_tpl_old_dev_12345678\n');
    expect(legacy.ns).toBe('backlot_tpl_old_dev_12345678');
    expect(legacy.drop).toBeNull();
  });

  it('concurrent binds bake the shared template exactly once', async () => {
    // create: appends to a log file — a double bake would append twice.
    const log = join(tree.dir, 'bakes.log');
    const countingSpec = {
      ...spec,
      create: `echo baked-{{ns}} >> ${log}`,
      drop: undefined,
    } as unknown as DatastoreSpec;

    await Promise.all([
      makeDatastore('db', countingSpec, 'stack4', 'ffffffffffff').ensure(handle('e1'), 'dev', true, false),
      makeDatastore('db', countingSpec, 'stack4', 'ffffffffffff').ensure(handle('e2'), 'dev', true, false),
      makeDatastore('db', countingSpec, 'stack4', 'ffffffffffff').ensure(handle('e3'), 'dev', true, false),
    ]);

    const bakes = readFileSync(log, 'utf8').trim().split('\n');
    expect(bakes).toHaveLength(1);
  });

  it('withBakeLock serializes and releases even when the task throws', async () => {
    const order: string[] = [];
    const first = withBakeLock('k', async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('first-end');
      throw new Error('boom');
    }).catch(() => order.push('first-caught'));
    const second = withBakeLock('k', async () => {
      order.push('second');
    });
    await Promise.all([first, second]);
    expect(order.indexOf('first-end')).toBeLessThan(order.indexOf('second'));
  });

  it('rebake drops the server-side template DBs recorded in markers', async () => {
    const log = join(tree.dir, 'drops.log');
    const droppingSpec = {
      ...spec,
      drop: `echo dropped-{{ns}} >> ${log}`,
    } as unknown as DatastoreSpec;
    const ds = makeDatastore('db', droppingSpec, 'stack5', '999999999999');
    await ds.ensure(handle('e1'), 'dev', true, false);
    writeFileSync(log, ''); // ignore the clean-slate drops from ensure itself

    await ds.rebake();
    const drops = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatch(/^dropped-backlot_tpl_stack5_dev_/);
    expect(existsSync(markerDirFor('stack5'))).toBe(false);
  });
});

describe('pruneTemplates drops server-side DBs', () => {
  it('executes the marker drop command before removing the marker file', async () => {
    const log = join(tree.dir, 'prune-drops.log');
    const root = join(state.dir, 'templates');
    const dir = join(root, 'stackP');
    mkdirSync(dir, { recursive: true });

    // 5 markers, newest-first retention keeps templatesKeep(=4 default) —
    // set an explicit tiny keep via env to make the test deterministic.
    process.env.BACKLOT_TEMPLATES_KEEP = '1';
    try {
      const now = Date.now();
      for (let i = 0; i < 3; i++) {
        const f = join(dir, `db-dev@${i}00000000000.baked`);
        writeFileSync(f, JSON.stringify({ v: 1, ns: `tpl_${i}`, drop: `echo pruned-tpl_${i} >> ${log}` }));
        // stagger mtimes: index 2 newest
        const t = new Date(now - (3 - i) * 60_000);
        const { utimesSync } = await import('node:fs');
        utimesSync(f, t, t);
      }
      // one legacy marker (oldest of all) — file-only prune, no drop
      const legacy = join(dir, 'db-dev@legacy000000.baked');
      writeFileSync(legacy, 'tpl_legacy');
      const { utimesSync } = await import('node:fs');
      const old = new Date(now - 10 * 60_000);
      utimesSync(legacy, old, old);

      const pruned = await pruneTemplates(policy(), root);
      expect(pruned).toBe(3); // keep=1 → newest survives, 3 pruned

      const dropped = readFileSync(log, 'utf8');
      expect(dropped).toContain('pruned-tpl_0');
      expect(dropped).toContain('pruned-tpl_1');
      expect(dropped).not.toContain('pruned-tpl_2'); // newest kept
      expect(existsSync(legacy)).toBe(false); // legacy pruned file-only
      expect(readdirSync(dir)).toHaveLength(1);
    } finally {
      delete process.env.BACKLOT_TEMPLATES_KEEP;
    }
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDatastore } from '../src/drivers/datastores.js';
import { flushMetrics, metricsSnapshot } from '../src/core/metrics.js';
import { disposeStateSync } from './support/leaks.js';

const roots: string[] = [];
const originalState = process.env.BACKLOT_STATE_DIR;
afterEach(() => {
  flushMetrics();
  for (const root of roots.splice(0)) disposeStateSync(root);
  if (originalState === undefined) delete process.env.BACKLOT_STATE_DIR;
  else process.env.BACKLOT_STATE_DIR = originalState;
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'runly-ds-metrics-'));
  roots.push(root);
  process.env.BACKLOT_STATE_DIR = root;
  return { envId: 'env-metrics', cwd: root, dataDir: join(root, 'data') };
}
const observations = (name: string, outcome?: string) => metricsSnapshot().series.filter((s) => s.name === name && (!outcome || s.labels.outcome === outcome));
const count = (name: string, outcome?: string) => observations(name, outcome).reduce((sum, s) => sum + s.count, 0);

describe('datastore measurements', () => {
  it('distinguishes one real template bake from two restores and namespace reuse', async () => {
    const h = fixture();
    const ds = makeDatastore('db', { driver: 'sqlite', template: true, create: 'printf seeded > {{ns}}' } as never, 'worktree');
    await ds.ensure(h, 'default', false, false);
    writeFileSync(ds.ns(h), 'changed');
    await ds.ensure(h, 'default', false, true);
    expect(readFileSync(ds.ns(h), 'utf8')).toBe('changed');
    await ds.ensure(h, 'default', true, true);
    expect(readFileSync(ds.ns(h), 'utf8')).toBe('seeded');
    expect(count('datastore.template_bake_ms', 'success')).toBe(1);
    expect(count('datastore.restore_ms', 'success')).toBe(2);
    expect(count('datastore.template_reuse')).toBe(1);
    expect(count('datastore.namespace_reuse')).toBe(1);
    expect(count('datastore.create_ms')).toBe(0);
    expect(metricsSnapshot().series.every((s) => s.labels.stack === 'worktree' && s.labels.envId === h.envId && s.labels.datastore === 'db')).toBe(true);
  });

  it('reports a failed restore attempt separately from its successful retry without an unnecessary rebake', async () => {
    const h = fixture();
    const ds = makeDatastore('db', {
      driver: 'postgres', url: 'postgres://secret@localhost/{{ns}}',
      create: 'printf seeded > {{ns}}', drop: 'rm -f {{ns}}',
      template_restore: 'if [ ! -f tried ]; then touch tried; exit 1; fi; cp {{template}} {{ns}}',
    } as never, 'worktree');
    await ds.ensure(h, 'default', false, false);
    expect(readFileSync(join(h.cwd, ds.ns(h)), 'utf8')).toBe('seeded');
    expect(count('datastore.template_bake_ms', 'success')).toBe(1);
    expect(count('datastore.restore_ms', 'error')).toBe(1);
    expect(count('datastore.restore_ms', 'success')).toBe(1);
    expect(count('datastore.restore_retry')).toBe(1);
    expect(JSON.stringify(metricsSnapshot())).not.toContain('secret');
  });

  it('measures failed creates and quiet drops without changing their error contracts', async () => {
    const h = fixture();
    const ds = makeDatastore('db', { driver: 'postgres', url: 'postgres://localhost/{{ns}}', create: 'exit 1', drop: 'exit 1' } as never, 'worktree');
    await expect(ds.ensure(h, 'default', false, false)).rejects.toThrow();
    await expect(ds.drop(h)).resolves.toBeUndefined();
    expect(count('datastore.create_ms', 'error')).toBe(1);
    expect(count('datastore.drop_ms', 'error')).toBe(2);
    expect(count('datastore.drop_ms', 'success')).toBe(0);
    expect(observations('datastore.create_ms')[0]!.min).toBeGreaterThanOrEqual(0);
  });
});

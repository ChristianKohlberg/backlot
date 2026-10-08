/**
 * The operational batch: pool-policy precedence and the retention sweep.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('pool policy precedence (unit)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runly-pol-'));
  const saved = { state: process.env.BACKLOT_STATE_DIR, pool: process.env.BACKLOT_POOL_MAX_TOTAL };
  afterEach(() => {
    process.env.BACKLOT_STATE_DIR = saved.state;
    if (saved.pool === undefined) delete process.env.BACKLOT_POOL_MAX_TOTAL;
    else process.env.BACKLOT_POOL_MAX_TOTAL = saved.pool;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('env var > config.json > heuristic', async () => {
    process.env.BACKLOT_STATE_DIR = dir;
    delete process.env.BACKLOT_POOL_MAX_TOTAL;
    const { policy, poolMaxHeuristic } = await import('../src/core/policy.js');

    const h = poolMaxHeuristic();
    expect(h).toBeGreaterThanOrEqual(1);
    expect(h).toBeLessThanOrEqual(64); // 2 x cores with the load budget on (decision 0036)
    expect(policy().poolMaxTotal).toBe(h); // heuristic default

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ poolMaxTotal: 5, idleTtlMs: 123 }));
    expect(policy().poolMaxTotal).toBe(5); // config file wins over heuristic
    expect(policy().idleTtlMs).toBe(123);

    process.env.BACKLOT_POOL_MAX_TOTAL = '2';
    expect(policy().poolMaxTotal).toBe(2); // env var wins over config
  });

  it('a leftover per-stack poolMax / BACKLOT_POOL_MAX is ignored (removed in decision 0032)', async () => {
    process.env.BACKLOT_STATE_DIR = dir;
    process.env.BACKLOT_POOL_MAX = '1';
    try {
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ poolMax: 1 }));
      const { policy } = await import('../src/core/policy.js');
      expect(Object.keys(policy())).not.toContain('poolMax');
    } finally {
      delete process.env.BACKLOT_POOL_MAX;
    }
  });


});

describe('retention sweep (unit)', () => {
  it('truncates fat logs, keeps newest templates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runly-ret-'));
    process.env.BACKLOT_STATE_DIR = dir;
    const { truncateLogs, pruneTemplates } = await import('../src/core/retention.js');
    const { policy } = await import('../src/core/policy.js');
    const p = { ...policy(), logCapBytes: 1000, templatesKeep: 2 };

    // A fat log is rotated once (decision 0038): it becomes web.log.1.
    const logs = join(dir, 'envs', 'env1', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'web.log'), 'x'.repeat(5000));
    expect(truncateLogs(p)).toBe(1);
    expect(existsSync(join(logs, 'web.log'))).toBe(false);
    expect(statSync(join(logs, 'web.log.1')).size).toBe(5000);

    // 4 templates, keep the 2 newest.
    const tpl = join(dir, 'templates', 'stack1');
    mkdirSync(tpl, { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(tpl, `t${i}.db`), 'db');
      const t = new Date(Date.now() - (4 - i) * 3600 * 1000);
      utimesSync(join(tpl, `t${i}.db`), t, t);
    }
    expect(await pruneTemplates(p)).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('per-worktree state outlives environments, not its worktree (decision 0032)', () => {
  it('prunes a worktree record only once the worktree is gone and no environment names it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runly-wtret-'));
    const { pruneWorktreeState } = await import('../src/core/retention.js');
    const live = mkdtempSync(join(tmpdir(), 'runly-wtret-live-'));
    const record = (id: string, root: string, file = 'ledger.json') => {
      mkdirSync(join(dir, id), { recursive: true });
      writeFileSync(join(dir, id, file), JSON.stringify({ root, fingerprints: {} }));
    };
    record('gone-stack', join(dir, 'no-such-worktree'));
    record('gone-triggers-only', join(dir, 'also-gone'), 'triggers.json');
    record('live-stack', live);
    record('gone-but-leased', join(dir, 'gone-too'));
    mkdirSync(join(dir, 'unreadable'));
    const journal = { envsForStack: (id: string) => (id === 'gone-but-leased' ? [{}] : []) } as never;
    expect(pruneWorktreeState(journal, dir)).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(['gone-but-leased', 'live-stack', 'unreadable']);
    rmSync(dir, { recursive: true, force: true });
    rmSync(live, { recursive: true, force: true });
  });
});

describe('template pruning honors the bake lock', () => {
  it('does not delete a stack template dir while a bake/restore is in flight', async () => {
    // pruneTemplates was the one remaining writer that mutated a stack's
    // template dir OUTSIDE the stack-scoped bake lock — reopening the exact
    // deleted-mid-restore race the lock was introduced to close.
    const dir = mkdtempSync(join(tmpdir(), 'runly-ret-lock-'));
    process.env.BACKLOT_STATE_DIR = dir;
    const { pruneTemplates } = await import('../src/core/retention.js');
    const { withBakeLock } = await import('../src/drivers/datastores.js');
    const { policy } = await import('../src/core/policy.js');
    const root = join(dir, 'templates');
    mkdirSync(join(root, 'stk'), { recursive: true });
    const tpl = join(root, 'stk', 'main-dev@abc.db');
    writeFileSync(tpl, 'baked');

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const bake = withBakeLock('stk', () => held); // an in-flight bake/restore
    const prune = pruneTemplates({ ...policy(), templatesKeep: 0, templateGraceMs: 0 }, root);
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(tpl), 'template deleted out from under the in-flight bake').toBe(true);
    release();
    await bake;
    expect(await prune).toBe(1); // after the lock frees, pruning proceeds
    expect(existsSync(tpl)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});

/**
 * Q3 (0.19): template retention leaked the templates of every pruned worktree.
 * `stackAlive` treated a stack with no record at all as alive, and the
 * worktree records are exactly what the sweep prunes once the worktree is
 * gone — so those templates (and their server-side databases) stayed forever.
 * Failed on 0.18.1: the orphan's marker survived the sweep.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};

describe('Q3 template retention collects the templates of pruned worktrees', () => {
  it('drops an orphan stack (no row, no record), keeps a live one, and runs the drop in a live sibling worktree', async () => {
    const state = tmp('v019-q3-state-');
    process.env.BACKLOT_STATE_DIR = state;
    const { Journal } = await import('../../src/core/journal.js');
    // The sweep's own entry point (same signature on 0.18.2), not its parts.
    const { retentionSweep } = await import('../../src/core/retention.js');
    const { policy } = await import('../../src/core/policy.js');
    const { templatesRoot } = await import('../../src/core/paths.js');
    const journal = new Journal(join(state, 'journal.db'));
    const live = tmp('v019-q3-live-');
    const old = new Date(Date.now() - 3600_000);
    const bake = (stack: string, file: string, ns: string, root?: string) => {
      const dir = join(templatesRoot(), stack);
      mkdirSync(dir, { recursive: true });
      if (root !== undefined) writeFileSync(join(dir, '.root'), root);
      // The drop records where it ran: a manifest's drop runs in the repo.
      writeFileSync(join(dir, file), JSON.stringify({ v: 1, ns, drop: `pwd > "${state}/dropped-${ns}"` }));
      utimesSync(join(dir, file), old, old);
    };
    // A pruned worktree from an older runly: no `.root`, no worktree records.
    bake('proj-aaaaaaaa', 'main-dev@k1.baked', 'tpl_orphan');
    // A pruned worktree recorded at bake time: its root is gone. Same project as the live one.
    bake('proj-bbbbbbbb', 'main-dev@k2.baked', 'tpl_gone', join(state, 'no-such-worktree'));
    // A live worktree: its current template stays.
    bake('proj-cccccccc', 'main-dev@k3.baked', 'tpl_live', live);

    const swept = await retentionSweep(journal, { ...policy(), templatesKeep: 1, templateGraceMs: 0 });

    expect(swept.templates).toBe(2);
    expect(existsSync(join(templatesRoot(), 'proj-aaaaaaaa')), 'the orphan stack kept its template').toBe(false);
    expect(existsSync(join(templatesRoot(), 'proj-bbbbbbbb'))).toBe(false);
    expect(existsSync(join(templatesRoot(), 'proj-cccccccc', 'main-dev@k3.baked'))).toBe(true);
    // The server-side databases went with their markers, the drop run in the
    // live worktree of the same project.
    expect(readFileSync(join(state, 'dropped-tpl_gone'), 'utf8').trim()).toBe(live);
    expect(existsSync(join(state, 'dropped-tpl_orphan'))).toBe(true);
    expect(existsSync(join(state, 'dropped-tpl_live'))).toBe(false);
  }, 30_000);
});

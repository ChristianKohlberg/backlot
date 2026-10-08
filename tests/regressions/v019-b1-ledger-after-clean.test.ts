/**
 * rv018 bug hunt — (fixed in 0.19, failed on 0.18.1) B1: `destroy` now keeps the worktree's upkeep ledger. The
 * pool that calls `destroy` (treehouse return --force: "clean, reset") then
 * wipes the gitignored artefacts the upkeep rules produced (node_modules, a
 * generated client). The trigger files are unchanged, so the next holder's
 * `up` skips the rules and runs against a tree without their output. The
 * consumer's docs (revamp docs/worktrees.md) rely on destroy dropping the
 * ledger "that no longer matches a reset tree".
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeCtx, SERVER, type Ctx } from '../support/context.js';

const ctxs: Ctx[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
});

describe('B1 destroy keeps the upkeep ledger across a pool reset', () => {
  it('re-runs an upkeep rule whose output a clean removed', async () => {
    const c = makeCtx();
    ctxs.push(c);
    const wt = c.worktree({
      'runly.yml': `name: ledger
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
upkeep:
  - { when: package.json, run: "mkdir -p node_modules && echo installed > node_modules/.installed" }
`,
      'server.mjs': SERVER,
      'package.json': '{}\n',
      '.gitignore': 'node_modules/\n',
    });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    expect(existsSync(join(wt, 'node_modules', '.installed'))).toBe(true);
    expect((await c.cli(['destroy', '--json'], wt)).code).toBe(0);
    // The pool takes the tree back: reset and clean, gitignored files included.
    execFileSync('git', ['reset', '-q', '--hard'], { cwd: wt });
    execFileSync('git', ['clean', '-q', '-fdx'], { cwd: wt });
    const next = await c.cli(['up', '--json'], wt);
    expect(next.code, next.stderr + next.stdout).toBe(0);
    expect(existsSync(join(wt, 'node_modules', '.installed')), 'the upkeep rule was skipped after destroy + clean: its output is gone').toBe(true);
  }, 90_000);
});

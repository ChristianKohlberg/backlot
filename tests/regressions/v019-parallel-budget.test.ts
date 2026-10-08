/**
 * rv018 bug hunt — (fixed in 0.19, failed on 0.18.1) the parallel data + build cold path: the build's share of
 * the load budget is released only after BOTH phases settle, so a short build
 * next to a long restore/bake keeps its (large) build reservation for the
 * whole data phase, and other agents queue behind memory nobody uses.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx, sleep, SERVER, type Ctx } from '../support/context.js';
import { disposeStateSync } from '../support/leaks.js';

const ctxs: Ctx[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
  for (const d of dirs) disposeStateSync(d);
});

describe('parallel data + build', () => {
  it('releases the build share when the build ends, not when the data phase ends', async () => {
    const c = makeCtx();
    ctxs.push(c);
    const server = realpathSync(mkdtempSync(join(tmpdir(), 'v019-pb-')));
    dirs.push(server);
    const wt = c.worktree({
      'runly.yml': `name: pb
services:
  web:
    build: "echo built > built.txt"
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 30 }
    resources: { memory: 128M, cpu: 0.25, build: { memory: 3G, cpu: 2 } }
datastores:
  main:
    driver: postgres
    url: "file://${server}/{{ns}}"
    presets: [dev]
    create: 'sleep 8 && mkdir -p "${server}/{{ns}}"'
    template_restore: 'cp -r "${server}/{{template}}" "${server}/{{ns}}"'
    drop: 'rm -rf "${server}/{{ns}}"'
`,
      'server.mjs': SERVER,
      '.gitignore': 'built.txt\n',
    });
    const upP = c.cli(['up', '--json'], wt, { BACKLOT_BUDGET_MEMORY: '16G', BACKLOT_BUDGET_CPU: '8' });
    await sleep(5000); // the build (an echo) is long done; the bake still runs
    const st = await c.cli(['status', '--json'], wt, { BACKLOT_BUDGET_MEMORY: '16G', BACKLOT_BUDGET_CPU: '8' });
    const up = await upP;
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const committedGiB = st.json.budget.committedMemoryBytes / 2 ** 30;
    console.log('committed during the data phase:', committedGiB.toFixed(2), 'GiB', JSON.stringify(st.json.budget.committed), '| phases', JSON.stringify(up.json.bindDiagnostics.phasesMs));
    expect(committedGiB, 'the finished build still holds its 3G share').toBeLessThan(1);
  }, 90_000);
});

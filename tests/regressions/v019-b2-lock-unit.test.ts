/**
 * rv018 bug hunt — (fixed in 0.19, failed on 0.18.1) B2 at the driver level (in-process, as the daemon runs it).
 *  (a) restores that "share the lock" are serialized anyway: every attempt
 *      first takes the EXCLUSIVE lock for its bake check, which waits for the
 *      running readers and blocks the readers queued behind it.
 *  (b) the "rebake only if the marker is still the one it restored from"
 *      check compares byte-identical marker content.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let state: string;
let server: string;
beforeAll(() => {
  state = realpathSync(mkdtempSync(join(tmpdir(), 'v019-b2u-state-')));
  server = realpathSync(mkdtempSync(join(tmpdir(), 'v019-b2u-srv-')));
  process.env.BACKLOT_STATE_DIR = state;
});
afterAll(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(server, { recursive: true, force: true });
});
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);

function spec(restoreSleep: number) {
  writeFileSync(join(server, 'bake.sh'), `#!/bin/sh\nsleep 1\nmkdir -p "${server}/$1"\necho "bake $1" >> "${server}/bakes.log"\necho "baked $(date +%s.%N)" >> "${server}/restores.log"\n`);
  writeFileSync(join(server, 'restore.sh'), `#!/bin/sh\necho "start $(date +%s.%N)" >> "${server}/restores.log"\nsleep ${restoreSleep}\n[ -d "${server}/$1" ] || { echo "fail $(date +%s.%N)" >> "${server}/restores.log"; echo "template $1 does not exist" >&2; exit 1; }\ncp -r "${server}/$1" "${server}/$2"\n`);
  return {
    driver: 'postgres',
    url: `file://${server}/{{ns}}`,
    presets: ['dev'],
    create: `sh ${server}/bake.sh "{{ns}}" "{{preset}}"`,
    template_restore: `sh ${server}/restore.sh "{{template}}" "{{ns}}"`,
    drop: `rm -rf "${server}/{{ns}}"`,
  };
}

describe('B2 template lock, in process', () => {
  it('(a) four restores of an existing template, arriving 0.5 s apart, run side by side (ideal 3.5 s)', async () => {
    const { makeDatastore } = await import('../../src/drivers/datastores.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ds = makeDatastore('main', spec(2) as any, 'stackA', 'k1');
    await ds.ensure({ envId: 'e0', cwd: server, dataDir: server }, 'dev', true, false); // bake + first restore
    rmSync(join(server, 'restores.log'), { force: true });
    const t0 = Date.now();
    await Promise.all([1, 2, 3, 4].map(async (i) => { await new Promise((r) => setTimeout(r, (i - 1) * 500)); return ds.ensure({ envId: `e${i}`, cwd: server, dataDir: server }, 'dev', true, false); }));
    const took = Date.now() - t0;
    console.log(`4 restores of 2 s took ${took} ms`, lines(join(server, 'restores.log')));
    expect(took, 'restores were serialized by the exclusive bake check').toBeLessThan(4500);
  }, 60_000);

  it('(b) N restores of a vanished template rebake it once', async () => {
    const { makeDatastore } = await import('../../src/drivers/datastores.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ds = makeDatastore('main', spec(1) as any, 'stackB', 'k2');
    await ds.ensure({ envId: 'f0', cwd: server, dataDir: server }, 'dev', true, false);
    const before = lines(join(server, 'bakes.log')).length;
    const tpl = lines(join(server, 'bakes.log')).at(-1)!.split(' ')[1]!;
    rmSync(join(server, tpl), { recursive: true, force: true });
    const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((i) => ds.ensure({ envId: `f${i}`, cwd: server, dataDir: server }, 'dev', true, false)));
    const bakes = lines(join(server, 'bakes.log')).length - before;
    console.log('rebakes:', bakes, results.map((r) => r.status), lines(join(server, 'restores.log')));
    expect(bakes, 'the template was rebaked once per failing restore').toBe(1);
  }, 120_000);
});

describe('B2 two restores in lockstep (queued behind a sibling restore)', () => {
  it('(c) rebake a vanished template once, not once per restore', async () => {
    const { makeDatastore } = await import('../../src/drivers/datastores.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = spec(1) as any;
    // Same stack, two datastores: `audit` is healthy (its restore is the "leader"), `main`'s template vanished.
    const audit = makeDatastore('audit', { ...s, create: s.create.replace('bake.sh', 'bake.sh') }, 'stackC', 'ka');
    const main = makeDatastore('main', s, 'stackC', 'km');
    await audit.ensure({ envId: 'g0', cwd: server, dataDir: server }, 'dev', true, false);
    await main.ensure({ envId: 'g0', cwd: server, dataDir: server }, 'dev', true, false);
    const bakesBefore = lines(join(server, 'bakes.log'));
    const mainTpl = bakesBefore.at(-1)!.split(' ')[1]!;
    rmSync(join(server, mainTpl), { recursive: true, force: true });
    writeFileSync(join(server, 'restores.log'), '');
    const leader = audit.ensure({ envId: 'g1', cwd: server, dataDir: server }, 'dev', true, false);
    await new Promise((r) => setTimeout(r, 200));
    const both = await Promise.allSettled([2, 3].map((i) => main.ensure({ envId: `g${i}`, cwd: server, dataDir: server }, 'dev', true, false)));
    await leader;
    const rebakes = lines(join(server, 'bakes.log')).slice(bakesBefore.length).filter((l) => l.includes(mainTpl));
    console.log('main rebakes:', rebakes.length, both.map((r) => r.status), lines(join(server, 'restores.log')));
    expect(rebakes, 'both lockstep restores rebaked: the marker check compares identical content').toHaveLength(1);
  }, 120_000);
});

/**
 * Shared templates (decision 0044): a content-keyed template is baked once per
 * (manifest name, datastore, preset, key) and restored by every worktree of
 * that name on the daemon.
 *
 * The datastore is server-shaped: namespaces are directories under a private
 * "server" dir, every bake appends to `bakes.log` and every restore to
 * `restores.log`, so the test counts what the daemon did, not what it said.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx, SERVER, type Ctx } from './support/context.js';
import { disposeStateSync } from './support/leaks.js';
import { parseBakedMarker } from '../src/drivers/datastores.js';
import { templateVerdicts } from '../src/core/retention.js';

const ctxs: Ctx[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
  for (const d of dirs) disposeStateSync(d);
});

const server = (): string => {
  const s = realpathSync(mkdtempSync(join(tmpdir(), 'runly-shared-srv-')));
  dirs.push(s);
  return s;
};

/**
 * `main` is content-keyed (an @rebake-template rule names it); `aux` has no
 * rule, so its key is the create command alone and it must stay per worktree.
 */
const stack = (srv: string, opts: { share?: boolean; bakeSleep?: number } = {}) => `name: shared
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
datastores:
  main:
    driver: postgres
    url: "file://${srv}/{{ns}}"
    presets: [dev]
    create: 'mkdir -p "${srv}/{{ns}}" && cp seed/a.sql "${srv}/{{ns}}/data" && sleep ${opts.bakeSleep ?? 0} && echo "{{ns}}" >> "${srv}/bakes.log"'
    template_restore: 'cp -r "${srv}/{{template}}" "${srv}/{{ns}}" && echo "{{template}} {{ns}}" >> "${srv}/restores.log"'
    drop: 'rm -rf "${srv}/{{ns}}"'
    list: 'ls -1 "${srv}" | grep backlot_ || true'${opts.share === false ? '\n    share_templates: false' : ''}
  aux:
    driver: postgres
    url: "file://${srv}/{{ns}}"
    create: 'mkdir -p "${srv}/{{ns}}" && echo "{{ns}}" >> "${srv}/bakes.log"'
    template_restore: 'cp -r "${srv}/{{template}}" "${srv}/{{ns}}"'
    drop: 'rm -rf "${srv}/{{ns}}"'
upkeep:
  - { when: "seed/**", run: "@rebake-template main" }
`;

const lines = (f: string): string[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
/** `main`'s bakes (preset dev); `aux` has no presets, so its templates say `default`. */
const mainBakes = (srv: string) => lines(join(srv, 'bakes.log')).filter((l) => /_dev_[0-9a-f]{8}/.test(l));
const auxBakes = (srv: string) => lines(join(srv, 'bakes.log')).filter((l) => /_default_[0-9a-f]{8}/.test(l));
const tplDirs = (c: Ctx) => (existsSync(join(c.stateDir, 'templates')) ? readdirSync(join(c.stateDir, 'templates')) : []);
const markersIn = (c: Ctx, dir: string) => (existsSync(join(c.stateDir, 'templates', dir)) ? readdirSync(join(c.stateDir, 'templates', dir)).filter((f) => f.endsWith('.baked')) : []);
const envOf = (c: Ctx, wt: string) => c.journal().allEnvs().find((e) => e.stackRoot === realpathSync(wt));
const dataOf = (srv: string, c: Ctx, wt: string) => readFileSync(join(srv, envOf(c, wt)!.datastoreNs.main!, 'data'), 'utf8');

describe('templates are shared by every worktree of a stack name (decision 0044)', () => {
  it("the second worktree's first up restores without baking; a per-worktree datastore stays per worktree", async () => {
    const srv = server();
    const c = makeCtx();
    ctxs.push(c);
    const files = { 'runly.yml': stack(srv), 'server.mjs': SERVER, 'seed/a.sql': 'v1' };
    const a = c.worktree(files);
    const b = c.worktree(files);
    const upA = await c.cli(['up', '--json'], a);
    expect(upA.code, upA.stderr + upA.stdout).toBe(0);
    expect(mainBakes(srv)).toHaveLength(1);
    const upB = await c.cli(['up', '--json'], b);
    expect(upB.code, upB.stderr + upB.stdout).toBe(0);
    // `main` was baked once for both; B restored from A's bake.
    expect(mainBakes(srv)).toHaveLength(1);
    expect(dataOf(srv, c, b)).toBe('v1');
    expect(markersIn(c, 'shared@shared').filter((f) => f.startsWith('main-'))).toHaveLength(1);
    const shared = parseBakedMarker(readFileSync(join(c.stateDir, 'templates', 'shared@shared', markersIn(c, 'shared@shared')[0]!), 'utf8'));
    // The shared template's database names no worktree.
    expect(shared.ns).toMatch(/^backlot_tpl_shared_shared_dev_[0-9a-f]{8}$/);
    expect(envOf(c, b)!.templates?.main).toBe(`shared@shared/${markersIn(c, 'shared@shared')[0]}`);
    // `aux` has no @rebake-template rule: its key is not content-derived, so
    // each worktree baked its own, in its own stack dir.
    expect(auxBakes(srv)).toHaveLength(2);
    expect(markersIn(c, 'shared@shared').some((f) => f.startsWith('aux-'))).toBe(false);
    expect(tplDirs(c).filter((d) => d !== 'shared@shared').every((d) => markersIn(c, d).every((f) => f.startsWith('aux-')))).toBe(true);
  }, 120_000);

  it('share_templates: false keeps a content-keyed datastore per worktree', async () => {
    const srv = server();
    const c = makeCtx();
    ctxs.push(c);
    const files = { 'runly.yml': stack(srv, { share: false }), 'server.mjs': SERVER, 'seed/a.sql': 'v1' };
    const a = c.worktree(files);
    const b = c.worktree(files);
    expect((await c.cli(['up', '--json'], a)).code).toBe(0);
    expect((await c.cli(['up', '--json'], b)).code).toBe(0);
    expect(mainBakes(srv)).toHaveLength(2);
    expect(tplDirs(c)).not.toContain('shared@shared');
  }, 120_000);

  it('a content change in one worktree bakes a new key without disturbing the other; --pristine bakes privately', async () => {
    const srv = server();
    const c = makeCtx();
    ctxs.push(c);
    const files = { 'runly.yml': stack(srv), 'server.mjs': SERVER, 'seed/a.sql': 'v1' };
    const a = c.worktree(files);
    const b = c.worktree(files);
    expect((await c.cli(['up', '--json'], a)).code).toBe(0);
    expect((await c.cli(['up', '--json'], b)).code).toBe(0);
    const sharedBefore = markersIn(c, 'shared@shared').filter((f) => f.startsWith('main-'));
    expect(sharedBefore).toHaveLength(1);
    const baseline = mainBakes(srv).length;

    // B's seed moves on: a new key, baked once; A keeps its data and its template.
    writeFileSync(join(b, 'seed/a.sql'), 'v2');
    const upB = await c.cli(['up', '--json'], b);
    expect(upB.code, upB.stderr + upB.stdout).toBe(0);
    expect(dataOf(srv, c, b)).toBe('v2');
    expect(mainBakes(srv).length).toBe(baseline + 1);
    expect(dataOf(srv, c, a)).toBe('v1');
    for (const m of sharedBefore) expect(existsSync(join(c.stateDir, 'templates', 'shared@shared', m))).toBe(true);
    const resetA = await c.cli(['up', '--reset-data', '--json'], a);
    expect(resetA.code, resetA.stderr + resetA.stdout).toBe(0);
    expect(dataOf(srv, c, a)).toBe('v1');
    expect(mainBakes(srv).length).toBe(baseline + 1); // a restore, not a bake

    // --pristine in A: a private template for A; the shared one stays for B.
    const sharedNow = markersIn(c, 'shared@shared').filter((f) => f.startsWith('main-'));
    const pristine = await c.cli(['up', '--pristine', '--json'], a);
    expect(pristine.code, pristine.stderr + pristine.stdout).toBe(0);
    expect(mainBakes(srv).length).toBe(baseline + 2);
    const stackA = envOf(c, a)!.stack;
    const priv = markersIn(c, stackA).filter((f) => f.startsWith('main-') && f.includes('.own.'));
    expect(priv).toHaveLength(1);
    expect(envOf(c, a)!.templates?.main).toBe(`${stackA}/${priv[0]}`);
    expect(markersIn(c, 'shared@shared').filter((f) => f.startsWith('main-'))).toEqual(sharedNow);
    // B resets from the shared template, without a bake; A from its private one.
    const resetB = await c.cli(['up', '--reset-data', '--json'], b);
    expect(resetB.code, resetB.stderr + resetB.stdout).toBe(0);
    expect(dataOf(srv, c, b)).toBe('v2');
    const resetA2 = await c.cli(['up', '--reset-data', '--json'], a);
    expect(resetA2.code).toBe(0);
    expect(mainBakes(srv).length).toBe(baseline + 2);
    expect(lines(join(srv, 'restores.log')).at(-1)).toContain('_own_');

    // Doctor: the referenced templates, private and shared, are not findings;
    // the shared namespaces are owned (never "foreign").
    writeFileSync(join(srv, 'backlot_tpl_shared_shared_dev_deadbeef'), '');
    const doc = await c.cli(['pool', 'doctor', '--json'], a);
    expect(doc.code, doc.stderr + doc.stdout).toBeLessThanOrEqual(1);
    const findings = (doc.json?.findings ?? []) as Array<{ kind: string; what: string }>;
    // The v1 shared template is superseded (A now restores from its private
    // copy, B from v2) and is the only template finding.
    const inUse = [envOf(c, a)!.templates!.main!, envOf(c, b)!.templates!.main!];
    expect(findings.filter((f) => f.kind === 'template').map((f) => f.what.split('/templates/')[1])).toEqual(
      sharedNow.filter((m) => !inUse.includes(`shared@shared/${m}`)).map((m) => `shared@shared/${m}`),
    );
    expect(findings.find((f) => f.what === 'backlot_tpl_shared_shared_dev_deadbeef')?.kind).toBe('namespace');
    expect(findings.filter((f) => f.kind === 'foreign-namespace')).toEqual([]);
  }, 180_000);

  it('a concurrent first up in three worktrees bakes once', async () => {
    const srv = server();
    const c = makeCtx();
    ctxs.push(c);
    const files = { 'runly.yml': stack(srv, { bakeSleep: 2 }), 'server.mjs': SERVER, 'seed/a.sql': 'v1' };
    const trees = [c.worktree(files), c.worktree(files), c.worktree(files)];
    const ups = await Promise.all(trees.map((t) => c.cli(['up', '--json'], t)));
    for (const u of ups) expect(u.code, u.stderr + u.stdout).toBe(0);
    expect(mainBakes(srv)).toEqual([expect.stringMatching(/^backlot_tpl_shared_shared_dev_/)]);
    expect(lines(join(srv, 'restores.log')).filter((l) => l.startsWith('backlot_tpl_shared_shared'))).toHaveLength(3);
    for (const t of trees) expect(dataOf(srv, c, t)).toBe('v1');
  }, 180_000);

  it('adopts a per-worktree template with the same key instead of baking (migration)', async () => {
    const srv = server();
    const c = makeCtx();
    ctxs.push(c);
    // A bakes per worktree (the pre-0.20 layout); B shares.
    const a = c.worktree({ 'runly.yml': stack(srv, { share: false }), 'server.mjs': SERVER, 'seed/a.sql': 'v1' });
    const b = c.worktree({ 'runly.yml': stack(srv), 'server.mjs': SERVER, 'seed/a.sql': 'v1' });
    expect((await c.cli(['up', '--json'], a)).code).toBe(0);
    const legacyBakes = mainBakes(srv).length;
    const stackA = envOf(c, a)!.stack;
    const legacy = markersIn(c, stackA).find((f) => f.startsWith('main-'))!;
    const legacyNs = parseBakedMarker(readFileSync(join(c.stateDir, 'templates', stackA, legacy), 'utf8')).ns;
    const upB = await c.cli(['up', '--json'], b);
    expect(upB.code, upB.stderr + upB.stdout).toBe(0);
    expect(mainBakes(srv).length).toBe(legacyBakes); // adopted, not baked
    const adopted = parseBakedMarker(readFileSync(join(c.stateDir, 'templates', 'shared@shared', legacy), 'utf8'));
    expect(adopted.ns).toBe(legacyNs);
    expect(adopted.adoptedFrom).toBe(stackA);
    expect(dataOf(srv, c, b)).toBe('v1');

    // A switches to sharing; once nothing references the per-worktree marker,
    // doctor --fix removes the marker only — the database the shared marker
    // names stays.
    writeFileSync(join(a, 'runly.yml'), stack(srv));
    expect((await c.cli(['up', '--reset-data', '--json'], a)).code).toBe(0);
    expect(envOf(c, a)!.templates?.main).toBe(`shared@shared/${legacy}`);
    const doc = await c.cli(['pool', 'doctor', '--fix', '--json'], a);
    const dup = ((doc.json?.findings ?? []) as Array<{ kind: string; what: string; fixed?: boolean; detail: string }>).find((f) => f.what.endsWith(join(stackA, legacy)));
    expect(dup?.fixed, doc.stdout + doc.stderr).toBe(true);
    expect(dup?.detail).toMatch(/copy of a shared template/);
    expect(existsSync(join(srv, legacyNs))).toBe(true);
    expect((await c.cli(['up', '--reset-data', '--json'], b)).code).toBe(0);
    expect(dataOf(srv, c, b)).toBe('v1');
  }, 180_000);
});

describe('retention verdicts for shared templates (decision 0044)', () => {
  const refs = (referenced: string[], alive = true) => ({ referenced: new Set(referenced), stackAlive: () => alive });
  const old = Date.now() - 3 * 3600_000;
  it('keeps the newest shared per datastore+preset and every referenced one', () => {
    const v = templateVerdicts('p@shared', [
      { f: 'main-dev@aaa.baked', mtime: old + 3 },
      { f: 'main-dev@bbb.baked', mtime: old + 2 },
      { f: 'main-dev@ccc.baked', mtime: old + 1 },
    ], refs(['p@shared/main-dev@ccc.baked']), 1, 3600_000);
    expect(v.map((x) => [x.f, x.keep, x.why])).toEqual([
      ['main-dev@aaa.baked', true, 'current'],
      ['main-dev@bbb.baked', false, 'superseded'],
      ['main-dev@ccc.baked', true, 'referenced'],
    ]);
  });
  it('a private template stays only while referenced; a duplicate of a shared one is never current', () => {
    const v = templateVerdicts('p-abcdefgh', [
      { f: 'main-dev@aaa.own.baked', mtime: old + 3 },
      { f: 'main-dev@aaa.baked', mtime: old + 2 },
      { f: 'main-dev@zzz.baked', mtime: old + 1 },
    ], refs([]), 1, 3600_000, new Set(['main-dev@aaa.baked']));
    expect(v.map((x) => [x.f, x.keep, x.why])).toEqual([
      ['main-dev@aaa.own.baked', false, 'private'],
      ['main-dev@aaa.baked', false, 'duplicate'],
      ['main-dev@zzz.baked', true, 'current'],
    ]);
  });
});


describe('sqlite templates are shared the same way', () => {
  it('bakes one shared template file for two worktrees', async () => {
    const srv = server();
    const c = makeCtx();
    ctxs.push(c);
    const yml = `name: sq
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
datastores:
  main: { driver: sqlite, template: true, create: 'cp seed/a.sql "{{ns}}" && echo bake >> "${srv}/bakes.log"' }
upkeep:
  - { when: "seed/**", run: "@rebake-template main" }
`;
    const files = { 'runly.yml': yml, 'server.mjs': SERVER, 'seed/a.sql': 'v1' };
    const a = c.worktree(files);
    const b = c.worktree(files);
    expect((await c.cli(['up', '--json'], a)).code).toBe(0);
    expect((await c.cli(['up', '--json'], b)).code).toBe(0);
    expect(lines(join(srv, 'bakes.log'))).toHaveLength(1);
    expect(readdirSync(join(c.stateDir, 'templates', 'sq@shared')).filter((f) => f.endsWith('.db'))).toHaveLength(1);
    expect(readFileSync(envOf(c, b)!.datastoreNs.main!, 'utf8')).toBe('v1');
  }, 120_000);
});

describe('retention keeps what any worktree of the name uses (decision 0044)', () => {
  it('a shared dir is alive while one worktree of its name is; a live worktree\'s record is a reference', async () => {
    const state = realpathSync(mkdtempSync(join(tmpdir(), 'runly-shared-ret-')));
    dirs.push(state);
    const live = realpathSync(mkdtempSync(join(tmpdir(), 'runly-shared-live-')));
    dirs.push(live);
    const prev = process.env.BACKLOT_STATE_DIR;
    process.env.BACKLOT_STATE_DIR = state;
    try {
      const { Journal } = await import('../src/core/journal.js');
      const { templateRefs, pruneTemplates } = await import('../src/core/retention.js');
      const { recordWorktreeTemplate } = await import('../src/core/tree-ledger.js');
      const tpl = join(state, 'templates', 'p@shared');
      mkdirSync(tpl, { recursive: true });
      const old = new Date(Date.now() - 3 * 3600_000);
      for (const [f, age] of [['main-dev@new.db', 1], ['main-dev@mid.db', 2], ['main-dev@old.db', 3]] as const) {
        writeFileSync(join(tpl, f), 'x');
        utimesSync(join(tpl, f), old, new Date(old.getTime() - age * 1000));
      }
      // A worktree of `p` with no environment, whose last restore was `mid`.
      recordWorktreeTemplate('p-abcdefgh', live, 'main/dev', 'p@shared/main-dev@mid.db');
      const journal = new Journal(join(state, 'journal.db'));
      const refs = templateRefs(journal);
      expect(refs.stackAlive('p@shared')).toBe(true);
      expect(refs.stackAlive('q@shared')).toBe(false);
      expect(refs.referenced.has('p@shared/main-dev@mid.db')).toBe(true);
      expect(await pruneTemplates({ templatesKeep: 1, templateGraceMs: 0 }, join(state, 'templates'), refs)).toBe(1);
      expect(readdirSync(tpl).sort()).toEqual(['main-dev@mid.db', 'main-dev@new.db']);
      // The worktree goes: nothing of `p` can be bound again, so nothing stays.
      rmSync(live, { recursive: true, force: true });
      expect(await pruneTemplates({ templatesKeep: 1, templateGraceMs: 0 }, join(state, 'templates'), templateRefs(journal))).toBe(2);
      expect(existsSync(tpl)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.BACKLOT_STATE_DIR;
      else process.env.BACKLOT_STATE_DIR = prev;
    }
  });
});

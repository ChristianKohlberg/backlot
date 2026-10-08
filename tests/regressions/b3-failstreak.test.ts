/**
 * Regressions from the 0.18 bug hunt (B3), fixed in 0.18.1. Failed against
 * 0.18.0 (2345a24): a service that crashed at boot during a bind of a leased
 * environment failed the whole bind (every service stopped, wake and exec
 * refused), counted toward failStreak, and after two such `up`s the next one
 * was escalated to pristine — wiping the environment's data, the opposite of
 * decision 0039. The FIXED behaviour is asserted below.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCtx, SERVER, type Ctx } from '../support/context.js';

const ctxs: Ctx[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
});

const FLAKY = `import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
if (existsSync('crash.flag')) { console.error('boom'); process.exit(3); }
createServer((q, s) => s.end('api ' + process.pid)).listen(Number(process.env.PORT), '127.0.0.1');
`;

const manifest = (name: string, gen = 0) => `name: ${name}
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
  api: { run: node flaky.mjs, build: node build.mjs, port: api, env: { PORT: "{{ports.api}}", GEN: "${gen}" }, ready: { http: /, timeout: 20 }, depends_on: [web] }
datastores:
  main: { driver: sqlite, create: 'node seed.mjs "{{ns}}"', template: true }
`;
const files = (name: string) => ({
  'runly.yml': manifest(name),
  'flaky.mjs': FLAKY,
  'build.mjs': `import { existsSync } from 'node:fs'; if (existsSync('build.flag')) { console.error('build broke'); process.exit(2); }\n`,
  'server.mjs': SERVER,
  'seed.mjs': `import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(process.argv[2]).exec('CREATE TABLE IF NOT EXISTS t(x)');\n`,
  '.gitignore': 'crash.flag\nbuild.flag\n',
});

const sql = (db: string, q: string) =>
  execFileSync(process.execPath, ['--no-warnings', '-e', `const { DatabaseSync } = require('node:sqlite'); const d = new DatabaseSync(${JSON.stringify(db)}); const r = d.prepare(${JSON.stringify(q)}).all(); console.log(JSON.stringify(r));`], { encoding: 'utf8' }).trim();

describe('B3 a service failing during a bind of a leased environment (0.18.1)', () => {
  it('a service crashing at boot is reported failed and leaves the rest running and usable', async () => {
    const c = makeCtx({ BACKLOT_SWEEP_MS: '200' });
    ctxs.push(c);
    const wt = c.worktree(files('b3boot'));
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    writeFileSync(join(wt, 'crash.flag'), '1');
    writeFileSync(join(wt, 'runly.yml'), manifest('b3boot', 1)); // a manifest change: a full bind restarts api
    const failing = await c.cli(['up', '--json'], wt);
    expect(failing.code).not.toBe(0);
    expect(failing.json?.error?.message).toMatch(/service 'api' failed to boot: exited during boot.*the other services keep running/);
    const env = c.journal().allEnvs()[0]!;
    expect(env.failStreak, 'one failed service is not a failed bind').toBe(0);
    expect(Object.keys(env.servicePids), 'the healthy service was stopped with the failed bind').toContain('web');
    expect(Object.keys(env.servicePids)).not.toContain('api');
    const r = await fetch(up.json.urls.web).then((x) => `${x.status}`, (e) => `error ${String(e.cause?.code ?? e)}`);
    expect(r, 'the healthy service does not answer').toBe('200');
    const ps = await c.cli(['ps', '--json'], wt);
    const api = ps.json.services.find((s: { service: string }) => s.service === 'api');
    expect(api.state).toBe('failed');
    expect(api.failure.reason).toBe('boot-failed');
    // exec is not refused because of the failed service.
    const ex = await c.cli(['exec', '--', 'node', '-e', 'process.exit(0)'], wt);
    expect(ex.code, ex.stderr + ex.stdout).toBe(0);
  }, 120_000);

  it('a crashing service never escalates the leased environment to a pristine bind that wipes the data', async () => {
    const c = makeCtx({ BACKLOT_SWEEP_MS: '200' });
    ctxs.push(c);
    const wt = c.worktree(files('b3wipe'));
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const db = up.json.datastores.main.ns as string;
    sql(db, "INSERT INTO t(x) VALUES ('work in progress') RETURNING x");
    writeFileSync(join(wt, 'crash.flag'), '1');
    for (let i = 0; i < 2; i++) {
      writeFileSync(join(wt, 'runly.yml'), manifest('b3wipe', i + 1));
      const f = await c.cli(['up', '--json'], wt);
      expect(f.code).not.toBe(0);
    }
    rmSync(join(wt, 'crash.flag'));
    const fixed = await c.cli(['up', '--json'], wt);
    expect(fixed.code, fixed.stderr + fixed.stdout).toBe(0);
    expect(fixed.json.bindDiagnostics?.reasons).not.toContain('hygiene-pristine');
    expect(sql(fixed.json.datastores.main.ns, 'SELECT x FROM t'), 'the leased environment lost its data').toContain('work in progress');
  }, 180_000);

  it('two failed binds of a leased environment do not escalate it to pristine either', async () => {
    const c = makeCtx({ BACKLOT_SWEEP_MS: '200' });
    ctxs.push(c);
    const wt = c.worktree(files('b3build'));
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    sql(up.json.datastores.main.ns, "INSERT INTO t(x) VALUES ('work in progress') RETURNING x");
    // A failing build is a real bind failure: it still counts …
    writeFileSync(join(wt, 'build.flag'), '1');
    for (let i = 0; i < 2; i++) {
      const f = await c.cli(['up', '--json'], wt);
      expect(f.code).not.toBe(0);
    }
    expect(c.journal().allEnvs()[0]!.failStreak).toBeGreaterThanOrEqual(2);
    // … but the environment is leased: the next `up` keeps its data.
    rmSync(join(wt, 'build.flag'));
    const fixed = await c.cli(['up', '--json'], wt);
    expect(fixed.code, fixed.stderr + fixed.stdout).toBe(0);
    expect(fixed.json.bindDiagnostics?.reasons).not.toContain('hygiene-pristine');
    expect(sql(fixed.json.datastores.main.ns, 'SELECT x FROM t')).toContain('work in progress');
  }, 180_000);
});

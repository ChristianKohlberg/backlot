/**
 * Fleet review, datastore-driver cluster. Each test drives the real driver and
 * asserts on real state (file contents, database rows, wall-clock), not on
 * whether a function was called.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeDatastore, type DsHandle } from '../src/drivers/datastores.js';
import { runBounded } from '../src/core/exec.js';

const dirs: string[] = [];
const mk = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function handle(envId = 'ds-e1'): DsHandle {
  const root = mk('backlot-ds-');
  return { envId, envTree: root, dataDir: join(root, 'data') };
}

describe('sqlite: WAL sidecars must not survive a template restore', () => {
  it("does not replay a previous lease's WAL onto a restored database", async () => {
    process.env.BACKLOT_STATE_DIR = mk('backlot-ds-state-');
    const h = handle();
    // template: true is the path the finding describes — restore is a file
    // copy over the .db, which leaves any sidecar untouched. The create
    // command seeds a marker row so template content is identifiable.
    const seed = join(mk('backlot-ds-seed-'), 'seed.mjs');
    writeFileSync(
      seed,
      `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('DROP TABLE IF EXISTS rows');
db.exec('CREATE TABLE rows (v TEXT)');
db.exec("INSERT INTO rows VALUES ('from-template')");
db.close();`,
    );
    const ds = makeDatastore(
      'app',
      { driver: 'sqlite', file: 'app.db', create: `node ${seed} {{ns}}`, template: true } as never,
      'stk',
    );
    const dbPath = ds.ns(h);

    // Lease 1: bake + restore, then write in WAL mode and leave the sidecar
    // behind exactly as a SIGKILLed dev-server would.
    await ds.ensure(h, 'dev', false, false);
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec("INSERT INTO rows VALUES ('lease-one-secret')");
    const wal = `${dbPath}-wal`;
    const walBytes = existsSync(wal) ? readFileSync(wal) : null;
    db.close();
    expect(walBytes).not.toBeNull(); // the scenario requires a real WAL

    // Lease 2, hygiene reset-data -> force: restore copies the template over
    // the .db. Re-plant the crash-left sidecar to model the race.
    writeFileSync(wal, walBytes!);
    await ds.ensure(h, 'dev', true, true);

    expect(existsSync(wal)).toBe(false);

    // The restored store must contain ONLY template content. If the stale WAL
    // survived, SQLite recovers lease one's frames and the secret reappears in
    // an environment the user was told was reset.
    const fresh = new DatabaseSync(dbPath);
    const vals = (fresh.prepare('SELECT v FROM rows').all() as Array<{ v: string }>).map((r) => r.v);
    fresh.close();
    expect(vals).toEqual(['from-template']);
    expect(vals).not.toContain('lease-one-secret');
  }, 30_000);

  it('drop removes the sidecars too, so the next database is not poisoned', async () => {
    const h = handle();
    const ds = makeDatastore('app', { driver: 'sqlite', file: 'app.db', create: 'true' } as never, 'stk');
    const dbPath = ds.ns(h);
    await ds.ensure(h, 'dev', false, false);
    writeFileSync(`${dbPath}-wal`, 'stale');
    writeFileSync(`${dbPath}-shm`, 'stale');

    await ds.drop(h);

    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);
  });
});

describe('command family: namespaces must not collide', () => {
  it('gives two same-driver datastores in one stack distinct namespaces', () => {
    const h = handle('stk-e7');
    const spec = { driver: 'postgres', url: 'postgres://localhost/{{ns}}', create: 'true' } as never;
    const app = makeDatastore('app', spec, 'stk');
    const audit = makeDatastore('audit', spec, 'stk');

    // Before the fix both were `backlot_stk_e7`: audit's clean-slate drop
    // destroyed app's freshly seeded database, and both services were handed
    // the identical url.
    expect(app.ns(h)).not.toBe(audit.ns(h));
    expect(app.url(h)).not.toBe(audit.url(h));
    // Still SQL-safe and still env-scoped.
    expect(app.ns(h)).toMatch(/^[A-Za-z0-9_]+$/);
    expect(app.ns(h)).toContain('e7');
    expect(app.ns(h)).toContain('app');
  });

  it('keeps namespaces distinct across environments as well', () => {
    const spec = { driver: 'postgres', url: 'postgres://localhost/{{ns}}', create: 'true' } as never;
    const app = makeDatastore('app', spec, 'stk');
    expect(app.ns(handle('stk-e1'))).not.toBe(app.ns(handle('stk-e2')));
  });
});

describe('repo-declared commands are bounded', () => {
  it('kills a hung command and its whole process group', async () => {
    const cwd = mk('backlot-ds-hang-');
    const marker = join(cwd, 'child-alive');
    const started = Date.now();

    // `sh -c` forks, so the grandchild is what actually leaks. It touches a
    // file every 200ms; if the group survived the timeout it keeps touching.
    const r = await runBounded(
      `sh -c 'while true; do touch ${marker}; sleep 0.2; done' & wait`,
      cwd,
      1,
    );
    const elapsed = Date.now() - started;

    expect(r.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(6000); // bounded, not hung forever

    // Prove the descendant died: clear the marker, wait, and it must not return.
    rmSync(marker, { force: true });
    await new Promise((res) => setTimeout(res, 1200));
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('reports a normal failure without waiting for the timeout', async () => {
    const started = Date.now();
    const r = await runBounded('exit 3', mk('backlot-ds-fail-'), 30);
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('captures output from a successful command', async () => {
    const r = await runBounded('echo hello-from-cmd', mk('backlot-ds-ok-'), 30);
    expect(r.code).toBe(0);
    expect(r.output).toContain('hello-from-cmd');
  });

  it('settles even when the command cannot be spawned', async () => {
    // A cwd that does not exist makes spawn emit 'error' with no 'exit'. The
    // promise must still settle, or the caller's lock wedges forever.
    const r = await runBounded('true', join(tmpdir(), 'backlot-does-not-exist-xyz'), 5);
    expect(r.code).toBe(1);
  });
});

describe('baked template markers self-heal when the server loses the template', () => {
  it('rebakes instead of failing every future bind forever', async () => {
    // A file-backed stand-in for a server: "databases" are files in a dir, so
    // wiping the appliance (docker rm -f, volume prune) is an rm -rf. No real
    // postgres needed to drive the exact failure.
    const server = mk('backlot-ds-server-');
    process.env.BACKLOT_STATE_DIR = mk('backlot-ds-state2-');
    const h = handle('bake-e1');

    const spec = {
      driver: 'postgres',
      url: 'fake://{{ns}}',
      create: `echo baked > ${server}/{{ns}}`,
      // Restore FAILS when the template file is absent, exactly as
      // `createdb -T missing_template` does.
      template_restore: `test -f ${server}/{{template}} && cp ${server}/{{template}} ${server}/{{ns}}`,
      drop: `rm -f ${server}/{{ns}}`,
    } as never;
    const ds = makeDatastore('app', spec, 'stk-bake');

    // First bind bakes the template and writes the local marker.
    await ds.ensure(h, 'dev', false, false);
    expect(existsSync(join(server, ds.ns(h)))).toBe(true);
    const templates = readFileSync(join(server, ds.ns(h)), 'utf8');
    expect(templates.trim()).toBe('baked');

    // The appliance is recreated empty. Every server-side database is gone,
    // but the LOCAL marker still claims the template exists.
    rmSync(server, { recursive: true, force: true });
    mkdirSync(server, { recursive: true });

    // Before the fix this threw 'template restore failed' on this bind and
    // every bind after it, blaming the repo's restore command for what was an
    // infrastructure event, with no path back short of deleting state by hand.
    await ds.ensure(h, 'dev', true, true);
    expect(existsSync(join(server, ds.ns(h)))).toBe(true);
    expect(readFileSync(join(server, ds.ns(h)), 'utf8').trim()).toBe('baked');
  }, 30_000);

  it('still surfaces a genuinely broken restore command after rebaking', async () => {
    const server = mk('backlot-ds-server2-');
    process.env.BACKLOT_STATE_DIR = mk('backlot-ds-state3-');
    const h = handle('bake-e2');
    const ds = makeDatastore(
      'app',
      {
        driver: 'postgres',
        url: 'fake://{{ns}}',
        create: `echo baked > ${server}/{{ns}}`,
        template_restore: 'exit 7', // always broken — not an infrastructure blip
        drop: `rm -f ${server}/{{ns}}`,
      } as never,
      'stk-bake2',
    );
    // Self-healing must not become an infinite retry that hides a real defect:
    // one rebake, one retry, then the repo's error surfaces.
    await expect(ds.ensure(h, 'dev', false, false)).rejects.toThrow(/template restore failed/);
  }, 30_000);
});

describe('template identifiers survive Postgres truncation', () => {
  it('keeps the disambiguating hash for a long stack id', () => {
    const spec = { driver: 'postgres', url: 'postgres://h/{{ns}}', create: 'echo a', template_restore: 'true', drop: 'true' } as never;
    const longStack = 'a-really-quite-long-monorepo-stack-identifier-that-goes-on';
    const a = makeDatastore('app', spec, longStack) as unknown as { templateNs?: (p: string) => string };
    // templateNs is private; drive it through the public surface instead by
    // comparing two datastores whose ONLY difference is the create command,
    // which is what the content hash encodes.
    const one = makeDatastore('app', { ...(spec as object), create: 'echo one' } as never, longStack);
    const two = makeDatastore('app', { ...(spec as object), create: 'echo two' } as never, longStack);
    void a;

    // Both build a template name from stackId + preset + a content hash. With
    // the hash at the END, Postgres's 63-char truncation silently removed it
    // and two different templates collapsed onto one database.
    const nsOne = (one as unknown as { templateNs: (p: string) => string })['templateNs']?.call(one, 'dev');
    const nsTwo = (two as unknown as { templateNs: (p: string) => string })['templateNs']?.call(two, 'dev');
    expect(nsOne).toBeDefined();
    expect(nsOne!.length).toBeLessThanOrEqual(63);
    expect(nsTwo!.length).toBeLessThanOrEqual(63);
    expect(nsOne).not.toBe(nsTwo);
  });
});

describe('an ephemeral flush failure is reported, not swallowed', () => {
  it('fails the reset instead of claiming a store was cleared', async () => {
    process.env.BACKLOT_STATE_DIR = mk('backlot-ds-eph-');
    const h = handle('eph-e1');
    const ds = makeDatastore(
      'cache',
      { driver: 'redis', url: 'redis://h/{{ns}}', ephemeral: true, create: 'true', drop: 'exit 9' } as never,
      'stk-eph',
    );
    await ds.ensure(h, 'dev', false, false); // first bind: create only

    // force+exists is the reset-data path. The drop command IS the reset here,
    // so swallowing its failure handed back an environment that reported clean
    // hygiene while still holding the previous lease's keys.
    await expect(ds.ensure(h, 'dev', true, true)).rejects.toThrow(/NOT reset|flush failed/);
  }, 30_000);
});

describe('command-datastore namespaces obey the 63-byte identifier limit', () => {
  it('two long datastore names stay DISTINCT after truncation', () => {
    // Postgres silently cuts identifiers at 63 bytes. The env id + a long
    // datastore name overflowed that, and because the disambiguating name sat
    // at the END, two datastores truncated to the same identifier — so one's
    // clean-slate drop destroyed the other's data. templateNs() already got
    // this defense; ns() needs the same one.
    const spec = { driver: 'postgres', server: 'external', create: 'true', url: 'postgres://x/{{ns}}' } as never;
    const h: DsHandle = {
      envId: 'analytics-platform-backend-Ab3dEf9h-e12',
      envTree: '/tmp/x',
      dataDir: '/tmp/x/data',
    };
    const a = makeDatastore('reporting_readmodel', spec, 'stk').ns(h);
    const b = makeDatastore('reporting_readmodel_v2', spec, 'stk').ns(h);
    expect(a.length).toBeLessThanOrEqual(63);
    expect(b.length).toBeLessThanOrEqual(63);
    expect(a).not.toBe(b);
    // Short names keep the historical readable scheme — existing databases
    // must stay addressable across an upgrade.
    expect(makeDatastore('app', spec, 'stk').ns({ ...h, envId: 'web-x1-e1' })).toBe('backlot_web_x1_e1_app');
  });
});

describe('rebake serializes with an in-flight bake/restore', () => {
  it('a concurrent rebake cannot delete the template out from under a bind', async () => {
    // engine's upkeep pass calls rebake while OTHER envs of the same stack may
    // be inside ensure(): unserialized, the rm of the template dir landed
    // between a sibling's bake and its restore copy, failing an innocent bind
    // with a spurious infra-error (and bumping its failStreak).
    process.env.BACKLOT_STATE_DIR = mk('backlot-ds-rebake-');
    const h = handle('rb-e1');
    const seed = join(mk('backlot-ds-rbseed-'), 'seed.mjs');
    writeFileSync(
      seed,
      `import { DatabaseSync } from 'node:sqlite';
await new Promise((r) => setTimeout(r, 600)); // a deliberately SLOW bake
const db = new DatabaseSync(process.argv[2]);
db.exec('CREATE TABLE t (v TEXT)');
db.close();`,
    );
    const ds = makeDatastore(
      'app',
      { driver: 'sqlite', file: 'app.db', create: `node ${seed} {{ns}}`, template: true } as never,
      'stk-rebake',
    );
    const bind = ds.ensure(h, 'dev', false, false);
    await new Promise((r) => setTimeout(r, 150)); // rebake lands mid-bake
    await ds.rebake();
    await expect(bind).resolves.toBeUndefined(); // the bind must survive
    // And the rebake still did its job once the bake was out of the way.
    const h2 = handle('rb-e2');
    await expect(ds.ensure(h2, 'dev', false, false)).resolves.toBeUndefined();
  }, 30_000);
});

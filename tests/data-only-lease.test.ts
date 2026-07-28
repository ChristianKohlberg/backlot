/**
 * `backlot up --data-only`: lease the datastores, not the application (issue #39).
 *
 * The reported shape: a repo whose application environments backlot already
 * brokers well runs its integration tests outside backlot, because the unit a
 * test lane needs — "a warm, seeded database, leased per consumer, reset on
 * release" — was not available on its own. So every agent started its own SQL
 * Server container and restored a full legacy backup into it, per test
 * collection: 4m18s + 3m16s of actual assertions became ~2 hours of wall clock
 * with three agents active. Idle-box runs improved only ~20%, which says the
 * cost is structural (container start + restore, repeated) rather than
 * contention.
 *
 * The two options before this were "lease a whole application environment"
 * (heavier than a test lane needs, and it competes with the interactive leases
 * agents use to LOOK at the app) or "build your own" — and everybody built
 * their own.
 *
 * The distinction that makes this more than a flag: an empty service SELECTION
 * has always meant "the whole app", so "no services" needed its own durable
 * representation. Without it, a shape-preserving rebind — `reset-data` on a data
 * lease, which is exactly what a lane does between runs — would boot the stack.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../src/core/journal.js';
import { scanTagged } from '../src/core/procscan.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

/** A stack with one service AND one datastore, so both halves can be observed. */
function ctx(opts: { datastores?: boolean } = {}) {
  const withStore = opts.datastores !== false;
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-dataonly-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-dataonly-wt-'));
  writeFileSync(
    join(wt, 'srv.mjs'),
    `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT));\n`,
  );
  // The manifest's own create hook, exactly as a real repo declares it.
  writeFileSync(
    join(wt, 'seed.mjs'),
    `import { DatabaseSync } from 'node:sqlite';
const [dbPath, preset] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec('DROP TABLE IF EXISTS rows');
db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY, note TEXT NOT NULL)');
const seeds = { dev: ['one', 'two', 'three'], empty: [] };
for (const note of seeds[preset] ?? []) db.prepare('INSERT INTO rows (note) VALUES (?)').run(note);
db.close();
`,
  );
  writeFileSync(
    join(wt, 'stack.yaml'),
    `name: dataonly\n` +
      `services:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: ready, timeout: 20 } }\n` +
      (withStore
        ? `datastores:\n  main:\n    driver: sqlite\n    create: node seed.mjs {{ns}} {{preset}}\n    presets: [dev, empty]\n    default_preset: { session: dev, run: empty }\n    template: true\n`
        : '') +
      `checks:\n  ok: { run: "true" }\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '400' };
  const cli = (args: string[], cwd = wt) =>
    new Promise<{ code: number; json?: Record<string, unknown>; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const journal = () => new Journal(join(stateDir, 'journal.db'));
  cleanups.push(() => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* already gone */
    }
    for (const p of scanTagged(stateDir)) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });
  return { stateDir, wt, cli, journal };
}

/** What the leased store actually contains — the only proof that seeding ran. */
function notes(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare('SELECT note FROM rows ORDER BY id').all() as Array<{ note: string }>).map((r) => r.note);
  } finally {
    db.close();
  }
}

/** Real service processes for this state root, by tag — never a cmdline grep. */
const serviceCount = (stateDir: string): number => scanTagged(stateDir).length;

describe('a data-only lease hands over a seeded store and nothing else', () => {
  it('seeds the datastore, starts no services, and says so in the context blob', async () => {
    const { cli, stateDir, journal } = ctx();

    const up = await cli(['up', '--data-only', '--ttl', '10', '--json']);
    expect(up.code, up.stderr).toBe(0);

    // The whole point: a real, seeded database at its session preset.
    const url = (up.json?.datastores as Record<string, { url: string }>).main.url;
    expect(notes(url)).toEqual(['one', 'two', 'three']);

    // And none of the weight a test lane was paying for.
    expect(serviceCount(stateDir), 'a data-only lease started services').toBe(0);
    expect(up.json?.urls).toEqual({});
    // `urls: {}` alone is ambiguous — it is also what a failed service looks
    // like. A fixture reading this blob has to be able to tell.
    expect(up.json?.dataOnly).toBe(true);
    // `warm` is the honest state: nothing is running, everything else is intact.
    expect(up.json?.state).toBe('warm');

    const envId = String(up.json?.envId);
    expect(journal().getEnv(envId)?.dataOnly).toBe(true);
  }, 120_000);

  it('lets exec run against the lease, even though the env is warm', async () => {
    // assertUsable refuses a warm env because warm normally means "the daemon
    // restarted and your services are gone". A data-only env is warm BY DESIGN,
    // and refusing it would break the one verb such a lease has left.
    const { cli } = ctx();
    expect((await cli(['up', '--data-only', '--json'])).code).toBe(0);

    const res = await cli(['exec', 'echo', 'reached-the-env']);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/reached-the-env/);
  }, 120_000);

  it('reset-data restores the store without booting the application', async () => {
    // The between-runs move for a test lane. A shape-preserving rebind reads the
    // env's recorded shape, and an empty shape has always resolved to "the whole
    // app" — so without a durable data-only flag this booted the stack.
    const { cli, stateDir } = ctx();
    const up = await cli(['up', '--data-only', '--json']);
    const url = (up.json?.datastores as Record<string, { url: string }>).main.url;

    // Dirty the store the way a test run would.
    const db = new DatabaseSync(url);
    db.exec("INSERT INTO rows (note) VALUES ('left over from a test')");
    db.close();
    expect(notes(url)).toContain('left over from a test');

    const reset = await cli(['reset-data', '--json']);
    expect(reset.code, reset.stderr).toBe(0);
    expect(reset.json?.dataOnly).toBe(true);
    expect(reset.json?.urls).toEqual({});
    expect(serviceCount(stateDir), 'reset-data booted the app on a data-only lease').toBe(0);
    // Back to the baseline, which is the other half of "reset on release".
    expect(notes(url)).toEqual(['one', 'two', 'three']);
  }, 120_000);

  it('gives two holders two separate stores — a database per consumer', async () => {
    // This is the actual ask: a per-run database on the pooled server rather
    // than a container per test collection.
    const { cli, journal } = ctx();
    const a = await cli(['up', '--data-only', '--json']);
    const b = await cli(['up', '--data-only', '--holder', 'lane-2', '--json']);
    expect(a.code, a.stderr).toBe(0);
    expect(b.code, b.stderr).toBe(0);
    expect(a.json?.envId).not.toBe(b.json?.envId);

    const urlA = (a.json?.datastores as Record<string, { url: string }>).main.url;
    const urlB = (b.json?.datastores as Record<string, { url: string }>).main.url;
    expect(urlA).not.toBe(urlB);

    // Isolation is the property under test: one lane's writes must not be
    // visible to the other, which is what Testcontainers was being used for.
    const db = new DatabaseSync(urlA);
    db.exec("INSERT INTO rows (note) VALUES ('only lane 1')");
    db.close();
    expect(notes(urlA)).toContain('only lane 1');
    expect(notes(urlB)).not.toContain('only lane 1');

    for (const env of journal().allEnvs()) expect(env.dataOnly).toBe(true);
  }, 120_000);
});

describe('a data-only environment does not leak its shape to the next holder', () => {
  it('a fresh claim after release brings the whole app up again', async () => {
    // activeServices is deliberately not inherited across owners, and dataOnly
    // must follow the same rule — otherwise one lane's data lease would silently
    // turn the next agent's `up` into a service-less environment.
    const { cli, stateDir, journal } = ctx();
    const first = await cli(['up', '--data-only', '--json']);
    const envId = String(first.json?.envId);
    await cli(['release', '--json']);

    const second = await cli(['up', '--holder', 'a-different-agent', '--json']);
    expect(second.code, second.stderr).toBe(0);
    expect(second.json?.envId, 'expected the pooled env to be reused').toBe(envId);
    expect(second.json?.dataOnly).toBe(false);
    expect(second.json?.state).toBe('hot');
    expect(Object.keys(second.json?.urls as object).length).toBeGreaterThan(0);
    expect(serviceCount(stateDir)).toBeGreaterThan(0);
    expect(journal().getEnv(envId)?.dataOnly).toBe(false);
  }, 120_000);

  it('an explicit full up on the same lease starts the services, and back again stops them', async () => {
    const { cli, stateDir } = ctx();
    expect((await cli(['up', '--data-only', '--json'])).code).toBe(0);
    expect(serviceCount(stateDir)).toBe(0);

    const full = await cli(['up', '--json']);
    expect(full.code, full.stderr).toBe(0);
    expect(full.json?.dataOnly).toBe(false);
    expect(serviceCount(stateDir), 'an explicit full up did not start services').toBeGreaterThan(0);

    // And back: an explicit request always wins over the recorded shape.
    const back = await cli(['up', '--data-only', '--json']);
    expect(back.code, back.stderr).toBe(0);
    expect(back.json?.dataOnly).toBe(true);
    expect(back.json?.urls).toEqual({});
    expect(serviceCount(stateDir), 'returning to data-only left services running').toBe(0);
  }, 120_000);
});

describe('a data-only request that cannot mean anything is refused', () => {
  it('refuses to combine --data-only with a named service', async () => {
    const { cli } = ctx();
    // Guessing a precedence here hands the caller the opposite of one of the two
    // things they asked for, silently.
    const res = await cli(['up', 'web', '--data-only', '--json']);
    expect(res.code).toBe(1);
    expect(JSON.stringify(res.json)).toMatch(/cannot be combined/);
  }, 60_000);

  it('refuses --data-only when the manifest declares no datastore', async () => {
    const { cli } = ctx({ datastores: false });
    // Otherwise the caller gets a lease over an empty tree while believing they
    // hold a database.
    const res = await cli(['up', '--data-only', '--json']);
    expect(res.code).toBe(1);
    expect(JSON.stringify(res.json)).toMatch(/needs at least one datastore/);
  }, 60_000);

  it('refuses --watch under --data-only, which has nothing to reload', async () => {
    const { cli } = ctx();
    const res = await cli(['up', '--data-only', '--watch', '--json']);
    expect(res.code).toBe(64);
    expect(res.stderr).toMatch(/nothing to do/);
  }, 60_000);
});

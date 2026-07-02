/**
 * The command-datastore family against a REAL PostgreSQL (docker-gated; the
 * suite skips cleanly when docker is unavailable). Proves: probe, seed,
 * template bake + native `createdb -T` restore, reset-data, ns drop on
 * recycle — all through the real CLI, with all mechanics repo-declared.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const hasDocker = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

const CONTAINER = `infront-pg-test-${Math.random().toString(36).slice(2, 8)}`;
const pg = (args: string) =>
  execFileSync('sh', ['-c', `docker exec ${CONTAINER} ${args}`], { encoding: 'utf8', timeout: 30_000 });

describe.skipIf(!hasDocker)('postgres datastore (docker-gated)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'infront-pg-'));
  const wt = mkdtempSync(join(tmpdir(), 'infront-pg-wt-'));
  const env = { ...process.env, INFRONT_STATE_DIR: stateDir, INFRONT_SWEEP_MS: '500' };
  const cli = (args: string[]): Promise<{ exitCode: number; json?: Record<string, unknown>; out: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json, out: String(stdout) });
      });
    });

  beforeAll(async () => {
    execFileSync('docker', ['run', '-d', '--rm', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=pw', 'postgres:16-alpine'], {
      stdio: 'ignore', timeout: 120_000,
    });
    for (let i = 0; i < 60; i++) {
      try {
        pg('pg_isready -U postgres');
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: hello-pg
services:
  app:
    run: node -e 'console.log("app up");setInterval(()=>{},1e9)'
    ready: { log: "app up" }
datastores:
  main:
    driver: postgres
    url: "postgres://postgres:pw@localhost:5432/{{ns}}"
    create: docker exec ${CONTAINER} createdb -U postgres {{ns}} && docker exec ${CONTAINER} psql -U postgres -d {{ns}} -c "CREATE TABLE items(id serial primary key, name text); INSERT INTO items(name) VALUES ('alpha'),('beta'),('gamma')"
    drop: docker exec ${CONTAINER} dropdb --if-exists -U postgres {{ns}}
    template_restore: docker exec ${CONTAINER} createdb -U postgres -T {{template}} {{ns}}
    presets: [dev]
checks:
  rows:
    run: docker exec ${CONTAINER} psql -U postgres -d {{datastores.main.ns}} -tAc "select count(*) from items" | grep -qx 3
`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
  }, 180_000);

  afterAll(async () => {
    try {
      const pid = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
      process.kill(pid);
    } catch {
      /* gone */
    }
    try {
      execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });

  let ns = '';

  it('up seeds a real postgres db via template bake + createdb -T restore', async () => {
    const res = await cli(['up', '--json']);
    expect(res.exitCode).toBe(0);
    const ds = (res.json!.datastores as Record<string, { url: string; ns: string }>).main;
    ns = ds.ns;
    expect(ns).toMatch(/^infront_/);
    expect(ds.url).toBe(`postgres://postgres:pw@localhost:5432/${ns}`);
    expect(pg(`psql -U postgres -d ${ns} -tAc "select count(*) from items"`).trim()).toBe('3');
    // The template was baked once, machine-global, immutable-keyed.
    const stackTplDir = readdirSync(join(stateDir, 'templates'))[0]!;
    expect(readdirSync(join(stateDir, 'templates', stackTplDir)).some((f) => f.endsWith('.baked'))).toBe(true);
  });

  it('reset-data restores from the template — mutation gone, same ns', async () => {
    pg(`psql -U postgres -d ${ns} -c "INSERT INTO items(name) VALUES ('mutation')"`);
    expect(pg(`psql -U postgres -d ${ns} -tAc "select count(*) from items"`).trim()).toBe('4');
    const res = await cli(['reset-data', '--json']);
    expect(res.exitCode).toBe(0);
    expect(pg(`psql -U postgres -d ${ns} -tAc "select count(*) from items"`).trim()).toBe('3');
  });

  it('the check templates {{datastores.main.ns}} and passes against live data', async () => {
    const res = await cli(['run', 'rows', '--json']);
    expect(res.exitCode).toBe(0);
    expect(res.json!.ok).toBe(true);
  });

  it('recycle drops the server-side namespace', async () => {
    await cli(['release']);
    const res = await cli(['pool', 'recycle', '--json']);
    expect((res.json!.recycled as string[]).length).toBeGreaterThan(0);
    const list = pg(`psql -U postgres -tAc "select datname from pg_database"`);
    expect(list).not.toContain(ns);
  });
});

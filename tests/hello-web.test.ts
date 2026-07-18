/**
 * Circles around hello-web: seed determinism, template-as-file-copy semantics
 * (the sqlite driver's capability), boot-to-ready, the smoke check as a run,
 * and preset behavior. These are engine conformance properties proven against
 * the fixture before the engine exists.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir, freePort, startService, waitHttp, runCmd, type Service } from './helpers.js';

const example = join(import.meta.dirname, '..', 'examples', 'hello-web');
const { dir: tmp, cleanup } = tempDir('hello-web');
const services: Service[] = [];

afterAll(async () => {
  for (const s of services) await s.stop();
  cleanup();
});

const seed = (db: string, preset: string) => runCmd(['node', 'seed.mjs', db, preset], { cwd: example });
const rows = (db: string) =>
  new DatabaseSync(db).prepare('SELECT id, message FROM greetings ORDER BY id').all();

describe('hello-web fixture', () => {
  it('seeds deterministically — same preset, same content, every time', async () => {
    const a = join(tmp, 'det-a.db');
    const b = join(tmp, 'det-b.db');
    expect((await seed(a, 'dev')).exitCode).toBe(0);
    expect((await seed(b, 'dev')).exitCode).toBe(0);
    expect(rows(a)).toEqual(rows(b));
    expect(rows(a).length).toBeGreaterThan(0);
  });

  it('supports the empty preset (integration-style: schema, no data)', async () => {
    const db = join(tmp, 'empty.db');
    expect((await seed(db, 'empty')).exitCode).toBe(0);
    expect(rows(db)).toEqual([]);
  });

  it('rejects an unknown preset with a non-zero exit (work-error shape)', async () => {
    const res = await seed(join(tmp, 'bad.db'), 'nope');
    expect(res.exitCode).not.toBe(0);
    expect(res.output).toContain("unknown preset 'nope'");
  });

  it('template restore = file copy: instant, identical, and independent', async () => {
    const template = join(tmp, 'template.db');
    await seed(template, 'dev');
    const run1 = join(tmp, 'run1.db');
    copyFileSync(template, run1); // what the sqlite driver's templateRestore does
    expect(rows(run1)).toEqual(rows(template));

    // Mutating the run DB must not touch the template (reset-data's guarantee).
    new DatabaseSync(run1).prepare("INSERT INTO greetings (message) VALUES ('mutated')").run();
    expect(rows(run1).length).toBe(rows(template).length + 1);

    // reset-data: restore from template again — mutation gone.
    copyFileSync(template, run1);
    expect(rows(run1)).toEqual(rows(template));
  });

  it('boots to ready and serves the seeded data end to end', async () => {
    const db = join(tmp, 'serve.db');
    await seed(db, 'dev');
    const port = await freePort();
    const svc = startService(['node', 'server.mjs'], {
      cwd: example,
      env: { PORT: String(port), DB_PATH: db },
    });
    services.push(svc);
    await waitHttp(`http://localhost:${port}/health`, svc, /Error:/);

    const greetings = (await fetch(`http://localhost:${port}/api/greetings`).then((r) => r.json())) as Array<{
      message: string;
    }>;
    expect(greetings.length).toBe(3);

    const page = await fetch(`http://localhost:${port}/`).then((r) => r.text());
    for (const g of greetings) expect(page).toContain(g.message);
  });

  it("runs the manifest's smoke check green against the running service", async () => {
    const db = join(tmp, 'smoke.db');
    await seed(db, 'dev');
    const port = await freePort();
    const svc = startService(['node', 'server.mjs'], {
      cwd: example,
      env: { PORT: String(port), DB_PATH: db },
    });
    services.push(svc);
    await waitHttp(`http://localhost:${port}/health`, svc, /Error:/);

    const res = await runCmd(['node', 'smoke.test.mjs'], {
      cwd: example,
      env: { BASE_URL: `http://localhost:${port}` },
    });
    expect(res.output).toContain('smoke ok');
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
  });

  it('smoke check fails contractually without its injected env (exit 2)', async () => {
    const res = await runCmd(['node', 'smoke.test.mjs'], { cwd: example, env: { BASE_URL: '' } });
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(2);
  });

  it('two environments on different ports/DBs are fully isolated', async () => {
    const dbA = join(tmp, 'iso-a.db');
    const dbB = join(tmp, 'iso-b.db');
    await seed(dbA, 'dev');
    await seed(dbB, 'empty');
    const [portA, portB] = [await freePort(), await freePort()];
    const a = startService(['node', 'server.mjs'], { cwd: example, env: { PORT: String(portA), DB_PATH: dbA } });
    const b = startService(['node', 'server.mjs'], { cwd: example, env: { PORT: String(portB), DB_PATH: dbB } });
    services.push(a, b);
    await waitHttp(`http://localhost:${portA}/health`, a, /Error:/);
    await waitHttp(`http://localhost:${portB}/health`, b, /Error:/);

    const ga = (await fetch(`http://localhost:${portA}/api/greetings`).then((r) => r.json())) as unknown[];
    const gb = (await fetch(`http://localhost:${portB}/api/greetings`).then((r) => r.json())) as unknown[];
    expect(ga.length).toBe(3);
    expect(gb.length).toBe(0);
  });
});

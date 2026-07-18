/**
 * Circles around hello-multi — the topology hello-web deliberately lacks:
 * service wiring via {{services.api.url}}, depends_on ordering, a portless
 * worker with log-marker readiness, fatal_logs fail-fast, and preset variants.
 * The test plays the engine: allocates ports, injects env, enforces readiness.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tempDir, freePort, startService, waitHttp, waitLog, runCmd, type Service } from './helpers.js';

const example = join(import.meta.dirname, '..', 'examples', 'hello-multi');
const { dir: tmp, cleanup } = tempDir('hello-multi');
const services: Service[] = [];

afterAll(async () => {
  for (const s of services) await s.stop();
  cleanup();
  rmSync(join(example, 'smoke-report.json'), { force: true });
});

const seed = (db: string, preset: string) => runCmd(['node', 'seed.mjs', db, preset], { cwd: example });

async function bootTopology(db: string) {
  const [apiPort, webPort] = [await freePort(), await freePort()];
  const apiUrl = `http://localhost:${apiPort}`;
  const webUrl = `http://localhost:${webPort}`;

  const api = startService(['node', 'api.mjs'], { cwd: example, env: { PORT: String(apiPort), DB_PATH: db } });
  services.push(api);
  await waitHttp(`${apiUrl}/health`, api, /Error:/); // depends_on: web starts only after api is ready

  const web = startService(['node', 'web.mjs'], {
    cwd: example,
    env: { PORT: String(webPort), API_URL: apiUrl },
  });
  services.push(web);
  await waitHttp(`${webUrl}/health`, web, /Error:/);

  const worker = startService(['node', 'worker.mjs'], { cwd: example, env: { DB_PATH: db } });
  services.push(worker);
  await waitLog(worker, /worker ready/); // portless readiness: log marker, not HTTP

  return { apiUrl, webUrl, worker };
}

describe('hello-multi fixture', () => {
  it('boots the full topology and passes the smoke check (with artifact)', async () => {
    const db = join(tmp, 'full.db');
    await seed(db, 'dev');
    const { apiUrl, webUrl } = await bootTopology(db);

    const res = await runCmd(['node', 'smoke.test.mjs'], {
      cwd: example,
      env: { API_URL: apiUrl, WEB_URL: webUrl },
    });
    expect(res.output).toContain('smoke ok');
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);

    // The manifest declares artifacts: [smoke-report.json] — it must exist and be honest.
    const reportPath = join(example, 'smoke-report.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it('worker drains the queue independently of the HTTP services', async () => {
    const db = join(tmp, 'worker.db');
    await seed(db, 'dev');
    const worker = startService(['node', 'worker.mjs'], { cwd: example, env: { DB_PATH: db } });
    services.push(worker);
    await waitLog(worker, /worker ready/);
    // 3 queued jobs, 200ms poll — all done within a couple of seconds.
    const start = Date.now();
    while (!/processed job 3/.test(worker.logs())) {
      if (Date.now() - start > 10_000) throw new Error(`worker never finished:\n${worker.logs()}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  it('fatal_logs semantics: web without its wiring dies loudly and fast', async () => {
    const web = startService(['node', 'web.mjs'], { cwd: example, env: { PORT: '0', API_URL: '' } });
    services.push(web);
    const start = Date.now();
    while (web.proc.exitCode === null) {
      if (Date.now() - start > 5_000) throw new Error('expected fast exit');
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(web.proc.exitCode).not.toBe(0);
    expect(web.logs()).toMatch(/Error:/); // the manifest's fatal_logs marker
  });

  it('preset variants: demo and empty produce their declared shapes', async () => {
    const demo = join(tmp, 'demo.db');
    const empty = join(tmp, 'empty.db');
    const rDemo = await seed(demo, 'demo');
    const rEmpty = await seed(empty, 'empty');
    expect(rDemo.output).toContain('1 items, 1 jobs');
    expect(rEmpty.output).toContain('0 items, 0 jobs');

    const port = await freePort();
    const api = startService(['node', 'api.mjs'], { cwd: example, env: { PORT: String(port), DB_PATH: demo } });
    services.push(api);
    await waitHttp(`http://localhost:${port}/health`, api, /Error:/);
    const items = (await fetch(`http://localhost:${port}/api/items`).then((r) => r.json())) as Array<{
      name: string;
    }>;
    expect(items.map((i) => i.name)).toEqual(['showpiece']);
  });
});

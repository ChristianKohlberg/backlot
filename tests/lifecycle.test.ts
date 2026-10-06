/**
 * The 0.16 lifecycle (decision 0035): per-service idle stop with ports kept,
 * start on demand by a held connection (also chained, SPA -> /api -> api),
 * the self-restart gap, persisted activity, and teardown when the agent's
 * tether dies or its worktree goes — also across a daemon restart.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { get as httpGet } from 'node:http';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeCtx, SERVER, sleep, waitFor, type Ctx } from './support/context.js';

const ctxs: Ctx[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
});
const ctx = (env: Record<string, string> = {}) => {
  const c = makeCtx(env);
  ctxs.push(c);
  return c;
};

const STACK = `name: life
services:
  api:
    run: node server.mjs
    port: api
    env: { PORT: "{{ports.api}}" }
    ready: { http: /, timeout: 20 }
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}", UPSTREAM: "http://127.0.0.1:{{public_ports.api}}/" }
    ready: { http: /, timeout: 20 }
`;

/** One request on a fresh connection: a pooled keep-alive socket to a killed process would fail before the proxy sees it. */
const get = (url: string, timeoutMs = 30_000) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = httpGet(url, { agent: false, timeout: timeoutMs }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
const pidsOf = (c: Ctx) => {
  const env = c.journal().allEnvs()[0];
  return env ? Object.keys(env.servicePids) : [];
};

describe('idle stop (decision 0035)', () => {
  it('stops each service on its own clock, keeps its port, and health probes do not keep it alive', async () => {
    const c = ctx({ BACKLOT_SERVICE_IDLE_MS: '2000' });
    const wt = c.worktree({ 'runly.yml': STACK, 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const apiPort = Number(new URL(up.json.urls.api).port);

    // Keep web busy with client bytes; leave api alone. Server-wide verbs and
    // the daemon's own probing are not activity on this environment.
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      await get(up.json.urls.web);
      await c.cli(['status', '--json'], wt);
      await sleep(400);
    }
    expect(pidsOf(c), 'api was used by nobody and should be idle-stopped').toEqual(['web']);

    const stopped = await waitFor(() => pidsOf(c).length === 0, 15_000);
    expect(stopped).toBe(true);
    // The lease and the public ports stay.
    expect(c.journal().allLeases().length).toBe(1);
    const ps = await c.cli(['ps', '--json'], wt);
    expect(ps.json.services.map((s: { state: string }) => s.state)).toEqual(['idle', 'idle']);
    // The port is still held (connecting to it is a wake, so it is checked last).
    expect(await listening(apiPort)).toBe(true);
  }, 60_000);

  it('per-service idle: in the manifest overrides the default; never/off keeps it running', async () => {
    const c = ctx({ BACKLOT_SERVICE_IDLE_MS: '1500' });
    const wt = c.worktree({
      'runly.yml': STACK.replace('    port: api\n', '    port: api\n    idle: never\n'),
      'server.mjs': SERVER,
    });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    expect(await waitFor(() => pidsOf(c).length === 1, 15_000)).toBe(true);
    await sleep(2500);
    expect(pidsOf(c)).toEqual(['api']);
  }, 60_000);
});

describe('start on demand (decision 0035)', () => {
  it('a connection to an idle-stopped service starts it and is held until it answers', async () => {
    const c = ctx({ BACKLOT_SERVICE_IDLE_MS: '1500' });
    const wt = c.worktree({ 'runly.yml': STACK, 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    const before = (await get(up.json.urls.api)).text;
    expect(await waitFor(() => pidsOf(c).length === 0, 15_000)).toBe(true);

    const t0 = Date.now();
    const after = await get(up.json.urls.api);
    expect(after.status).toBe(200);
    expect(after.text).not.toBe(before); // a new process answered
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(pidsOf(c)).toContain('api');
    // Only what was asked for woke.
    expect(pidsOf(c)).not.toContain('web');
  }, 60_000);

  it('chains: a request to the idle web, whose handler calls the idle api, wakes both', async () => {
    const c = ctx({ BACKLOT_SERVICE_IDLE_MS: '1500' });
    const wt = c.worktree({ 'runly.yml': STACK, 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    expect(await waitFor(() => pidsOf(c).length === 0, 15_000)).toBe(true);

    const res = await get(`${String(up.json.urls.web).replace(/\/$/, '')}/chain`);
    expect(res.status, res.text).toBe(200);
    expect(res.text).toMatch(/^via \d+ -> \d+$/);
    expect(pidsOf(c).sort()).toEqual(['api', 'web']);
  }, 60_000);

  it('a downed service is not woken by a connection — down means down', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': STACK, 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    expect((await c.cli(['down', 'api', '--json'], wt)).code).toBe(0);
    await expect(fetch(up.json.urls.api, { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
    expect(pidsOf(c)).toEqual(['web']);
  }, 60_000);

  it('holds connections across a crash-restart of the service (the self-restart gap)', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': STACK, 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    const pid = Number((await get(up.json.urls.api)).text);
    process.kill(pid, 'SIGKILL');
    // Once it is gone (a connection the dying process still accepted is lost
    // with it, as with any proxy) and before the supervisor relaunches it,
    // which waits 500 ms: this request lands in the gap.
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5000, 5);
    const res = await get(up.json.urls.api);
    expect(res.status).toBe(200);
    expect(Number(res.text)).not.toBe(pid);
  }, 60_000);
});

describe('activity survives a daemon restart (decision 0035)', () => {
  it('persists the last client byte per port', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': STACK, 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    await sleep(300);
    const t = Date.now();
    await get(up.json.urls.web);
    await c.stopDaemon(wt);
    const row = c.journal().allEnvs()[0]!;
    expect(row.activity?.web ?? 0).toBeGreaterThanOrEqual(t - 50);
    // And the restarted daemon reads it back: ps reports the idle time from it.
    const ps = await c.cli(['ps', '--json'], wt);
    const web = ps.json.services.find((s: { service: string }) => s.service === 'web');
    expect(web.lastActivityAt).toBeGreaterThanOrEqual(t - 50);
  }, 60_000);
});

describe('teardown when the agent or its worktree is gone (decision 0035)', () => {
  it('a dead tether tears everything down — also when it died while the daemon was down', async () => {
    const c = ctx({ BACKLOT_TETHER_GRACE_MS: '0' });
    const wt = c.worktree({ 'runly.yml': STACK, 'server.mjs': SERVER });
    const agent = spawn('sh', ['-c', 'sleep 600'], { detached: true, stdio: 'ignore' });
    agent.unref();
    const up = await c.cli(['up', '--holder-pid', String(agent.pid), '--json'], wt);
    expect(up.code, up.stderr).toBe(0);
    const envId = up.json.envId as string;
    await c.stopDaemon(wt);
    process.kill(-agent.pid!, 'SIGKILL');

    // Any verb respawns the daemon; recovery plus one sweep must finish the job.
    await c.cli(['status', '--json'], wt);
    expect(await waitFor(() => c.journal().allEnvs().length === 0 && c.journal().allLeases().length === 0, 20_000)).toBe(true);
    expect(existsSync(join(c.stateDir, 'envs', envId))).toBe(false);
    await expect(fetch(up.json.urls.web, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  }, 60_000);

  it('a removed worktree tears its leased environment down, across a daemon restart', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': STACK, 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code).toBe(0);
    const envId = up.json.envId as string;
    await c.stopDaemon(wt);
    rmSync(wt, { recursive: true, force: true });
    await c.cli(['status', '--json'], c.stateDir);
    expect(await waitFor(() => c.journal().allEnvs().length === 0 && c.journal().allLeases().length === 0, 20_000)).toBe(true);
    expect(existsSync(join(c.stateDir, 'envs', envId))).toBe(false);
  }, 60_000);

  it('runly destroy removes the environment and its copies now, and keeps the worktree records (decision 0039)', async () => {
    const c = ctx();
    const wt = c.worktree({
      'runly.yml': `${STACK}datastores:\n  main: { driver: sqlite, create: 'node seed.mjs "{{ns}}"', template: true, presets: [dev] }\n`,
      'server.mjs': SERVER,
      'seed.mjs': `import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(process.argv[2]).exec('CREATE TABLE IF NOT EXISTS t(x)');\n`,
    });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const copy = await c.cli(['db', 'new', 'main', '--json'], wt);
    expect(copy.code, copy.stderr + copy.stdout).toBe(0);
    const d = await c.cli(['destroy', '--json'], wt);
    expect(d.code, d.stderr + d.stdout).toBe(0);
    expect(d.json.environments).toEqual([up.json.envId]);
    expect(d.json.copies).toEqual([copy.json.name]);
    expect(c.journal().allEnvs()).toEqual([]);
    expect(c.journal().allDbCopies()).toEqual([]);
    // The upkeep/build records describe the worktree, which destroy never
    // touches: they stay, so the next `up` does not redo its installs.
    expect(readdirSync(join(c.stateDir, 'worktrees')).length).toBe(1);
    await expect(fetch(up.json.urls.web, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  }, 60_000);
});

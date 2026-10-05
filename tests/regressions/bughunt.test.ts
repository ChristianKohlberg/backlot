/**
 * Regressions from the 0.16.0 bug hunt (R1–R13 and the lifecycle findings).
 * Each test failed against 0.16.0 (b267f58) and states the FIXED behaviour.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI, makeCtx, SERVER, sleep, waitFor, type Ctx } from '../support/context.js';

const ctxs: Ctx[] = [];
const kids: number[] = [];
afterAll(() => {
  for (const p of kids) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const c of ctxs) c.dispose();
});
const ctx = (env: Record<string, string> = {}) => {
  const c = makeCtx(env);
  ctxs.push(c);
  return c;
};
const fakeServer = () => realpathSync(mkdtempSync(join(tmpdir(), 'bh-srv-')));

const stack = (name: string, server: string, extraSvc = '', create = 'mkdir -p "${S}/{{ns}}" && echo seeded > "${S}/{{ns}}/marker"', drop = 'rm -rf "${S}/{{ns}}"') => `name: ${name}
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
    resources: { memory: 100M, cpu: 0.1 }
${extraSvc}datastores:
  main:
    driver: postgres
    url: "file://${server}/{{ns}}"
    create: '${create.replaceAll('${S}', server)}'
    drop: '${drop.replaceAll('${S}', server)}'
    list: 'ls -1 "${server}"'
`;

/** Connect, send a request, and report when the proxy closes the connection (and what came back). */
const heldThenClosed = (port: number) =>
  new Promise<{ closedMs: number; got: string }>((resolve) => {
    const t0 = Date.now();
    let got = '';
    const s = connect(port, '127.0.0.1', () => s.write('GET / HTTP/1.0\r\n\r\n'));
    s.on('data', (d) => (got += d.toString()));
    s.on('error', () => undefined);
    s.on('close', () => resolve({ closedMs: Date.now() - t0, got }));
    setTimeout(() => s.destroy(), 25_000).unref();
  });

describe('R1 a budget refusal is not a bind failure', () => {
  it('leaves failStreak at 0: wake-on-connect keeps working and the next up is not escalated to pristine', async () => {
    const server = fakeServer();
    const c = ctx({ BACKLOT_BUDGET_MEMORY: '1G', BACKLOT_SERVICE_IDLE_MS: '1500' });
    const big = `  big:\n    run: node server.mjs\n    port: big\n    env: { PORT: "{{ports.big}}" }\n    resources: { memory: 50G, cpu: 0.1 }\n`;
    const wt = c.worktree({ 'runly.yml': stack('bhr1', server, big), 'server.mjs': SERVER });
    const up = await c.cli(['up', 'web', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const ns = c.journal().allEnvs()[0]!.datastoreNs.main!;
    writeFileSync(join(server, ns, 'user-row'), 'precious');
    const webPort = Number(new URL(up.json.urls.web).port);

    const r1 = await c.cli(['up', 'big', '--json'], wt);
    expect(r1.code).not.toBe(0);
    expect(r1.stdout + r1.stderr).toMatch(/load budget can never admit/);
    expect(c.journal().allEnvs()[0]!.failStreak).toBe(0);

    // web idles out; a connection to its public port wakes it.
    expect(await waitFor(() => Object.keys(c.journal().allEnvs()[0]!.servicePids).length === 0, 15_000)).toBe(true);
    const woken = await heldThenClosed(webPort);
    expect(woken.got).toMatch(/^HTTP\/1\.[01] 200/);

    const r2 = await c.cli(['up', 'big', '--json'], wt);
    expect(r2.code).not.toBe(0);
    expect(c.journal().allEnvs()[0]!.failStreak).toBe(0);
    const again = await c.cli(['up', 'web', '--json'], wt);
    expect(again.code, again.stderr + again.stdout).toBe(0);
    expect(again.json.bindDiagnostics.reasons).not.toContain('hygiene-pristine');
    expect(readFileSync(join(server, ns, 'user-row'), 'utf8')).toBe('precious');
    await c.cli(['destroy', '--json'], wt);
  }, 90_000);
});

describe('R2 a re-up without a holder pid clears the previous tether', () => {
  it('the first caller dying no longer tears down the environment the second one is using', async () => {
    const server = fakeServer();
    const c = ctx({ BACKLOT_TETHER_GRACE_MS: '0' });
    const wt = c.worktree({ 'runly.yml': stack('bhr2', server), 'server.mjs': SERVER });
    const agent = spawn('sleep', ['300'], { stdio: 'ignore' });
    kids.push(agent.pid!);
    const first = await c.cli(['up', '--holder-pid', String(agent.pid), '--json'], wt);
    expect(first.code, first.stderr + first.stdout).toBe(0);
    expect(c.journal().allLeases()[0]!.holderPid).toBe(agent.pid);
    const second = await c.cli(['up', '--json'], wt);
    expect(second.code, second.stderr + second.stdout).toBe(0);
    const lease = c.journal().allLeases()[0]!;
    expect(lease.holderPid).toBeUndefined();
    expect(lease.holderStart).toBeUndefined();
    const ns = c.journal().allEnvs()[0]!.datastoreNs.main!;
    agent.kill('SIGKILL');
    await sleep(2500); // several sweeps (BACKLOT_SWEEP_MS=300) with a zero grace
    expect(c.journal().allEnvs()).toHaveLength(1);
    expect(existsSync(join(server, ns, 'marker'))).toBe(true);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

describe('R3 exec and token after every service idled out', () => {
  it('start the idle-stopped services and run, instead of being refused as after a daemon restart', async () => {
    const server = fakeServer();
    const c = ctx({ BACKLOT_SERVICE_IDLE_MS: '1500' });
    const wt = c.worktree({ 'runly.yml': stack('bhr3', server) + 'auth:\n  token: "echo tok-{{role}}-$RUNLY_ROLE"\n', 'server.mjs': SERVER });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    expect(await waitFor(() => Object.keys(c.journal().allEnvs()[0]!.servicePids).length === 0, 15_000)).toBe(true);
    // The exec'd command reaches the service through its public URL — which
    // used to wait on a wake queued behind the exec's own lock.
    const ex = await c.cli(['exec', '--json', 'node -e "fetch(process.env.RUNLY_URL_WEB).then(r=>r.text()).then(t=>console.log(\'got\', t.length > 0))"'], wt);
    expect(ex.code, ex.stdout + ex.stderr).toBe(0);
    expect(ex.json.stdout).toContain('got true');
    expect(Object.keys(c.journal().allEnvs()[0]!.servicePids)).toContain('web');
    expect(await waitFor(() => Object.keys(c.journal().allEnvs()[0]!.servicePids).length === 0, 15_000)).toBe(true);
    const tok = await c.cli(['token', '--role', 'admin', '--json'], wt);
    expect(tok.code, tok.stdout + tok.stderr).toBe(0);
    expect(tok.json.token).toBe('tok-admin-admin');
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

describe('R4 pool doctor --fix during a first restore', () => {
  it('leaves the namespace an in-flight up is restoring alone; the up succeeds', async () => {
    const server = fakeServer();
    const c = ctx();
    const slow = 'mkdir -p "${S}/{{ns}}" && sleep 6 && echo seeded > "${S}/{{ns}}/marker"';
    const wt = c.worktree({ 'runly.yml': stack('bhr4', server, '', slow), 'server.mjs': SERVER });
    const upP = c.cli(['up', '--json'], wt);
    expect(await waitFor(() => readdirSync(server).length > 0, 15_000)).toBe(true);
    const doc = await c.cli(['pool', 'doctor', '--fix', '--json'], wt);
    const up = await upP;
    expect(doc.code, doc.stdout + doc.stderr).toBe(0);
    const dropped = (doc.json?.findings ?? []).filter((f: { kind: string; fixed?: boolean }) => f.kind === 'namespace' && f.fixed);
    expect(dropped).toEqual([]);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const ns = c.journal().allEnvs()[0]!.datastoreNs.main!;
    expect(readFileSync(join(server, ns, 'marker'), 'utf8').trim()).toBe('seeded');
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

const SLOW_SERVER = `import { createServer } from 'node:http';
setTimeout(() => createServer((q, s) => s.end(String(process.pid))).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening ' + process.env.PORT)), Number(process.env.DELAY ?? 3000));
`;

describe('R5 an internal port is reserved when it is allocated', () => {
  it('two environments starting at once never share one: with a single free port, the second is refused', async () => {
    const c = ctx({ BACKLOT_INTERNAL_PORT_RANGE: '30533-30533' });
    const yml = (n: string) => `name: ${n}\nservices:\n  web:\n    run: node slow.mjs\n    port: web\n    env: { PORT: "{{ports.web}}", DELAY: "3000" }\n    ready: { http: /, timeout: 20 }\n`;
    const a = c.worktree({ 'runly.yml': yml('bhr5a'), 'slow.mjs': SLOW_SERVER });
    const b = c.worktree({ 'runly.yml': yml('bhr5b'), 'slow.mjs': SLOW_SERVER });
    await c.cli(['status', '--json'], a);
    const [ra, rb] = await Promise.all([c.cli(['up', '--json'], a), c.cli(['up', '--json'], b)]);
    const ok = [ra, rb].filter((r) => r.code === 0);
    const refused = [ra, rb].filter((r) => r.code !== 0);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.stdout + refused[0]!.stderr).toMatch(/no free internal port/);
    // …and the port goes back once that environment's service stops.
    const winner = ra.code === 0 ? a : b;
    const loser = ra.code === 0 ? b : a;
    expect((await c.cli(['down', '--json'], winner)).code).toBe(0);
    const retry = await c.cli(['up', '--json'], loser);
    expect(retry.code, retry.stdout + retry.stderr).toBe(0);
    for (const wt of [a, b]) await c.cli(['destroy', '--json'], wt);
  }, 90_000);
});

describe('R6 a queued up whose client disconnected', () => {
  it('leaves the budget queue and never binds', async () => {
    const c = ctx({ BACKLOT_BUDGET_MEMORY: '300M' });
    const yml = (n: string) => `name: ${n}\nservices:\n  web:\n    run: node server.mjs\n    port: web\n    env: { PORT: "{{ports.web}}" }\n    ready: { http: /, timeout: 20 }\n    resources: { memory: 200M, cpu: 0.1 }\n`;
    const a = c.worktree({ 'runly.yml': yml('bhr6a'), 'server.mjs': SERVER });
    const b = c.worktree({ 'runly.yml': yml('bhr6b'), 'server.mjs': SERVER });
    expect((await c.cli(['up', '--json'], a)).code).toBe(0);
    const queued = spawn(process.execPath, [CLI, 'up', '--json'], { cwd: b, env: c.env, stdio: 'ignore' });
    kids.push(queued.pid!);
    expect(await waitFor(async () => (await c.cli(['ps', '--all', '--json'], a)).json?.budget?.waiting === 1, 15_000)).toBe(true);
    queued.kill('SIGKILL');
    expect(await waitFor(async () => (await c.cli(['ps', '--all', '--json'], a)).json?.budget?.waiting === 0, 5_000)).toBe(true);
    expect((await c.cli(['down', '--json'], a)).code).toBe(0);
    await sleep(3000);
    expect(c.journal().allEnvs().some((e) => e.stack.startsWith('bhr6b') && Object.keys(e.servicePids).length > 0)).toBe(false);
    for (const wt of [a, b]) await c.cli(['destroy', '--json'], wt);
  }, 90_000);
});

describe('R8 a starting service is counted once', () => {
  it('the reservation hands its share back as each service starts', async () => {
    const c = ctx({ BACKLOT_BUDGET_MEMORY: '4G' });
    const yml = `name: bhr8\nservices:\n  web:\n    run: node slow.mjs\n    port: web\n    env: { PORT: "{{ports.web}}", DELAY: "4000" }\n    ready: { http: /, timeout: 20 }\n    resources: { memory: 1G, cpu: 0.1 }\n`;
    const wt = c.worktree({ 'runly.yml': yml, 'slow.mjs': SLOW_SERVER });
    await c.cli(['status', '--json'], wt);
    const upP = c.cli(['up', '--json'], wt);
    let max = 0;
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      const ps = await c.cli(['ps', '--all', '--json'], wt);
      max = Math.max(max, ps.json?.budget?.committedMemoryBytes ?? 0);
      await sleep(250);
    }
    expect((await upP).code).toBe(0);
    expect(max).toBe(1024 ** 3);
    expect((await c.cli(['ps', '--all', '--json'], wt)).json.budget.committedMemoryBytes).toBe(1024 ** 3);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

describe('R9 caches: [**/bin] matches bin directories only', () => {
  it('an edit under src/Cabin/ is source, and the when: build runs again', async () => {
    const c = ctx();
    const yml = `name: bhr9\ncaches: ["**/bin"]\nservices:\n  api:\n    run: node server.mjs\n    port: api\n    env: { PORT: "{{ports.api}}" }\n    ready: { http: /, timeout: 20 }\n    build: { run: "echo built >> builds.txt", when: ["src/**"] }\n`;
    const wt = c.worktree({ 'runly.yml': yml, 'server.mjs': SERVER, 'src/Cabin/a.txt': 'one', 'src/bin/out.txt': 'build output', '.gitignore': 'builds.txt\n' });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    writeFileSync(join(wt, 'src/Cabin/a.txt'), 'two — a real source change');
    const again = await c.cli(['up', '--json'], wt);
    expect(again.code).toBe(0);
    expect(again.json.bindDiagnostics.builds).toEqual([expect.objectContaining({ service: 'api', reason: expect.not.stringMatching(/when-unchanged/) })]);
    expect(readFileSync(join(wt, 'builds.txt'), 'utf8').trim().split('\n')).toHaveLength(2);
    // What IS under a bin/ is output, not source: it does not trigger the build.
    writeFileSync(join(wt, 'src/bin/out.txt'), 'rewritten by a build');
    const third = await c.cli(['up', '--json'], wt);
    expect(third.json.bindDiagnostics.builds).toEqual([expect.objectContaining({ service: 'api', reason: 'when-unchanged' })]);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

describe('R10 logs -f --until across a rotation', () => {
  it('drains the rotated file, so a line written just before the rotation is matched', async () => {
    const { LogWriter } = await import('../../src/core/logs.js');
    const { showLogs } = await import('../../src/cli/logs.js');
    const dir = mkdtempSync(join(tmpdir(), 'bh-logs-'));
    const file = join(dir, 'web.log');
    const w = new LogWriter(file, 4096);
    w.line('-- runly: web started --');
    const out: string[] = [];
    const p = showLogs({ envId: 'e', dir, build: false, files: [{ service: 'web', file }] }, { follow: true, until: /NEEDLE/, timeoutMs: 2500, json: false, prefix: false }, (s) => out.push(s));
    await sleep(50);
    w.write('out', 'NEEDLE: the service is ready\n');
    w.write('out', `${'x'.repeat(5000)}\n`); // crosses the cap: rotates before the follower polls
    const code = await p;
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(code).toBe(0);
    expect(out.join('')).toContain('NEEDLE');
  }, 20_000);

  it('prints a line written while the backlog was read exactly once', async () => {
    const { LogWriter } = await import('../../src/core/logs.js');
    const { showLogs } = await import('../../src/cli/logs.js');
    const dir = mkdtempSync(join(tmpdir(), 'bh-logs-'));
    const file = join(dir, 'web.log');
    const w = new LogWriter(file);
    w.line('-- runly: web started --');
    for (let i = 0; i < 2000; i++) w.write('out', `line ${i}\n`);
    const out: string[] = [];
    const p = showLogs({ envId: 'e', dir, build: false, files: [{ service: 'web', file }] }, { follow: true, until: /^DONE$/, timeoutMs: 3000, json: false, prefix: false, lines: 3 }, (s) => out.push(s));
    w.write('out', 'late\n');
    w.write('out', 'DONE\n');
    expect(await p).toBe(0);
    expect(out.join('').split('\n').filter((l) => l === 'late')).toHaveLength(1);
  }, 20_000);
});

const STUBBORN = `import { createServer } from 'node:http';
process.on('SIGTERM', () => undefined); // dies only to the SIGKILL after runly's 2 s grace
createServer((q, s) => s.end(String(process.pid))).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening'));
`;
const TWO = `name: NAME
services:
  api:
    run: node server.mjs
    port: api
    idle: 1500ms
    env: { PORT: "{{ports.api}}" }
    ready: { http: /, timeout: 20 }
  slow:
    run: node stubborn.mjs
    port: slow
    idle: never
    env: { PORT: "{{ports.slow}}" }
    ready: { http: /, timeout: 20 }
`;

describe('R11 a wake queued behind down', () => {
  it('starts nothing, leaves the state alone and closes the held connection at once', async () => {
    const c = ctx({ BACKLOT_PROXY_HOLD_MS: '8000' });
    const wt = c.worktree({ 'runly.yml': TWO.replace('NAME', 'bhr11'), 'server.mjs': SERVER, 'stubborn.mjs': STUBBORN });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const apiPort = Number(new URL(up.json.urls.api).port);
    expect(await waitFor(() => !('api' in c.journal().allEnvs()[0]!.servicePids), 15_000)).toBe(true);
    const downP = c.cli(['down', '--json'], wt); // stopping `slow` takes ~2 s
    await sleep(600);
    const conn = heldThenClosed(apiPort);
    expect((await downP).code).toBe(0);
    const r = await conn;
    await sleep(500);
    const env = c.journal().allEnvs()[0]!;
    expect(Object.keys(env.servicePids)).toEqual([]);
    expect(env.state).toBe('warm');
    expect(r.closedMs).toBeLessThan(6000);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

describe('R12 logs --until and --timeout', () => {
  it('--until never matches an earlier process in the backlog, and --timeout alone exits 124 (decision 0038)', async () => {
    const { LogWriter } = await import('../../src/core/logs.js');
    const { showLogs } = await import('../../src/cli/logs.js');
    const dir = mkdtempSync(join(tmpdir(), 'bh-logs2-'));
    const file = join(dir, 'web.log');
    const w = new LogWriter(file);
    w.line('-- runly: web started (pid 1) --');
    w.write('out', 'listening on 30001\n');
    w.line('-- runly: web started (pid 2) — restart 1 after it exited --');
    const spec = { envId: 'e', dir, build: false, files: [{ service: 'web', file }] };
    const p = showLogs(spec, { follow: true, until: /listening/, timeoutMs: 5000, json: false, prefix: false }, () => undefined);
    const t0 = Date.now();
    await sleep(600);
    w.write('out', 'listening on 30002\n'); // the current process
    expect(await p).toBe(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    expect(await showLogs(spec, { follow: true, until: /listening on 30001/, timeoutMs: 400, json: false, prefix: false }, () => undefined)).toBe(124);
    expect(await showLogs(spec, { follow: true, timeoutMs: 300, json: false, prefix: false }, () => undefined)).toBe(124);
  }, 20_000);
});

describe('R13 the daemon umask is the socket\'s alone', () => {
  it('services, builds and exec run with the caller\'s umask', async () => {
    const mask = process.umask(); // the CLI spawns the daemon with this one
    const c = ctx();
    const yml = `name: bhr13\nservices:\n  web:\n    run: node server.mjs\n    port: web\n    env: { PORT: "{{ports.web}}" }\n    ready: { http: /, timeout: 20 }\n    build: "mkdir -p out && touch out/artifact && umask > out/build-umask"\n`;
    const wt = c.worktree({ 'runly.yml': yml, 'server.mjs': SERVER, '.gitignore': 'out/\n' });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    const ex = await c.cli(['exec', '--json', 'umask'], wt);
    const want = mask.toString(8).padStart(4, '0');
    expect(readFileSync(join(wt, 'out/build-umask'), 'utf8').trim()).toBe(want);
    expect(String(ex.json.stdout).trim()).toBe(want);
    expect((statSync(join(wt, 'out')).mode & 0o777)).toBe(0o777 & ~mask);
    // The socket and the state root stay private.
    expect(statSync(c.stateDir).mode & 0o077).toBe(0);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

describe('W6 token --role', () => {
  it('refuses a role that is not a name instead of running it as shell', async () => {
    const server = fakeServer();
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': stack('bhw6', server) + 'auth:\n  token: "echo tok-{{role}}"\n', 'server.mjs': SERVER });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    const evil = await c.cli(['token', '--role', 'x; touch pwned', '--json'], wt);
    expect(evil.code).toBe(1);
    expect(evil.json.error.message).toMatch(/--role must be a name/);
    expect(existsSync(join(wt, 'pwned'))).toBe(false);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

describe('L2 a port key the manifest drops', () => {
  it('releases its public port on the next up', async () => {
    const c = ctx();
    const two = `name: bhl2\nservices:\n  web:\n    run: node server.mjs\n    port: web\n    env: { PORT: "{{ports.web}}" }\n    ready: { http: /, timeout: 20 }\n  api:\n    run: node server.mjs\n    port: api\n    env: { PORT: "{{ports.api}}" }\n    ready: { http: /, timeout: 20 }\n`;
    const wt = c.worktree({ 'runly.yml': two, 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stdout + up.stderr).toBe(0);
    const apiPort = up.json.ports.api as number;
    writeFileSync(join(wt, 'runly.yml'), two.slice(0, two.indexOf('  api:')));
    const again = await c.cli(['up', '--json'], wt);
    expect(again.code, again.stdout + again.stderr).toBe(0);
    expect(again.json.ports.api).toBeUndefined();
    const refused = await new Promise<boolean>((resolve) => {
      const s = connect(apiPort, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(false); });
      s.once('error', () => resolve(true));
    });
    expect(refused).toBe(true);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

describe('W4 a namespace cut to 63 bytes', () => {
  it('is still known as this state root\'s to pool doctor', async () => {
    const server = fakeServer();
    const c = ctx();
    const name = `bhw4-${'a-very-long-stack-name-'.repeat(3)}`;
    // The first drop fails, so teardown leaves the namespace behind.
    const wt = c.worktree({ 'runly.yml': stack(name, server, '', undefined, '[ -f "${S}/allow" ] && rm -rf "${S}/{{ns}}"'), 'server.mjs': SERVER });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    const ns = c.journal().allEnvs()[0]!.datastoreNs.main!;
    expect(ns).toHaveLength(63);
    expect(ns.startsWith(`backlot_${c.journal().allEnvs()[0]!.stack.replace(/[^A-Za-z0-9_]/g, '_')}_`)).toBe(false);
    expect((await c.cli(['pool', 'recycle', '--force', '--json'], wt)).code).toBe(0);
    expect(existsSync(join(server, ns))).toBe(true);
    const doc = await c.cli(['pool', 'doctor', '--json'], wt);
    expect(doc.json.findings).toContainEqual(expect.objectContaining({ kind: 'namespace', what: ns }));
    writeFileSync(join(server, 'allow'), '');
    const fixed = await c.cli(['pool', 'doctor', '--fix', '--json'], wt);
    expect(fixed.json.findings).toContainEqual(expect.objectContaining({ kind: 'namespace', what: ns, fixed: true }));
    expect(existsSync(join(server, ns))).toBe(false);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

void execFile;

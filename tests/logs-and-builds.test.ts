/**
 * Logs (decision 0038): interleaving, --since up|<duration>, --grep,
 * -f --until/--timeout, --build, rotation, and their life with the
 * environment. Build skip: `build: {run, when}` and --rebuild; outputs
 * compared by content.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LogWriter, readLog, sinceLastStart, startMarker } from '../src/core/logs.js';
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

const TALKER = `const name = process.env.NAME;
console.log(name + ' boot ' + process.pid);
let i = 0;
setInterval(() => console.log(name + ' tick ' + (++i)), 150);
if (process.env.PORT) require('node:http').createServer((q, s) => s.end(String(process.pid))).listen(Number(process.env.PORT), '127.0.0.1');
`;
const STACK = `name: logs
services:
  a:
    run: node talker.cjs
    env: { NAME: alpha }
    ready: { log: alpha boot, timeout: 20 }
    build: "echo building-alpha && echo alpha-build-err 1>&2"
  b:
    run: node talker.cjs
    port: b
    env: { NAME: beta, PORT: "{{ports.b}}" }
    ready: { http: /, timeout: 20 }
`;

describe('LogWriter and readLog', () => {
  it('stamps whole lines per stream, rotates once at the cap, and --since up reads from the last start', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runly-logw-'));
    const file = join(dir, 'svc.log');
    const w = new LogWriter(file, 400);
    w.line(startMarker('svc', 1, ''));
    w.write('out', 'hel');
    w.write('err', 'oops\n');
    w.write('out', 'lo\n');
    const lines = readLog(file, 'svc');
    expect(lines.map((l) => l.text)).toEqual([startMarker('svc', 1, ''), 'oops', 'hello']);
    expect(lines[0]!.marker).toBe(true);
    for (let i = 0; i < 30; i++) w.write('out', `line ${i} ${'x'.repeat(20)}\n`);
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size).toBeLessThanOrEqual(400);
    w.line(startMarker('svc', 2, 'restart'));
    w.write('out', 'second life\n');
    const current = sinceLastStart(readLog(file, 'svc'));
    expect(current.map((l) => l.text)).toEqual([startMarker('svc', 2, 'restart'), 'second life']);
  });
});

describe('runly logs', () => {
  it('interleaves services with a prefix; filters by --grep and --since; shows build output with --build', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': STACK, 'talker.cjs': TALKER });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    await sleep(1500);

    const all = await c.cli(['logs', '--lines', '10'], wt);
    expect(all.code, all.stderr).toBe(0);
    const lines = all.stdout.trim().split('\n');
    expect(lines.length).toBe(10);
    expect(lines.every((l) => /^(a|b) \| /.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith('a | alpha tick'))).toBe(true);
    expect(lines.some((l) => l.startsWith('b | beta tick'))).toBe(true);

    const one = await c.cli(['logs', 'b', '--grep', 'boot'], wt);
    expect(one.stdout.trim()).toMatch(/^beta boot \d+$/);

    const recent = await c.cli(['logs', 'a', '--since', '1s', '--json'], wt);
    const entries = recent.json.entries as Array<{ at: string; text: string }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => Date.parse(e.at) >= Date.now() - 3000)).toBe(true);

    const build = await c.cli(['logs', 'a', '--build'], wt);
    expect(build.stdout).toContain('building-alpha');
    expect(build.stdout).toContain('alpha-build-err');
  }, 60_000);

  it('--since up shows only the current process; logs survive an idle stop and go with the environment', async () => {
    const c = ctx({ BACKLOT_SERVICE_IDLE_MS: '1500' });
    const wt = c.worktree({ 'runly.yml': STACK, 'talker.cjs': TALKER });
    const up = await c.cli(['up', '--json'], wt);
    const firstPid = Number((await (await fetch(up.json.urls.b)).text()));
    expect(await waitFor(() => Object.keys(c.journal().allEnvs()[0]!.servicePids).length === 0, 15_000)).toBe(true);
    // Woken by a request: a second process, same log file.
    const secondPid = Number((await (await fetch(up.json.urls.b)).text()));
    expect(secondPid).not.toBe(firstPid);
    const whole = await c.cli(['logs', 'b', '--grep', 'boot', '--since', '1h'], wt);
    expect(whole.stdout).toContain(`beta boot ${firstPid}`);
    expect(whole.stdout).toContain(`beta boot ${secondPid}`);
    const current = await c.cli(['logs', 'b', '--grep', 'boot', '--since', 'up'], wt);
    expect(current.stdout.trim()).toBe(`beta boot ${secondPid}`);

    const logDir = join(c.stateDir, 'envs', up.json.envId, 'logs');
    expect(existsSync(join(logDir, 'b.log'))).toBe(true);
    expect((await c.cli(['destroy', '--json'], wt)).code).toBe(0);
    expect(existsSync(logDir)).toBe(false);
  }, 60_000);

  it('-f --until exits 0 at the first match, and 124 when --timeout runs out', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': STACK, 'talker.cjs': TALKER });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    const t0 = Date.now();
    const hit = await c.cli(['logs', 'a', '-f', '--lines', '1', '--until', 'alpha tick (2\\d|3\\d)$', '--timeout', '20'], wt);
    expect(hit.code, hit.stderr).toBe(0);
    expect(hit.stdout.trim().split('\n').pop()).toMatch(/alpha tick (2\d|3\d)$/);
    expect(Date.now() - t0).toBeLessThan(15_000);

    const miss = await c.cli(['logs', '-f', '--until', 'never-printed', '--timeout', '1'], wt);
    expect(miss.code).toBe(124);
    expect(miss.stderr).toMatch(/did not match within 1s/);

    const usage = await c.cli(['logs', '--timeout', '5'], wt);
    expect(usage.code).toBe(64);
  }, 60_000);

  it('caps each log file and keeps one rotation', async () => {
    const c = ctx({ BACKLOT_LOG_CAP_BYTES: '20000' });
    const wt = c.worktree({
      'runly.yml': `name: rot\nservices:\n  noisy:\n    run: node noisy.cjs\n    ready: { log: go, timeout: 20 }\n`,
      'noisy.cjs': `console.log('go'); let i = 0; setInterval(() => { for (let k = 0; k < 50; k++) console.log('noise ' + (++i) + ' ' + 'x'.repeat(60)); }, 20);\n`,
    });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr).toBe(0);
    const file = join(c.stateDir, 'envs', up.json.envId, 'logs', 'noisy.log');
    expect(await waitFor(() => existsSync(`${file}.1`), 15_000)).toBe(true);
    await sleep(1000);
    expect(statSync(file).size).toBeLessThanOrEqual(20000 + 8192);
    expect(statSync(`${file}.1`).size).toBeLessThanOrEqual(20000 + 8192);
  }, 60_000);
});

describe('build skip (decision 0038)', () => {
  const STACK_WHEN = `name: skip
services:
  api:
    run: node server.mjs
    port: api
    env: { PORT: "{{ports.api}}" }
    ready: { http: /, timeout: 20 }
    build: { run: "echo built >> builds.txt", when: ["src/**"] }
`;
  const count = (wt: string) => (existsSync(join(wt, 'builds.txt')) ? readFileSync(join(wt, 'builds.txt'), 'utf8').trim().split('\n').length : 0);

  it('skips a when: build while its inputs are unchanged, rebuilds on a change or --rebuild', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': STACK_WHEN, 'server.mjs': SERVER, 'src/a.txt': 'one', '.gitignore': 'builds.txt\n' });
    let up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    expect(count(wt)).toBe(1);

    up = await c.cli(['up'], wt);
    expect(up.code, up.stderr).toBe(0);
    expect(count(wt)).toBe(1);
    expect(up.stderr).toContain('build api: skipped (when: unchanged)');
    const j = await c.cli(['up', '--json'], wt);
    expect(j.json.bindDiagnostics.builds).toEqual([expect.objectContaining({ service: 'api', reason: 'when-unchanged', restart: false })]);

    // A changed input (size+mtime) builds again.
    writeFileSync(join(wt, 'src/a.txt'), 'two!');
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    expect(count(wt)).toBe(2);
    // A new file under the glob too.
    writeFileSync(join(wt, 'src/b.txt'), 'new');
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    expect(count(wt)).toBe(3);

    // --rebuild forces it.
    expect((await c.cli(['up', '--rebuild', '--json'], wt)).code).toBe(0);
    expect(count(wt)).toBe(4);
    // runly plan sees the skip as well.
    const plan = await c.cli(['plan', '--json'], wt);
    // api runs, so nothing starts; its build is listed as skipped and costs nothing.
    expect(plan.json.items).toEqual([expect.objectContaining({ kind: 'build', name: 'api', skipped: 'when: unchanged' })]);
    expect(plan.json.need.memoryBytes).toBe(0);
  }, 90_000);

  it('a failed build is never vouched for: the next up runs it again', async () => {
    const c = ctx();
    const wt = c.worktree({
      'runly.yml': STACK_WHEN.replace('echo built >> builds.txt', 'echo built >> builds.txt && test -f ok'),
      'server.mjs': SERVER, 'src/a.txt': 'one', '.gitignore': 'builds.txt\nok\n',
    });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(1);
    writeFileSync(join(wt, 'ok'), '');
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    expect(count(wt)).toBe(2);
  }, 60_000);

  it('outputs compare: content restarts only when the built bytes changed; stat restarts on a new mtime', async () => {
    const yaml = (compare: string) => `name: out
services:
  api:
    run: node server.mjs
    port: api
    env: { PORT: "{{ports.api}}" }
    ready: { http: /, timeout: 20 }
    build: "mkdir -p out && cp src/v.txt out/v.txt"
    outputs: { paths: ["out/**"], compare: ${compare} }
`;
    const c = ctx();
    const pid = async (url: string) => (await (await fetch(url)).text());
    const wt = c.worktree({ 'runly.yml': yaml('content'), 'server.mjs': SERVER, 'src/v.txt': 'v1', '.gitignore': 'out/\n' });
    const up = await c.cli(['up', '--json'], wt);
    const p1 = await pid(up.json.urls.api);
    await sleep(50);
    utimesSync(join(wt, 'src/v.txt'), new Date(), new Date());
    let again = await c.cli(['up', '--json'], wt);
    expect(again.json.bindDiagnostics.builds[0].reason).toBe('outputs-unchanged');
    expect(await pid(up.json.urls.api)).toBe(p1);
    writeFileSync(join(wt, 'src/v.txt'), 'v2');
    again = await c.cli(['up', '--json'], wt);
    expect(again.json.bindDiagnostics.builds[0].reason).toBe('outputs-changed');
    expect(await pid(up.json.urls.api)).not.toBe(p1);

    // The same unchanged rebuild under compare: stat restarts (cp writes a new mtime).
    writeFileSync(join(wt, 'runly.yml'), yaml('stat'));
    await c.cli(['up', '--json'], wt); // manifest change: a full rebind
    const p2 = await pid(up.json.urls.api);
    await sleep(50);
    again = await c.cli(['up', '--json'], wt);
    expect(again.json.bindDiagnostics.builds[0].reason).toBe('outputs-changed');
    expect(await pid(up.json.urls.api)).not.toBe(p2);
  }, 90_000);
});

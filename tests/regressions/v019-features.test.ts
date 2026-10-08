/**
 * 0.19 regressions: one test per finding of the 0.18 bug hunt, the perf and
 * simplification batch and the real-usage list that is not covered by its own
 * v019-*.test.ts file. Each states the FIXED behaviour; each failed on 0.18.2
 * (origin/main d630f6c) except Q1, which pins the build skip the faster
 * decision path must keep (its speed-up is measured by the perf bench).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLI, makeCtx, SERVER, sleep, waitFor, type Ctx } from '../support/context.js';
import { sameProcess, startTime } from '../../src/core/procscan.js';
import { disposeStateSync } from '../support/leaks.js';

const ctxs: Ctx[] = [];
const dirs: string[] = [];
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
  for (const d of dirs) disposeStateSync(d);
});
const ctx = (env: Record<string, string> = {}) => {
  const c = makeCtx(env);
  ctxs.push(c);
  return c;
};

const WEB = `name: v19
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
`;

describe('#10 a unit for a state root with spaces', () => {
  it('writes WorkingDirectory= and append: paths systemd accepts', async () => {
    const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'v019 unit '))), 'state dir');
    dirs.push(root);
    const c = ctx({ BACKLOT_STATE_DIR: root });
    const wt = c.worktree({ 'runly.yml': WEB, 'server.mjs': SERVER });
    const r = await c.cli(['daemon', 'install', '--print', '--json'], wt);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    if (r.json.kind !== 'systemd') return;
    const content = r.json.content as string;
    expect(content).toContain(`WorkingDirectory=${root}\n`);
    expect(content).toContain(`StandardOutput=append:${join(root, 'daemon.log')}\n`);
    let analyze = true;
    try {
      execFileSync('systemd-analyze', ['--version'], { stdio: 'ignore' });
    } catch {
      analyze = false;
    }
    if (!analyze) return;
    const unitDir = mkdtempSync(join(tmpdir(), 'v019-unit-'));
    dirs.push(unitDir);
    const file = join(unitDir, 'runly-v019-test.service');
    writeFileSync(file, content);
    let out = '';
    try {
      out = execFileSync('systemd-analyze', ['--user', 'verify', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String((e as { stderr?: string }).stderr ?? e);
    }
    expect(out, 'systemd refused the unit').not.toMatch(/not absolute|Failed to parse|Invalid/i);
  }, 60_000);
});

describe('#13 the unit environment: an allowlist, --env NAME, what was left out', () => {
  it('captures PATH, the allowlist, BACKLOT_*, manifest references and --env; never an env_from input', async () => {
    const c = ctx({ V19_REF: 'ref-value', V19_EXTRA: 'extra-value', V19_SECRET: 'secret-value', V19_NOISE: 'noise', BACKLOT_PORT_RANGE: '26500-26999' });
    const wt = c.worktree({
      'runly.yml': `name: cap
services:
  web: { run: 'echo $V19_REF $V19_UNSET; node server.mjs', port: web, env: { PORT: "{{ports.web}}" }, env_from: { V19_SECRET: { required: false } }, ready: { http: /, timeout: 20 } }
`,
      'server.mjs': SERVER,
    });
    const r = await c.cli(['daemon', 'install', '--print', '--json', '--env', 'V19_EXTRA'], wt);
    expect(r.code, r.stderr + r.stdout).toBe(0);
    const e = r.json.environment;
    expect(e.captured).toEqual(expect.arrayContaining(['PATH', 'V19_REF', 'V19_EXTRA', 'BACKLOT_PORT_RANGE']));
    expect(e.captured).not.toContain('V19_NOISE');
    expect(e.captured).not.toContain('V19_SECRET');
    expect(e.excludedInputs).toContain('V19_SECRET');
    expect(e.notSet).toContain('V19_UNSET');
    expect(e.leftOut).toBeGreaterThan(0);
    expect(r.json.content).not.toContain('secret-value');
    expect(r.json.content).toContain('RUNLY_SUPERVISOR'); // Environment="RUNLY_SUPERVISOR=…" or a plist <key>
    // Plain: what was captured and left out is said before anything is written.
    const plain = await c.cli(['daemon', 'install', '--print'], wt);
    expect(plain.stderr).toMatch(/captured from this shell: .*V19_REF/);
    expect(plain.stderr).toMatch(/left out; add one with --env NAME/);
  }, 60_000);

  it('a command failing for its environment says so, and how the unit gets it', async () => {
    const { environmentHint } = await import('../../src/core/util.js');
    expect(environmentHint('sh: 1: dotnet: not found')).toMatch(/environment/i);
    expect(environmentHint('error CS1002: ; expected')).toBeUndefined();
  });
});

describe('#14 db with: the command dies with the CLI, whatever kills it', () => {
  it.skipIf(process.platform === 'win32')('a SIGKILL of the CLI alone takes the command down (no daemon sweep needed)', async () => {
    // The sweep is off: only the watchdog can stop the command.
    const c = ctx({ BACKLOT_SWEEP_MS: '600000' });
    const wt = c.worktree({
      'runly.yml': `name: wd
services:
  web: { run: "true" }
datastores:
  main: { driver: sqlite, create: 'node seed.mjs "{{ns}}"', template: true }
`,
      'seed.mjs': `import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(process.argv[2]).exec('CREATE TABLE IF NOT EXISTS t(x)');\n`,
    });
    const pidFile = join(wt, 'child.pid');
    // The CLI leads its own group (no terminal), the command another.
    const cli = spawn(process.execPath, [CLI, 'db', 'with', 'main', '--', `sleep 300 & echo $! > '${pidFile}'; wait`], { cwd: wt, env: c.env, stdio: 'ignore', detached: true });
    kids.push(cli.pid!);
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 30_000)).toBe(true);
    const sleeper = Number(readFileSync(pidFile, 'utf8'));
    kids.push(sleeper);
    const sleeperStart = startTime(sleeper);
    process.kill(-cli.pid!, 'SIGKILL');
    const stopped = await waitFor(() => !sameProcess(sleeper, sleeperStart), 8_000, 50);
    expect(stopped, 'the command outlived the CLI that holds its database copy').toBe(true);
  }, 90_000);
});

describe('#15 the proxy bounds what all connections carry for a replay', () => {
  it('a connection past the global cap is not replayed; one under it is', async () => {
    const c = ctx({ BACKLOT_PROXY_REPLAY_CAP_BYTES: '1500', BACKLOT_SWEEP_MS: '200' });
    const svc = `import { createServer } from 'node:http';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const first = !existsSync('relaunched');
let seen = 0;
createServer((q, s) => {
  if (q.url === '/') return s.end('ok');
  appendFileSync('seen.log', q.url + ' ' + process.pid + '\\n');
  if (first) {
    // Hold both requests unanswered, then die before answering either.
    if (++seen === 2) { writeFileSync('relaunched', '1'); process.exit(1); }
    return;
  }
  s.end('answered ' + q.url);
}).listen(Number(process.env.PORT), '127.0.0.1');
`;
    const wt = c.worktree({
      'runly.yml': `name: cap\nservices:\n  api: { run: node svc.mjs, port: api, env: { PORT: "{{ports.api}}" }, ready: { http: /, timeout: 20 } }\n`,
      'svc.mjs': svc,
      '.gitignore': 'seen.log\nrelaunched\n',
    });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const port = up.json.ports.api as number;
    const get = (path: string) => new Promise<string>((resolve) => {
      let got = '';
      const s = connect(port, '127.0.0.1', () => s.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nX-Pad: ${'p'.repeat(900)}\r\nConnection: close\r\n\r\n`));
      s.on('data', (d) => (got += d.toString()));
      s.on('error', () => undefined);
      s.on('close', () => resolve(got));
      setTimeout(() => s.destroy(), 25_000).unref();
    });
    const a = get('/a');
    await sleep(400);
    const b = get('/b');
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra, 'the request under the cap was replayed to the relaunch').toContain('answered /a');
    expect(rb, 'the request past the global cap was replayed anyway').not.toContain('answered /b');
    const st = await c.cli(['status', '--json'], wt);
    expect(st.json.proxyReplayCarriedBytes).toBe(0);
  }, 90_000);
});

describe('Q2 datastores are prepared in parallel', () => {
  it('two slow bakes overlap', async () => {
    const c = ctx();
    const server = realpathSync(mkdtempSync(join(tmpdir(), 'v019-q2-')));
    dirs.push(server);
    const ds = (n: string) => `  ${n}:
    driver: postgres
    url: "file://${server}/{{ns}}"
    presets: [dev]
    create: 'echo "start ${n} $(date +%s%N)" >> "${server}/spans"; sleep 2; mkdir -p "${server}/{{ns}}"; echo "end ${n} $(date +%s%N)" >> "${server}/spans"'
    template_restore: 'cp -r "${server}/{{template}}" "${server}/{{ns}}"'
    drop: 'rm -rf "${server}/{{ns}}"'
`;
    const wt = c.worktree({ 'runly.yml': `${WEB}datastores:\n${ds('one')}${ds('two')}`, 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const spans: Record<string, { start: number; end: number }> = {};
    for (const line of readFileSync(join(server, 'spans'), 'utf8').trim().split('\n')) {
      const [what, n, ns] = line.split(' ') as [string, string, string];
      spans[n] ??= { start: 0, end: 0 };
      spans[n][what === 'start' ? 'start' : 'end'] = Number(BigInt(ns) / 1_000_000n);
    }
    expect(spans.one!.start < spans.two!.end && spans.two!.start < spans.one!.end, 'the two bakes ran one after the other').toBe(true);
    await c.cli(['destroy', '--json'], wt);
  }, 90_000);
});

describe('Q5 exec runs in the CLI', () => {
  it('real exit codes, the caller environment, nothing cut, and no lock on the environment', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': WEB, 'server.mjs': SERVER });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    const code = await c.cli(['exec', 'exit 7'], wt);
    expect(code.code, 'the command exit code was folded into 1').toBe(7);
    const env = await c.cli(['exec', 'echo "$V19_CALLER $RUNLY_ENV_ID"'], wt, { V19_CALLER: 'from-caller' });
    expect(env.stdout).toMatch(/^from-caller v19-/);
    const big = await c.cli(['exec', `node -e "process.stdout.write('x'.repeat(100000))"`], wt);
    expect(big.stdout.length, 'exec output was cut').toBe(100000);
    const json = await c.cli(['exec', '--json', 'echo out; echo err >&2; exit 3'], wt);
    expect(json.code).toBe(3);
    expect(json.json).toMatchObject({ ok: false, exitCode: 3, stdout: 'out\n', stderr: 'err\n' });
    // A long exec does not hold the environment: an `up` next to it is not queued behind it.
    const long = c.cli(['exec', 'sleep 4'], wt);
    await sleep(500);
    const t0 = Date.now();
    const again = await c.cli(['up', '--json'], wt);
    expect(again.code).toBe(0);
    expect(Date.now() - t0, 'up waited for the exec').toBeLessThan(3000);
    expect((await long).code).toBe(0);
  }, 90_000);
});

describe('Q7 plain summaries, and exec after a daemon restart', () => {
  it('status and destroy print a summary; token resumes after a restart', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': `${WEB}auth:\n  token: "echo tok-{{role}}"\n`, 'server.mjs': SERVER });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    const st = await c.cli(['status'], wt);
    expect(st.stdout).toMatch(/^runly daemon pid \d+ \(autospawned\), 1 of at most \d+ environment/);
    expect(st.stdout).not.toMatch(/^\{/);
    await c.stopDaemon(wt);
    const tok = await c.cli(['token', '--role', 'dev', '--raw'], wt);
    expect(tok.code, tok.stderr).toBe(0);
    expect(tok.stdout.trim()).toBe('tok-dev');
    const ps = await c.cli(['ps', '--json'], wt);
    expect(ps.json.services[0].state).toBe('running');
    const d = await c.cli(['destroy'], wt);
    expect(d.stdout).toMatch(/^destroyed v19-\S+ \(services, data, ports, lease\)/);
  }, 90_000);
});

describe('BACKLOT_UNLEASED_TTL tears down an unleased environment nobody uses', () => {
  it('goes after the TTL; the worktree records stay', async () => {
    const c = ctx({ BACKLOT_UNLEASED_TTL: '2s', BACKLOT_SWEEP_MS: '300' });
    const wt = c.worktree({ 'runly.yml': `${WEB}upkeep:\n  - { when: server.mjs, run: "echo ran >> upkeep.log" }\n`, 'server.mjs': SERVER, '.gitignore': 'upkeep.log\n' });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    expect((await c.cli(['release', '--json'], wt)).code).toBe(0);
    expect(await waitFor(() => c.journal().allEnvs().length === 0, 20_000), 'the unleased environment stayed').toBe(true);
    const stack = up.json.envId.replace(/-e\d+$/, '');
    expect(existsSync(join(c.stateDir, 'worktrees', stack))).toBe(true);
    // The next up skips the upkeep rule: its ledger survived.
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    expect(readFileSync(join(wt, 'upkeep.log'), 'utf8').trim().split('\n')).toHaveLength(1);
  }, 90_000);
});

describe('C1 verbs from a subdirectory act on the worktree', () => {
  it('ctx, exec and release from a subdirectory find the lease', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': WEB, 'server.mjs': SERVER, 'sub/dir/keep': '' });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code).toBe(0);
    const sub = join(wt, 'sub', 'dir');
    const cx = await c.cli(['ctx', '--json'], sub);
    expect(cx.code, cx.stdout + cx.stderr).toBe(0);
    expect(cx.json.envId).toBe(up.json.envId);
    const ex = await c.cli(['exec', 'pwd'], sub);
    expect(ex.code, ex.stderr).toBe(0);
    const rel = await c.cli(['release', '--json'], sub);
    expect(rel.json.released).toBe(true);
  }, 60_000);
});

describe('C2 + C9 a full rebind reports what it started and why', () => {
  it('fills started/restarted and names the reasons', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': WEB, 'server.mjs': SERVER });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    writeFileSync(join(wt, 'runly.yml'), WEB.replace('PORT: "{{ports.web}}"', 'PORT: "{{ports.web}}", V: "2"'));
    const r = await c.cli(['up', '--json'], wt);
    expect(r.code).toBe(0);
    expect(r.json.bindDiagnostics.reuse).toBe('rebound');
    expect(r.json.bindDiagnostics.reasons).toContain('manifest-changed');
    expect(r.json.bindDiagnostics.restarted).toEqual(['web']);
    writeFileSync(join(wt, 'runly.yml'), WEB);
    const plain = await c.cli(['up'], wt);
    expect(plain.stdout).toMatch(/restarted web/);
    expect(plain.stdout).toMatch(/full rebind: the manifest changed/);
  }, 60_000);
});

describe('C3 a failed first up is reported by ctx and ps', () => {
  it('names what failed and that up redoes it', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': `name: bf\nservices:\n  web: { build: "echo nope; exit 2", run: "echo ready; sleep 300", ready: { log: ready, timeout: 5 } }\n` });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(1);
    const cx = await c.cli(['ctx', '--json'], wt);
    expect(cx.json.lastUpFailed?.message).toMatch(/build failed for service 'web'/);
    const ps = await c.cli(['ps'], wt);
    expect(ps.stdout).toMatch(/the last 'runly up' failed \[work-error\]: build failed/);
    expect(ps.stdout).not.toMatch(/connection starts what is wanted/);
  }, 60_000);
});

describe('C4 + C5 logs', () => {
  it('--grep with no match exits 1; --build shows each section and what was cut', async () => {
    const c = ctx();
    const wt = c.worktree({
      'runly.yml': `name: lg
services:
  web: { build: "for i in $(seq 1 100); do echo line-$i; done", run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
  side: { build: "echo side-built", run: "echo ready; sleep 300", ready: { log: ready, timeout: 20 } }
`,
      'server.mjs': SERVER,
    });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    expect((await c.cli(['logs', 'web', '--grep', 'listening'], wt)).code).toBe(0);
    const none = await c.cli(['logs', 'web', '--grep', 'no-such-line'], wt);
    expect(none.code).toBe(1);
    const build = await c.cli(['logs', '--build', '--lines', '5'], wt);
    expect(build.code).toBe(0);
    expect(build.stdout).toMatch(/== build web: last 5 of 100 lines \(95 earlier cut; --lines 100 shows all\) ==\nline-96\n/);
    expect(build.stdout).toMatch(/== build side: 1 line ==\nside-built\n/);
  }, 60_000);
});

describe('C6 + C7 db with: RUNLY_DB_DATABASE, and runly failures told apart from the command', () => {
  it('exports the database name; marks runly own failure and passes the command exit through', async () => {
    const c = ctx();
    const wt = c.worktree({
      'runly.yml': `name: dw\nservices:\n  web: { run: "true" }\ndatastores:\n  main: { driver: sqlite, create: 'node seed.mjs "{{ns}}"', template: true }\n`,
      'seed.mjs': `import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(process.argv[2]).exec('CREATE TABLE IF NOT EXISTS t(x)');\n`,
    });
    const name = await c.cli(['db', 'with', 'main', '--', 'echo "db=$RUNLY_DB_DATABASE"'], wt);
    expect(name.code, name.stderr).toBe(0);
    expect(name.stdout).toMatch(/^db=\S+/);
    const cmd = await c.cli(['db', 'with', 'main', '--', 'exit 4'], wt);
    expect(cmd.code).toBe(4);
    const own = await c.cli(['db', 'with', 'nope', '--runly-exit', '125', '--', 'true'], wt);
    expect(own.code).toBe(125);
    expect(own.stderr).toMatch(/runly db with/);
    const ownJson = await c.cli(['db', 'with', '--json', 'nope', '--', 'true'], wt);
    expect(ownJson.stderr).toMatch(/"runlyDbWith"/);
  }, 60_000);
});

describe('C8 a tethered lease shows its agent; --ttl is for untethered leases', () => {
  it('prints "held by agent <pid>" and refuses --ttl next to --holder-pid', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': WEB, 'server.mjs': SERVER });
    const agent = spawn('sleep', ['300'], { stdio: 'ignore' });
    kids.push(agent.pid!);
    const up = await c.cli(['up', '--holder-pid', String(agent.pid)], wt);
    expect(up.code, up.stderr).toBe(0);
    expect(up.stdout).toMatch(new RegExp(`held by agent ${agent.pid}`));
    expect(up.stdout).not.toMatch(/lease until/);
    const both = await c.cli(['up', '--holder-pid', String(agent.pid), '--ttl', '10'], wt);
    expect(both.code).toBe(64);
    expect(both.stderr).toMatch(/--ttl sets the length of an untethered lease/);
  }, 60_000);
});

describe('C10 up <service> touches only it and its dependencies', () => {
  it('does not rebuild or restart another running service', async () => {
    const c = ctx();
    const svc = (n: string) => `  ${n}: { build: "echo ${n} >> builds.log", run: node server.mjs, port: ${n}, env: { PORT: "{{ports.${n}}}" }, ready: { http: /, timeout: 20 } }\n`;
    const wt = c.worktree({ 'runly.yml': `name: sc\nservices:\n${svc('a')}${svc('b')}`, 'server.mjs': SERVER, '.gitignore': 'builds.log\n' });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    const before = readFileSync(join(wt, 'builds.log'), 'utf8').trim().split('\n');
    const r = await c.cli(['up', 'a', '--json'], wt);
    expect(r.code).toBe(0);
    const after = readFileSync(join(wt, 'builds.log'), 'utf8').trim().split('\n');
    expect(after.slice(before.length)).toEqual(['a']);
    expect(r.json.bindDiagnostics.builds).toContainEqual(expect.objectContaining({ service: 'b', reason: 'not-named', restart: false }));
  }, 60_000);
});

describe('Q1 one build decision per operation', () => {
  it('a no-op up over a large tree skips the when: build; a changed input runs it', async () => {
    const c = ctx();
    const files: Record<string, string> = { 'runly.yml': `name: q1\nservices:\n  web: { build: { run: "echo built >> builds.log", when: ["src/**"] }, run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }\n`, 'server.mjs': SERVER, '.gitignore': 'builds.log\n' };
    for (let i = 0; i < 3000; i++) files[`src/d${i % 30}/f${i}.ts`] = `export const x${i} = ${i};\n`;
    const wt = c.worktree(files);
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    const r = await c.cli(['up', '--json'], wt);
    expect(r.code).toBe(0);
    expect(r.json.bindDiagnostics.builds).toContainEqual(expect.objectContaining({ service: 'web', reason: 'when-unchanged' }));
    expect(readFileSync(join(wt, 'builds.log'), 'utf8').trim().split('\n')).toHaveLength(1);
    // A changed input is seen again.
    mkdirSync(join(wt, 'src', 'new'), { recursive: true });
    writeFileSync(join(wt, 'src', 'new', 'g.ts'), 'export {};\n');
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    expect(readFileSync(join(wt, 'builds.log'), 'utf8').trim().split('\n')).toHaveLength(2);
  }, 90_000);
});

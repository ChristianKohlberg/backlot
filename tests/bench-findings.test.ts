/**
 * The step-10 benchmark findings (decision 0039), each driven through the real
 * CLI against an isolated state dir:
 *
 *  B1  templates survive a teardown (destroy keeps the worktree's records; a
 *      template whose key matches is reused, never rebaked), and the data
 *      phase overlaps the build phase on a full bind.
 *  B2  a failed restore is logged and retried before anything is rebaked;
 *      parallel restores of one template never cascade into rebakes.
 *  B3  a crash-looping service in a LEASED environment is stopped and marked
 *      failed; the environment, its data, its other services and its logs stay.
 *  B5  `runly db with` killed by SIGKILL: its command is stopped with the copy.
 *  B6  polling the read-only verbs is not activity.
 *  B7  `runly daemon install` writes a supervising unit, and the CLI starts the
 *      daemon through it.
 *  B8  a `copies_only` datastore is never provisioned for an environment.
 *
 * (B4, the proxy's hold-and-retry on a reset before the first byte, is in
 * tests/proxy-reset.test.ts.)
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeCtx, sleep, waitFor, SERVER, CLI, type Ctx } from './support/context.js';
import { sameProcess, startTime } from '../src/core/procscan.js';
import { disposeStateSync } from './support/leaks.js';

const ctxs: Ctx[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
  for (const d of dirs) disposeStateSync(d);
});
const ctx = (env: Record<string, string> = {}) => {
  const c = makeCtx(env);
  ctxs.push(c);
  return c;
};
const tmp = (prefix: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
const lines = (file: string): string[] => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const events = (c: Ctx): Array<{ kind: string; level: string; detail?: string }> =>
  lines(join(c.stateDir, 'events.jsonl')).map((l) => JSON.parse(l) as { kind: string; level: string; detail?: string });

/**
 * A server-shaped datastore whose namespaces are directories under `server`:
 * `create:` is a slow bake (it logs every bake), `template_restore:` a copy.
 */
function bakingStack(server: string, opts: { bakeS?: number; buildS?: number; restore?: string } = {}): Record<string, string> {
  const bake = `#!/bin/sh
sleep ${opts.bakeS ?? 1}
mkdir -p "${server}/$1"
echo "$2" > "${server}/$1/preset"
echo "bake $1" >> "${server}/bakes.log"
`;
  return {
    'runly.yml': `name: bench
services:
  web:
    build: "sleep ${opts.buildS ?? 0} && echo built > built.txt"
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}", DB: "{{datastores.main.url}}" }
    ready: { http: /, timeout: 30 }
datastores:
  main:
    driver: postgres
    url: "file://${server}/{{ns}}"
    presets: [dev]
    create: 'sh bake.sh "{{ns}}" "{{preset}}"'
    template_restore: '${opts.restore ?? `cp -r "${server}/{{template}}" "${server}/{{ns}}"`}'
    drop: 'rm -rf "${server}/{{ns}}"'
upkeep:
  - { when: seed.sql, run: "@rebake-template main" }
  - { when: package.json, run: "echo ran >> upkeep.log" }
`,
    'bake.sh': bake,
    'seed.sql': 'create table t(x);\n',
    'package.json': '{}\n',
    'server.mjs': SERVER,
    '.gitignore': 'built.txt\nupkeep.log\n',
  };
}

describe('B1: templates survive a teardown (decision 0039)', () => {
  it('up after destroy reuses the template whose key is unchanged and re-runs no upkeep rule', async () => {
    const c = ctx();
    const server = tmp('runly-b1-srv-');
    const wt = c.worktree(bakingStack(server, { bakeS: 2 }));
    const first = await c.cli(['up', '--json'], wt);
    expect(first.code, first.stderr + first.stdout).toBe(0);
    expect(lines(join(server, 'bakes.log'))).toHaveLength(1);
    expect(lines(join(wt, 'upkeep.log'))).toHaveLength(1);

    const d = await c.cli(['destroy', '--json'], wt);
    expect(d.code, d.stderr + d.stdout).toBe(0);
    expect(c.journal().allEnvs()).toEqual([]);

    const again = await c.cli(['up', '--json'], wt);
    expect(again.code, again.stderr + again.stdout).toBe(0);
    // The template from the first up is current (same create, same seed.sql):
    // restored, not rebaked; the upkeep rule's trigger did not change.
    expect(lines(join(server, 'bakes.log')), 'the template was rebaked after destroy').toHaveLength(1);
    expect(lines(join(wt, 'upkeep.log')), 'an upkeep rule re-ran after destroy').toHaveLength(1);
    expect(again.json.bindDiagnostics.phasesMs.data).toBeLessThan(1500);
    // The fresh environment's datastore was restored from that template.
    expect(readFileSync(join(server, again.json.datastores.main.ns, 'preset'), 'utf8').trim()).toBe('dev');
  }, 120_000);

  it('a changed seed reloads from a new template; --pristine rebakes the current one', async () => {
    const c = ctx();
    const server = tmp('runly-b1b-srv-');
    const wt = c.worktree(bakingStack(server));
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    expect(lines(join(server, 'bakes.log'))).toHaveLength(1);
    // Same content: an up is a no-op for the data.
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    expect(lines(join(server, 'bakes.log'))).toHaveLength(1);
    // New seed content: a new template key, baked once, and the environment's
    // store reloaded from it.
    writeFileSync(join(wt, 'seed.sql'), 'create table t(x, y);\n');
    const changed = await c.cli(['up', '--json'], wt);
    expect(changed.code, changed.stderr + changed.stdout).toBe(0);
    const bakes = lines(join(server, 'bakes.log'));
    expect(bakes).toHaveLength(2);
    expect(bakes[0]).not.toBe(bakes[1]);
    // Pristine trusts nothing: the current template is baked again.
    const pristine = await c.cli(['up', '--pristine', '--json'], wt);
    expect(pristine.code, pristine.stderr + pristine.stdout).toBe(0);
    expect(lines(join(server, 'bakes.log'))).toHaveLength(3);
  }, 120_000);

  it('a full bind restores the data while the services build', async () => {
    const c = ctx();
    const server = tmp('runly-b1c-srv-');
    const wt = c.worktree(bakingStack(server, { bakeS: 3, buildS: 3 }));
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const d = up.json.bindDiagnostics;
    expect(d.phasesMs.data).toBeGreaterThan(2500);
    expect(d.phasesMs.build).toBeGreaterThan(2500);
    // Serial, the bind took at least data + build; overlapped, it saves most of the shorter one.
    expect(d.durationMs, JSON.stringify(d.phasesMs)).toBeLessThan(d.phasesMs.data + d.phasesMs.build - 1500);
    expect(readFileSync(join(wt, 'built.txt'), 'utf8').trim()).toBe('built');
  }, 120_000);
});

describe('B2: a failed restore is said and retried, never silently rebaked (decision 0039)', () => {
  it('parallel copies with one failing restore bake the template once and log the failure', async () => {
    const c = ctx();
    const server = tmp('runly-b2-srv-');
    // The first restore anywhere fails (a transient error); every restore takes a moment.
    const restore = `sh restore.sh "{{template}}" "{{ns}}"`;
    const files = bakingStack(server, { restore });
    files['restore.sh'] = `#!/bin/sh
if mkdir "${server}/.failed-once" 2>/dev/null; then echo "transient: lock wait timed out" >&2; exit 1; fi
sleep 1
cp -r "${server}/$1" "${server}/$2"
`;
    const wt = c.worktree(files);
    // Bake once up front so the copies below all restore from the same template.
    const warm = await c.cli(['db', 'new', 'main', '--json'], wt);
    expect(warm.code, warm.stderr + warm.stdout).toBe(0);
    expect(lines(join(server, 'bakes.log'))).toHaveLength(1);
    const copies = await Promise.all([1, 2, 3, 4].map(() => c.cli(['db', 'new', 'main', '--json'], wt)));
    for (const r of copies) expect(r.code, r.stderr + r.stdout).toBe(0);
    expect(lines(join(server, 'bakes.log')), 'a failed restore rebaked the template').toHaveLength(1);
    const said = events(c).filter((e) => e.kind === 'template');
    expect(said.length, JSON.stringify(events(c).slice(-10))).toBeGreaterThan(0);
    expect(said[0]!.detail).toMatch(/failed — retrying the restore: .*transient: lock wait timed out/);
  }, 120_000);
});

describe('B3: a crash loop in a leased environment keeps the environment (decision 0039)', () => {
  it('stops the failed service, keeps env, data, other services and logs, and the next up retries it', async () => {
    const c = ctx({ BACKLOT_SWEEP_MS: '200' });
    const flaky = `import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
if (existsSync('crash.flag')) { console.error('boom: crash.flag is set'); process.exit(3); }
createServer((q, s) => { if (q.url === '/die') { s.end('bye'); setTimeout(() => process.exit(3), 20); return; } s.end(String(process.pid)); })
  .listen(Number(process.env.PORT), '127.0.0.1');
`;
    const wt = c.worktree({
      'runly.yml': `name: crashy
services:
  api: { run: node flaky.mjs, port: api, env: { PORT: "{{ports.api}}" }, ready: { http: /, timeout: 20 } }
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
datastores:
  main: { driver: sqlite, create: 'node seed.mjs "{{ns}}"', template: true }
`,
      'flaky.mjs': flaky,
      'server.mjs': SERVER,
      'seed.mjs': `import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(process.argv[2]).exec('CREATE TABLE IF NOT EXISTS t(x)');\n`,
      '.gitignore': 'crash.flag\n',
    });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const envId = up.json.envId as string;
    const db = up.json.datastores.main.ns as string;
    const webPid = c.journal().getEnv(envId)!.servicePids.web!.pid;

    // From now on every start of api dies at once: a crash loop.
    writeFileSync(join(wt, 'crash.flag'), '1');
    await fetch(`${up.json.urls.api}/die`).catch(() => undefined);
    const failed = await waitFor(async () => {
      const ps = await c.cli(['ps', '--json'], wt);
      return ps.json?.services?.some((s: { service: string; state: string }) => s.service === 'api' && s.state === 'failed');
    }, 30_000, 300);
    expect(failed, JSON.stringify(events(c).slice(-8))).toBe(true);
    await sleep(1500); // several sweeps: a degraded env used to be recycled here

    const env = c.journal().getEnv(envId);
    expect(env, 'the leased environment was recycled').toBeDefined();
    expect(env!.state).not.toBe('degraded');
    expect(existsSync(db), 'its data was dropped').toBe(true);
    expect(existsSync(join(c.stateDir, 'envs', envId, 'logs', 'api.log')), 'its logs were deleted').toBe(true);
    expect(readFileSync(join(c.stateDir, 'envs', envId, 'logs', 'api.log'), 'utf8')).toMatch(/boom: crash.flag is set/);
    expect(sameProcess(webPid, c.journal().getEnv(envId)!.servicePids.web?.startTime), 'the other service was stopped').toBe(true);
    const ps = await c.cli(['ps', '--json'], wt);
    const api = ps.json.services.find((s: { service: string }) => s.service === 'api');
    expect(api.failure.exitCode).toBe(3);
    expect(api.failure.hint).toBe('runly logs api');
    const ctxView = await c.cli(['ctx', '--json'], wt);
    expect(ctxView.json.services.api).toBe('failed');
    expect(ctxView.json.failures.api.exitCode).toBe(3);

    // Fixed: the next up starts it again, on the same environment.
    rmSync(join(wt, 'crash.flag'));
    const retry = await c.cli(['up', '--json'], wt);
    expect(retry.code, retry.stderr + retry.stdout).toBe(0);
    expect(retry.json.envId).toBe(envId);
    expect(retry.json.services.api).toBe('running');
    expect((await fetch(retry.json.urls.api)).status).toBe(200);
  }, 120_000);

  it('an UNLEASED environment whose service crash-loops is still recycled', async () => {
    const c = ctx({ BACKLOT_SWEEP_MS: '200' });
    const wt = c.worktree({
      'runly.yml': `name: crashy2
services:
  api: { run: node flaky.mjs, port: api, env: { PORT: "{{ports.api}}" }, ready: { http: /, timeout: 20 } }
`,
      'flaky.mjs': `import { createServer } from 'node:http';
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
setTimeout(() => process.exit(3), 300);
`,
    });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    expect((await c.cli(['release', '--json'], wt)).code).toBe(0);
    expect(await waitFor(() => c.journal().allEnvs().length === 0, 30_000)).toBe(true);
  }, 90_000);
});

describe('B5: `runly db with` killed by SIGKILL takes its command down with the copy (decision 0039)', () => {
  it.skipIf(process.platform === 'win32')('stops the command (and what it started) before the copy is dropped', async () => {
    const c = ctx({ BACKLOT_SWEEP_MS: '200', BACKLOT_TETHER_GRACE_MS: '0' });
    const wt = c.worktree({
      'runly.yml': `name: dbwith
services:
  web: { run: "true" }
datastores:
  main: { driver: sqlite, create: 'node seed.mjs "{{ns}}"', template: true }
`,
      'seed.mjs': `import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(process.argv[2]).exec('CREATE TABLE IF NOT EXISTS t(x)');\n`,
    });
    const pidFile = join(wt, 'child.pid');
    // A shell that starts a long-running child: the shape of a test runner.
    const cli = spawn(process.execPath, [CLI, 'db', 'with', 'main', '--', `sleep 300 & echo $! > '${pidFile}'; wait`], {
      cwd: wt,
      env: c.env,
      stdio: 'ignore',
    });
    expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 30_000)).toBe(true);
    const sleeper = Number(readFileSync(pidFile, 'utf8'));
    const sleeperStart = startTime(sleeper);
    expect(c.journal().allDbCopies()).toHaveLength(1);
    cli.kill('SIGKILL');
    // The copy goes …
    expect(await waitFor(() => c.journal().allDbCopies().length === 0, 30_000)).toBe(true);
    // … and so does what ran against it.
    const stopped = await waitFor(() => !sameProcess(sleeper, sleeperStart), 10_000);
    try {
      process.kill(sleeper, 'SIGKILL');
    } catch {
      /* gone, as it should be */
    }
    expect(stopped, 'the db with command kept running after its copy was dropped').toBe(true);
  }, 90_000);
});

describe('B6: read-only verbs are not activity (decision 0039)', () => {
  const polled = (name: string) => ({
    'runly.yml': `name: ${name}
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
`,
    'server.mjs': SERVER,
  });

  it('ps shows IDLE and STOPS IN from the one clock the sweeper stops by', async () => {
    const c = ctx({ BACKLOT_SERVICE_IDLE_MS: '60000' });
    const wt = c.worktree(polled('clock'));
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    await sleep(1000);
    const web = (await c.cli(['ps', '--json'], wt)).json.services[0];
    // No client byte yet: the clock is the bind. The two add up to the limit.
    expect(web.idleMs).toBeGreaterThan(800);
    expect(Math.abs(web.idleMs + web.idleStopInMs - 60_000)).toBeLessThan(500);
  }, 60_000);

  it('polling ps, ctx, plan and logs does not keep an idle service awake', async () => {
    const c = ctx({ BACKLOT_SERVICE_IDLE_MS: '2500', BACKLOT_SWEEP_MS: '200' });
    const wt = c.worktree(polled('poll'));
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const deadline = Date.now() + 9000;
    let stopped = false;
    while (Date.now() < deadline && !stopped) {
      await Promise.all([c.cli(['ps', '--json'], wt), c.cli(['ctx', '--json'], wt), c.cli(['plan', '--json'], wt), c.cli(['logs', '--json'], wt)]);
      stopped = Object.keys(c.journal().allEnvs()[0]?.servicePids ?? {}).length === 0;
      await sleep(250);
    }
    expect(stopped, 'polling read-only verbs kept the service running').toBe(true);
  }, 60_000);

  it('exec is activity', async () => {
    const c = ctx({ BACKLOT_SERVICE_IDLE_MS: '2500', BACKLOT_SWEEP_MS: '200' });
    const wt = c.worktree(polled('execd'));
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      expect((await c.cli(['exec', 'true'], wt)).code).toBe(0);
      await sleep(400);
    }
    expect(Object.keys(c.journal().allEnvs()[0]!.servicePids)).toEqual(['web']);
  }, 60_000);
});

describe('B7: a supervised daemon (decision 0039)', () => {
  it.skipIf(process.platform !== 'linux')('daemon install writes a restarting systemd user unit, and the CLI starts the daemon through it', async () => {
    const c = ctx();
    const config = tmp('runly-b7-cfg-');
    const bin = tmp('runly-b7-bin-');
    const calls = join(bin, 'calls.log');
    const entry = join(import.meta.dirname, '..', 'dist', 'daemon', 'index.js');
    // A systemctl stand-in: records its arguments; `start` launches the daemon
    // the way the unit's ExecStart would.
    const fake = join(bin, 'systemctl');
    writeFileSync(fake, `#!/bin/sh
echo "$*" >> "${calls}"
if [ "$2" = "start" ]; then
  BACKLOT_STATE_DIR="${c.stateDir}" nohup "${process.execPath}" --disable-warning=ExperimentalWarning "${entry}" >/dev/null 2>&1 &
fi
exit 0
`);
    chmodSync(fake, 0o755);
    const env = { XDG_CONFIG_HOME: config, BACKLOT_SYSTEMCTL: fake };
    const wt = c.worktree({ 'runly.yml': 'name: unit\nservices:\n  web: { run: "true" }\n' });

    const printed = await c.cli(['daemon', 'install', '--print'], wt, env);
    expect(printed.code, printed.stderr).toBe(0);
    expect(printed.stdout).toMatch(/^Restart=on-failure$/m);
    expect(printed.stdout).toMatch(/^RestartSec=1$/m);
    expect(printed.stdout).toMatch(/^KillMode=process$/m);
    expect(printed.stdout).toContain(entry);
    expect(printed.stdout).toContain(`BACKLOT_STATE_DIR=${c.stateDir}`);
    expect(readdirSync(config)).toEqual([]); // --print writes nothing

    const installed = await c.cli(['daemon', 'install', '--json'], wt, env);
    expect(installed.code, installed.stderr + installed.stdout).toBe(0);
    expect(installed.json.started).toBe(true);
    const unitPath = installed.json.path as string;
    expect(unitPath.startsWith(join(config, 'systemd', 'user'))).toBe(true);
    expect(readFileSync(unitPath, 'utf8')).toBe(printed.stdout);
    expect(lines(calls)).toEqual(['--user daemon-reload', `--user enable ${installed.json.name}.service`, `--user start ${installed.json.name}.service`]);
    expect(await waitFor(() => c.daemonPid() !== undefined, 10_000)).toBe(true);

    // With the unit installed, a CLI that finds no daemon starts the unit
    // instead of spawning one outside it.
    await c.stopDaemon(wt);
    writeFileSync(calls, '');
    const status = await c.cli(['status', '--json'], wt, env);
    expect(status.code, status.stderr + status.stdout).toBe(0);
    expect(lines(calls)).toEqual([`--user start ${installed.json.name}.service`]);

    const removed = await c.cli(['daemon', 'uninstall', '--json'], wt, env);
    expect(removed.code).toBe(0);
    expect(removed.json.removed).toBe(true);
    expect(existsSync(unitPath)).toBe(false);
  }, 60_000);
});

describe('B8: a copies_only datastore (decision 0039)', () => {
  const stack = (server: string, extra = '') => ({
    'runly.yml': `name: copies
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}", DB: "{{datastores.main.url}}"${extra} }
    ready: { http: /, timeout: 20 }
datastores:
  main: { driver: sqlite, create: 'node seed.mjs "{{ns}}"', template: true }
  integration:
    driver: postgres
    copies_only: true
    url: "file://${server}/{{ns}}"
    presets: [legacy]
    create: 'sh bake.sh "{{ns}}" "{{preset}}"'
    template_restore: 'cp -r "${server}/{{template}}" "${server}/{{ns}}"'
    drop: 'rm -rf "${server}/{{ns}}"'
`,
    'server.mjs': SERVER,
    'seed.mjs': `import { DatabaseSync } from 'node:sqlite'; new DatabaseSync(process.argv[2]).exec('CREATE TABLE IF NOT EXISTS t(x)');\n`,
    'bake.sh': `#!/bin/sh\nmkdir -p "${server}/$1"\necho "$2" > "${server}/$1/preset"\necho "bake $1" >> "${server}/bakes.log"\n`,
  });

  it('is never provisioned for an environment, and is the source of copies', async () => {
    const c = ctx();
    const server = tmp('runly-b8-srv-');
    const wt = c.worktree(stack(server));
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    expect(Object.keys(up.json.datastores)).toEqual(['main']);
    expect(Object.keys(c.journal().getEnv(up.json.envId)!.datastoreNs)).toEqual(['main']);
    expect(lines(join(server, 'bakes.log'))).toEqual([]);
    const env = await c.cli(['ctx', '--env'], wt);
    expect(env.stdout).toContain('RUNLY_DATASTORE_MAIN_URL');
    expect(env.stdout).not.toContain('INTEGRATION');

    // Copies bake its template once and reuse it.
    const a = await c.cli(['db', 'new', 'integration', '--json'], wt);
    const b = await c.cli(['db', 'new', 'integration', '--json'], wt);
    expect(a.code, a.stderr + a.stdout).toBe(0);
    expect(b.code, b.stderr + b.stdout).toBe(0);
    expect(a.json.preset).toBe('legacy');
    expect(readFileSync(join(server, a.json.ns, 'preset'), 'utf8').trim()).toBe('legacy');
    expect(lines(join(server, 'bakes.log'))).toHaveLength(1);

    // An environment cannot be asked to reload it.
    const preset = await c.cli(['up', '--preset', 'integration=legacy', '--json'], wt);
    expect(preset.code).toBe(1);
    expect(preset.json.error.message).toMatch(/copies_only/);
  }, 90_000);

  it('a service that templates it is refused at load', async () => {
    const c = ctx();
    const server = tmp('runly-b8b-srv-');
    const wt = c.worktree(stack(server, ', IT: "{{datastores.integration.url}}"'));
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code).toBe(1);
    expect(up.json.error.message).toMatch(/service 'web' templates datastore 'integration', which is copies_only/);
  }, 60_000);

  it('an environment made before the datastore became copies_only gives its namespace back', async () => {
    const c = ctx();
    const server = tmp('runly-b8c-srv-');
    const files = stack(server);
    const wt = c.worktree({ ...files, 'runly.yml': files['runly.yml']!.replace('    copies_only: true\n', '') });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const ns = up.json.datastores.integration.ns as string;
    expect(existsSync(join(server, ns))).toBe(true);
    writeFileSync(join(wt, 'runly.yml'), files['runly.yml']!);
    const again = await c.cli(['up', '--json'], wt);
    expect(again.code, again.stderr + again.stdout).toBe(0);
    expect(existsSync(join(server, ns))).toBe(false);
    expect(Object.keys(c.journal().getEnv(again.json.envId)!.datastoreNs)).toEqual(['main']);
  }, 90_000);
});

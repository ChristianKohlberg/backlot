/**
 * Decision 0032: environments run in the caller's worktree — one per worktree —
 * and `runly warm` runs its due upkeep and its builds with no lease and no
 * services.
 * Driven through the real CLI against an isolated state dir.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
}

function makeContext(extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-inplace-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '600000', ...extraEnv };
  const cli = (args: string[], cwd: string): Promise<CliResult> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* human output */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr), json });
      });
    });
  const cleanup = () => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')));
    } catch {
      /* gone */
    }
    rmSync(stateDir, { recursive: true, force: true });
  };
  return { stateDir, env, cli, cleanup };
}

function worktree(stackYaml: string, files: Record<string, string> = {}): string {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), 'runly-inplace-wt-')));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(wt, name), content);
  writeFileSync(join(wt, 'runly.yml'), stackYaml);
  execFileSync('git', ['init', '-q'], { cwd: wt });
  return wt;
}

const PID_SERVER = `import { createServer } from 'node:http';
createServer((q, s) => s.end(String(process.pid))).listen(Number(process.env.PORT), '127.0.0.1');
`;

const SERVER = `import { createServer } from 'node:http';
createServer((q, s) => s.end(process.cwd())).listen(Number(process.env.PORT), '127.0.0.1');
console.log('listening');
`;

describe('services run in the worktree; the environment keeps only private state', () => {
  const ctx = makeContext();
  const wt = worktree(
    `name: inplace
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
`,
    { 'server.mjs': SERVER, 'keep.txt': 'mine' },
  );
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('serves from the worktree, makes no copy, and teardown leaves the worktree alone', async () => {
    const up = await ctx.cli(['up', '--json'], wt);
    expect(up.exitCode, up.stdout + up.stderr).toBe(0);
    const envId = up.json!.envId as string;
    expect(await (await fetch((up.json!.urls as Record<string, string>).web!)).text()).toBe(wt);
    const exec = await ctx.cli(['exec', 'pwd'], wt);
    expect(exec.stdout.trim()).toBe(wt);
    expect(existsSync(join(ctx.stateDir, 'envs', envId, 'tree'))).toBe(false);
    const status = (await ctx.cli(['status', '--json'], wt)).json!;
    expect((status.envs as Array<{ worktree: string }>)[0]!.worktree).toBe(wt);

    // Someone else's process sitting in the worktree — the agent's own build,
    // a shell. cwd there is no proof of ownership, so teardown must not touch it.
    const bystander = spawn(process.execPath, ['--eval', 'setInterval(()=>{},1000)'], {
      cwd: wt, detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '' },
    });
    bystander.unref();
    const recycled = await ctx.cli(['pool', 'recycle', envId, '--force', '--json'], wt);
    expect(recycled.exitCode, recycled.stdout + recycled.stderr).toBe(0);
    let bystanderAlive = true;
    try {
      process.kill(bystander.pid!, 0);
    } catch {
      bystanderAlive = false;
    }
    try {
      process.kill(bystander.pid!, 'SIGKILL');
    } catch {
      /* already gone */
    }
    expect(bystanderAlive, 'teardown reaped an untagged process by its worktree cwd').toBe(true);
    expect(existsSync(join(ctx.stateDir, 'envs', envId))).toBe(false);
    expect(readFileSync(join(wt, 'keep.txt'), 'utf8')).toBe('mine');
    expect(existsSync(join(wt, 'runly.yml'))).toBe(true);
  }, 60_000);

  it('recovery reclaims the source copy an older daemon left in the environment', async () => {
    const up = await ctx.cli(['up', '--json'], wt);
    const envId = up.json!.envId as string;
    await ctx.cli(['release', '--json'], wt);
    // Fabricate the projection-era leftover, then quiesce so nothing runs.
    const legacy = join(ctx.stateDir, 'envs', envId, 'tree');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'server.mjs'), SERVER);
    await ctx.cli(['daemon', 'stop', '--json'], wt); // recovery on the next verb reaps and cleans
    const again = await ctx.cli(['up', '--json'], wt);
    expect(again.exitCode, again.stdout + again.stderr).toBe(0);
    expect(existsSync(legacy)).toBe(false);
  }, 60_000);
});

describe('runly warm', () => {
  const ctx = makeContext();
  afterAll(() => ctx.cleanup());

  it('runs upkeep and builds with no lease; the next bind finds the upkeep done and builds again', async () => {
    const wt = worktree(
      `name: warmup
services:
  web:
    build: "echo built >> build.log"
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
  templated:
    build: "echo {{ports.web}} > templated.log"
    run: "echo ready; sleep 300"
    ready: { log: ready, timeout: 20 }
upkeep:
  - { when: dep.lock, run: "echo installed >> upkeep.log" }
  - { when: seed.sql, run: "@rebake-template main" }
`,
      { 'server.mjs': SERVER, 'dep.lock': 'v1', 'seed.sql': 'x', '.gitignore': 'build.log\nupkeep.log\ntemplated.log\n' },
    );
    try {
      const warm = await ctx.cli(['warm', '--json'], wt);
      expect(warm.exitCode, warm.stdout + warm.stderr).toBe(0);
      const w = warm.json!;
      expect(w.ok).toBe(true);
      const steps = w.steps as Array<{ kind: string; status: string; durationMs: number; service?: string; reason?: string }>;
      expect(steps.map((s) => `${s.kind}:${s.service ?? ''}:${s.status}`)).toEqual([
        'upkeep::ran', 'upkeep::skipped', 'build:web:ran', 'build:templated:skipped',
      ]);
      expect(steps.every((s) => typeof s.durationMs === 'number')).toBe(true);
      expect(steps[3]!.reason).toMatch(/environment/);
      // No lease, no environment, no services.
      expect((await ctx.cli(['status', '--json'], wt)).json!.envs).toEqual([]);
      expect(readFileSync(join(wt, 'build.log'), 'utf8')).toBe('built\n');

      // The upkeep rule is fresh now; builds are never recorded (decision
      // 0032: the build tool decides what is current), so they run again.
      const again = (await ctx.cli(['warm', '--json'], wt)).json!;
      expect((again.steps as Array<{ status: string }>).map((s) => s.status)).toEqual(['fresh', 'skipped', 'ran', 'skipped']);
      expect(readFileSync(join(wt, 'build.log'), 'utf8')).toBe('built\nbuilt\n');

      // The next bind trusts the upkeep warm did, and builds what it starts.
      const up = await ctx.cli(['up', '--json'], wt);
      expect(up.exitCode, up.stdout + up.stderr).toBe(0);
      const diag = up.json!.bindDiagnostics as { upkeep: { ran: number }; builds: Array<{ service: string }> };
      expect(diag.upkeep.ran).toBe(1); // only the @rebake built-in, which acts on the environment's data
      expect(diag.builds.map((b) => b.service).sort()).toEqual(['templated', 'web']);
      expect(readFileSync(join(wt, 'upkeep.log'), 'utf8')).toBe('installed\n');
      expect(readFileSync(join(wt, 'build.log'), 'utf8')).toBe('built\nbuilt\nbuilt\n');
      await ctx.cli(['release', '--json'], wt);

      // Human output names each step and its time, never the command.
      writeFileSync(join(wt, 'dep.lock'), 'v2');
      const human = await ctx.cli(['warm'], wt);
      expect(human.exitCode, human.stderr).toBe(0);
      expect(human.stdout).toMatch(/upkeep rule 1 \(dep\.lock\): ran in \d+\.\ds/);
      expect(human.stdout).toMatch(/build 'web': ran in \d+\.\ds/);
      expect(human.stdout).not.toContain('echo');
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  }, 60_000);

  it('a failing step fails the warm-up with a work-error verdict (exit 1)', async () => {
    const wt = worktree(`name: warmfail\nservices:\n  web: { run: "true", build: "echo nope; exit 4" }\n`);
    try {
      const res = await ctx.cli(['warm', '--json'], wt);
      expect(res.exitCode).toBe(1);
      expect(res.json!.ok).toBe(false);
      expect((res.json!.failure as { class: string; message: string }).message).toMatch(/build failed for service 'web'/);
      expect((res.json!.steps as Array<{ status: string }>).at(-1)!.status).toBe('failed');
      // Nothing is recorded for a build: the next warm simply runs it again.
      const again = await ctx.cli(['warm', '--json'], wt);
      expect((again.json!.steps as Array<{ status: string }>).at(-1)!.status).toBe('failed');
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  }, 60_000);

  it('waits for an operation in flight on one of the worktree\'s environments', async () => {
    const wt = worktree(
      `name: warmlock
services:
  worker:
    build: "echo build-start >> order.log; sleep 2; echo build-end >> order.log"
    run: "echo ready; sleep 300"
    ready: { log: ready, timeout: 20 }
`,
      { 'src.txt': 'v1', '.gitignore': 'order.log\n' },
    );
    try {
      const up = spawn(process.execPath, [CLI, 'up', '--ttl', '5', '--json'], { cwd: wt, env: ctx.env, stdio: 'ignore' });
      const done = new Promise((r) => up.once('exit', r));
      const order = () => (existsSync(join(wt, 'order.log')) ? readFileSync(join(wt, 'order.log'), 'utf8').trim().split('\n') : []);
      for (let i = 0; i < 100 && !order().includes('build-start'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(order()).toEqual(['build-start']);
      const warm = await ctx.cli(['warm', '--json'], wt);
      expect(warm.exitCode, warm.stdout + warm.stderr).toBe(0);
      await done;
      // Without the environment lock warm's build would interleave with the bind's.
      expect(order()).toEqual(['build-start', 'build-end', 'build-start', 'build-end']);
      await ctx.cli(['release', '--json'], wt);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('one environment per worktree', () => {
  const ctx = makeContext({ BACKLOT_SWEEP_MS: '300', BACKLOT_WAIT_MS: '30000' });
  afterAll(() => ctx.cleanup());

  it('a second holder never gets a second environment: it fails fast, naming who holds it', async () => {
    const wt = worktree(
      `name: oneenv
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
`,
      { 'server.mjs': SERVER },
    );
    try {
      const up = await ctx.cli(['up', '--ttl', '30', '--json'], wt);
      expect(up.exitCode, up.stdout + up.stderr).toBe(0);
      const started = Date.now();
      const other = await ctx.cli(['up', '--holder', 'someone-else', '--json'], wt);
      expect(other.exitCode).toBe(2);
      expect((other.json!.error as { message: string }).message).toMatch(/exactly one environment/);
      expect(Date.now() - started).toBeLessThan(15_000);
      const status = (await ctx.cli(['status', '--json'], wt)).json!;
      expect((status.envs as Array<{ id: string }>).map((e) => e.id)).toEqual([up.json!.envId]);
      await ctx.cli(['release', '--json'], wt);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  }, 60_000);

  it('every up runs the builds and restarts only the services whose build output changed', async () => {
    // api: output declared, build rewrites it only when its source changed.
    // tool: a build with no outputs declared, so it is restarted after every build.
    // idle: no build at all, so it is never restarted by an up.
    const wt = worktree(
      `name: outputs
services:
  api:
    build: "mkdir -p out && (cmp -s api-src.txt out/api.txt || cp api-src.txt out/api.txt); echo api >> build.log"
    outputs: [out/**]
    run: node pid.mjs
    port: api
    env: { PORT: "{{ports.api}}" }
    ready: { http: /, timeout: 20 }
  tool:
    build: "echo tool >> build.log"
    run: "echo ready; sleep 300"
    ready: { log: ready, timeout: 20 }
  idle:
    run: "echo ready; sleep 300"
    ready: { log: ready, timeout: 20 }
`,
      { 'pid.mjs': PID_SERVER, 'api-src.txt': 'v1', '.gitignore': 'build.log\nout/\n' },
    );
    type Diag = { reuse: string; restarted: string[]; builds: Array<{ service: string; restart: boolean; reason: string }> };
    const reason = (d: Diag, svc: string) => d.builds.find((b) => b.service === svc)?.reason;
    let envId = '';
    const pids = async (): Promise<Record<string, number>> => {
      const { Journal } = await import('../src/core/journal.js');
      const journal = new Journal(join(ctx.stateDir, 'journal.db'));
      return { ...journal.getEnv(envId)!.servicePids };
    };
    try {
      const builds = () => readFileSync(join(wt, 'build.log'), 'utf8').trim().split('\n');
      const first = await ctx.cli(['up', '--json'], wt);
      expect(first.exitCode, first.stdout + first.stderr).toBe(0);
      expect((first.json!.bindDiagnostics as Diag).reuse).toBe('rebound');
      expect(builds().sort()).toEqual(['api', 'tool']);
      envId = first.json!.envId as string;
      const apiUrl = (first.json!.urls as Record<string, string>).api!;
      const apiPid1 = await fetch(apiUrl).then((r) => r.text());
      const before = await pids();

      // Nothing changed: both builds still run (runly keeps no build cache), the
      // api's output is untouched so it keeps running; tool declares no outputs.
      const second = await ctx.cli(['up', '--json'], wt);
      expect(second.exitCode, second.stdout + second.stderr).toBe(0);
      const d2 = second.json!.bindDiagnostics as Diag;
      expect(d2.reuse).toBe('restarted');
      expect(d2.restarted).toEqual(['tool']);
      expect(reason(d2, 'api')).toBe('outputs-unchanged');
      expect(reason(d2, 'tool')).toBe('no-outputs-declared');
      expect(d2.builds.map((b) => b.service)).not.toContain('idle');
      expect(builds()).toHaveLength(4);
      expect(await fetch(apiUrl).then((r) => r.text())).toBe(apiPid1);
      const after2 = await pids();
      expect(after2.idle).toEqual(before.idle);
      expect(after2.tool).not.toEqual(before.tool);

      // The api's source changed: its build rewrites the output, so it restarts.
      writeFileSync(join(wt, 'api-src.txt'), 'version two');
      const third = await ctx.cli(['up', '--json'], wt);
      expect(third.exitCode, third.stdout + third.stderr).toBe(0);
      const d3 = third.json!.bindDiagnostics as Diag;
      expect(d3.restarted.sort()).toEqual(['api', 'tool']);
      expect(reason(d3, 'api')).toBe('outputs-changed');
      expect((third.json!.urls as Record<string, string>).api).toBe(apiUrl); // same port
      expect(await fetch(apiUrl).then((r) => r.text())).not.toBe(apiPid1);
      expect((await pids()).idle).toEqual(before.idle);
      await ctx.cli(['release', '--json'], wt);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  }, 90_000);

  it('an up whose every build left its outputs alone reuses the running services', async () => {
    const wt = worktree(
      `name: allquiet
services:
  web:
    build: "mkdir -p dist && test -f dist/app.js || echo built > dist/app.js"
    outputs: [dist]
    run: node pid.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
`,
      { 'pid.mjs': PID_SERVER, '.gitignore': 'dist/\n' },
    );
    try {
      const first = await ctx.cli(['up', '--json'], wt);
      expect(first.exitCode, first.stdout + first.stderr).toBe(0);
      const url = (first.json!.urls as Record<string, string>).web!;
      const pid = await fetch(url).then((r) => r.text());
      const again = await ctx.cli(['up', '--json'], wt);
      expect(again.exitCode, again.stdout + again.stderr).toBe(0);
      const d = again.json!.bindDiagnostics as { reuse: string; restarted: string[]; builds: Array<{ reason: string }> };
      expect(d.reuse).toBe('reused');
      expect(d.restarted).toEqual([]);
      expect(d.builds.map((b) => b.reason)).toEqual(['outputs-unchanged']);
      expect(await fetch(url).then((r) => r.text())).toBe(pid);
      // A new file in a declared output directory is a change.
      writeFileSync(join(wt, 'dist', 'extra.js'), 'x');
      const third = await ctx.cli(['up', '--json'], wt);
      // The snapshot is taken around the build, so a change made between two
      // ups is already in the "before" picture and does not restart.
      expect((third.json!.bindDiagnostics as { reuse: string }).reuse).toBe('reused');
      await ctx.cli(['release', '--json'], wt);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  }, 60_000);

  it('a second environment an older runly left for the same worktree is drained by the sweep', async () => {
    const wt = worktree(`name: surplus\nservices:\n  idle: { run: "echo ready; sleep 300", ready: { log: ready, timeout: 20 } }\n`);
    try {
      const up = await ctx.cli(['up', '--json'], wt);
      expect(up.exitCode, up.stdout + up.stderr).toBe(0);
      await ctx.cli(['release', '--json'], wt);
      // Plant the shape an older journal can hold: a second, unleased row for
      // the same stack.
      const { Journal } = await import('../src/core/journal.js');
      const journal = new Journal(join(ctx.stateDir, 'journal.db'));
      const row = journal.getEnv(up.json!.envId as string)!;
      const twinId = `${row.stack}-e99`;
      journal.saveEnv({ ...row, id: twinId, state: 'warm', servicePids: {}, ports: {}, root: join(ctx.stateDir, 'envs', twinId), lastUsedAt: row.lastUsedAt - 60_000 });
      expect(journal.envsForStack(row.stack)).toHaveLength(2);
      let left = 2;
      for (let i = 0; i < 60 && left > 1; i++) {
        await new Promise((r) => setTimeout(r, 250));
        left = journal.envsForStack(row.stack).length;
      }
      expect(journal.envsForStack(row.stack).map((e) => e.id)).toEqual([row.id]);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  }, 60_000);
});

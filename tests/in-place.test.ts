/**
 * Decision 0032: environments run in the caller's worktree, and `runly warm`
 * brings that worktree's caches up to date with no lease and no services.
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
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '600000', BACKLOT_POOL_MAX: '3', ...extraEnv };
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

  it('runs upkeep and builds with no lease, then the next bind finds them done', async () => {
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

      // Idempotent: nothing moved, nothing runs.
      const again = (await ctx.cli(['warm', '--json'], wt)).json!;
      expect((again.steps as Array<{ status: string }>).map((s) => s.status)).toEqual(['fresh', 'skipped', 'fresh', 'skipped']);

      // The point of it: the next bind trusts what warm did.
      const up = await ctx.cli(['up', '--json'], wt);
      expect(up.exitCode, up.stdout + up.stderr).toBe(0);
      const diag = up.json!.bindDiagnostics as { upkeep: { ran: number }; builds: Array<{ service: string; cache: string }> };
      expect(diag.builds.find((b) => b.service === 'web')!.cache).toBe('hit');
      expect(diag.builds.find((b) => b.service === 'templated')!.cache).toBe('miss');
      expect(readFileSync(join(wt, 'upkeep.log'), 'utf8')).toBe('installed\n');
      expect(readFileSync(join(wt, 'build.log'), 'utf8')).toBe('built\n');
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
      // A failed build leaves no stamp: the next warm tries again.
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
    build: "echo build >> order.log"
    run: "echo ready; sleep 300"
    ready: { log: ready, timeout: 20 }
checks:
  slow: { run: "echo check-start >> order.log; sleep 2; echo check-end >> order.log" }
`,
      { 'src.txt': 'v1', '.gitignore': 'order.log\n' },
    );
    try {
      const run = spawn(process.execPath, [CLI, 'run', 'slow', '--json'], { cwd: wt, env: ctx.env, stdio: 'ignore' });
      const done = new Promise((r) => run.once('exit', r));
      const order = () => (existsSync(join(wt, 'order.log')) ? readFileSync(join(wt, 'order.log'), 'utf8').trim().split('\n') : []);
      for (let i = 0; i < 100 && !order().includes('check-start'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(order()).toEqual(['build', 'check-start']);
      writeFileSync(join(wt, 'src.txt'), 'v2'); // the build is now stale
      const warm = await ctx.cli(['warm', '--json'], wt);
      expect(warm.exitCode, warm.stdout + warm.stderr).toBe(0);
      await done;
      // Without the environment lock the rebuild would land mid-check.
      expect(order()).toEqual(['build', 'check-start', 'check-end', 'build']);
    } finally {
      rmSync(wt, { recursive: true, force: true });
    }
  }, 60_000);
});

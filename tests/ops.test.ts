/**
 * The operational batch: check timeouts (process-group kill), bind --ref,
 * job ls, pool-policy precedence, and the retention sweep.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, utimesSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

function makeContext() {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-ops-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };
  const cli = (args: string[], cwd: string): Promise<{ exitCode: number; json?: Record<string, unknown> }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json, stdout: String(stdout), stderr: String(stderr) });
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
  return { stateDir, cli, cleanup };
}

const SERVE = `import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
createServer((q, s) => s.end(readFileSync('./message.txt', 'utf8'))).listen(Number(process.env.PORT));
`;

const STACK = `name: opsy
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
checks:
  hang: { run: "sh -c 'sleep 300 & echo $! > hung-child.pid; wait'", timeout: 2 }
  quick: { run: "true" }
`;

describe('check timeouts and job ls', () => {
  const ctx = makeContext();
  const wt = mkdtempSync(join(tmpdir(), 'backlot-ops-wt-'));
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('a hung check is group-killed at its timeout with an explanatory verdict', async () => {
    writeFileSync(join(wt, 'server.mjs'), SERVE);
    writeFileSync(join(wt, 'message.txt'), 'v1');
    writeFileSync(join(wt, 'stack.yaml'), STACK);
    execFileSync('git', ['init', '-q'], { cwd: wt });

    const start = Date.now();
    const res = await ctx.cli(['run', 'hang', '--json'], wt);
    expect(Date.now() - start).toBeLessThan(30_000); // 2s timeout + bind, nowhere near 300s
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(1);
    const v = res.json!;
    expect(v.ok).toBe(false);
    expect((v.failure as { message: string }).message).toContain('timed out after 2s');

    // The verdict text alone proved nothing about the PROCESS TABLE: a
    // regression from group-kill back to killing only the sh wrapper would
    // still produce this message while leaking the real child. The fixture
    // forks deliberately and records the grandchild's pid, so this asserts the
    // thing the test is named for.
    const envs = (await ctx.cli(['pool', 'ls', '--json'], wt)).json!.envs as Array<{ id: string }>;
    let childPid: number | undefined;
    for (const e of envs) {
      const f = join(ctx.stateDir, 'envs', e.id, 'tree', 'hung-child.pid');
      if (existsSync(f)) childPid = Number(readFileSync(f, 'utf8').trim());
    }
    expect(childPid, 'the hang fixture should have recorded its child pid').toBeGreaterThan(0);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Give the group kill a moment to land, then require the grandchild gone.
    for (let i = 0; i < 40 && alive(childPid!); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(childPid!), `grandchild ${childPid} outlived the group kill`).toBe(false);
  }, 60_000);

  it('job ls lists detached runs newest-first with their outcome', async () => {
    const submit = await ctx.cli(['run', 'quick', '--detach', '--json'], wt);
    const jobId = submit.json!.jobId as string;
    let done = false;
    for (let i = 0; i < 60 && !done; i++) {
      const j = (await ctx.cli(['job', jobId, '--json'], wt)).json!;
      done = j.state === 'done';
      if (!done) await new Promise((r) => setTimeout(r, 300));
    }
    const ls = await ctx.cli(['job', 'ls', '--json'], wt);
    const jobs = ls.json!.jobs as Array<{ id: string; state: string; ok: boolean | null }>;
    expect(jobs[0]!.id).toBe(jobId);
    expect(jobs[0]!.ok).toBe(true);
  }, 60_000);

  it('bind --ref serves the committed state; sync returns to the worktree state', async () => {
    execFileSync('git', ['add', '-A'], { cwd: wt });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'v1'], { cwd: wt });
    writeFileSync(join(wt, 'message.txt'), 'v2-dirty');

    const bound = await ctx.cli(['bind', '--ref', 'HEAD', '--json'], wt);
    expect(bound.exitCode, `stdout: ${bound.stdout ?? ''}\nstderr: ${bound.stderr ?? ''}`).toBe(0);
    const url = (bound.json!.urls as Record<string, string>).web!;
    expect(await (await fetch(url)).text()).toBe('v1'); // the COMMIT, not the dirty tree

    await ctx.cli(['sync'], wt);
    expect(await (await fetch(url)).text()).toBe('v2-dirty'); // back to worktree state

    const bad = await ctx.cli(['bind', '--ref', 'nope-branch', '--json'], wt);
    expect(bad.exitCode, `stdout: ${bad.stdout ?? ''}\nstderr: ${bad.stderr ?? ''}`).toBe(1); // work-error: not a commit
  }, 60_000);
});

describe('pool policy precedence (unit)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'backlot-pol-'));
  const saved = { state: process.env.BACKLOT_STATE_DIR, pool: process.env.BACKLOT_POOL_MAX };
  afterEach(() => {
    process.env.BACKLOT_STATE_DIR = saved.state;
    if (saved.pool === undefined) delete process.env.BACKLOT_POOL_MAX;
    else process.env.BACKLOT_POOL_MAX = saved.pool;
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('env var > config.json > heuristic', async () => {
    process.env.BACKLOT_STATE_DIR = dir;
    delete process.env.BACKLOT_POOL_MAX;
    const { policy, poolMaxHeuristic } = await import('../src/core/policy.js');

    const h = poolMaxHeuristic();
    expect(h).toBeGreaterThanOrEqual(1);
    expect(h).toBeLessThanOrEqual(8);
    expect(policy().poolMax).toBe(h); // heuristic default

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ poolMax: 5, idleTtlMs: 123 }));
    expect(policy().poolMax).toBe(5); // config file wins over heuristic
    expect(policy().idleTtlMs).toBe(123);

    process.env.BACKLOT_POOL_MAX = '2';
    expect(policy().poolMax).toBe(2); // env var wins over config
  });

  it('leasedIdleTtlMs defaults to 2 x the CONFIGURED idleTtlMs, not a constant', async () => {
    // architecture.md §11: default is `2 x idleTtlMs`. A hardcoded 60min meant
    // a user raising idleTtlMs to 2h had LEASED envs quiesce before ABANDONED
    // ones — a leased environment reclaimed more aggressively than a forgotten
    // one inverts the lease-liveness design.
    process.env.BACKLOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'backlot-pol2-'));
    const savedEnv = { idle: process.env.BACKLOT_IDLE_TTL_MS, leased: process.env.BACKLOT_LEASED_IDLE_TTL_MS };
    try {
      delete process.env.BACKLOT_LEASED_IDLE_TTL_MS;
      const { policy } = await import('../src/core/policy.js');

      process.env.BACKLOT_IDLE_TTL_MS = String(2 * 60 * 60_000); // 2h
      expect(policy().leasedIdleTtlMs).toBe(4 * 60 * 60_000); // 2 x idle, derived

      delete process.env.BACKLOT_IDLE_TTL_MS;
      expect(policy().leasedIdleTtlMs).toBe(60 * 60_000); // 2 x the 30min default

      process.env.BACKLOT_LEASED_IDLE_TTL_MS = '123456';
      expect(policy().leasedIdleTtlMs).toBe(123456); // explicit setting still wins
    } finally {
      for (const [k, v] of [['BACKLOT_IDLE_TTL_MS', savedEnv.idle], ['BACKLOT_LEASED_IDLE_TTL_MS', savedEnv.leased]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('retention sweep (unit)', () => {
  it('prunes old artifacts, truncates fat logs, keeps newest templates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'backlot-ret-'));
    process.env.BACKLOT_STATE_DIR = dir;
    const { pruneArtifacts, truncateLogs, pruneTemplates } = await import('../src/core/retention.js');
    const { policy } = await import('../src/core/policy.js');
    const p = { ...policy(), artifactDays: 1, logCapBytes: 1000, templatesKeep: 2 };

    // Old + fresh artifacts.
    const art = join(dir, 'artifacts', 'env1');
    mkdirSync(join(art, 'old'), { recursive: true });
    mkdirSync(join(art, 'fresh'), { recursive: true });
    const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    utimesSync(join(art, 'old'), past, past);
    expect(pruneArtifacts(p)).toBe(1);

    // A fat log keeps only its tail.
    const logs = join(dir, 'envs', 'env1', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'web.log'), 'x'.repeat(5000));
    expect(truncateLogs(p)).toBe(1);
    expect(statSync(join(logs, 'web.log')).size).toBeLessThan(1000);

    // 4 templates, keep the 2 newest.
    const tpl = join(dir, 'templates', 'stack1');
    mkdirSync(tpl, { recursive: true });
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(tpl, `t${i}.db`), 'db');
      const t = new Date(Date.now() - (4 - i) * 3600 * 1000);
      utimesSync(join(tpl, `t${i}.db`), t, t);
    }
    expect(await pruneTemplates(p)).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('template pruning honors the bake lock', () => {
  it('does not delete a stack template dir while a bake/restore is in flight', async () => {
    // pruneTemplates was the one remaining writer that mutated a stack's
    // template dir OUTSIDE the stack-scoped bake lock — reopening the exact
    // deleted-mid-restore race the lock was introduced to close.
    const dir = mkdtempSync(join(tmpdir(), 'backlot-ret-lock-'));
    process.env.BACKLOT_STATE_DIR = dir;
    const { pruneTemplates } = await import('../src/core/retention.js');
    const { withBakeLock } = await import('../src/drivers/datastores.js');
    const { policy } = await import('../src/core/policy.js');
    const root = join(dir, 'templates');
    mkdirSync(join(root, 'stk'), { recursive: true });
    const tpl = join(root, 'stk', 'main-dev@abc.db');
    writeFileSync(tpl, 'baked');

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const bake = withBakeLock('stk', () => held); // an in-flight bake/restore
    const prune = pruneTemplates({ ...policy(), templatesKeep: 0 }, root);
    await new Promise((r) => setTimeout(r, 400));
    expect(existsSync(tpl), 'template deleted out from under the in-flight bake').toBe(true);
    release();
    await bake;
    expect(await prune).toBe(1); // after the lock frees, pruning proceeds
    expect(existsSync(tpl)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);
});

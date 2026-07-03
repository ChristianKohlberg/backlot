/**
 * The operational batch: check timeouts (process-group kill), bind --ref,
 * job ls, pool-policy precedence, and the retention sweep.
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

function makeContext() {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-ops-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };
  const cli = (args: string[], cwd: string): Promise<{ exitCode: number; json?: Record<string, unknown> }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json });
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
  hang: { run: "sleep 300", timeout: 2 }
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
    expect(res.exitCode).toBe(1);
    const v = res.json!;
    expect(v.ok).toBe(false);
    expect((v.failure as { message: string }).message).toContain('timed out after 2s');
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
    expect(bound.exitCode).toBe(0);
    const url = (bound.json!.urls as Record<string, string>).web!;
    expect(await (await fetch(url)).text()).toBe('v1'); // the COMMIT, not the dirty tree

    await ctx.cli(['sync'], wt);
    expect(await (await fetch(url)).text()).toBe('v2-dirty'); // back to worktree state

    const bad = await ctx.cli(['bind', '--ref', 'nope-branch', '--json'], wt);
    expect(bad.exitCode).toBe(1); // work-error: not a commit
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
    expect(pruneTemplates(p)).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

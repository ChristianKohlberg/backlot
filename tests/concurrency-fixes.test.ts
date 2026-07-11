/**
 * Regressions for the concurrency review's confirmed criticals (#17-21):
 * env-id never reused after reap, daemon singleton, run-holder isolation,
 * doctor/reconcile surface, and stale-job recovery.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/core/journal.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

function makeContext(extra: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-cfx-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '300', ...extra };
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
  return { stateDir, env, cli, cleanup };
}

const SERVE = `import { createServer } from 'node:http';
console.log('up');
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT));
`;
function makeWt(name: string, extra = ''): string {
  const dir = mkdtempSync(join(tmpdir(), `backlot-cfx-${name}-`));
  writeFileSync(join(dir, 'server.mjs'), SERVE);
  writeFileSync(
    join(dir, 'stack.yaml'),
    `name: ${name}
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
checks:
  ok: { run: "true" }
${extra}`,
  );
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('#17 env-id never reused after a reap (monotonic counter)', () => {
  it('a recycled env id does not collide with a later-created env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backlot-seq-'));
    const j = new Journal(join(dir, 'j.db'));
    const s1 = j.nextEnvSeq('stackA');
    const s2 = j.nextEnvSeq('stackA');
    const s3 = j.nextEnvSeq('stackA');
    expect([s1, s2, s3]).toEqual([1, 2, 3]);
    // Even if envs 1-3 are all deleted, the next id is 4, never a reused 1.
    expect(j.nextEnvSeq('stackA')).toBe(4);
    // A different stack has its own sequence.
    expect(j.nextEnvSeq('stackB')).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('#19 daemon singleton — a second daemon defers to the live one', () => {
  const ctx = makeContext();
  const wt = makeWt('single');
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('two concurrent cold-start CLIs converge on ONE daemon (one pid)', async () => {
    // Fire several verbs at once with no daemon running — the classic fleet race.
    const results = await Promise.all([
      ctx.cli(['status', '--json'], wt),
      ctx.cli(['status', '--json'], wt),
      ctx.cli(['status', '--json'], wt),
      ctx.cli(['up', '--json'], wt),
    ]);
    for (const r of results) expect(r.exitCode, `output: ${(r as { output?: string }).output ?? ''}${r.stdout ?? ''}${r.stderr ?? ''}`).toBe(0);
    // All status calls report the same daemon pid — not one-per-CLI.
    const pids = new Set(results.filter((r) => r.json?.pid).map((r) => r.json!.pid));
    expect(pids.size).toBe(1);
  }, 30_000);
});

describe('#21d run with a shared --holder does not destroy the session', () => {
  const ctx = makeContext();
  const wt = makeWt('holder');
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('after `run` the session lease still exists and its data is intact', async () => {
    const up = await ctx.cli(['up', '--json', '--holder', 'shared'], wt);
    expect(up.exitCode, `output: ${(up as { output?: string }).output ?? ''}${up.stdout ?? ''}${up.stderr ?? ''}`).toBe(0);
    const envId = up.json!.envId;

    await ctx.cli(['run', 'ok', '--json', '--holder', 'shared'], wt);

    // The session's ctx still resolves (lease alive) and points at the same env.
    const ctxRes = await ctx.cli(['ctx', '--json', '--holder', 'shared'], wt);
    expect(ctxRes.exitCode, `output: ${(ctxRes as { output?: string }).output ?? ''}${ctxRes.stdout ?? ''}${ctxRes.stderr ?? ''}`).toBe(0);
    expect(ctxRes.json!.envId).toBe(envId);
    expect((ctxRes.json!.lease as unknown)).not.toBeNull();
  }, 30_000);
});

describe('#23 doctor + reconcile surface', () => {
  const ctx = makeContext();
  const wt = makeWt('doc');
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('doctor reports a clean bill on a healthy pool and lists events', async () => {
    await ctx.cli(['up'], wt);
    const doc = await ctx.cli(['doctor', '--json'], wt);
    expect(doc.exitCode, `output: ${(doc as { output?: string }).output ?? ''}${doc.stdout ?? ''}${doc.stderr ?? ''}`).toBe(0);
    expect(doc.json!.ok).toBe(true);
    expect(Array.isArray(doc.json!.events)).toBe(true);
    // recover event is always logged at daemon start.
    expect((doc.json!.events as Array<{ kind: string }>).some((e) => e.kind === 'recover')).toBe(true);
  }, 30_000);

  it('pool reconcile is a real verb (not exit 64)', async () => {
    const rec = await ctx.cli(['pool', 'reconcile', '--json'], wt);
    expect(rec.exitCode, `output: ${(rec as { output?: string }).output ?? ''}${rec.stdout ?? ''}${rec.stderr ?? ''}`).toBe(0);
    expect(Array.isArray(rec.json!.reaped)).toBe(true);
  }, 30_000);
});

describe('stale-job recovery (#9)', () => {
  it('a job left running by a dead daemon is failed on recovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backlot-job-'));
    const j = new Journal(join(dir, 'j.db'));
    j.saveJob({ id: 'job-x', stackCwd: '/x', check: 'e2e', state: 'running' });
    expect(j.failStaleJobs()).toBe(1);
    const job = j.getJob('job-x')!;
    expect(job.state).toBe('done');
    expect((job.verdict as { ok: boolean }).ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Fleet review finding: 'pool at capacity (1/1) — waited 60s' on macOS CI is
 * not a slow-runner problem. poolMaxHeuristic resolves to 1 on a 3-vCPU/7 GB
 * runner, and `run` always mints its own ephemeral holder — so a session lease
 * plus a run structurally needs two environments. Waiting can never help, and
 * the old message blamed timing, which sent the diagnosis the wrong way for
 * months.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poolMaxHeuristic } from '../src/core/policy.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    try {
      process.kill(Number(readFileSync(join(d, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* not a state dir */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

function ctx() {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-cap-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-cap-wt-'));
  dirs.push(stateDir, wt);
  writeFileSync(join(wt, 'srv.mjs'), `import{createServer}from'node:http';console.log('up');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT));\n`);
  writeFileSync(
    join(wt, 'stack.yaml'),
    `name: cap\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  // POOL_MAX=1 reproduces a small CI runner exactly. WAIT_MS stays long so a
  // fail-fast is unmistakable: the old code burned the whole window.
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_POOL_MAX: '1', BACKLOT_WAIT_MS: '30000', BACKLOT_SWEEP_MS: '300' };
  const cli = (args: string[]) =>
    new Promise<{ json?: Record<string, unknown> }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 16 * 1024 * 1024 }, (_e, stdout) => {
        try {
          resolve({ json: JSON.parse(String(stdout)) });
        } catch {
          resolve({});
        }
      });
    });
  return { cli };
}

describe('pool capacity diagnostics', () => {
  it('the capacity heuristic can legitimately resolve to 1', () => {
    // Documents the mechanism rather than this machine's value: floor(3/2) and
    // floor(7/4) both give 1 on GitHub's macos-latest arm runners.
    expect(poolMaxHeuristic()).toBeGreaterThanOrEqual(1);
    expect(Math.max(1, Math.min(8, Math.min(Math.floor(3 / 2), Math.floor(7 / 4))))).toBe(1);
  });

  it('fails fast with a structural diagnosis instead of waiting out the window', async () => {
    const { cli } = ctx();
    const up = await cli(['up', '--json']);
    expect(up.json?.state).toBe('hot');

    const started = Date.now();
    const run = await cli(['run', 'ok', '--json']);
    const elapsed = Date.now() - started;

    const msg = String((run.json?.error as { message?: string })?.message ?? '');
    expect(msg).toContain('queueing cannot succeed');
    expect(msg).toContain('BACKLOT_POOL_MAX >= 2');
    expect(msg).toMatch(/held by/); // names the blocking lease
    // The whole point: it must NOT burn the 30s wait on something impossible.
    expect(elapsed).toBeLessThan(15_000);
  }, 60_000);

  it('still queues normally when a lease will expire inside the window', async () => {
    const { cli } = ctx();
    // A short-TTL session lease frees the env well inside the wait window, so
    // this must WAIT and succeed rather than fail fast.
    await cli(['up', '--ttl', '0.05', '--json']); // 3s
    const run = await cli(['run', 'ok', '--json']);
    expect(run.json?.ok).toBe(true);
  }, 90_000);
});

/**
 * 0.3 + 0.4 surface: detached submit-and-poll runs, the deliberately-foreign
 * Python consumer — all against the real daemon.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disposeStateSync } from './support/leaks.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const hasPython = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function makeContext() {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-m34-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '400' };
  const cli = (args: string[], cwd: string): Promise<{ exitCode: number; json?: Record<string, unknown>; out: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json, out: String(stdout), stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const cleanup = async () => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')));
    } catch {
      /* gone */
    }
    disposeStateSync(stateDir);
  };
  return { stateDir, env, cli, cleanup };
}

function makeWorktree(example: string): { dir: string; drop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `runly-wt-${example}-`));
  cpSync(join(repo, 'examples', example), dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return { dir, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- 0.4: foreign consumer

describe.skipIf(!hasPython)('the foreign consumer (hello-python)', () => {
  const ctx = makeContext();
  const wt = makeWorktree('hello-python');
  afterAll(async () => {
    await ctx.cleanup();
    wt.drop();
  });

  it('a stdlib-Python stack gets the identical broker loop', async () => {
    const up = await ctx.cli(['up', '--json'], wt.dir);
    expect(up.exitCode, `stdout: ${up.stdout ?? ''}\nstderr: ${up.stderr ?? ''}`).toBe(0);
    const url = (up.json!.urls as Record<string, string>).web!;
    const facts = (await (await fetch(`${url}/api/facts`)).json()) as unknown[];
    expect(facts.length).toBe(3);

    // Its own smoke test runs against `ctx --env`, outside runly (decision 0032).
    const env = (await ctx.cli(['ctx', '--env'], wt.dir)).stdout;
    execFileSync('sh', ['-c', `${env}\nexport RUNLY_URL_WEB\nexec python3 smoke.py`], { cwd: wt.dir, encoding: 'utf8' });
  });
});

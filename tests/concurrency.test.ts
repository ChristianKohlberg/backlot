/**
 * Per-environment locking: two consumers bind CONCURRENTLY (the old global
 * queue would serialize them), while one environment never runs two
 * operations at once (implicitly guaranteed by every other suite).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const stateDir = mkdtempSync(join(tmpdir(), 'backlot-conc-'));
const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };

function makeSlowWorktree(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `backlot-conc-${name}-`));
  // A service that takes ~1.5s to become ready — long enough that two
  // serialized binds (>3s) are clearly distinguishable from two parallel ones.
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { createServer } from 'node:http';
await new Promise((r) => setTimeout(r, 1500));
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), () => console.log('slow-ready'));
`,
  );
  writeFileSync(
    join(dir, 'stack.yaml'),
    `name: slow-${name}
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 30 }
`,
  );
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

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

const wtA = makeSlowWorktree('a');
const wtB = makeSlowWorktree('b');

afterAll(async () => {
  try {
    process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')));
  } catch {
    /* gone */
  }
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(wtA, { recursive: true, force: true });
  rmSync(wtB, { recursive: true, force: true });
});

describe('per-environment concurrency', () => {
  it('two stacks bind in parallel, not serialized', async () => {
    await cli(['status'], wtA); // daemon warm-up outside the measurement
    // Overlap proof (load-independent, unlike a wall-clock ceiling): each up
    // needs >=1.5s of in-daemon ready-wait; if the two in-flight intervals
    // overlap, the old global serialization is gone.
    const timed = async (cwd: string) => {
      const start = Date.now();
      const res = await cli(['up', '--json'], cwd);
      return { ...res, start, end: Date.now() };
    };
    const [a, b] = await Promise.all([timed(wtA), timed(wtB)]);
    expect(a.exitCode, `output: ${(a as { output?: string }).output ?? ''}${a.stdout ?? ''}${a.stderr ?? ''}`).toBe(0);
    expect(b.exitCode, `output: ${(b as { output?: string }).output ?? ''}${b.stdout ?? ''}${b.stderr ?? ''}`).toBe(0);
    const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
    expect(overlap).toBeGreaterThan(1000); // serialized binds cannot overlap >= the ready-wait
    expect((a.json!.urls as Record<string, string>).web).not.toBe((b.json!.urls as Record<string, string>).web);
  }, 30_000);
});

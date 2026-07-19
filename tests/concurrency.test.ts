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
  // It records its own boot window (process start -> listening) to an absolute
  // path in THIS dir, so the test can see when the daemon actually ran the
  // bind's expensive part — regardless of where the synced tree lives.
  const windowFile = join(dir, 'boot-window.json');
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
const start = Date.now();
await new Promise((r) => setTimeout(r, 1500));
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), () => {
  writeFileSync(${JSON.stringify(windowFile)}, JSON.stringify({ start, end: Date.now() }));
  console.log('slow-ready');
});
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
    const started = Date.now();
    const [a, b] = await Promise.all([cli(['up', '--json'], wtA), cli(['up', '--json'], wtB)]);
    const totalMs = Date.now() - started;
    expect(a.exitCode, `stdout: ${a.stdout ?? ''}\nstderr: ${a.stderr ?? ''}`).toBe(0);
    expect(b.exitCode, `stdout: ${b.stdout ?? ''}\nstderr: ${b.stderr ?? ''}`).toBe(0);
    // Overlap of the SERVICE boot windows, not of the CLI processes. CLI-level
    // overlap is vacuous (Promise.all launches both together, so their
    // wall-clock windows overlap even when the daemon queues one internally),
    // and a total-elapsed ceiling (< 2800ms here, once) measures the machine:
    // under suite load two genuinely parallel binds blew it. The daemon spawns
    // a stack's service INSIDE its bind, so if binds serialize, B's service
    // process cannot start until A's bind — including A's >=1.5s ready-wait —
    // has finished, and the two windows below cannot overlap. Each window is
    // >=1.5s long by construction, so overlap is the load-independent proof
    // that the expensive part of both binds ran concurrently.
    const win = (dir: string) => JSON.parse(readFileSync(join(dir, 'boot-window.json'), 'utf8')) as { start: number; end: number };
    const [wa, wb] = [win(wtA), win(wtB)];
    const detail = `a: ${wa.start}..${wa.end}, b: ${wb.start}..${wb.end}`;
    expect(wa.start, `service boot windows do not overlap — the binds were serialized (${detail})`).toBeLessThan(wb.end);
    expect(wb.start, `service boot windows do not overlap — the binds were serialized (${detail})`).toBeLessThan(wa.end);
    // Generous sanity ceiling only: catches a wedged daemon, not a slow machine.
    expect(totalMs, `two 1.5s binds took ${totalMs}ms — something is wedged`).toBeLessThan(20_000);
    expect((a.json!.urls as Record<string, string>).web).not.toBe((b.json!.urls as Record<string, string>).web);
  }, 30_000);
});

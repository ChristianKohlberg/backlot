/**
 * The daemon's event loop must survive a large bind (BACKLOG P2, decision
 * 0020's one open language-attributable item): syncIntoEnv's synchronous
 * hashing/copying blocked the loop, so every concurrent verb — even a
 * read-only `status` — stalled behind the slowest bind in flight.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    try {
      process.kill(Number(readFileSync(join(d, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* none */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe('a large bind does not block the daemon', () => {
  it('status answers promptly while a many-file sync is in flight', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-loop-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-loop-wt-'));
    dirs.push(stateDir, wt);
    writeFileSync(
      join(wt, 'backlot.yml'),
      `name: bigtree\nservices:\n  idle: { run: "echo ready; sleep 300", ready: { log: "ready", timeout: 60 } }\n`,
    );
    // A tree big enough that enumerate+hash+copy occupies the sync phase for
    // several seconds on ANY machine (fast CI NVMe included): 500 dirs x 80
    // files of ~1KB — 40k files, the syscalls dominate.
    const payload = 'x'.repeat(1024);
    for (let d = 0; d < 500; d++) {
      const dir = join(wt, 'src', `mod-${d}`);
      mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 80; f++) writeFileSync(join(dir, `f${f}.txt`), `${d}/${f}:${payload}`);
    }
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };
    const cli = (args: string[]) =>
      new Promise<{ code: number; stdout: string; elapsedMs: number }>((resolve) => {
        const started = Date.now();
        execFile(process.execPath, [CLI, ...args, '--json'], { cwd: wt, env, maxBuffer: 64 * 1024 * 1024 }, (err, out) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(out), elapsedMs: Date.now() - started }),
        );
      });

    // Warm the daemon so the probe below measures the LOOP, not a cold spawn.
    expect((await cli(['status'])).code).toBe(0);

    const upStart = Date.now();
    const up = cli(['up']);
    await new Promise((r) => setTimeout(r, 700)); // inside the bind's sync phase
    const probe = await cli(['status']);
    const upRes = await up;
    const upMs = Date.now() - upStart;

    expect(upRes.code, upRes.stdout).toBe(0);
    // Guard against a vacuous pass: the bind must still have been running
    // when the probe fired, or the probe measured nothing.
    expect(upMs, `bind finished in ${upMs}ms — tree too small to prove anything`).toBeGreaterThan(3000);
    expect(probe.code).toBe(0);
    // Relative bound: a BLOCKED loop makes the probe wait out most of the
    // remaining sync (red measured 5005ms of a ~7s bind); a free loop answers
    // in a fraction of it even when suite-load disk thrash slows everything.
    expect(
      probe.elapsedMs,
      `status took ${probe.elapsedMs}ms during a ${upMs}ms bind — the loop was blocked`,
    ).toBeLessThan(Math.min(4000, upMs / 2));
  }, 120_000);
});

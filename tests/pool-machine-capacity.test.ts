import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/core/journal.js';
import { disposeStateSync } from './support/leaks.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    disposeStateSync(d);
  }
});

/**
 * One daemon, several stacks, and a machine-wide cap of `total`.
 *
 * The stacks declare the cheapest service the schema allows (it requires one):
 * capacity accounting is about environment rows, so paying for a real dev server
 * in a test about counting would only make it slower. A short idle TTL is what
 * makes a released environment "cold" — the same threshold `status` reports as
 * `heat: 'cold'` — without waiting out the real 30 minutes.
 */
function ctx(opts: { total: number; idleTtlMs?: number; sweepMs?: number; stubbornService?: boolean }) {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-mcap-'));
  dirs.push(stateDir);
  const env = {
    ...process.env,
    BACKLOT_STATE_DIR: stateDir,
    // per-stack cap must never be the binding one here
    BACKLOT_POOL_MAX_TOTAL: String(opts.total),
    BACKLOT_IDLE_TTL_MS: String(opts.idleTtlMs ?? 250),
    // Long, so a fail-fast is unmistakable: the reported bug burned 60s.
    BACKLOT_WAIT_MS: '30000',
    BACKLOT_SWEEP_MS: String(opts.sweepMs ?? 300),
  };
  const stack = (name: string) => {
    const wt = mkdtempSync(join(tmpdir(), `runly-mcap-${name}-`));
    dirs.push(wt);
    writeFileSync(
      join(wt, 'runly.yml'),
      // The cheapest manifest the schema allows (it requires at least one
      // service): a shell that announces readiness and idles. No port, no build,
      // no datastore — none of which capacity accounting counts.
      //
      // `stubbornService` traps SIGTERM and sits there, so a teardown cannot
      // finish until the kill escalates — which is what makes "a quiesce is in
      // flight" a deterministic condition rather than a race.
      opts.stubbornService
        ? `name: ${name}\nservices:\n  idle: { run: "trap 'sleep 30' TERM; echo ready; sleep 300", ready: { log: ready, timeout: 20 } }\n`
        : `name: ${name}\nservices:\n  idle: { run: "echo ready; sleep 300", ready: { log: ready, timeout: 20 } }\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
    return wt;
  };
  const cli = (args: string[], cwd: string) =>
    new Promise<{ code: number; json?: Record<string, unknown>; stdout: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json, stdout: String(stdout) });
      });
    });
  const journal = () => new Journal(join(stateDir, 'journal.db'));
  const events = (): Array<{ kind: string; envId?: string; detail?: string }> => {
    const p = join(stateDir, 'events.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { kind: string; envId?: string; detail?: string });
  };
  const errOf = (r: { json?: Record<string, unknown> }) =>
    String((r.json?.error as { message?: string } | undefined)?.message ?? '');
  return { stateDir, stack, cli, journal, events, errOf };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('capacity preserves worktree environments', () => {
  it.each([false, true])('refuses without deleting data (released=%s), then accepts explicit cleanup', async (released) => {
    const c = ctx({ total: 1 });
    const a = c.stack('retain');
    const b = c.stack('newcomer');
    const up = await c.cli(['up', '--json'], a);
    expect(up.code, up.stdout).toBe(0);
    if (released) await c.cli(['release', '--json'], a);
    await sleep(600);
    const started = Date.now();
    const refused = await c.cli(['up', '--json'], b);
    expect(refused.code).not.toBe(0);
    expect(c.errOf(refused)).toContain('BACKLOT_POOL_MAX_TOTAL');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(c.journal().allEnvs().map(r => r.id)).toEqual([String(up.json?.envId)]);
    expect(c.events().filter(e => e.kind === 'pool-evict')).toEqual([]);
    expect((await c.cli(['destroy', '--json'], a)).code).toBe(0);
    expect((await c.cli(['up', '--json'], b)).code).toBe(0);
  }, 60_000);
});

/**
 * The machine-wide pool cap: eviction, and a refusal that names the right knob
 * (issues #46 and #47).
 *
 * Reported from a 12-core / 31.3 GB host where `poolMax` and `poolMaxTotal` both
 * resolve to 6. Six environments existed across seven worktrees, every one of
 * them `state: warm, heat: cold, lease: null`, idle 2h–15h against a 30-minute
 * idle TTL. A seventh stack with ZERO environments of its own asked for a lease
 * and was refused `pool at capacity (6/6)` — indefinitely, while nothing ran.
 *
 * Two distinct defects sat in that one line:
 *
 * 1. Idle reclamation quiesces HEAT, not the environment. The row survives, and
 *    the row is what counts toward `poolMaxTotal` — so once a host holds as many
 *    worktrees as the heuristic allows, the machine-wide budget is permanently
 *    full. The ceiling measured history rather than load.
 * 2. The refusal printed the per-stack cap in both the ratio and the remedy.
 *    `(6/6)` was not even a count — it was `POOL_MAX` twice — and the advice it
 *    gave (`BACKLOT_POOL_MAX=8`) cannot clear a machine-wide block.
 *
 * The fix is eviction rather than simply not counting cold rows: the caps gate
 * environment CREATION only — rebinding an existing environment is never
 * capacity-checked — so the row count is what bounds worst-case concurrent load,
 * and excluding cold rows would leave nothing to stop N of them going hot at
 * once. Waiting can never clear a machine-wide block either, because releasing a
 * lease leaves the row behind; that is why the old fast-fail guard, which
 * deliberately treated a machine-wide block as "another stack will release",
 * burned the whole window on something provably hopeless.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/core/journal.js';

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
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-mcap-'));
  dirs.push(stateDir);
  const env = {
    ...process.env,
    BACKLOT_STATE_DIR: stateDir,
    BACKLOT_POOL_MAX: '9', // per-stack cap must never be the binding one here
    BACKLOT_POOL_MAX_TOTAL: String(opts.total),
    BACKLOT_IDLE_TTL_MS: String(opts.idleTtlMs ?? 250),
    // Long, so a fail-fast is unmistakable: the reported bug burned 60s.
    BACKLOT_WAIT_MS: '30000',
    BACKLOT_SWEEP_MS: String(opts.sweepMs ?? 300),
  };
  const stack = (name: string) => {
    const wt = mkdtempSync(join(tmpdir(), `backlot-mcap-${name}-`));
    dirs.push(wt);
    writeFileSync(
      join(wt, 'stack.yaml'),
      // The cheapest manifest the schema allows (it requires at least one
      // service): a shell that announces readiness and idles. No port, no build,
      // no datastore — none of which capacity accounting counts.
      //
      // `stubbornService` traps SIGTERM and sits there, so a teardown cannot
      // finish until the kill escalates — which is what makes "a quiesce is in
      // flight" a deterministic condition rather than a race.
      opts.stubbornService
        ? `name: ${name}\nservices:\n  idle: { run: "trap 'sleep 30' TERM; echo ready; sleep 300", ready: { log: ready, timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`
        : `name: ${name}\nservices:\n  idle: { run: "echo ready; sleep 300", ready: { log: ready, timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`,
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

describe('a cold, unleased environment no longer holds a machine-wide slot forever', () => {
  it('is evicted so a stack with zero environments can bind', async () => {
    const c = ctx({ total: 1 });
    const a = c.stack('mcapa');
    const b = c.stack('mcapb');

    const upA = await c.cli(['up', '--json'], a);
    expect(upA.code).toBe(0);
    const envA = String(upA.json?.envId);
    await c.cli(['release', '--json'], a);
    await sleep(400); // past the idle TTL: now cold and unleased, as reported

    // Stack B has NO environments of its own. Before the fix this was
    // `pool at capacity (1/1)` forever, with nothing running anywhere.
    const upB = await c.cli(['up', '--json'], b);
    expect(upB.code, upB.stdout).toBe(0);
    const envB = String(upB.json?.envId);
    expect(envB).not.toBe(envA);

    // The slot was returned for REAL — the row is gone, not merely uncounted.
    // That is what keeps the ceiling meaningful: reuse is never capacity-checked,
    // so an uncounted row could still be rebound hot with nothing to stop it.
    const rows = c.journal().allEnvs();
    expect(rows.map((r) => r.id)).toEqual([envB]);

    // And it is on the record: an eviction deletes another stack's warm tree, so
    // it must never be silent.
    const evictions = c.events().filter((e) => e.kind === 'pool-evict');
    expect(evictions.length).toBe(1);
    expect(evictions[0]!.envId).toBe(envA);
    expect(evictions[0]!.detail).toMatch(/unleased and idle/);
  }, 120_000);

  it('evicts an environment the sweeper has condemned but not yet quiesced', async () => {
    // Found by driving the real thing rather than by a test: an environment
    // released and abandoned is idle past IDLE_TTL — which is exactly what the
    // sweeper quiesces — but it stays `hot` until the sweep actually runs, up to
    // BACKLOT_SWEEP_MS later (15s by default). While eviction required `warm`,
    // the caller was refused for that whole window, and refused with "waiting
    // will not help" when the next sweep would in fact have freed a slot.
    //
    // The long sweep interval here is the point: it guarantees nothing has been
    // quiesced, so the candidate is hot-but-condemned.
    const c = ctx({ total: 1, idleTtlMs: 200, sweepMs: 60_000 });
    const a = c.stack('mcaph');
    const b = c.stack('mcapi');

    const upA = await c.cli(['up', '--json'], a);
    expect(upA.code).toBe(0);
    await c.cli(['release', '--json'], a);
    await sleep(400); // past the idle TTL, but no sweep will have run

    // Still hot — the precondition this test exists for.
    expect(c.journal().getEnv(String(upA.json?.envId))?.state).toBe('hot');

    const upB = await c.cli(['up', '--json'], b);
    expect(upB.code, upB.stdout).toBe(0);
    expect(c.journal().allEnvs().map((r) => r.id)).toEqual([String(upB.json?.envId)]);
    const evicted = c.events().filter((e) => e.kind === 'pool-evict');
    expect(evicted.length).toBe(1);
    // The record must say it took a hot one, or the next reader will think the
    // `warm` restriction is still in force.
    expect(evicted[0]!.detail).toMatch(/hot/);
  }, 120_000);

  it('waits out a quiesce in flight instead of refusing as if it were permanent', async () => {
    // The CI failure this exists for. The idle quiesce runs under the ENVIRONMENT
    // LOCK, which marks the environment `busy`, and decision 0021 deliberately
    // keeps its mid-quiesce state as plain `hot`. So while the sweeper reclaims
    // heat from the only candidate, that candidate is briefly unevictable — and
    // the machine-wide refusal, whose whole claim is that waiting cannot help,
    // fired on a condition that clears in milliseconds. It reproduced on the
    // macOS runner, where teardown is slower (SIGTERM, then a verified SIGKILL).
    //
    // Made deterministic by a service that STALLS on SIGTERM: the quiesce cannot
    // complete until the kill escalates, so it is reliably in flight while the
    // second stack asks for a slot.
    const c = ctx({ total: 1, idleTtlMs: 250, stubbornService: true });
    const a = c.stack('mcapj');
    const b = c.stack('mcapk');

    const upA = await c.cli(['up', '--json'], a);
    expect(upA.code).toBe(0);
    await c.cli(['release', '--json'], a);
    // Long enough for the sweeper to START quiescing, far too short for the
    // stubborn service to have finished dying.
    await sleep(600);

    const upB = await c.cli(['up', '--json'], b);
    // The contract: wait for the quiesce, then take the slot. Never an immediate
    // "queueing cannot succeed" — that was a lie about a transient state.
    expect(upB.code, upB.stdout).toBe(0);
    expect(c.journal().allEnvs().map((r) => r.id)).toEqual([String(upB.json?.envId)]);
  }, 120_000);

  it('never evicts a LEASED environment, and says so in a second rather than a minute', async () => {
    const c = ctx({ total: 1 });
    const a = c.stack('mcapc');
    const b = c.stack('mcapd');

    // A live lease. The sweeper will still reclaim its HEAT (that is the
    // documented quiesce), but the lease — and the row — survive.
    const upA = await c.cli(['up', '--ttl', '10', '--json'], a);
    expect(upA.code).toBe(0);
    await sleep(400);

    const started = Date.now();
    const upB = await c.cli(['up', '--json'], b);
    const elapsed = Date.now() - started;
    expect(upB.code).not.toBe(0);

    const msg = c.errOf(upB);
    // Names the cap that actually bound, and the knob that can move it.
    expect(msg).toMatch(/MACHINE-WIDE/);
    expect(msg).toContain('BACKLOT_POOL_MAX_TOTAL');
    // Explains why the obvious remedy is not one: a release leaves the row.
    expect(msg).toMatch(/Releasing a lease will not help/);
    // Real counts, not the cap printed twice.
    expect(msg).toMatch(/machine holds 1\/1/);
    expect(msg).toMatch(/this stack holds 0\/9/);
    // Waiting cannot clear a machine-wide block, so it must not wait.
    expect(elapsed).toBeLessThan(15_000);

    // The lease is untouched: never take an environment somebody else holds.
    expect(c.journal().leaseForEnv(String(upA.json?.envId))).toBeTruthy();
    expect(c.events().filter((e) => e.kind === 'pool-evict')).toEqual([]);
  }, 120_000);

  it('evicts the least-recently-used cold environment, leaving a leased one alone', async () => {
    const c = ctx({ total: 2 });
    const a = c.stack('mcape'); // will be cold, and used FIRST (the LRU victim)
    const b = c.stack('mcapf'); // will stay leased
    const d = c.stack('mcapg'); // the newcomer

    const upA = await c.cli(['up', '--json'], a);
    await c.cli(['release', '--json'], a);
    const upB = await c.cli(['up', '--ttl', '10', '--json'], b);
    expect(upA.code).toBe(0);
    expect(upB.code).toBe(0);
    await sleep(400);

    const upD = await c.cli(['up', '--json'], d);
    expect(upD.code, upD.stdout).toBe(0);

    const ids = c.journal().allEnvs().map((r) => r.id);
    expect(ids).toContain(String(upB.json?.envId)); // the leased one survived
    expect(ids).toContain(String(upD.json?.envId));
    expect(ids).not.toContain(String(upA.json?.envId)); // the cold one paid
  }, 120_000);
});

/**
 * Crash atomicity: every half-state a SIGKILL between journal writes can leave
 * must be one recovery/sweep converges — disk is truth (decision 0009), and
 * the truth after a torn write is still the daemon's to reconcile, not the
 * user's to notice.
 *
 * The half-states are FABRICATED directly in the journal db (the same file the
 * daemon opens), because the windows themselves are microseconds wide and have
 * no honest interleaving reproduction. The sequences these states fall out of:
 *
 *   - deleteEnv: DELETE envs, then DELETE leases — a kill between them leaves
 *     a lease naming an env row that no longer exists (the dangling lease).
 *   - tryClaim: createEnv's saveEnv, then saveLease — a kill between them
 *     leaves an env row no lease points at (a free env, and it must stay one).
 *   - teardownClaimed: the row is flipped to 'recycling', the tree is removed,
 *     THEN deleteEnv — a kill before the delete leaves a recycling env with
 *     its lease still on disk.
 *
 * journal.ts now wraps each multi-statement sequence in a real transaction, so
 * these states can no longer be produced by a crash — but old journals, and
 * corruption, still can. The sweeper is the backstop this file enforces.
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

function ctx(extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-atom-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-atom-wt-'));
  dirs.push(stateDir, wt);
  writeFileSync(
    join(wt, 'stack.yaml'),
    `name: atom\nservices:\n  web: { run: "echo ready; sleep 300", ready: { log: ready, timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '300', ...extraEnv };
  const cli = (args: string[]) =>
    new Promise<{ code: number; json?: Record<string, unknown> }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json });
      });
    });
  const journal = () => new Journal(join(stateDir, 'journal.db'));
  const killDaemon = () => process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')), 'SIGKILL');
  return { stateDir, wt, cli, journal, killDaemon };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await settle(150);
  }
  return pred();
}

describe('a dangling lease (its env row is gone) is pruned by the sweeper', () => {
  it('does not squat until its TTL, and the prune is announced', async () => {
    const c = ctx();
    const up = await c.cli(['up', '--json']);
    expect(up.json?.state).toBe('hot');

    // The half-state a kill between deleteEnv's two deletes left behind: a
    // lease whose env_id names no env row. Far-future expiry and no holder
    // pid, so neither existing sweep rule (expiry, dead holder) touches it —
    // before the prune it simply sat in the journal until its TTL, invisible
    // to every JOIN but still a row asserting ownership of nothing.
    c.journal().saveLease({
      id: 'l-dangling',
      envId: 'atom-e999',
      kind: 'session',
      holder: c.wt,
      hygiene: 'reuse',
      expiresAt: Date.now() + 60 * 60_000,
    });

    const pruned = await waitFor(() => c.journal().allLeases().every((l) => l.id !== 'l-dangling'));
    expect(pruned, 'a dangling lease must be pruned by the sweeper, not held for its full TTL').toBe(true);

    // Only the corpse goes: the real, env-backed lease survives the same sweeps.
    expect(c.journal().allLeases().length).toBe(1);

    // Silent repair hides the defect that caused it — the prune logs an event.
    const events = readFileSync(join(c.stateDir, 'events.jsonl'), 'utf8');
    expect(events).toMatch(/no longer exists/);
  }, 60_000);

  it('never blocks acquisition or capacity math while it exists', async () => {
    // Sweeps effectively off: the dangling lease STAYS on disk for the whole
    // test, so every assertion below runs against the un-repaired half-state.
    const c = ctx({ BACKLOT_SWEEP_MS: '600000', BACKLOT_POOL_MAX: '1' });
    // Fabricate before the daemon ever runs — the journal is just a file.
    c.journal().saveLease({
      id: 'l-dangling',
      envId: 'atom-e999',
      kind: 'session',
      holder: c.wt, // the SAME holder the up below uses — nastiest case
      hygiene: 'reuse',
      expiresAt: Date.now() + 60 * 60_000,
    });

    // A one-env pool must still bind: the phantom lease pins no env, so it
    // must count for nothing — not against leaseForHolder (the JOIN skips
    // it), not as an occupied environment, not as a structural block.
    const up = await c.cli(['up', '--json']);
    expect(up.code).toBe(0);
    expect(up.json?.state).toBe('hot');
    expect(c.journal().allEnvs().length).toBe(1);

    const ls = await c.cli(['pool', 'ls', '--json']);
    const envs = ls.json?.envs as Array<{ id: string; lease: { id: string } | null }>;
    expect(envs.length).toBe(1);
    expect(envs[0]!.lease?.id).not.toBe('l-dangling');
  }, 60_000);
});

describe('an env row with no lease (crash between saveEnv and saveLease) stays claimable', () => {
  it('is handed to the next up instead of leaking or wedging capacity', async () => {
    const c = ctx({ BACKLOT_POOL_MAX: '1' });
    const up1 = await c.cli(['up', '--json']);
    expect(up1.json?.state).toBe('hot');
    const envId = String(up1.json?.envId);

    // Rewind to the instant after createEnv persisted the row but before
    // tryClaim persisted the lease, as a SIGKILL there would have left it.
    c.killDaemon();
    await settle(300);
    const j = c.journal();
    for (const l of j.allLeases()) j.deleteLease(l.id);

    // On a one-env pool the ONLY way this succeeds is by claiming that
    // leaseless row — if the half-state made it unclaimable, this would be a
    // capacity failure, not a bind.
    const up2 = await c.cli(['up', '--json']);
    expect(up2.code).toBe(0);
    expect(String(up2.json?.envId)).toBe(envId);
    expect(c.journal().allEnvs().length).toBe(1);
    expect(c.journal().leaseForEnv(envId)).toBeTruthy();
  }, 90_000);
});

describe('a torn teardown (recycling row, lease still on disk) is finished by recovery', () => {
  it('deletes both the env and its lease after a restart', async () => {
    const c = ctx();
    const up = await c.cli(['up', '--json']);
    expect(up.json?.state).toBe('hot');
    const envId = String(up.json?.envId);

    // The instant teardownClaimed died: row claimed as 'recycling', tree
    // half-gone, deleteEnv never reached — env AND lease both still on disk.
    c.killDaemon();
    await settle(300);
    const j = c.journal();
    j.saveEnv({ ...j.getEnv(envId)!, state: 'recycling' });
    expect(j.leaseForEnv(envId)).toBeTruthy();

    // Any verb restarts the daemon; recovery's contract for 'recycling' is
    // FINISH THE TEARDOWN, which must take the lease down with the row.
    await c.cli(['pool', 'ls', '--json']);
    const converged = await waitFor(() => {
      const jj = c.journal();
      return jj.getEnv(envId) === undefined && jj.leaseForEnv(envId) === undefined;
    });
    expect(converged, 'recovery left a torn teardown unresolved').toBe(true);
    expect(existsSync(join(c.stateDir, 'envs', envId)), 'the recycled tree survived recovery').toBe(false);
  }, 90_000);
});

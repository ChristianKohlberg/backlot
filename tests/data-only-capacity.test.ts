/**
 * A data-only lease is priced like a catalog, not like a stack (issue #48).
 *
 * `up --data-only` (#39) removed the WEIGHT of a full application environment —
 * no services, no ports, no build — but kept the slot competition, because a
 * data-only environment was charged against `poolMax`/`poolMaxTotal` like any
 * other. Those caps come from `min(cores/2, memGB/4)`: they bound running
 * services. Where the datastore is an appliance, the marginal cost of a data-only
 * environment is a database catalog plus a synced tree.
 *
 * The consequence was the contention #39 set out to remove: a test lane invoked
 * by every agent on every integration run competed with — and could be blocked
 * by, or evict — the interactive leases people use to LOOK at the app. Concretely,
 * a fresh worktree asking for `--data-only` was refused because six *application*
 * environments, all cold and unleased, held the machine-wide budget.
 *
 * So data-only environments answer to their own machine-wide ceiling
 * (`BACKLOT_POOL_MAX_DATA_ONLY`, disk-shaped rather than CPU-shaped) and to
 * neither application cap. The sharp edge that makes this sound is that the
 * SHAPE has to be durable: with the two shapes counted against different
 * ceilings, and reuse never capacity-checked, a claim that changes an
 * environment's shape moves it between ceilings — and if that move is unmetered,
 * the cheap ceiling becomes application capacity: create N catalog-priced
 * environments, convert them to full stacks for free, repeat. Hence decision
 * 0025 — the shape lives on the row, and CHANGING it is a capacity event that the
 * destination ceiling has to have room for. Switching your own lease both ways
 * (0023's behaviour) still works; it is just no longer free.
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

function ctx(opts: { total?: number; dataOnly?: number; idleTtlMs?: number } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-docap-'));
  dirs.push(stateDir);
  const env = {
    ...process.env,
    BACKLOT_STATE_DIR: stateDir,
    BACKLOT_POOL_MAX: '9',
    BACKLOT_POOL_MAX_TOTAL: String(opts.total ?? 1),
    BACKLOT_POOL_MAX_DATA_ONLY: String(opts.dataOnly ?? 4),
    BACKLOT_IDLE_TTL_MS: String(opts.idleTtlMs ?? 250),
    BACKLOT_WAIT_MS: '20000',
    BACKLOT_SWEEP_MS: '300',
  };
  /** A stack with one cheap service AND a datastore, so both shapes are bindable. */
  const stack = (name: string) => {
    const wt = mkdtempSync(join(tmpdir(), `backlot-docap-${name}-`));
    dirs.push(wt);
    writeFileSync(
      join(wt, 'seed.mjs'),
      `import { DatabaseSync } from 'node:sqlite';
const [dbPath] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec('CREATE TABLE IF NOT EXISTS rows (id INTEGER PRIMARY KEY)');
db.close();
`,
    );
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: ${name}\n` +
        `services:\n  idle: { run: "echo ready; sleep 300", ready: { log: ready, timeout: 20 } }\n` +
        `datastores:\n  main:\n    driver: sqlite\n    create: node seed.mjs {{ns}}\n    presets: [dev]\n    default_preset: { session: dev, run: dev }\n` +
        `checks:\n  ok: { run: "true" }\n`,
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

describe('a data-only lease is not charged an application slot', () => {
  it('binds even when the application caps are entirely spent', async () => {
    // Exactly the reported situation, minimised: the machine-wide APPLICATION
    // budget is full (1/1, leased so it cannot even be evicted), and a different
    // stack wants a database.
    const c = ctx({ total: 1 });
    const app = c.stack('docapa');
    const lane = c.stack('docapb');

    const upApp = await c.cli(['up', '--ttl', '10', '--json'], app);
    expect(upApp.code).toBe(0);

    const upLane = await c.cli(['up', '--data-only', '--json'], lane);
    expect(upLane.code, upLane.stdout).toBe(0);
    expect(upLane.json?.dataOnly).toBe(true);

    // Both exist: the data-only environment did not evict the interactive one,
    // and was not blocked by it. That is the whole point of #39.
    const rows = c.journal().allEnvs();
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.dataOnly === true).length).toBe(1);
    expect(c.journal().leaseForEnv(String(upApp.json?.envId))).toBeTruthy();
  }, 120_000);

  it('is still bounded — by its own ceiling, named in the refusal', async () => {
    // Priced separately does not mean free: the trees are still on disk.
    const c = ctx({ total: 4, dataOnly: 1 });
    const one = c.stack('docapc');
    const two = c.stack('docapd');

    const first = await c.cli(['up', '--data-only', '--ttl', '10', '--json'], one);
    expect(first.code).toBe(0);

    const second = await c.cli(['up', '--data-only', '--json'], two);
    expect(second.code).not.toBe(0);
    const msg = c.errOf(second);
    expect(msg).toMatch(/DATA-ONLY cap/);
    expect(msg).toContain('BACKLOT_POOL_MAX_DATA_ONLY');
    expect(msg).toMatch(/1\/1 data-only environments/);
    // And it must not misattribute the block to the application caps, which have
    // room — that misattribution was half of #47.
    expect(msg).toMatch(/is not what stopped this/);
  }, 120_000);

  it('evicts a cold data-only environment rather than an application one', async () => {
    const c = ctx({ total: 4, dataOnly: 1 });
    const one = c.stack('docape');
    const two = c.stack('docapf');
    const app = c.stack('docapg');

    // An application environment that is ALSO cold and unleased. If eviction
    // ignored shape it would be a candidate — and taking it would neither free a
    // data-only slot nor be fair to its stack.
    const upApp = await c.cli(['up', '--json'], app);
    await c.cli(['release', '--json'], app);
    const first = await c.cli(['up', '--data-only', '--json'], one);
    await c.cli(['release', '--json'], one);
    expect(upApp.code).toBe(0);
    expect(first.code).toBe(0);
    await new Promise((r) => setTimeout(r, 400));

    const second = await c.cli(['up', '--data-only', '--json'], two);
    expect(second.code, second.stdout).toBe(0);

    const ids = c.journal().allEnvs().map((r) => r.id);
    expect(ids).toContain(String(upApp.json?.envId)); // the app env is untouched
    expect(ids).not.toContain(String(first.json?.envId)); // the cold data-only one paid
  }, 120_000);
});

describe('changing an environment\'s shape is a capacity event', () => {
  it('still switches a lease between shapes when the destination has room', async () => {
    // Switching both directions on your own lease is deliberate, tested 0023
    // behaviour, and metering the conversion must not quietly remove it.
    const c = ctx({ total: 2, dataOnly: 4 });
    const s = c.stack('docaph');

    const lane = await c.cli(['up', '--data-only', '--ttl', '10', '--json'], s);
    expect(lane.code).toBe(0);
    expect(lane.json?.dataOnly).toBe(true);

    const full = await c.cli(['up', '--json'], s);
    expect(full.code, full.stdout).toBe(0);
    expect(String(full.json?.envId)).toBe(String(lane.json?.envId)); // same environment
    expect(full.json?.dataOnly).toBeFalsy();

    // It moved buckets, so it must now be counted as an application environment.
    expect(c.journal().getEnv(String(lane.json?.envId))?.dataOnly).toBeFalsy();
    // A move between ceilings is a capacity fact, so it is on the record.
    expect(c.events().some((e) => e.kind === 'pool-shape')).toBe(true);
  }, 120_000);

  it('will not let the data-only ceiling be spent as application capacity', async () => {
    // THE leak. Shape used to be decided per claim, and reuse is never
    // capacity-checked — so a catalog-priced environment could be turned into a
    // full application stack for free. Take the cheap ceiling, convert, repeat,
    // and a 1-application host runs as many stacks as you like.
    const c = ctx({ total: 1, dataOnly: 4 });
    const lane = c.stack('docapj');
    const app = c.stack('docapk');

    // The single application slot, leased — so it cannot be evicted either.
    const appUp = await c.cli(['up', '--ttl', '10', '--json'], app);
    expect(appUp.code).toBe(0);

    // A free (cold, unleased) data-only environment belonging to the other stack.
    const laneUp = await c.cli(['up', '--data-only', '--json'], lane);
    expect(laneUp.code).toBe(0);
    await c.cli(['release', '--json'], lane);
    await new Promise((r) => setTimeout(r, 400));

    // An ordinary `up` there would have to convert it, and there is no
    // application room to convert into.
    const plain = await c.cli(['up', '--json'], lane);
    expect(plain.code).not.toBe(0);
    expect(c.errOf(plain)).toMatch(/MACHINE-WIDE/);

    // Nothing was converted, and the application population did not grow.
    expect(c.journal().getEnv(String(laneUp.json?.envId))?.dataOnly).toBe(true);
    expect(c.journal().allEnvs().filter((r) => r.dataOnly !== true).length).toBe(1);
  }, 120_000);
});

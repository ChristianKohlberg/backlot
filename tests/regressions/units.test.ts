/**
 * Unit-level regressions of the 0.16.0 bug hunt and the 0.17.0 quick wins:
 * the glob compiler (R9), the git pathspecs a listing is narrowed to, the
 * backwards log tail, the budget's CPU gate / zero-need / start hand-back /
 * build waves, the supervisor's start during a crash backoff (L3), the
 * truncated-namespace record (W4), the single default preset and the export
 * lines `ctx --env` prints.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globToRegex, matchesAny } from '../../src/core/util.js';
import { globPathspecs } from '../../src/core/worktree.js';
import { LogWriter, readLastLines, readLog } from '../../src/core/logs.js';
import { BudgetRefusal, LoadBudget, needOf, type Committed, type Machine, type NeedItem } from '../../src/daemon/budget.js';
import type { Budget } from '../../src/core/policy.js';
import { exportLines } from '../../src/core/env-vars.js';
import { defaultPresetFor, presetCatalog } from '../../src/core/presets.js';

describe('R9 globs are anchored at path segments', () => {
  const cases: Array<[string, string, boolean]> = [
    ['**/bin', 'bin', true],
    ['**/bin', 'src/bin', true],
    ['**/bin', 'src/bin/Debug/app.dll', true],
    ['**/bin', 'src/Cabin', false],
    ['**/bin', 'src/Cabin/Program.cs', false],
    ['**/obj', 'src/Domain/ValueObj/Money.cs', false],
    ['**/package.json', 'package.json', true],
    ['**/package.json', 'a/b/package.json', true],
    ['**/package.json', 'tools/not-a-package.json', false],
    ['src/**', 'src/a.ts', true],
    ['src/**', 'src/a/b/c.ts', true],
    ['src/**', 'srcx/a.ts', false],
    ['src/**', 'src', false],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/b', true],
    ['a/**/b', 'a/x/y/b/c.txt', true],
    ['a/**/b', 'a/xb', false],
    ['src/**/x.ts', 'src/foox.ts', false],
    ['src/**/x.ts', 'src/x.ts', true],
    ['src/**/x.ts', 'src/d/x.ts', true],
    // dotfiles are not special
    ['**/.env', '.env', true],
    ['**/.env', 'app/.env', true],
    ['*.json', '.eslintrc.json', true],
    ['**/x', '.hidden/x', true],
    // `*` and `?` stay in one segment
    ['src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'src/d/a.ts', false],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    // a bare name matches the segment anywhere
    ['node_modules', 'node_modules/x', true],
    ['node_modules', 'a/node_modules/x', true],
    ['node_modules', 'a/my_node_modules/x', false],
  ];
  for (const [glob, path, want] of cases) {
    it(`${glob} ${want ? 'matches' : 'does not match'} ${path}`, () => {
      expect(matchesAny(path, [glob])).toBe(want);
    });
  }
  it('compiles each pattern once', () => {
    expect(globToRegex('**/bin')).toBe(globToRegex('**/bin'));
  });
});

describe('B4 a listing is narrowed to the globs\' literal prefixes', () => {
  it('passes the literal directories as pathspecs, or nothing when a glob can match anywhere', () => {
    expect(globPathspecs(['frontend/pnpm-lock.yaml', 'db/migrations/**', 'src/*/x.ts'])).toEqual(['frontend/pnpm-lock.yaml', 'db/migrations', 'src']);
    expect(globPathspecs(['src/**', '**/package.json'])).toBeNull();
    expect(globPathspecs(['package.json'])).toBeNull(); // a bare name matches anywhere
    expect(globPathspecs(['./a/**'])).toEqual(['a']);
  });
});

describe('B7 logs --lines reads backwards', () => {
  it('returns the same last lines as a whole read, across a rotation, markers included', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tail-'));
    const file = join(dir, 'svc.log');
    const w = new LogWriter(file, 64 * 1024);
    w.line('-- runly: svc started --');
    for (let i = 0; i < 5000; i++) w.write('out', `line ${i} ${'x'.repeat(i % 50)}\n`);
    w.line('-- runly: svc started (restart) --');
    for (let i = 0; i < 3; i++) w.write('out', `after ${i}\n`);
    const whole = readLog(file, 'svc').filter((l) => !l.marker);
    for (const n of [1, 3, 40, 2000]) {
      const tail = readLastLines(file, 'svc', n).filter((l) => !l.marker);
      expect(tail.slice(-n).map((l) => l.text)).toEqual(whole.slice(-n).map((l) => l.text));
    }
  });
});

const G = 1024 ** 3;
const budget = (over: Partial<Budget> = {}): Budget => ({
  enabled: true, memoryBytes: 4 * G, cpu: 4, reserveBytes: 0, cpuPressure: 70, loadPerCore: 4, waitMs: 2000, maxQueue: 8,
  defaultRun: { memoryBytes: 512 * 1024 ** 2, cpu: 0.5 }, defaultBuild: { memoryBytes: G, cpu: 1 }, ...over,
});
const machine = (over: Partial<Machine> = {}): Machine => ({ totalBytes: 16 * G, availableBytes: 12 * G, load1: 0, cores: 4, cpuPressure: null, ...over });
const none: Committed = { memoryBytes: 0, cpu: 0, items: [] };
const cost = (gb: number) => ({ memoryBytes: gb * G, cpu: 0.5, declared: true });
const start = (name: string, gb: number): NeedItem => ({ kind: 'start', name, cost: cost(gb) });
const build = (name: string, gb: number, wave?: number): NeedItem => ({ kind: 'build', name, cost: cost(gb), wave });

describe('B2 the CPU gate', () => {
  it('uses PSI where there is PSI: both windows over the limit wait, a spike does not', () => {
    const busy = new LoadBudget(() => budget(), () => none, () => machine({ load1: 100, cpuPressure: { avg10: 90, avg60: 80 } }));
    expect(busy.check(needOf([start('a', 1)])).waitFor).toMatch(/cpu pressure/);
    const spike = new LoadBudget(() => budget(), () => none, () => machine({ load1: 100, cpuPressure: { avg10: 95, avg60: 20 } }));
    expect(spike.check(needOf([start('a', 1)])).fits).toBe(true); // load average alone no longer holds anyone
  });
  it('falls back to the load average (4 x cores) without PSI', () => {
    const lb = new LoadBudget(() => budget(), () => none, () => machine({ load1: 17, cpuPressure: null }));
    expect(lb.check(needOf([start('a', 1)])).waitFor).toMatch(/load: 17\.0 on 4 cores/);
    const ok = new LoadBudget(() => budget(), () => none, () => machine({ load1: 15, cpuPressure: null }));
    expect(ok.check(needOf([start('a', 1)])).fits).toBe(true);
  });
  it('lets a wake of a recently running service skip it, but not the memory gate', async () => {
    const lb = new LoadBudget(() => budget({ memoryBytes: 2 * G }), () => none, () => machine({ cpuPressure: { avg10: 99, avg60: 99 } }));
    expect(lb.check(needOf([start('a', 1)]), { skipLoadGate: true }).fits).toBe(true);
    const r = await lb.admit(needOf([start('a', 1)]), 'wake a', { skipLoadGate: true });
    r.release();
    await expect(lb.admit(needOf([start('b', 3)]), 'wake b', { skipLoadGate: true })).rejects.toBeInstanceOf(BudgetRefusal);
  });
});

describe('B2 a need of nothing never queues', () => {
  it('is admitted at once although others wait', async () => {
    const lb = new LoadBudget(() => budget({ memoryBytes: 2 * G }), () => none, () => machine());
    const held = await lb.admit(needOf([start('a', 2)]), 'a');
    const waiting = lb.admit(needOf([start('b', 1)]), 'b').catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    expect(lb.queueLength()).toBe(1);
    const t0 = Date.now();
    const noop = await lb.admit(needOf([{ ...build('c', 1), skipped: 'when: unchanged' }]), 'no-op up');
    expect(Date.now() - t0).toBeLessThan(100);
    noop.release();
    held.release();
    const b = await waiting;
    if (!(b instanceof Error)) b.release();
  });
});

describe('R1/R6 budget refusals are typed, and a gone caller leaves the queue', () => {
  it('throws BudgetRefusal for impossible, timeout and abort', async () => {
    const lb = new LoadBudget(() => budget({ memoryBytes: 2 * G, waitMs: 300 }), () => none, () => machine());
    await expect(lb.admit(needOf([start('huge', 9)]), 'huge')).rejects.toBeInstanceOf(BudgetRefusal);
    const held = await lb.admit(needOf([start('a', 2)]), 'a');
    await expect(lb.admit(needOf([start('b', 1)]), 'b')).rejects.toBeInstanceOf(BudgetRefusal);
    const ac = new AbortController();
    const queued = lb.admit(needOf([start('c', 1)]), 'c', { signal: ac.signal, waitMs: 10_000 });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();
    await expect(queued).rejects.toThrow(/caller disconnected/);
    expect(lb.queueLength()).toBe(0);
    held.release();
  });
});

describe('R8 a reservation hands back each started service', () => {
  it('consume() lowers what is committed in flight', async () => {
    const lb = new LoadBudget(() => budget(), () => none, () => machine());
    const r = await lb.admit(needOf([start('a', 1), start('b', 1)]), 'up');
    expect(lb.committed().memoryBytes).toBe(2 * G);
    r.consume(cost(1));
    expect(lb.committed().memoryBytes).toBe(G);
    r.consume(cost(5));
    expect(lb.committed().memoryBytes).toBe(0);
    r.release();
  });
});

describe('B3 builds of one wave add up', () => {
  it('holds the costliest wave\'s sum; a build without a wave runs alone', () => {
    const n = needOf([build('a', 2, 0), build('b', 1, 0), build('c', 2, 1), build('serial', 3), { ...build('skip', 9, 0), skipped: 'when: unchanged' }]);
    expect(n.build.memoryBytes).toBe(3 * G); // max(a+b, c, serial)
    expect(needOf([build('a', 2, 0), build('b', 2, 0)]).build.memoryBytes).toBe(4 * G);
  });
});

describe('L3 a start during a crash backoff', () => {
  const dirs: string[] = [];
  afterAll(() => undefined);
  it('cancels the pending relaunch instead of spawning an untracked second process', async () => {
    const { EnvSupervisor } = await import('../../src/daemon/supervisor.js');
    const root = mkdtempSync(join(tmpdir(), 'l3-'));
    dirs.push(root);
    // Deterministic (0.19): the second start waits for the supervisor's own
    // signal that the relaunch is pending (onCrashed fires as it schedules
    // the backoff), not for a fixed 100 ms after the crash.
    let crashed!: () => void;
    const relaunchPending = new Promise<void>((r) => (crashed = r));
    const sup = new EnvSupervisor('l3-e1', root, join(root, 'logs'), undefined, undefined, undefined, { onCrashed: () => crashed() });
    const run = 'echo x >> launches.txt; if [ -f first ]; then sleep 30; else touch first; exit 1; fi';
    sup.start('svc', { run }, {});
    await relaunchPending;
    sup.start('svc', { run }, {});
    await new Promise((r) => setTimeout(r, 1500));
    expect(readFileSync(join(root, 'launches.txt'), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(Object.keys(sup.pids())).toEqual(['svc']);
    await sup.stopAll();
  }, 15_000);
});

describe('W4 truncated namespaces are recorded', () => {
  it('records a 63-byte name with its stack, and only such names', async () => {
    const prev = process.env.BACKLOT_STATE_DIR;
    process.env.BACKLOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'ns-'));
    try {
      const { recordNamespace, recordedNamespaces, forgetNamespace } = await import('../../src/core/namespaces.js');
      const long = `backlot_${'x'.repeat(46)}_deadbeef`;
      expect(long).toHaveLength(63);
      recordNamespace(long, 'stack-1');
      recordNamespace('backlot_short_main', 'stack-1');
      expect([...recordedNamespaces()]).toEqual([[long, 'stack-1']]);
      forgetNamespace(long);
      expect(recordedNamespaces().size).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.BACKLOT_STATE_DIR;
      else process.env.BACKLOT_STATE_DIR = prev;
    }
  });
});

describe('B9 default_preset is one value', () => {
  it('takes a name, and reads the old {run, session} shape as one (session, then run)', () => {
    expect(defaultPresetFor('main', { driver: 'sqlite', presets: ['dev', 'demo'], default_preset: 'demo' })).toBe('demo');
    expect(defaultPresetFor('main', { driver: 'sqlite', presets: ['dev', 'demo'], default_preset: { run: 'dev', session: 'demo' } })).toBe('demo');
    expect(defaultPresetFor('main', { driver: 'sqlite', presets: ['dev', 'demo'], default_preset: { run: 'dev' } })).toBe('dev');
    expect(presetCatalog({ driver: 'sqlite', default_preset: 'seeded' })).toEqual(['default', 'seeded']);
  });
});

describe('ctx --env prints export lines', () => {
  it('so eval "$(runly ctx --env)" reaches a child process', async () => {
    const lines = exportLines({ envId: 'e1', ports: { web: 1234 }, urls: { 'web-audit': 'http://localhost:1234' }, datastores: { main: { url: "pg://u:p'w@h/db", preset: 'dev' } }, logins: { user: 'a', password: 'b c' } });
    expect(lines).toEqual([
      'export RUNLY_ENV_ID=e1',
      'export RUNLY_PORT_WEB=1234',
      'export RUNLY_URL_WEB_AUDIT=http://localhost:1234',
      "export RUNLY_DATASTORE_MAIN_URL='pg://u:p'\\''w@h/db'",
      'export RUNLY_DATASTORE_MAIN_PRESET=dev',
      'export RUNLY_LOGIN_USER=a',
      "export RUNLY_LOGIN_PASSWORD='b c'",
    ]);
    const { execFileSync } = await import('node:child_process');
    const script = join(mkdtempSync(join(tmpdir(), 'envx-')), 'env.sh');
    writeFileSync(script, `${lines.join('\n')}\n`);
    const out = execFileSync('sh', ['-c', `eval "$(cat ${script})" && sh -c 'echo "$RUNLY_URL_WEB_AUDIT|$RUNLY_DATASTORE_MAIN_URL|$RUNLY_LOGIN_PASSWORD"'`], { encoding: 'utf8' });
    expect(out.trim()).toBe("http://localhost:1234|pg://u:p'w@h/db|b c");
  });
});

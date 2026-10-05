/**
 * The server-wide load budget (decision 0036): fit vs wait, FIFO order,
 * bounded waits, builds holding their share only while they build, and
 * `runly plan` saying which it would be.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { LoadBudget, costsOf, needOf, type Committed, type Machine } from '../src/daemon/budget.js';
import type { Budget } from '../src/core/policy.js';
import { makeCtx, SERVER, type Ctx } from './support/context.js';

const G = 1024 ** 3;
const budget = (over: Partial<Budget> = {}): Budget => ({
  enabled: true, memoryBytes: 4 * G, cpu: 4, reserveBytes: 0, loadPerCore: 100, waitMs: 5000, maxQueue: 8,
  defaultRun: { memoryBytes: G / 2, cpu: 0.5 }, defaultBuild: { memoryBytes: G, cpu: 1 }, ...over,
});
const machine = (over: Partial<Machine> = {}): Machine => ({ totalBytes: 16 * G, availableBytes: 12 * G, load1: 0, cores: 4, ...over });
const none: Committed = { memoryBytes: 0, cpu: 0, items: [] };
const start = (name: string, gb: number, cpu = 0.5) => ({ kind: 'start' as const, name, cost: { memoryBytes: gb * G, cpu, declared: true } });
const build = (name: string, gb: number, cpu = 1) => ({ kind: 'build' as const, name, cost: { memoryBytes: gb * G, cpu, declared: true } });

describe('costs', () => {
  it('uses declared resources, and a conservative default — flagged — for what is not declared', () => {
    const b = budget();
    expect(costsOf({ memory: '600M', cpu: 1, build: { memory: '2G', cpu: 2 } }, b)).toEqual({
      run: { memoryBytes: 600 * 1024 ** 2, cpu: 1, declared: true },
      build: { memoryBytes: 2 * G, cpu: 2, declared: true },
    });
    const d = costsOf(undefined, b);
    expect(d.run).toEqual({ memoryBytes: G / 2, cpu: 0.5, declared: false });
    expect(d.build.declared).toBe(false);
  });

  it('sums starts and takes the largest build (builds run one after another)', () => {
    const n = needOf([start('a', 1), start('b', 1), build('a', 2), build('b', 1)]);
    expect(n.start.memoryBytes).toBe(2 * G);
    expect(n.build.memoryBytes).toBe(2 * G);
  });
});

describe('admission', () => {
  it('fits when committed + need is under the budget; waits when not; never when it cannot ever fit', () => {
    let committed = none;
    const lb = new LoadBudget(() => budget(), () => committed, () => machine());
    expect(lb.check(needOf([start('a', 1)])).fits).toBe(true);
    committed = { memoryBytes: 3.5 * G, cpu: 1, items: [{ what: 'x', memoryBytes: 3.5 * G, cpu: 1 }] };
    const v = lb.check(needOf([start('a', 1)]));
    expect(v.fits).toBe(false);
    expect(v.waitFor).toMatch(/memory/);
    expect(lb.check(needOf([start('huge', 8)])).impossible).toMatch(/whole budget/);
  });

  it('gates on free memory (reserve) and on load', () => {
    const lb = new LoadBudget(() => budget({ reserveBytes: 2 * G, loadPerCore: 1 }), () => none, () => machine({ availableBytes: 2.5 * G, load1: 9 }));
    const v = lb.check(needOf([start('a', 1)]));
    expect(v.fits).toBe(false);
    expect(v.waitFor).toMatch(/free memory/);
    expect(v.waitFor).toMatch(/load/);
  });

  it('queues FIFO with a position, and admits in order as capacity frees', async () => {
    const lb = new LoadBudget(() => budget({ memoryBytes: 2 * G }), () => none, () => machine());
    const first = await lb.admit(needOf([start('one', 2)]), 'one');
    const order: string[] = [];
    const positions: Record<string, number[]> = { two: [], three: [] };
    const two = lb.admit(needOf([start('two', 2)]), 'two', { onWait: (p) => positions.two!.push(p) }).then((r) => { order.push('two'); return r; });
    await new Promise((r) => setTimeout(r, 50));
    const three = lb.admit(needOf([start('three', 1)]), 'three', { onWait: (p) => positions.three!.push(p) }).then((r) => { order.push('three'); return r; });
    await new Promise((r) => setTimeout(r, 1200));
    expect(lb.queueLength()).toBe(2);
    // three would fit by size alone (1G) — but it is behind two: no overtaking.
    expect(order).toEqual([]);
    expect(positions.two![0]).toBe(1);
    expect(positions.three![0]).toBe(2);
    first.release();
    const r2 = await two;
    expect(order).toEqual(['two']);
    r2.release();
    (await three).release();
    expect(order).toEqual(['two', 'three']);
  });

  it('a build holds its share only while it builds', async () => {
    const lb = new LoadBudget(() => budget({ memoryBytes: 3 * G }), () => none, () => machine());
    const r = await lb.admit(needOf([start('a', 1), build('a', 2)]), 'a');
    expect(lb.committed().memoryBytes).toBe(3 * G);
    expect(lb.check(needOf([start('b', 1)])).fits).toBe(false);
    r.releaseBuild();
    expect(lb.committed().memoryBytes).toBe(1 * G);
    expect(lb.check(needOf([start('b', 1)])).fits).toBe(true);
    r.release();
  });

  it('a bounded wait fails clearly, and a full queue refuses at once', async () => {
    const lb = new LoadBudget(() => budget({ memoryBytes: G, maxQueue: 1 }), () => none, () => machine());
    const held = await lb.admit(needOf([start('a', 1)]), 'a');
    const waiting = lb.admit(needOf([start('b', 1)]), 'b', { waitMs: 600 });
    await expect(lb.admit(needOf([start('c', 1)]), 'c')).rejects.toThrow(/queue is full/);
    await expect(waiting).rejects.toThrow(/waited .* for the load budget/);
    held.release();
  });

  it('switched off, everything is admitted', async () => {
    const lb = new LoadBudget(() => budget({ enabled: false, memoryBytes: 1 }), () => none, () => machine());
    (await lb.admit(needOf([start('a', 100)]), 'a')).release();
  });
});

const ctxs: Ctx[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
});

describe('runly plan, and an up that has to wait', () => {
  const STACK = `name: plan
services:
  api:
    run: node server.mjs
    port: api
    env: { PORT: "{{ports.api}}" }
    ready: { http: /, timeout: 20 }
    resources: { memory: 600M, cpu: 1, build: { memory: 400M, cpu: 2 } }
    build: { run: "true", when: ["server.mjs"] }
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
`;

  it('plan says "starts now", itemises costs and flags assumed defaults; changes nothing', async () => {
    const c = makeCtx({ BACKLOT_BUDGET_MEMORY: '8G', BACKLOT_BUDGET_CPU: '8' });
    ctxs.push(c);
    const wt = c.worktree({ 'runly.yml': STACK, 'server.mjs': SERVER });
    const p = await c.cli(['plan', '--json'], wt);
    expect(p.code, p.stderr + p.stdout).toBe(0);
    expect(p.json.startsNow).toBe(true);
    expect(p.json.verdict).toBe('starts now');
    const kinds = p.json.items.map((i: { kind: string; name: string }) => `${i.kind}:${i.name}`).sort();
    expect(kinds).toEqual(['build:api', 'start:api', 'start:web']);
    expect(p.json.defaultsAssumed).toEqual(['start web']);
    expect(c.journal().allEnvs()).toEqual([]);
    const human = await c.cli(['plan'], wt);
    expect(human.stdout).toMatch(/starts now/);
    expect(human.stdout).toMatch(/default — not declared/);
  }, 60_000);

  it('plan says what it would wait for; an up queues and then fails clearly when the budget stays full', async () => {
    // 1.1G: api (600M) runs; web's assumed 512M does not fit beside it.
    const c = makeCtx({ BACKLOT_BUDGET_MEMORY: '1100M', BACKLOT_BUDGET_CPU: '8', BACKLOT_BUDGET_WAIT_MS: '1500' });
    ctxs.push(c);
    const wt = c.worktree({ 'runly.yml': STACK, 'server.mjs': SERVER });
    const up = await c.cli(['up', 'api', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const p = await c.cli(['plan', 'web', '--json'], wt);
    expect(p.json.startsNow).toBe(false);
    expect(p.json.verdict).toMatch(/^would wait for memory/);
    const blocked = await c.cli(['up', 'web', '--json', '--progress'], wt);
    expect(blocked.code).toBe(2);
    expect(blocked.json.error.message).toMatch(/waited .* for the load budget/);
    expect(blocked.stderr).toMatch(/waiting for the load budget: position 1/);
    // Stopping api frees its share; now it fits.
    expect((await c.cli(['down', 'api', '--json'], wt)).code).toBe(0);
    const ok = await c.cli(['up', 'web', '--json'], wt);
    expect(ok.code, ok.stderr + ok.stdout).toBe(0);
  }, 60_000);
});

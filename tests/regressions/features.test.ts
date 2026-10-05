/**
 * The 0.17 quick wins that change what a caller sees: builds of one up run in
 * depends_on waves (B3), and the agent-facing output of up / ctx / exec / ps
 * (B10).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCtx, SERVER, type Ctx } from '../support/context.js';

const ctxs: Ctx[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
});
const ctx = (env: Record<string, string> = {}) => {
  const c = makeCtx(env);
  ctxs.push(c);
  return c;
};

/** a and b are independent; c depends on a. Each build logs its start and end. */
const buildStack = (name: string, mode?: 'serial') => {
  const svc = (n: string, deps = '') => `  ${n}:
    build: 'echo "start ${n} $(date +%s%N)" >> builds.log; sleep 1; echo "end ${n} $(date +%s%N)" >> builds.log'
    run: node server.mjs
    port: ${n}
    env: { PORT: "{{ports.${n}}}" }
    ready: { http: /, timeout: 20 }
${deps}`;
  return `name: ${name}\n${mode ? `builds: ${mode}\n` : ''}services:\n${svc('a')}${svc('b')}${svc('c', '    depends_on: [a]\n')}`;
};

const spans = (wt: string) => {
  const out: Record<string, { start: number; end: number }> = {};
  for (const line of readFileSync(join(wt, 'builds.log'), 'utf8').trim().split('\n')) {
    const [what, n, ns] = line.split(' ') as [string, string, string];
    const t = Number(BigInt(ns) / 1_000_000n);
    out[n] ??= { start: 0, end: 0 };
    out[n][what === 'start' ? 'start' : 'end'] = t;
  }
  return out;
};
const overlap = (x: { start: number; end: number }, y: { start: number; end: number }) => x.start < y.end && y.start < x.end;

describe('B3 builds run in depends_on waves', () => {
  it('runs independent builds at once and a dependent build after its dependency', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': buildStack('b3par'), 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const s = spans(wt);
    expect(overlap(s.a!, s.b!)).toBe(true);
    expect(s.c!.start).toBeGreaterThanOrEqual(s.a!.end);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);

  it('builds: serial runs them one at a time', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': buildStack('b3ser', 'serial'), 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const s = spans(wt);
    expect(overlap(s.a!, s.b!)).toBe(false);
    expect(overlap(s.b!, s.c!)).toBe(false);
    expect(overlap(s.a!, s.c!)).toBe(false);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

describe('B10 agent-facing output', () => {
  const simple = (name: string) => `name: ${name}
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
`;

  it('plain up prints a summary, up --env and ctx --env print export lines, exec exports RUNLY_* like ctx --env', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': simple('b10'), 'server.mjs': SERVER });
    const up = await c.cli(['up'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    expect(up.stdout.trimStart().startsWith('{')).toBe(false);
    expect(up.stdout).toMatch(/^b10 \S+ \w+/m);
    expect(up.stdout).toMatch(/^ {2}web +\w+ +http:\/\/(localhost|127\.0\.0\.1):\d+/m);

    const upEnv = await c.cli(['up', '--env'], wt);
    expect(upEnv.code, upEnv.stderr + upEnv.stdout).toBe(0);
    const lines = upEnv.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/^export [A-Z_][A-Z0-9_]*=/);

    const ctxEnv = await c.cli(['ctx', '--env'], wt);
    expect(ctxEnv.code).toBe(0);
    const exported = Object.fromEntries(
      ctxEnv.stdout.trim().split('\n').map((l) => {
        const m = /^export ([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l);
        expect(m, l).not.toBeNull();
        return [m![1], m![2]!.replace(/^'(.*)'$/, '$1')];
      }),
    );
    expect(Object.keys(exported).some((k) => k.startsWith('RUNLY_'))).toBe(true);

    const ex = await c.cli(['exec', '--', 'env'], wt);
    expect(ex.code, ex.stderr + ex.stdout).toBe(0);
    const inside = Object.fromEntries(ex.stdout.split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    for (const [k, v] of Object.entries(exported)) if (k.startsWith('RUNLY_')) expect(inside[k], k).toBe(v);
    expect(Object.keys(inside).some((k) => k.startsWith('BACKLOT_'))).toBe(true);

    const bad = await c.cli(['ctx', '--env', '--json'], wt);
    expect(bad.code).not.toBe(0);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);

  it('ps --all shows a WORKTREE column; ps outside any env says so honestly', async () => {
    const c = ctx();
    const wt = c.worktree({ 'runly.yml': simple('b10ps'), 'server.mjs': SERVER });
    expect((await c.cli(['up', '--json'], wt)).code).toBe(0);
    const all = await c.cli(['ps', '--all'], wt);
    expect(all.code, all.stderr + all.stdout).toBe(0);
    expect(all.stdout).toMatch(/WORKTREE/);
    expect(all.stdout).toContain(wt.split('/').pop()!);
    await c.cli(['destroy', '--json'], wt);
    const none = await c.cli(['ps'], wt);
    expect(none.stdout + none.stderr).not.toMatch(/WORKTREE/);
    expect((none.stdout + none.stderr).trim().length).toBeGreaterThan(0);
  }, 60_000);
});

describe('messages name the manifest actually loaded', () => {
  it('a repo whose manifest is backlot.yml is told about backlot.yml, not runly.yml', async () => {
    const c = ctx();
    const wt = c.worktree({
      'backlot.yml': `name: mfname
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
`,
      'server.mjs': SERVER,
    });
    const db = await c.cli(['db', 'new', 'nosuch'], wt);
    expect(db.code).not.toBe(0);
    expect(db.stdout + db.stderr).toMatch(/no datastore 'nosuch' in backlot\.yml/);
    const svc = await c.cli(['up', 'nope'], wt);
    expect(svc.code).not.toBe(0);
    expect(svc.stdout + svc.stderr).toMatch(/no service 'nope' in backlot\.yml/);
    await c.cli(['destroy', '--json'], wt);
  }, 60_000);
});

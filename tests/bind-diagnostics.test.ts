import { afterAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BindDiagnostics } from '../src/core/diagnostics.js';
import type { Context } from '../src/core/types.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');
const state = mkdtempSync(join(tmpdir(), 'backlot-diag-state-'));
const wt = mkdtempSync(join(tmpdir(), 'backlot-diag-wt-'));
const env = { ...process.env, BACKLOT_STATE_DIR: state };
writeFileSync(join(wt, 'server.mjs'), `import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
createServer((q,s)=>s.end(readFileSync('content','utf8'))).listen(Number(process.env.PORT),'127.0.0.1');`);
writeFileSync(join(wt, 'content'), 'one');
writeFileSync(join(wt, 'stack.yaml'), `name: diagnostics
caches: [.build]
services:
  web:
    run: node server.mjs
    build: "mkdir -p .build dist; sleep 0.2; echo build-secret-marker >> .build/count; test -f dist/app || echo app > dist/app"
    outputs: [dist/**]
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
`);
execFileSync('git', ['init', '-q'], { cwd: wt });

async function cli(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: wt, env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}
async function context(args: string[]): Promise<Context> {
  const r = await cli([...args, '--json']);
  expect(r.code, r.stdout + r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Context;
}
function checkTimings(d: BindDiagnostics) {
  expect(d.durationMs).toBeGreaterThan(0);
  expect(Object.keys(d.phasesMs).sort()).toEqual(['queue', 'prepare', 'appliances', 'upkeep', 'stop', 'data', 'build', 'ready', 'finalize'].sort());
  for (const ms of Object.values(d.phasesMs)) expect(ms).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(d)).not.toMatch(/build-secret-marker|mkdir|echo/);
}
afterAll(async () => {
  await cli(['release']);
  await cli(['pool', 'recycle']);
  await cli(['daemon', 'stop']);
  rmSync(state, { recursive: true, force: true });
  rmSync(wt, { recursive: true, force: true });
});

describe('request-local bind diagnostics', () => {
  it('explains a cold bind, a reuse and a rebind — the build runs on every one of them', async () => {
    const cold = await context(['up', '--ttl', '5']);
    const d = cold.bindDiagnostics!;
    checkTimings(d);
    expect(d.reuse).toBe('rebound');
    expect(d.builds.map((b) => [b.service, b.reason])).toEqual([['web', 'full-rebind']]);
    expect(d.builds[0]!.durationMs).toBeGreaterThanOrEqual(150);
    expect(d.phasesMs.build).toBeGreaterThanOrEqual(150);
    // The build ran in the worktree (decision 0032).
    const countFile = join(wt, '.build', 'count');
    const builds = () => readFileSync(countFile, 'utf8').trim().split('\n').length;
    expect(builds()).toBe(1);

    const warm = await context(['up']);
    checkTimings(warm.bindDiagnostics!);
    // Every up builds (decision 0032); the output did not change, so the
    // service keeps running.
    expect(warm.bindDiagnostics?.reuse).toBe('reused');
    expect(warm.bindDiagnostics?.restarted).toEqual([]);
    expect(warm.bindDiagnostics?.builds.map((b) => [b.service, b.restart, b.reason])).toEqual([['web', false, 'outputs-unchanged']]);
    expect(builds()).toBe(2);
    expect((await context(['ctx'])).bindDiagnostics).toBeUndefined();

    // No build cache (decision 0032): a rebind with nothing changed in the
    // worktree still runs the build — the build tool decides what is current.
    const rebound = await context(['reset-data']);
    checkTimings(rebound.bindDiagnostics!);
    expect(rebound.bindDiagnostics?.reuse).toBe('rebound');
    expect(rebound.bindDiagnostics?.reasons).toContain('hygiene-reset-data');
    expect(rebound.bindDiagnostics?.builds.map((b) => b.service)).toEqual(['web']);
    expect(builds()).toBe(3);
  });

  it('reports a restart when the build changed its declared output', async () => {
    rmSync(join(wt, 'dist'), { recursive: true, force: true });
    writeFileSync(join(wt, 'content'), 'restarted-three');
    const restarted = await context(['up']);
    const d = restarted.bindDiagnostics!;
    checkTimings(d);
    expect(d.reuse).toBe('restarted');
    expect(d.restarted).toEqual(['web']);
    expect(d.builds.map((b) => [b.service, b.restart, b.reason])).toEqual([['web', true, 'outputs-changed']]);
    expect(d.phasesMs.build).toBeGreaterThan(0);
    expect(await (await fetch(restarted.urls.web)).text()).toBe('restarted-three');
    expect((await context(['ctx'])).bindDiagnostics).toBeUndefined();
  });

  it('takes the full bind when an upkeep rule ran', async () => {
    const manifest = join(wt, 'stack.yaml');
    writeFileSync(manifest, readFileSync(manifest, 'utf8') + '\nupkeep:\n  - { when: content, run: "true" }\n');
    writeFileSync(join(wt, 'content'), 'fallback-four');
    const rebound = await context(['up']);
    const d = rebound.bindDiagnostics!;
    checkTimings(d);
    expect(d.reuse).toBe('rebound');
    expect(d.reasons).toContain('upkeep-required');
    expect(d.upkeep.ran).toBe(1);
    expect(await (await fetch(rebound.urls.web)).text()).toBe('fallback-four');
  });
});

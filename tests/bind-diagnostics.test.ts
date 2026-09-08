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
    build: "mkdir -p .build; sleep 0.2; echo build-secret-marker >> .build/count"
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
    hot_reload: true
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
  expect(Object.keys(d.phasesMs).sort()).toEqual(['queue', 'prepare', 'appliances', 'sync', 'upkeep', 'stop', 'data', 'build', 'ready', 'finalize'].sort());
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
  it('explains actual cold builds, warm skips and changed-source rebuilds without persisting timings', async () => {
    const cold = await context(['up', '--ttl', '5']);
    const d = cold.bindDiagnostics!;
    checkTimings(d);
    expect(d.reuse).toBe('rebound');
    expect(d.builds).toEqual([{ service: 'web', cache: 'miss', reason: 'no-build-record' }]);
    expect(d.phasesMs.build).toBeGreaterThanOrEqual(150);
    expect(d.sync.copied).toBeGreaterThan(0);
    const countFile = join(state, 'envs', cold.envId, 'tree', '.build', 'count');
    const builds = () => readFileSync(countFile, 'utf8').trim().split('\n').length;
    expect(builds()).toBe(1);

    const warm = await context(['up']);
    checkTimings(warm.bindDiagnostics!);
    expect(warm.bindDiagnostics?.reuse).toBe('reused');
    expect(warm.bindDiagnostics?.builds).toEqual([{ service: 'web', cache: 'hit', reason: 'source-unchanged' }]);
    expect(warm.bindDiagnostics?.sync.copied).toBe(0);
    expect(builds()).toBe(1);
    expect((await context(['ctx'])).bindDiagnostics).toBeUndefined();

    writeFileSync(join(wt, 'content'), 'two');
    const changed = await context(['up']);
    checkTimings(changed.bindDiagnostics!);
    expect(changed.bindDiagnostics?.reuse).toBe('rebound');
    expect(changed.bindDiagnostics?.reasons).toContain('source-changed');
    expect(changed.bindDiagnostics?.builds).toEqual([{ service: 'web', cache: 'miss', reason: 'source-changed' }]);
    expect(builds()).toBe(2);
  });

  it('reports a hot-reload projection without claiming a build ran', async () => {
    writeFileSync(join(wt, 'content'), 'projected-three');
    const projected = await context(['sync']);
    const d = projected.bindDiagnostics!;
    checkTimings(d);
    expect(d.reuse).toBe('projected');
    expect(d.sync.copied).toBeGreaterThan(0);
    expect(d.builds.every((build) => build.cache === 'hit')).toBe(true);
    expect(d.phasesMs.build).toBe(0);
    expect(await (await fetch(projected.urls.web)).text()).toBe('projected-three');
    expect((await context(['ctx'])).bindDiagnostics).toBeUndefined();
    const reused = await context(['up']);
    expect(reused.bindDiagnostics?.reuse).toBe('reused');
    expect(reused.bindDiagnostics?.builds).toEqual([{ service: 'web', cache: 'skipped', reason: 'running-service-reused' }]);
    expect(readFileSync(join(state, 'envs', projected.envId, 'tree', '.build', 'count'), 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('includes files copied by a projection that falls back for pending upkeep', async () => {
    const manifest = join(wt, 'stack.yaml');
    writeFileSync(manifest, readFileSync(manifest, 'utf8') + '\nupkeep:\n  - { when: content, run: "true" }\n');
    writeFileSync(join(wt, 'content'), 'fallback-four');
    const rebound = await context(['sync']);
    const d = rebound.bindDiagnostics!;
    checkTimings(d);
    expect(d.reuse).toBe('rebound');
    expect(d.reasons).toContain('projection-fallback');
    expect(d.upkeep.ran).toBe(1);
    // The projection already copied both edits. The later full bind copies
    // nothing, so this checks the report includes the whole request.
    expect(d.sync.copied).toBeGreaterThanOrEqual(2);
    expect(await (await fetch(rebound.urls.web)).text()).toBe('fallback-four');
  });
});

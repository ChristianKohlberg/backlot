import { afterEach, expect, it } from 'vitest';
import { get } from 'node:http';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeCtx, SERVER, waitFor, type Ctx } from './support/context.js';

let c: Ctx | undefined;
afterEach(() => c?.dispose());
function request(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = get(url, { agent: false }, res => {
      let text = '';
      res.on('data', d => text += d);
      res.on('end', () => resolve(text));
      res.on('error', reject);
    });
    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
const manifest = (name: string) => ['name: ' + name, 'services:', '  web:',
  '    run: node server.mjs', '    port: web', '    env: { PORT: "{{ports.web}}" }',
  '    ready: { http: /, timeout: 10 }', '    idle: 800ms', ''].join('\n');

it('monitor stays read-only; cold traffic correlates wake and first byte; scoped history survives restart and invalid manifests', async () => {
  c = makeCtx({ BACKLOT_SERVICE_IDLE_MS: '800' });
  const wt = c.worktree({ 'runly.yaml': manifest('metrics-a'), 'server.mjs': SERVER });
  const other = c.worktree({ 'runly.yml': manifest('metrics-b'), 'server.mjs': SERVER });
  const up = await c.cli(['up', '--json'], wt);
  expect(up.code, up.stderr + up.stdout).toBe(0);
  expect((await c.cli(['up', '--json'], other)).code).toBe(0);
  const nested = join(wt, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'runly.yml'), manifest('metrics-nested'));
  const nestedStats = await c.cli(['stats', '--json'], nested);
  expect(nestedStats.code, nestedStats.stderr).toBe(0);
  expect(nestedStats.json.live.environments).toHaveLength(0);
  expect(nestedStats.json.series).toHaveLength(0);
  const before = await c.cli(['stats', '--json'], wt);
  expect(before.code, before.stderr + before.stdout).toBe(0);
  expect(before.json.series.some((s: {name: string}) => s.name === 'bind.total_ms')).toBe(true);
  expect(before.json.live.environments).toHaveLength(1);
  expect(before.json.series.every((s: {labels: {stack?: string}}) => s.labels.stack === before.json.scope)).toBe(true);

  const monitor = await c.cli(['monitor', '--json', '--interval', '250ms', '--timeout', '2'], wt);
  expect(monitor.code, monitor.stderr).toBe(0);
  const snapshots = monitor.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(snapshots.length).toBeGreaterThan(1);
  expect(snapshots.at(-1).live.environments[0].proxy.web.state).toBe('down');
  expect(snapshots.at(-1).series.some((s: {name: string}) => s.name === 'service.idle_stops')).toBe(true);
  const response = await request(up.json.urls.web);
  expect(response).toMatch(/^\d+$/);
  let stats = await c.cli(['stats', '--json'], wt);
  expect(await waitFor(async () => {
    stats = await c!.cli(['stats', '--json'], wt);
    return stats.json.recentOperations.some((o: {name: string}) => o.name === 'wake.total_ms');
  })).toBe(true);
  const wake = stats.json.recentOperations.find((o: {name: string}) => o.name === 'wake.total_ms');
  const firstByte = stats.json.recentOperations.find((o: {name: string; labels: {operationId?: string}}) =>
    o.name === 'proxy.first_byte_ms' && o.labels.operationId === wake.labels.operationId);
  expect(firstByte).toBeDefined();
  expect(stats.json.series.some((s: {name: string; total: number}) => s.name === 'proxy.server_bytes' && s.total > 0)).toBe(true);

  const file = join(wt, 'runly.yaml');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, 'invalid: [yaml');
  expect((await c.cli(['stats', '--json'], wt)).json.scope).toBe(before.json.scope);
  writeFileSync(file, original);
  await c.stopDaemon(wt);
  const recovered = await c.cli(['stats', '--json'], wt);
  expect(recovered.code, recovered.stderr).toBe(0);
  expect(recovered.json.series.some((s: {name: string}) => s.name === 'wake.total_ms')).toBe(true);
  expect(recovered.json.live.daemonStartedAt).toBeGreaterThan(stats.json.live.daemonStartedAt);
  expect(recovered.json.live.environments[0].proxy.web.accepted).toBe(0);
  const all = await c.cli(['stats', '--all', '--json'], wt);
  expect(all.json.live.environments).toHaveLength(2);
  expect(new Set(all.json.series.map((s: {labels: {stack?: string}}) => s.labels.stack)).size).toBe(2);
}, 60_000);

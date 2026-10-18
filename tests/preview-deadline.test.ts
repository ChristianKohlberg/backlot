import { afterEach, expect, it } from 'vitest';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ctx, runPreviewCleanups, tunnelPid, goneWithin } from './support/preview-fixture.js';
import { sleep } from './support/context.js';
afterEach(runPreviewCleanups);

it('defaults to thirty minutes, and successful up renews public access', async () => {
  const { cli } = ctx();
  const up = await cli(['up', '--json']);
  expect(up.json?.previewUrls).toEqual({});
  const before = Date.now();
  const preview = await cli(['preview', 'web', '--json']);
  expect(preview.code, preview.stderr).toBe(0);
  const expiresAt = Number(preview.json?.expiresAt);
  expect(expiresAt - before).toBeGreaterThanOrEqual(30 * 60_000);
  expect(expiresAt - Date.now()).toBeLessThanOrEqual(30 * 60_000);
  const again = await cli(['up', '--json']);
  expect(Number(again.json?.previewExpiresAt)).toBeGreaterThan(expiresAt);
  expect(Number(again.json?.previewExpiresAt) - Date.now()).toBeGreaterThan(30 * 60_000 - 3000);
  expect(again.json?.lease).toEqual(up.json?.lease);
});

it('restart preserves the absolute deadline; expiry closes only public access', async () => {
  const { cli, stateDir } = ctx();
  const up = await cli(['up', '--json']);
  const preview = await cli(['preview', 'web', '--ttl', '0.08', '--json']);
  expect(preview.code, preview.stderr).toBe(0);
  const expiresAt = Number(preview.json?.expiresAt);
  await cli(['daemon', 'stop', '--json']);
  const restored = await cli(['ctx', '--json']);
  expect(restored.json?.previewExpiresAt).toBe(expiresAt);
  await sleep(Math.max(0, expiresAt - Date.now()) + 700);
  const after = await cli(['ctx', '--json']);
  expect(after.json?.previewUrls).toEqual({});
  expect(after.json?.lease).toEqual(up.json?.lease);
  expect(after.json?.envId).toBe(up.json?.envId);
  expect(await goneWithin(tunnelPid(stateDir), 5000)).toBe(true);
});

it('public origin closes at its deadline even while a build holds the environment lock', async () => {
  const { cli, wt, stateDir } = ctx();
  await cli(['up', '--json']);
  const preview = await cli(['preview', 'web', '--ttl', '0.04', '--json']);
  expect(preview.code, preview.stderr).toBe(0);
  const args = JSON.parse(readFileSync(join(stateDir, 'tunnel.pid.args'), 'utf8')) as string[];
  const origin = args[args.indexOf('--url') + 1]!;
  expect((await fetch(origin)).status).toBe(200);
  const manifest = join(wt, 'runly.yml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('web: { run:', 'web: { build: "sleep 5", run:'));
  const building = cli(['up', '--json']);
  await sleep(Math.max(0, Number(preview.json?.expiresAt) - Date.now()) + 150);
  await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  expect((await building).code).toBe(0);
  const after = await cli(['ctx', '--json']);
  expect(after.json?.previewUrls).toHaveProperty('web');
  expect(Number(after.json?.previewExpiresAt)).toBeGreaterThan(Number(preview.json?.expiresAt));
  expect(tunnelPid(stateDir)).toBeGreaterThan(0);
  expect(after.json?.lease).toBeTruthy();
});

it.each(['expired', 'legacy'])('does not restore a %s publication after downtime', async kind => {
  const { cli, stateDir } = ctx();
  await cli(['up', '--json']);
  const before = await cli(['preview', 'web', '--ttl', '0.025', '--json']);
  expect(before.code).toBe(0);
  await cli(['daemon', 'stop', '--json']);
  if (kind === 'legacy') {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(stateDir, 'journal.db'));
    try {
      const row = db.prepare('SELECT id, preview_restore FROM leases').get()!;
      const restore = JSON.parse(String(row.preview_restore));
      delete restore.expiresAt;
      db.prepare('UPDATE leases SET preview_restore = ? WHERE id = ?').run(JSON.stringify(restore), String(row.id));
    } finally { db.close(); }
  } else await sleep(Math.max(0, Number(before.json?.expiresAt) - Date.now()) + 100);
  const after = await cli(['ctx', '--json']);
  expect(after.code).toBe(0);
  expect(after.json?.previewUrls).toEqual({});
  expect(after.json?.lease).toBeTruthy();
  expect(await goneWithin(tunnelPid(stateDir), 5000)).toBe(true);
  const reopened = await cli(['up', '--json']);
  expect(reopened.code, reopened.stderr).toBe(0);
  if (kind === 'expired') {
    expect(reopened.json?.previewUrls).toHaveProperty('web');
    expect(Number(reopened.json?.previewExpiresAt)).toBeGreaterThan(Date.now());
    expect(Number(reopened.json?.previewExpiresAt) - Date.now()).toBeLessThanOrEqual(1500);
  } else expect(reopened.json?.previewUrls).toEqual({});
});

it('successful up renews the custom TTL and the same origin survives its old deadline', async () => {
  const { cli, stateDir } = ctx();
  await cli(['up', '--json']);
  const published = await cli(['preview', 'web', '--ttl', '0.06', '--json']);
  expect(published.code).toBe(0);
  const oldDeadline = Number(published.json?.expiresAt);
  const args = JSON.parse(readFileSync(join(stateDir, 'tunnel.pid.args'), 'utf8')) as string[];
  const origin = args[args.indexOf('--url') + 1]!;
  const pid = tunnelPid(stateDir);
  await sleep(1200);
  const before = Date.now();
  const up = await cli(['up', '--json']);
  expect(up.code).toBe(0);
  const renewed = Number(up.json?.previewExpiresAt);
  expect(renewed).toBeGreaterThan(oldDeadline);
  expect(renewed - before).toBeGreaterThanOrEqual(3600);
  expect(renewed - Date.now()).toBeLessThanOrEqual(3600);
  expect(tunnelPid(stateDir)).toBe(pid);
  await sleep(Math.max(0, oldDeadline - Date.now()) + 100);
  expect((await fetch(origin, { signal: AbortSignal.timeout(1500) })).status).toBe(200);
  await sleep(Math.max(0, renewed - Date.now()) + 100);
  await expect(fetch(origin, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
});

it('failed up leaves the existing preview deadline unchanged', async () => {
  const { cli, wt } = ctx();
  await cli(['up', '--json']);
  const published = await cli(['preview', 'web', '--json']);
  const manifest = join(wt, 'runly.yml');
  writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('web: { run:', 'web: { build: "exit 1", run:'));
  const failed = await cli(['up', '--json']);
  expect(failed.code).not.toBe(0);
  const after = await cli(['ctx', '--json']);
  expect(after.json?.previewExpiresAt).toBe(published.json?.expiresAt);
});

it.each(['stop', 'forbidden'])('expired preview stays private after %s, including subsequent up', async action => {
  const { cli, wt } = ctx();
  await cli(['up', '--json']);
  const published = await cli(['preview', 'web', '--ttl', '0.025', '--json']);
  await sleep(Math.max(0, Number(published.json?.expiresAt) - Date.now()) + 500);
  expect((await cli(['ctx', '--json'])).json?.previewRestore).toMatchObject({state: 'expired'});
  const manifest = join(wt, 'runly.yml');
  const source = readFileSync(manifest, 'utf8');
  if (action === 'stop') expect((await cli(['preview', 'stop', '--json'])).code).toBe(0);
  else writeFileSync(manifest, source + '\npreview: { forbidden: true }\n');
  const up = await cli(['up', '--json']);
  expect(up.code, up.stderr).toBe(0);
  expect(up.json?.previewUrls).toEqual({});
  writeFileSync(manifest, source);
  expect((await cli(['up', '--json'])).json?.previewUrls).toEqual({});
});

it('failed up does not reopen expired access, and a publisher failure is reported without failing the services', async () => {
  const { cli, wt, stateDir } = ctx();
  await cli(['up', '--json']);
  const published = await cli(['preview', 'web', '--ttl', '0.04', '--json']);
  await sleep(Math.max(0, Number(published.json?.expiresAt) - Date.now()) + 400);
  const manifest = join(wt, 'runly.yml');
  const source = readFileSync(manifest, 'utf8');
  writeFileSync(manifest, source.replace('web: { run:', 'web: { build: "exit 1", run:'));
  expect((await cli(['up', '--json'])).code).not.toBe(0);
  expect((await cli(['ctx', '--json'])).json?.previewUrls).toEqual({});
  writeFileSync(manifest, source);
  renameSync(join(stateDir, 'fake-cloudflared'), join(stateDir, 'fake-cloudflared.disabled'));
  const up = await cli(['up', '--json']);
  expect(up.code, up.stderr).toBe(0);
  expect(up.json?.previewUrls).toEqual({});
  expect(up.json?.previewRestore).toMatchObject({state: 'failed'});
  expect(up.json?.previewNotice).toContain('could not be reopened');
  expect(up.json?.lastUpFailed).toBeNull();
});

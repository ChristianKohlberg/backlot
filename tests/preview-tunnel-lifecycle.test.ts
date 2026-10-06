/**
 * Lease-scoped public preview (decision 0027): the tunnel's teardown paths —
 * orphan reports, timeouts, failed binds, recycle, TTL, daemon stop — and the
 * preset/forbidden interplay. Split from preview-tunnel.test.ts so the two
 * halves run in parallel.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse, stringify } from 'yaml';
import { alive, ctx, FAKE_URL, goneWithin, runPreviewCleanups, tunnelPid } from './support/preview-fixture.js';

afterEach(runPreviewCleanups);

describe('preview tunnels (teardown and lifecycle)', () => {
  // A quiesced env is `warm` and its tunnel outlives the quiesce by design, so
  // the tag scan sees a tagged process with no live env. Reporting that as an
  // orphan is a permanent error naming a remedy (`pool gc`) that skips this pid.
  it('doctor does not call a quiesced lease-scoped tunnel an orphan', async () => {
    const { cli, stateDir } = ctx({ BACKLOT_SERVICE_IDLE_MS: '400', BACKLOT_IDLE_TTL_MS: '400' });
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    let quiesced = false;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !quiesced) {
      const pool = (await cli(['pool', 'ls', '--json'])).json;
      quiesced = JSON.stringify(pool).includes('"warm"');
    }
    expect(quiesced).toBe(true);
    expect(alive(pid)).toBe(true);
    const doc = await cli(['doctor', '--json']);
    const issues = (doc.json?.issues ?? []) as Array<{ issue: string }>;
    expect(issues.some((i) => /orphaned process .*preview:/.test(i.issue))).toBe(false);
  });

  // Giving up on the WAIT is not giving up on the PROCESS: a merely slow tunnel
  // publishes its URL right after the timeout, and with no pid ever returned
  // there is no lease row, no gc entry and no `preview stop` that could name it.
  it('kills the tunnel process when it times out before publishing a URL', async () => {
    const { cli, stateDir } = ctx({ BACKLOT_PREVIEW_START_TIMEOUT_MS: '700' }, '', false, true);
    await cli(['up', '--json']);
    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    expect(String(prev.stderr + prev.stdout)).toMatch(/timed out waiting for cloudflared/);
    expect(await goneWithin(tunnelPid(stateDir), 5000)).toBe(true);
  });

  // A reusing up re-reads the manifest and refreshes the lease clock, so the
  // kill switch must take effect there too, not only on a full bind.
  it('honours preview.forbidden on a repeated up, not only on a full bind', async () => {
    const { cli, wt, stateDir } = ctx({}, '', true);
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    writeFileSync(join(wt, 'stack.yaml'), readFileSync(join(wt, 'stack.yaml'), 'utf8') + 'preview:\n  forbidden: true\n');
    writeFileSync(join(wt, 'note.txt'), 'edited\n');
    const synced = await cli(['up', '--json']);
    expect(synced.code).toBe(0);
    expect(synced.json?.previewUrls).toEqual({});
    expect(String(synced.json?.previewNotice)).toMatch(/work-error: stack.yaml now sets preview.forbidden/);
    expect(await goneWithin(pid, 10_000)).toBe(true);
  });

  // A startup configuration edit cannot be applied by projection. The full
  // bind commits the new port and reconciles the tunnel against that result.
  it('rebinds a port-key edit and stops the tunnel when its committed target moves', async () => {
    const { cli, wt, stateDir } = ctx({}, '', true);
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    writeFileSync(
      join(wt, 'stack.yaml'),
      readFileSync(join(wt, 'stack.yaml'), 'utf8').replace('port: web, env: { PORT: "{{ports.web}}" }', 'port: frontend, env: { PORT: "{{ports.frontend}}" }'),
    );
    const synced = await cli(['up', '--json']);
    expect(synced.code).toBe(0);
    expect(synced.json?.bindDiagnostics?.reuse).toBe('rebound');
    expect(synced.json?.previewUrls).toEqual({});
    expect(String(synced.json?.previewNotice)).toMatch(/moved from port .* torn down/);
    expect(alive(pid)).toBe(false);
  });

  it('keeps the tunnel when a startup env change rebinds on the same port', async () => {
    const { cli, wt, stateDir } = ctx({}, '', true);
    const before = await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    writeFileSync(join(wt, 'stack.yaml'), readFileSync(join(wt, 'stack.yaml'), 'utf8')
      .replace('env: { PORT:', 'env: { VALUE: changed, PORT:'));
    const synced = await cli(['up', '--json']);
    expect(synced.code).toBe(0);
    expect(synced.json?.bindDiagnostics?.reuse).toBe('rebound');
    expect(synced.json?.urls).toEqual(before.json?.urls);
    expect(synced.json?.previewUrls).toEqual({ web: FAKE_URL });
    expect(synced.json?.previewNotice).toBeUndefined();
    expect(alive(pid)).toBe(true);
  });

  // Tearing the live tunnel down and only then discovering the publisher cannot
  // run leaves the caller with no preview and an error reading as a no-op.
  it('does not kill the live tunnel when the new publish cannot even start', async () => {
    const { cli, stateDir } = ctx();
    const up = await cli(['up', '--json']);
    expect(up.code, up.stdout + up.stderr).toBe(0);
    const published = await cli(['preview', 'web', '--json']);
    expect(published.code, published.stdout + published.stderr).toBe(0);
    expect(published.json?.url).toBe(FAKE_URL);
    const pid = tunnelPid(stateDir);
    rmSync(join(stateDir, 'fake-cloudflared'));
    const second = await cli(['preview', 'api', '--json']);
    expect(second.code).toBe(2);
    expect(String(second.stderr + second.stdout)).toMatch(/preview requires cloudflared/);
    expect(alive(pid)).toBe(true);
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls).toEqual({ web: FAKE_URL });
  });

  // The teardown's own justification ("not in this bind's running set") is only
  // true once the bind commits that set — a bind that fails leaves the old shape
  // in the journal, so the next `up` brings the service back to a killed tunnel.
  it('keeps the tunnel when a bind fails', async () => {
    const { cli, wt, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    writeFileSync(join(wt, 'boom.mjs'), `process.exit(1);\n`);
    writeFileSync(
      join(wt, 'stack.yaml'),
      readFileSync(join(wt, 'stack.yaml'), 'utf8').replace('api: { run: node srv.mjs', 'api: { run: node boom.mjs'),
    );
    const narrowed = await cli(['up', 'api', '--json']);
    expect(narrowed.code).not.toBe(0);
    expect(alive(pid)).toBe(true);
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls).toEqual({ web: FAKE_URL });
  });

  // The tunnel's pid lives on the LEASE row, and teardown deletes that row
  // outright — so before the reap moved to reapEnvProcesses, a force-recycle
  // left the public URL serving with nothing left that could ever name it.
  it('a forced recycle reaps the tunnel before the lease row is deleted', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    expect(alive(pid)).toBe(true);
    const rec = await cli(['pool', 'recycle', '--force', '--json']);
    expect(rec.code).toBe(0);
    expect(await goneWithin(pid, 10_000)).toBe(true);
  });

  // A lapsed TTL ends the lease without anyone asking, and the tunnel is scoped
  // to the LEASE — an agent that wandered off must not leave a public,
  // unauthenticated URL serving for as long as the host stays up.
  it('a lapsed TTL reaps the tunnel with the lease it was scoped to', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    const prev = await cli(['preview', 'web', '--ttl', '0.05', '--json']);
    expect(prev.code).toBe(0);
    const pid = tunnelPid(stateDir);
    expect(alive(pid)).toBe(true);
    expect(await goneWithin(pid, 20_000)).toBe(true);
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls ?? {}).toEqual({});
  });

  // A graceful daemon stop leaves the LEASE standing (that is the contract) but
  // nothing is left to supervise a published URL, so the tunnel goes with it.
  it('a graceful daemon stop reaps the tunnel even though the lease survives', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    expect(alive(pid)).toBe(true);
    const stopped = await cli(['daemon', 'stop', '--json']);
    expect(stopped.code).toBe(0);
    expect(await goneWithin(pid, 15_000)).toBe(true);
    // The lease is still ours on the next verb (a new daemon autospawns), and it
    // no longer advertises a URL that stopped answering.
    const c = await cli(['ctx', '--json']);
    expect(c.code).toBe(0);
    expect(c.json?.previewUrls ?? {}).toEqual({});
  });
});


function presetPreview(hotReload = false) {
  const f = ctx({}, '', hotReload);
  const manifestPath = join(f.wt, 'stack.yaml');
  const manifest = parse(readFileSync(manifestPath, 'utf8'));
  manifest.datastores = { main: {
    driver: 'sqlite', presets: ['dev', 'alternate'], default_preset: { session: 'dev' },
    create: 'node seed.mjs "{{ns}}" "{{preset}}"', template: true,
  } };
  writeFileSync(manifestPath, stringify(manifest));
  writeFileSync(join(f.wt, 'seed.mjs'), `import {DatabaseSync} from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('CREATE TABLE marker(value TEXT)');
db.prepare('INSERT INTO marker VALUES (?)').run(process.argv[3]);db.close();
`);
  const marker = (url: string) => {
    const db = new DatabaseSync(url);
    try { return db.prepare('SELECT value FROM marker').get()!.value; } finally { db.close(); }
  };
  return { ...f, manifest, manifestPath, marker };
}

it.each([
  { args: ['up'], hotReload: false },
  { args: ['reset-data'], hotReload: false },
  { args: ['up', '--preset', 'alternate'], hotReload: false },
  { args: ['reset-data', '--preset', 'alternate'], hotReload: false },
])('enforces forbidden preview before invalid presets: $args reload=$hotReload', async ({ args, hotReload }) => {
  const f = presetPreview(hotReload);
  try {
    const up = await f.cli(['up', '--json']);
    expect(up.code, up.stdout + up.stderr).toBe(0);
    const stores = up.json!.datastores as Record<string, {url: string}>;
    const url = stores.main!.url;
    expect(f.marker(url)).toBe('dev');
    const published = await f.cli(['preview', 'web', '--json']);
    expect(published.code, published.stdout + published.stderr).toBe(0);
    const pid = tunnelPid(f.stateDir);
    expect(alive(pid)).toBe(true);
    f.manifest.preview = { forbidden: true };
    f.manifest.datastores.main.default_preset.session = 'missing';
    writeFileSync(f.manifestPath, stringify(f.manifest));
    const failed = await f.cli([...args, '--json']);
    expect(failed.code, failed.stdout + failed.stderr).toBe(1);
    expect(failed.stdout).toContain("default preset 'missing'");
    expect(await goneWithin(pid, 5000)).toBe(true);
    expect((await f.cli(['ctx', '--json'])).json?.previewUrls).toEqual({});
    expect(f.marker(url)).toBe('dev');
  } finally {
    await f.cli(['daemon', 'stop', '--json']);
  }
}, 30000);

it('retains the forbidden preview notice through a preset refresh fallback', async () => {
  const f = presetPreview(true);
  try {
    const up = await f.cli(['up', '--preset', 'alternate', '--json']);
    expect(up.code, up.stdout + up.stderr).toBe(0);
    const projected = await f.cli(['up', '--json']);
    expect((projected.json?.bindDiagnostics as {reuse: string}).reuse).toBe('reused');
    const published = await f.cli(['preview', 'web', '--json']);
    expect(published.code, published.stdout + published.stderr).toBe(0);
    const pid = tunnelPid(f.stateDir);
    f.manifest.preview = { forbidden: true };
    f.manifest.datastores.main.presets = ['dev'];
    writeFileSync(f.manifestPath, stringify(f.manifest));
    const synced = await f.cli(['up', '--json']);
    expect(synced.code, synced.stdout + synced.stderr).toBe(0);
    expect(synced.json?.previewUrls).toEqual({});
    expect(String(synced.json?.previewNotice)).toMatch(/preview.forbidden.*torn down/);
    expect((synced.json?.bindDiagnostics as {reasons: string[]}).reasons).toContain('manifest-changed');
    // No preset keeps the data (decision 0034), even one the catalog dropped.
    const stores = synced.json!.datastores as Record<string, {url: string; preset: string}>;
    expect(stores.main!.preset).toBe('alternate');
    expect(f.marker(stores.main!.url)).toBe('alternate');
    expect(await goneWithin(pid, 5000)).toBe(true);
    expect((await f.cli(['ctx', '--json'])).json?.previewNotice).toBeUndefined();
  } finally {
    await f.cli(['daemon', 'stop', '--json']);
  }
}, 30000);


/**
 * Lease-scoped public preview via Cloudflare quick tunnels (decision 0027):
 * publishing, stopping, and what binds do to a live tunnel. The teardown and
 * lifecycle half is preview-tunnel-lifecycle.test.ts (split so the two run in
 * parallel).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { alive, ctx, FAKE_URL, goneWithin, runPreviewCleanups, tunnelPid } from './support/preview-fixture.js';

afterEach(runPreviewCleanups);

describe('preview tunnels', () => {
  it('publishes a service and reports the URL in ctx', async () => {
    const { cli } = ctx();
    const up = await cli(['up', '--json']);
    expect(up.code).toBe(0);
    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(0);
    expect(prev.json?.url).toBe(FAKE_URL);
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls).toEqual({ web: FAKE_URL });
  });

  it('refuses preview when the manifest forbids it (work-error)', async () => {
    const { cli } = ctx({}, 'preview:\n  forbidden: true\n');
    await cli(['up', '--json']);
    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(1);
    expect(String(prev.stderr + prev.stdout)).toMatch(/forbids public preview|work-error/i);
  });

  it('reports env-error when cloudflared is missing', async () => {
    const { cli } = ctx({ BACKLOT_CLOUDFLARED: '/nonexistent/cloudflared' });
    await cli(['up', '--json']);
    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    expect(String(prev.stderr + prev.stdout)).toMatch(/cloudflared|env-error/i);
  });

  it('preview stop kills the tunnel and drops it from ctx', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    expect(alive(pid)).toBe(true);
    const stop = await cli(['preview', 'stop', '--json']);
    expect(stop.code).toBe(0);
    expect(stop.json?.stopped).toBe(true);
    expect(await goneWithin(pid, 5000)).toBe(true);
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls).toEqual({});
  });

  it('release reaps the tunnel process — nothing survives the lease', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    expect(alive(pid)).toBe(true);
    const rel = await cli(['release', '--json']);
    expect(rel.code).toBe(0);
    expect(await goneWithin(pid, 5000)).toBe(true);
  });

  // Preview is scoped to the LEASE, not to the service incarnation it publishes.
  // Ports are stable for an environment's lifetime (decision 0004), so a rebind
  // that merely restarts services leaves the tunnel pointing at the same place.
  it('survives a rebind that restarts the services it publishes', async () => {
    const { cli, wt, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    writeFileSync(
      join(wt, 'srv.mjs'),
      `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok2')).listen(Number(process.env.PORT), '127.0.0.1');\n`,
    );
    const again = await cli(['up', '--json']);
    expect(again.code).toBe(0);
    expect(again.json?.previewUrls).toEqual({ web: FAKE_URL });
    expect(alive(pid)).toBe(true);
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls).toEqual({ web: FAKE_URL });
  });

  // …but a tunnel aimed at a port the service no longer listens on publishes
  // nothing, so that one IS torn down — and said out loud, because the URL was
  // already shared with someone.
  it('tears the tunnel down when the previewed service moves to another port', async () => {
    const { cli, wt, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: previewtest\nservices:\n  web: { run: node srv.mjs, port: frontend, env: { PORT: "{{ports.frontend}}" }, ready: { log: ready, timeout: 20 } }\n`,
    );
    const again = await cli(['up', '--json']);
    expect(again.code).toBe(0);
    expect(again.json?.previewUrls).toEqual({});
    expect(String(again.json?.previewNotice)).toMatch(/moved from port .* torn down/);
    expect(await goneWithin(pid, 10_000)).toBe(true);
  });

  // The URL does not change when the data behind it does, so nothing about the
  // link tells the person holding it that it now serves a different database.
  it('warns that the unchanged public URL serves new data after a reset', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    const again = await cli(['up', '--reset-data', '--json']);
    expect(again.code).toBe(0);
    expect(again.json?.previewUrls).toEqual({ web: FAKE_URL });
    expect(String(again.json?.previewNotice)).toMatch(/reset-data bind replaced the data behind it/);
    expect(alive(pid)).toBe(true);
    // One-shot: the next read is not still reporting a bind that already happened.
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewNotice).toBeUndefined();
  });

  // A quick tunnel is best-effort and exits on its own; nothing looked while
  // the daemon was up, so ctx kept advertising a URL that had stopped answering.
  it('drops the URL from ctx once the tunnel exits on its own', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    const before = await cli(['ctx', '--json']);
    expect(before.json?.previewUrls).toEqual({ web: FAKE_URL });
    process.kill(pid, 'SIGKILL');
    expect(await goneWithin(pid, 5000)).toBe(true);
    let previewUrls: unknown = { web: FAKE_URL };
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      previewUrls = (await cli(['ctx', '--json'])).json?.previewUrls;
      if (JSON.stringify(previewUrls) === '{}') break;
    }
    expect(previewUrls).toEqual({});
  });

  // The publisher name is a seam: checking cloudflared on behalf of a stack
  // that names another provider tells it to install a tool it does not use.
  it('doctor reports the publisher the manifest actually names', async () => {
    // A path that does not exist, so the DEFAULT publisher's prerequisite would
    // fail — the absence of a cloudflared issue is then real evidence that
    // doctor never checked a publisher this stack does not use.
    const { cli } = ctx({ BACKLOT_CLOUDFLARED: '/nonexistent/cloudflared' }, 'preview:\n  publisher: some-future-adapter\n');
    await cli(['up', '--json']);
    const doc = await cli(['doctor', '--json']);
    const issues = (doc.json?.issues ?? []) as Array<{ level: string; issue: string }>;
    expect(issues.some((i) => /unknown preview publisher 'some-future-adapter'/.test(i.issue))).toBe(true);
    expect(issues.some((i) => /cloudflared/.test(i.issue))).toBe(false);
  });

  // Crash recovery must reap the tunnel like any other managed process — and
  // 'like any other' means cross-platform, not via the Linux-only tag scan.
  it('a daemon that was killed outright reaps the tunnel when it comes back', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    expect(alive(pid)).toBe(true);
    process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')), 'SIGKILL');
    const status = await cli(['status', '--json']);
    expect(status.code).toBe(0);
    expect(await goneWithin(pid, 10_000)).toBe(true);
  });

  // Nothing brings the service back this lease, so the URL would publish a port
  // with nothing behind it — the same rule `preview <out-of-slice>` is refused by.
  it('tears the tunnel down when `down` stops the previewed service', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    const narrowed = await cli(['down', 'web', '--json']);
    expect(narrowed.code).toBe(0);
    expect(narrowed.json?.previewUrls).toEqual({});
    expect(String(narrowed.json?.previewNotice)).toMatch(/env-error: service 'web' is not in this bind's running set/);
    expect(await goneWithin(pid, 10_000)).toBe(true);
  });

  // The kill switch has to act on what is already published, not merely refuse
  // the next publish — README presents it as "must never be published".
  it('tears the tunnel down when the manifest starts forbidding preview', async () => {
    const { cli, wt, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    writeFileSync(join(wt, 'stack.yaml'), readFileSync(join(wt, 'stack.yaml'), 'utf8') + 'preview:\n  forbidden: true\n');
    const again = await cli(['up', '--json']);
    expect(again.code).toBe(0);
    expect(again.json?.previewUrls).toEqual({});
    expect(String(again.json?.previewNotice)).toMatch(/work-error: stack.yaml now sets preview.forbidden/);
    expect(await goneWithin(pid, 10_000)).toBe(true);
  });

});

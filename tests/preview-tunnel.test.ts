/**
 * Lease-scoped public preview via Cloudflare quick tunnels (decision 0027).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse, stringify } from 'yaml';
import { scanTagged } from '../src/core/procscan.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const FAKE_URL = 'https://fake-preview-test.trycloudflare.com';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/**
 * Liveness of a pid this process did not spawn. The tunnel is a child of the
 * DAEMON, so signal 0 is the only cross-platform verdict available here — the
 * tag scan these tests used to assert on is Linux-only and silently passes
 * "nothing is running" on macOS.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

function tunnelPid(stateDir: string): number {
  const raw = Number(readFileSync(join(stateDir, 'tunnel.pid'), 'utf8').trim());
  expect(Number.isInteger(raw) && raw > 0).toBe(true);
  return raw;
}

function makeFakeCloudflared(dir: string): string {
  const script = join(dir, 'fake-cloudflared.mjs');
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
const u = process.env.FAKE_PREVIEW_URL || '${FAKE_URL}';
writeFileSync(process.env.FAKE_PREVIEW_PIDFILE, String(process.pid));
setTimeout(() => {}, 3600_000);
const emit = () => console.error('INF |  ' + u);
emit();
setInterval(emit, 500);
`,
  );
  const wrapper = join(dir, 'fake-cloudflared');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

/** A tunnel that records its pid and then never publishes a URL — the slow-network case. */
function makeMuteCloudflared(dir: string): string {
  const script = join(dir, 'mute-cloudflared.mjs');
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.FAKE_PREVIEW_PIDFILE, String(process.pid));
setTimeout(() => {}, 3600_000);
`,
  );
  const wrapper = join(dir, 'mute-cloudflared');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function ctx(extraEnv: Record<string, string> = {}, stackExtra = '', hotReload = false, mute = false) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-preview-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-preview-wt-'));
  writeFileSync(
    join(wt, 'srv.mjs'),
    `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n`,
  );
  writeFileSync(
    join(wt, 'stack.yaml'),
    `name: previewtest\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: ready, timeout: 20 }${hotReload ? ', hot_reload: true' : ''} }\n  api: { run: node srv.mjs, port: api, env: { PORT: "{{ports.api}}" }, ready: { log: ready, timeout: 20 }${hotReload ? ', hot_reload: true' : ''} }\n${stackExtra}`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  const cloudflared = mute ? makeMuteCloudflared(stateDir) : makeFakeCloudflared(stateDir);
  const env = {
    ...process.env,
    BACKLOT_STATE_DIR: stateDir,
    BACKLOT_SWEEP_MS: '300',
    BACKLOT_CLOUDFLARED: cloudflared,
    FAKE_PREVIEW_URL: FAKE_URL,
    FAKE_PREVIEW_PIDFILE: join(stateDir, 'tunnel.pid'),
    ...extraEnv,
  };
  const cli = (args: string[], cwd = wt) =>
    new Promise<{ code: number; json?: Record<string, unknown>; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const cleanup = async () => {
    // Reap detached services through their supervisor on both platforms before
    // killing the daemon: scanTagged cannot find them on macOS. Do this after
    // each test so idle daemons and services do not exhaust the runner's pids.
    const stopped = await cli(['daemon', 'stop', '--json']);
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
    for (const p of scanTagged(stateDir)) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    try {
      process.kill(tunnelPid(stateDir), 'SIGKILL');
    } catch {
      /* never started, or already gone */
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
  };
  cleanups.push(cleanup);
  return { wt, cli, stateDir, cleanup };
}

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
  it('tears the tunnel down when a bind drops the previewed service from the slice', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    const narrowed = await cli(['up', 'api', '--json']);
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
    expect(String(again.json?.previewNotice)).toMatch(/work-error: backlot.yml now sets preview.forbidden/);
    expect(await goneWithin(pid, 10_000)).toBe(true);
  });

  // A quiesced env is `warm` and its tunnel outlives the quiesce by design, so
  // the tag scan sees a tagged process with no live env. Reporting that as an
  // orphan is a permanent error naming a remedy (`pool gc`) that skips this pid.
  it('doctor does not call a quiesced lease-scoped tunnel an orphan', async () => {
    const { cli, stateDir } = ctx({ BACKLOT_LEASED_IDLE_TTL_MS: '400', BACKLOT_IDLE_TTL_MS: '400' });
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

  // A projection re-reads the manifest and refreshes the lease clock, so under
  // a watcher the kill switch would otherwise not take effect for days.
  it('honours preview.forbidden on a projecting sync, not only on a full bind', async () => {
    const { cli, wt, stateDir } = ctx({}, '', true);
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    writeFileSync(join(wt, 'stack.yaml'), readFileSync(join(wt, 'stack.yaml'), 'utf8') + 'preview:\n  forbidden: true\n');
    writeFileSync(join(wt, 'note.txt'), 'edited\n');
    const synced = await cli(['sync', '--json']);
    expect(synced.code).toBe(0);
    expect(synced.json?.previewUrls).toEqual({});
    expect(String(synced.json?.previewNotice)).toMatch(/work-error: backlot.yml now sets preview.forbidden/);
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
    const synced = await cli(['sync', '--json']);
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
    const synced = await cli(['sync', '--json']);
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
  it('keeps the tunnel when the bind that would have narrowed the slice fails', async () => {
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
  { args: ['sync'], hotReload: false },
  { args: ['up', '--preset', 'alternate'], hotReload: false },
  { args: ['reset-data', '--preset', 'alternate'], hotReload: false },
  { args: ['sync'], hotReload: true },
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
    const projectedManifest = join(f.stateDir, 'envs', String(up.json!.envId), 'tree', 'stack.yaml');
    const before = readFileSync(projectedManifest, 'utf8');
    f.manifest.preview = { forbidden: true };
    f.manifest.datastores.main.default_preset.session = 'missing';
    writeFileSync(f.manifestPath, stringify(f.manifest));
    const failed = await f.cli([...args, '--json']);
    expect(failed.code, failed.stdout + failed.stderr).toBe(1);
    expect(failed.stdout).toContain("default preset 'missing'");
    expect(await goneWithin(pid, 5000)).toBe(true);
    expect((await f.cli(['ctx', '--json'])).json?.previewUrls).toEqual({});
    expect(f.marker(url)).toBe('dev');
    expect(readFileSync(projectedManifest, 'utf8')).toBe(before);
  } finally {
    await f.cli(['daemon', 'stop', '--json']);
  }
}, 30000);

it('retains the forbidden preview notice through preset projection fallback', async () => {
  const f = presetPreview(true);
  try {
    const up = await f.cli(['up', '--preset', 'alternate', '--json']);
    expect(up.code, up.stdout + up.stderr).toBe(0);
    const projected = await f.cli(['sync', '--json']);
    expect((projected.json?.bindDiagnostics as {reuse: string}).reuse).toBe('projected');
    const published = await f.cli(['preview', 'web', '--json']);
    expect(published.code, published.stdout + published.stderr).toBe(0);
    const pid = tunnelPid(f.stateDir);
    f.manifest.preview = { forbidden: true };
    f.manifest.datastores.main.presets = ['dev'];
    writeFileSync(f.manifestPath, stringify(f.manifest));
    const synced = await f.cli(['sync', '--json']);
    expect(synced.code, synced.stdout + synced.stderr).toBe(0);
    expect(synced.json?.previewUrls).toEqual({});
    expect(String(synced.json?.previewNotice)).toMatch(/preview.forbidden.*torn down/);
    expect((synced.json?.bindDiagnostics as {reasons: string[]}).reasons).toContain('datastore-preset-changed');
    const stores = synced.json!.datastores as Record<string, {url: string; preset: string}>;
    expect(stores.main!.preset).toBe('dev');
    expect(f.marker(stores.main!.url)).toBe('dev');
    expect(await goneWithin(pid, 5000)).toBe(true);
    expect((await f.cli(['ctx', '--json'])).json?.previewNotice).toBeUndefined();
  } finally {
    await f.cli(['daemon', 'stop', '--json']);
  }
}, 30000);

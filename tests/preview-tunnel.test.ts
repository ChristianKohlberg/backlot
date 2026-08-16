/**
 * Lease-scoped public preview via Cloudflare quick tunnels (decision 0027).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTagged } from '../src/core/procscan.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const FAKE_URL = 'https://fake-preview-test.trycloudflare.com';

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
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
    `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT));\n`,
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
  const cleanup = () => {
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
      `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok2')).listen(Number(process.env.PORT));\n`,
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
    const { cli } = ctx({}, 'preview:\n  publisher: some-future-adapter\n');
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

  // A projection restarts nothing and allocates nothing: the renamed port key
  // only takes effect at the next full bind, so until then the service is still
  // listening exactly where the tunnel points.
  it('keeps the tunnel on a projecting sync that only renames the port key', async () => {
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
    expect(synced.json?.previewUrls).toEqual({ web: FAKE_URL });
    expect(synced.json?.previewNotice).toBeUndefined();
    expect(alive(pid)).toBe(true);
  });

  // Tearing the live tunnel down and only then discovering the publisher cannot
  // run leaves the caller with no preview and an error reading as a no-op.
  it('does not kill the live tunnel when the new publish cannot even start', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    rmSync(join(stateDir, 'fake-cloudflared'));
    const second = await cli(['preview', 'api', '--json']);
    expect(second.code).toBe(2);
    expect(String(second.stderr + second.stdout)).toMatch(/preview requires cloudflared/);
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
});

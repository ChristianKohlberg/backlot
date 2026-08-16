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

function ctx(extraEnv: Record<string, string> = {}, stackExtra = '') {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-preview-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-preview-wt-'));
  writeFileSync(
    join(wt, 'srv.mjs'),
    `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT));\n`,
  );
  writeFileSync(
    join(wt, 'stack.yaml'),
    `name: previewtest\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: ready, timeout: 20 } }\n${stackExtra}`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  const fake = makeFakeCloudflared(stateDir);
  const env = {
    ...process.env,
    BACKLOT_STATE_DIR: stateDir,
    BACKLOT_SWEEP_MS: '300',
    BACKLOT_CLOUDFLARED: fake,
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

  // Every env-level stop reaps the tunnel, and the record must go with it.
  // A rebind kills the tunnel (its process is tagged with the env), so a ctx
  // that still advertised the URL was pointing the world at a dead endpoint.
  it('a rebind that restarts services reaps the tunnel and clears it from ctx', async () => {
    const { cli, wt, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = tunnelPid(stateDir);
    expect(alive(pid)).toBe(true);
    writeFileSync(
      join(wt, 'srv.mjs'),
      `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok2')).listen(Number(process.env.PORT));\n`,
    );
    const again = await cli(['up', '--json']);
    expect(again.code).toBe(0);
    expect(await goneWithin(pid, 10_000)).toBe(true);
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls).toEqual({});
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

/**
 * Shared fixture of the preview-tunnel tests (decision 0027): a fake
 * cloudflared, a private state root, and a CLI bound to it.
 */
import { expect } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanTagged } from '../../src/core/procscan.js';
import { disposeStateSync } from './leaks.js';

const repo = join(import.meta.dirname, '..', '..');
export const CLI = join(repo, 'dist', 'cli', 'index.js');
export const FAKE_URL = 'https://fake-preview-test.trycloudflare.com';

const cleanups: Array<() => Promise<void>> = [];
/** Each test file calls this from its own afterEach. */
export async function runPreviewCleanups(): Promise<void> {
  for (const c of cleanups.splice(0)) await c();
}

/**
 * Liveness of a pid this process did not spawn. The tunnel is a child of the
 * DAEMON, so signal 0 is the only cross-platform verdict available here — the
 * tag scan these tests used to assert on is Linux-only and silently passes
 * "nothing is running" on macOS.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

export function tunnelPid(stateDir: string): number {
  const raw = Number(readFileSync(join(stateDir, 'tunnel.pid'), 'utf8').trim());
  expect(Number.isInteger(raw) && raw > 0).toBe(true);
  return raw;
}

export function makeFakeCloudflared(dir: string): string {
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
export function makeMuteCloudflared(dir: string): string {
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

export function ctx(extraEnv: Record<string, string> = {}, stackExtra = '', hotReload = false, mute = false) {
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
    disposeStateSync(stateDir);
    rmSync(wt, { recursive: true, force: true });
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
  };
  cleanups.push(cleanup);
  return { wt, cli, stateDir, cleanup };
}


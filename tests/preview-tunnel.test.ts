/**
 * Lease-scoped public preview via Cloudflare quick tunnels (decision 0027).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { procScanSupported, scanTagged } from '../src/core/procscan.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const FAKE_URL = 'https://fake-preview-test.trycloudflare.com';

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

function makeFakeCloudflared(dir: string): string {
  const script = join(dir, 'fake-cloudflared.mjs');
  writeFileSync(
    script,
    `const u = process.env.FAKE_PREVIEW_URL || '${FAKE_URL}';
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

  it('preview stop clears the tunnel', async () => {
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    expect(scanTagged(stateDir).some((p) => p.service.startsWith('preview:'))).toBe(true);
    const stop = await cli(['preview', 'stop', '--json']);
    expect(stop.code).toBe(0);
    expect(stop.json?.stopped).toBe(true);
    expect(scanTagged(stateDir).some((p) => p.service.startsWith('preview:'))).toBe(false);
  });

  it('release reaps the tunnel process — nothing survives the lease', async () => {
    if (!procScanSupported()) return;
    const { cli, stateDir } = ctx();
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    expect(scanTagged(stateDir).filter((p) => p.service.startsWith('preview:')).length).toBeGreaterThan(0);
    const rel = await cli(['release', '--json']);
    expect(rel.code).toBe(0);
    await new Promise((r) => setTimeout(r, 500));
    expect(scanTagged(stateDir).filter((p) => p.service.startsWith('preview:')).length).toBe(0);
  });
});

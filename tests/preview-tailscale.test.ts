/**
 * The `tailscale` preview publisher (decision 0031).
 *
 * What it adds over the Cloudflare publishers is a private address: the
 * machine's own tailnet name, served by a FOREGROUND `tailscale serve` whose
 * mapping lives exactly as long as the process. So these tests assert the URL,
 * the port choice (pinned, derived, and walking past a busy port), the
 * refusals that must happen before anything is served, and that stopping the
 * preview ends the process — which is what ends the mapping.
 *
 * tailscale is faked. A real one would change the serve config of whatever
 * machine runs the suite, which is not a thing a test suite may do.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { scanTagged } from '../src/core/procscan.js';
import { deriveTailnetPort, tailnetPortsInUse } from '../src/drivers/preview.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

/**
 * A tailscale that answers `status --json`, `debug prefs` and
 * `serve status --json`, and plays a foreground `serve --https=<port> <url>`.
 *
 * Live sessions are files under FAKE_TS_DIR/serving/<port> holding the serving
 * pid, and `serve status` reports only those whose pid is alive — the same
 * "the mapping is the process" rule the real tailscaled applies to foreground
 * sessions. FAKE_TS_BUSY lists ports some other publication already holds.
 */
function makeFakeTailscale(dir: string): string {
  const script = join(dir, 'fake-tailscale.mjs');
  writeFileSync(
    script,
    `import { writeFileSync, appendFileSync, existsSync, readdirSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const dir = process.env.FAKE_TS_DIR;
appendFileSync(join(dir, 'calls.txt'), args.join(' ') + '\\n');
const serving = join(dir, 'serving');
mkdirSync(serving, { recursive: true });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

if (args[0] === 'status' && args[1] === '--json') {
  process.stdout.write(JSON.stringify({
    BackendState: process.env.FAKE_TS_STATE || 'Running',
    Self: { DNSName: 'box.tail1234.ts.net.' },
    CertDomains: process.env.FAKE_TS_NOCERT ? null : ['box.tail1234.ts.net'],
  }));
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'prefs') {
  process.stdout.write(JSON.stringify({ OperatorUser: process.env.FAKE_TS_OPERATOR ?? '' }));
  process.exit(0);
}
if (args[0] === 'serve' && args[1] === 'status') {
  const tcp = {};
  for (const p of (process.env.FAKE_TS_BUSY || '').split(',').filter(Boolean)) tcp[p] = { HTTPS: true };
  const fg = {};
  for (const f of readdirSync(serving)) {
    const pid = Number(readFileSync(join(serving, f), 'utf8'));
    if (alive(pid)) fg['s' + f] = { TCP: { [f]: { HTTPS: true } } };
  }
  process.stdout.write(JSON.stringify({ TCP: tcp, Foreground: fg }));
  process.exit(0);
}
if (args[0] === 'serve' && args[1].startsWith('--https=')) {
  const port = args[1].slice('--https='.length);
  if (process.env.FAKE_TS_DENY) {
    console.error('sending serve config: Access denied: serve config denied');
    process.exit(1);
  }
  writeFileSync(join(serving, port), String(process.pid));
  writeFileSync(process.env.FAKE_PREVIEW_PIDFILE, String(process.pid));
  const drop = () => { rmSync(join(serving, port), { force: true }); process.exit(0); };
  process.on('SIGTERM', drop);
  process.on('SIGINT', drop);
  console.log('Available within your tailnet:\\n\\nhttps://box.tail1234.ts.net:' + port + '/\\n|-- proxy ' + args[2] + '\\n\\nPress Ctrl+C to exit.');
  setInterval(() => {}, 3600_000);
} else {
  console.error('fake tailscale: unhandled ' + args.join(' '));
  process.exit(64);
}
`,
  );
  const wrapper = join(dir, 'tailscale');
  writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${script} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function ctx(stackExtra: string, extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-ts-'));
  const wt = mkdtempSync(join(tmpdir(), 'runly-ts-wt-'));
  const tsDir = join(stateDir, 'fake-ts');
  mkdirSync(tsDir, { recursive: true });
  writeFileSync(
    join(wt, 'srv.mjs'),
    `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n`,
  );
  writeFileSync(
    join(wt, 'stack.yaml'),
    `name: tstest\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: ready, timeout: 20 } }\n${stackExtra}`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });

  const env = {
    ...process.env,
    BACKLOT_STATE_DIR: stateDir,
    BACKLOT_SWEEP_MS: '300',
    BACKLOT_TAILSCALE: makeFakeTailscale(tsDir),
    FAKE_TS_DIR: tsDir,
    FAKE_TS_OPERATOR: userInfo().username,
    FAKE_PREVIEW_PIDFILE: join(stateDir, 'serve.pid'),
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
        resolve({ code: err && typeof err === 'object' && 'code' in err ? Number(err.code) : 0, json, stdout: String(stdout), stderr: String(stderr) });
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
      process.kill(Number(readFileSync(join(stateDir, 'serve.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* never started */
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { wt, cli, stateDir, tsDir, cleanup };
}

const TS = 'preview:\n  publisher: tailscale\n';

describe('the tailscale preview publisher', () => {
  it('publishes on the tailnet name at the pinned port, in the foreground', async () => {
    const { cli, tsDir } = ctx(`${TS}  https_port: 20601\n`);
    expect((await cli(['up', '--json'])).code).toBe(0);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(0);
    expect(prev.json?.url).toBe('https://box.tail1234.ts.net:20601');

    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls).toEqual({ web: 'https://box.tail1234.ts.net:20601' });

    // Foreground — never --bg, whose config would outlive every reap path —
    // and aimed at the service's loopback port.
    const calls = readFileSync(join(tsDir, 'calls.txt'), 'utf8');
    expect(calls).toMatch(/^serve --https=20601 http:\/\/127\.0\.0\.1:\d+$/m);
    expect(calls).not.toMatch(/--bg/);
  });

  it('derives a stable port when none is pinned', async () => {
    const { cli } = ctx(TS);
    await cli(['up', '--json']);
    const first = await cli(['preview', 'web', '--json']);
    expect(first.code).toBe(0);
    const url = String(first.json?.url);
    expect(url).toMatch(/^https:\/\/box\.tail1234\.ts\.net:2\d{4}$/);

    // A re-publish on the same environment hands out the same address.
    expect((await cli(['preview', 'stop', '--json'])).code).toBe(0);
    const again = await cli(['preview', 'web', '--json']);
    expect(again.json?.url).toBe(url);
  });

  it('--https-port pins the port for this publish, over the manifest', async () => {
    const { cli, tsDir } = ctx(`${TS}  https_port: 20601\n`);
    await cli(['up', '--json']);
    const prev = await cli(['preview', 'web', '--https-port', '20777', '--json']);
    expect(prev.code).toBe(0);
    expect(prev.json?.url).toBe('https://box.tail1234.ts.net:20777');
    expect(readFileSync(join(tsDir, 'calls.txt'), 'utf8')).toMatch(/^serve --https=20777 /m);
  });

  it('rejects a --https-port that is not a port (usage)', async () => {
    const { cli } = ctx(TS);
    await cli(['up', '--json']);
    const prev = await cli(['preview', 'web', '--https-port', 'abc', '--json']);
    expect(prev.code).toBe(64);
  });

  it('refuses a pinned port another publication holds, and serves nothing (work-error)', async () => {
    const { cli, tsDir } = ctx(`${TS}  https_port: 20601\n`, { FAKE_TS_BUSY: '20601' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(1);
    expect(String(prev.stderr + prev.stdout)).toMatch(/20601.*already served/);
    expect(readFileSync(join(tsDir, 'calls.txt'), 'utf8')).not.toMatch(/^serve --https/m);
  });

  it('refuses when the caller is not the tailscale operator, naming the command that fixes it', async () => {
    const { cli, tsDir } = ctx(TS, { FAKE_TS_OPERATOR: 'someone-else' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    expect(String(prev.stderr + prev.stdout)).toMatch(/tailscale set --operator=/);
    expect(readFileSync(join(tsDir, 'calls.txt'), 'utf8')).not.toMatch(/^serve --https/m);
  });

  it('refuses when tailscale is not connected', async () => {
    const { cli } = ctx(TS, { FAKE_TS_STATE: 'NeedsLogin' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    expect(String(prev.stderr + prev.stdout)).toMatch(/tailscale up/);
  });

  it('refuses a tailnet without HTTPS certificates', async () => {
    const { cli } = ctx(TS, { FAKE_TS_NOCERT: '1' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    expect(String(prev.stderr + prev.stdout)).toMatch(/HTTPS Certificates/);
  });

  it('turns tailscale access-denied into the operator hint', async () => {
    const { cli } = ctx(TS, { FAKE_TS_DENY: '1' });
    await cli(['up', '--json']);

    const prev = await cli(['preview', 'web', '--json']);
    expect(prev.code).toBe(2);
    expect(String(prev.stderr + prev.stdout)).toMatch(/tailscale set --operator=/);
  });

  it('stop ends the serve process, and with it the tailnet mapping', async () => {
    const { cli, stateDir, tsDir } = ctx(`${TS}  https_port: 20601\n`);
    await cli(['up', '--json']);
    await cli(['preview', 'web', '--json']);
    const pid = Number(readFileSync(join(stateDir, 'serve.pid'), 'utf8'));
    expect(existsSync(join(tsDir, 'serving', '20601'))).toBe(true);

    expect((await cli(['preview', 'stop', '--json'])).code).toBe(0);

    expect(await goneWithin(pid, 5000)).toBe(true);
    const c = await cli(['ctx', '--json']);
    expect(c.json?.previewUrls ?? {}).toEqual({});
  });
});

describe('tailnet port choice', () => {
  it('is deterministic per environment and service', () => {
    const a = deriveTailnetPort('stack-e1', 'web', new Set());
    expect(deriveTailnetPort('stack-e1', 'web', new Set())).toBe(a);
    expect(a).toBeGreaterThanOrEqual(21000);
    expect(a).toBeLessThan(22000);
  });

  it('walks past a port that is already served', () => {
    const a = deriveTailnetPort('stack-e1', 'web', new Set());
    const b = deriveTailnetPort('stack-e1', 'web', new Set([a]));
    expect(b).not.toBe(a);
    expect(b).toBe(a === 21999 ? 21000 : a + 1);
  });

  it('reads busy ports from both the persistent config and live foreground sessions', () => {
    const used = tailnetPortsInUse({
      TCP: { '20400': { HTTPS: true } },
      Foreground: { abc: { TCP: { '21007': { HTTPS: true } } } },
    });
    expect([...used].sort()).toEqual([20400, 21007]);
  });
});

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

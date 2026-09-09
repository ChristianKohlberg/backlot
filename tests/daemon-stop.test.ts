import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitDaemonGone } from '../src/cli/client.js';
import { VERSION } from '../src/core/version.js';

const CLI = join(import.meta.dirname, '../dist/cli/index.js');
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-stop-')));
  const state = join(root, 'state');
  mkdirSync(state);
  const cli = (args: string[], vars: NodeJS.ProcessEnv = {}) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args, '--json'], {
      cwd: root, env: { ...process.env, BACKLOT_STATE_DIR: state, ...vars }, timeout: 25_000,
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
  });
  const cleanup = async () => {
    const pidFile = join(state, 'daemon.pid');
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (alive(pid)) await cli(['daemon', 'stop']);
      for (let i = 0; i < 200 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(alive(pid), `private daemon ${pid} did not stop`).toBe(false);
    }
    rmSync(root, { recursive: true, force: true });
  };
  return { root, state, cli, cleanup };
}

it('waits for slow service shutdown before completing and the next command reaches a new daemon', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'server.mjs'), `import {createServer} from 'node:http';
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),800));
createServer((q,s)=>s.end('ready')).listen(Number(process.env.PORT),'127.0.0.1');\n`);
    writeFileSync(join(f.root, 'stack.yaml'), `name: stop-completion
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: '{{ports.web}}' }
    ready: { http: /, timeout: 10 }
`);
    const up = await f.cli(['up']);
    expect(up.code, JSON.stringify(up)).toBe(0);
    const oldPid = Number(readFileSync(join(f.state, 'daemon.pid'), 'utf8'));
    const stop = await f.cli(['daemon', 'stop']);
    expect(stop.code, JSON.stringify(stop)).toBe(0);
    expect(alive(oldPid), 'stop returned while the old daemon was still alive').toBe(false);
    expect(JSON.parse(stop.stdout)).toEqual({ stopping: true, stopped: true });
    const status = await f.cli(['status']);
    expect(status.code, JSON.stringify(status)).toBe(0);
    expect(JSON.parse(status.stdout).pid).not.toBe(oldPid);
  } finally { await f.cleanup(); }
}, 30_000);

it('stopping an absent daemon succeeds without spawning it', async () => {
  const f = fixture();
  try {
    const stop = await f.cli(['daemon', 'stop']);
    expect(stop.code, JSON.stringify(stop)).toBe(0);
    expect(JSON.parse(stop.stdout)).toEqual({ stopping: true, stopped: true });
    expect(existsSync(join(f.state, 'daemon.log'))).toBe(false);
    expect(existsSync(join(f.state, 'daemon.pid'))).toBe(false);
  } finally { await f.cleanup(); }
});

it('reports infra-error when an acknowledged shutdown never completes', async () => {
  const f = fixture();
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const { verb } = JSON.parse(body);
      res.end(JSON.stringify({ type: 'result', ok: true, data: verb === 'ping' ? { version: VERSION, pid: process.pid } : { stopping: true } }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(join(f.state, 'daemon.sock'), resolve));
  try {
    const stop = await f.cli(['daemon', 'stop']);
    expect(stop.code, JSON.stringify(stop)).toBe(3);
    expect(JSON.parse(stop.stdout).error).toMatchObject({ class: 'infra-error', source: 'daemon' });
    expect(JSON.parse(stop.stdout).error.message).toContain('shutdown');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
}, 25_000);


it('keeps shutdown polling bounded even when ping stops responding', async () => {
  const f = fixture();
  const previous = process.env.BACKLOT_STATE_DIR;
  const server = createServer((_req, res) => { res.writeHead(200); res.write(' '); });
  await new Promise<void>((resolve) => server.listen(join(f.state, 'daemon.sock'), resolve));
  try {
    process.env.BACKLOT_STATE_DIR = f.state;
    const started = performance.now();
    expect(await awaitDaemonGone(process.pid, 150)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    if (previous === undefined) delete process.env.BACKLOT_STATE_DIR;
    else process.env.BACKLOT_STATE_DIR = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
}, 5000);


it('does not claim an unresponsive daemon is already stopped', async () => {
  const f = fixture();
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(join(f.state, 'daemon.sock'), resolve));
  try {
    const stop = await f.cli(['daemon', 'stop'], { BACKLOT_RPC_TIMEOUT_MS: '100' });
    expect(stop.code, JSON.stringify(stop)).toBe(3);
    expect(JSON.parse(stop.stdout).error.class).toBe('infra-error');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.cleanup();
  }
});

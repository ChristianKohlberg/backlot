import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { monitorStats, type StatsData } from '../src/cli/metrics.js';
import { VERSION } from '../src/core/version.js';
import { disposeStateSync } from './support/leaks.js';

const CLI = join(import.meta.dirname, '../dist/cli/index.js');
const roots: string[] = [];
function state(): string {
  const root = mkdtempSync(join(tmpdir(), 'metrics-cli-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) disposeStateSync(root);
});

describe('statistics CLI lifecycle', () => {
  it.each([
    ['stats', '--since', '25h'],
    ['monitor', '--interval', '1ms'],
    ['monitor', '--timeout', 'off'],
  ])('rejects %s %s %s before starting a daemon', (...args) => {
    const root = state();
    let status: number | undefined;
    try {
      execFileSync(process.execPath, [CLI, ...args], {
        cwd: root, env: { ...process.env, BACKLOT_STATE_DIR: root }, stdio: 'pipe',
      });
    } catch (error) { status = (error as { status: number }).status; }
    expect(status).toBe(64);
    expect(existsSync(join(root, 'daemon.pid'))).toBe(false);
    expect(existsSync(join(root, 'daemon.log'))).toBe(false);
    expect(existsSync(join(root, 'daemon.sock'))).toBe(false);
  });

  it('aborts an outstanding fetch on timeout and removes timers and signal listeners', async () => {
    vi.useFakeTimers();
    const listeners = ['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal));
    let aborted = false;
    const pending = monitorStats((signal) => new Promise<StatsData>((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
    }), { json: true, intervalMs: 250, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(aborted).toBe(true);
    expect(['SIGINT', 'SIGTERM'].map((signal) => process.listenerCount(signal))).toEqual(listeners);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['timeout', 'SIGINT', 'SIGTERM'] as const)('closes a hung stats HTTP request on %s', async (stop) => {
    const root = state();
    let requested!: () => void;
    let disconnected!: () => void;
    const requestSeen = new Promise<void>((resolve) => { requested = resolve; });
    const connectionClosed = new Promise<void>((resolve) => { disconnected = resolve; });
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (JSON.parse(body).verb === 'ping') {
          res.end(JSON.stringify({ type: 'result', ok: true, data: { version: VERSION } }) + '\n');
        } else {
          res.on('close', disconnected);
          requested();
          // Deliberately leave the request open, without headers or a response.
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(join(root, 'daemon.sock'), resolve));
    const child = spawn(process.execPath, [CLI, 'monitor', '--all', '--json', ...(stop === 'timeout' ? ['--timeout', '250ms'] : [])], {
      cwd: root, env: { ...process.env, BACKLOT_STATE_DIR: root, BACKLOT_RPC_TIMEOUT_MS: '60000' }, stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      await Promise.race([requestSeen, exited.then(() => { throw new Error(`monitor exited before requesting stats: ${output}`); })]);
      if (stop !== 'timeout') child.kill(stop);
      expect(await exited).toEqual({ code: 0, signal: null });
      await connectionClosed;
      expect(output).toBe('');
    } finally {
      clearTimeout(watchdog);
      child.kill('SIGKILL');
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

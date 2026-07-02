/**
 * Test helpers that "play the engine": spawn services the way the daemon will
 * (env injection, readiness by http/log, fail-fast on fatal markers), so the
 * fixtures prove the model before the engine exists — and become the engine's
 * conformance bar once it does.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Service {
  proc: ChildProcess;
  logs: () => string;
  stop: () => Promise<void>;
}

export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `infront-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A genuinely free port, the way the engine's port broker will hand them out. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const address = srv.address();
      if (typeof address === 'object' && address) {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('no port allocated')));
      }
    });
  });
}

export function startService(
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Service {
  const [bin, ...args] = cmd;
  const proc = spawn(bin!, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  proc.stdout!.on('data', (d) => (buf += d.toString()));
  proc.stderr!.on('data', (d) => (buf += d.toString()));
  return {
    proc,
    logs: () => buf,
    stop: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill();
        setTimeout(() => proc.kill('SIGKILL'), 2000).unref();
      }),
  };
}

/** Poll an HTTP url until 200 — with the fatal-log fast-fail the engine will have. */
export async function waitHttp(url: string, svc: Service, fatalRe?: RegExp, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (fatalRe && fatalRe.test(svc.logs())) {
      throw new Error(`fatal marker in logs while waiting for ${url}:\n${svc.logs().slice(0, 500)}`);
    }
    if (svc.proc.exitCode !== null) {
      throw new Error(`service exited (${svc.proc.exitCode}) while waiting for ${url}:\n${svc.logs().slice(0, 500)}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${url}\nlogs:\n${svc.logs().slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Readiness by log marker — how the engine probes portless services (workers). */
export async function waitLog(svc: Service, marker: RegExp, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (marker.test(svc.logs())) return;
    if (svc.proc.exitCode !== null) {
      throw new Error(`service exited (${svc.proc.exitCode}) before log marker ${marker}:\n${svc.logs().slice(0, 500)}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for log marker ${marker}\nlogs:\n${svc.logs().slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Run a one-shot command (seed scripts, checks) and capture the outcome. */
export function runCmd(
  cmd: string[],
  opts: { cwd: string; env?: Record<string, string> },
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    const proc = spawn(bin!, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    proc.stdout!.on('data', (d) => (output += d.toString()));
    proc.stderr!.on('data', (d) => (output += d.toString()));
    proc.on('exit', (code) => resolve({ exitCode: code ?? -1, output }));
  });
}

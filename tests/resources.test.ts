/**
 * Fleet review, ports and resource-exhaustion cluster.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { truncateLogs } from '../src/core/retention.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('log truncation survives a very large log', () => {
  it('trims by reading the tail, not the whole file as one string', () => {
    const root = mkdtempSync(join(tmpdir(), 'runly-logs-'));
    dirs.push(root);
    const logDir = join(root, 'env-1', 'logs');
    rmSync(logDir, { recursive: true, force: true });
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(logDir, { recursive: true });
    const full = join(logDir, 'web.log');

    // 8 MiB against a 1 MiB cap. The old implementation read the entire file
    // into a utf8 string, which throws outright past Node's ~512 MiB string
    // limit — so the logs that most needed trimming were the ones that could
    // never be trimmed, and they grew without bound.
    const chunk = 'x'.repeat(1024 * 1024);
    writeFileSync(full, `HEAD-MARKER\n${chunk.repeat(8)}TAIL-MARKER`);

    const policy = { logCapBytes: 1024 * 1024, templatesKeep: 4, sessionTtlMs: 1, idleTtlMs: 1, waitMs: 1 };
    const n = truncateLogs(policy, root);

    expect(n).toBe(1);
    const after = readFileSync(full, 'utf8');
    expect(statSync(full).size).toBeLessThan(policy.logCapBytes);
    expect(after).toContain('truncated by retention sweep');
    // The TAIL is what matters — the recent lines are the useful ones.
    expect(after).toContain('TAIL-MARKER');
    expect(after).not.toContain('HEAD-MARKER');
  });

  it('leaves a log under the cap untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'runly-logs2-'));
    dirs.push(root);
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    const logDir = join(root, 'env-1', 'logs');
    mkdirSync(logDir, { recursive: true });
    const full = join(logDir, 'web.log');
    writeFileSync(full, 'short and sweet');
    const policy = { logCapBytes: 1024 * 1024, templatesKeep: 4, sessionTtlMs: 1, idleTtlMs: 1, waitMs: 1 };
    expect(truncateLogs(policy, root)).toBe(0);
    expect(readFileSync(full, 'utf8')).toBe('short and sweet');
  });
});

describe('ports are reserved pool-wide', () => {
  it('never hands the same port to two environments', async () => {
    const { execFile, execFileSync } = await import('node:child_process');
    const { mkdirSync } = await import('node:fs');
    const stateDir = mkdtempSync(join(tmpdir(), 'runly-ports-'));
    // One environment per worktree (decision 0032): three worktrees of the
    // same app make three environments.
    const wts = ['a', 'b', 'c'].map((tag) => {
      const wt = mkdtempSync(join(tmpdir(), `runly-ports-wt-${tag}-`));
      dirs.push(wt);
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, 'srv.mjs'), `import{createServer}from'node:http';console.log('up');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');\n`);
      writeFileSync(
        join(wt, 'stack.yaml'),
        `name: ports\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }\n`,
      );
      execFileSync('git', ['init', '-q'], { cwd: wt });
      return wt;
    });
    dirs.push(stateDir);
    const wt = wts[0]!;
    const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };
    const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');
    const cli = (args: string[], cwd = wt) =>
      new Promise<Record<string, unknown> | undefined>((resolve) => {
        execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => {
          try {
            resolve(JSON.parse(String(out)));
          } catch {
            resolve(undefined);
          }
        });
      });

    for (const w of wts) await cli(['up', '--json'], w);

    const status = await cli(['pool', 'ls', '--json']);
    const envs = (status?.envs ?? []) as Array<{ id: string; ports: Record<string, number> }>;
    expect(envs.length).toBeGreaterThanOrEqual(2);

    // freePort closes its listener immediately, so nothing stopped the OS
    // handing the same port to the next environment moments later.
    const all = envs.flatMap((e) => Object.values(e.ports));
    expect(new Set(all).size).toBe(all.length);

    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* gone */
    }
  }, 120_000);
});

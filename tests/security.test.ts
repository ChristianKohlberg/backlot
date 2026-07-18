/**
 * Regressions for the review findings that are now fixed: the argv parser
 * (F1/F4), path-escape guards on manifest-supplied paths (sec 2/3/4), and
 * state-dir/socket permissions (sec 1).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeJoin } from '../src/core/util.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

function makeContext() {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-sec-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };
  const cli = (args: string[], cwd: string): Promise<{ exitCode: number; json?: Record<string, unknown>; out: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json, out: String(stdout), stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const cleanup = () => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')));
    } catch {
      /* gone */
    }
    rmSync(stateDir, { recursive: true, force: true });
  };
  return { stateDir, cli, cleanup };
}

const SERVE = `import { createServer } from 'node:http';
console.log('web up');
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT));
`;
const stackWith = (extra = '') => `name: sec
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
${extra}`;

function makeWt(stackYaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'backlot-sec-wt-'));
  writeFileSync(join(dir, 'server.mjs'), SERVE);
  writeFileSync(join(dir, 'stack.yaml'), stackYaml);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('safeJoin (unit)', () => {
  it('accepts in-tree, rejects .. and absolute', () => {
    expect(safeJoin('/base', 'a/b.txt', 'x')).toBe('/base/a/b.txt');
    expect(() => safeJoin('/base', '../evil', 'x')).toThrow(/escapes/);
    expect(() => safeJoin('/base', 'a/../../evil', 'x')).toThrow(/escapes/);
    expect(() => safeJoin('/base', '/etc/passwd', 'x')).toThrow(/absolute/);
    // a prefix that is NOT a path boundary must not slip through
    expect(() => safeJoin('/base', '../basement/x', 'x')).toThrow(/escapes/);
  });
});

describe('argv parser (F1/F4)', () => {
  const ctx = makeContext();
  const wt = makeWt(stackWith());
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('exec passes inner --flags through verbatim (does not strip them)', async () => {
    await ctx.cli(['up'], wt);
    // Echo the args back; the old parser stripped every --flag from the command.
    const res = await ctx.cli(['exec', 'printf', '[%s]', '--frozen-lockfile', 'end'], wt);
    expect(res.out).toContain('[--frozen-lockfile]');
    expect(res.out).toContain('[end]');
  });

  it('a value flag mid-line does not steal the following positional', async () => {
    // `logs --lines 5 web`: `web` is the service, `5` is the flag value — not swapped.
    await ctx.cli(['up'], wt);
    const good = await ctx.cli(['logs', '--lines', '5', 'web'], wt);
    expect(good.exitCode, `stdout: ${good.stdout ?? ''}\nstderr: ${good.stderr ?? ''}`).toBe(0); // service resolved to 'web', logs exist
    const bad = await ctx.cli(['logs', '--lines', '5', 'nosuch'], wt);
    expect(bad.exitCode, `stdout: ${bad.stdout ?? ''}\nstderr: ${bad.stderr ?? ''}`).toBe(2); // proves the positional really was the last token
  });

  it('rejects an unknown flag and a bad --ttl instead of silently misbehaving', async () => {
    expect((await ctx.cli(['up', '--bogus'], wt)).exitCode).toBe(64);
    expect((await ctx.cli(['up', '--ttl', '4h'], wt)).exitCode).toBe(64); // hours not supported; must not silently default
    expect((await ctx.cli(['up', '--ttl', '15'], wt)).exitCode).toBe(0); // minutes ok
  });
});

describe('path-escape guards (sec 2/3/4)', () => {
  const ctx = makeContext();
  afterAll(() => ctx.cleanup());

  it('sync.include with .. is rejected, not projected/deleted', async () => {
    const wt = makeWt(stackWith('sync:\n  include: ["../../../etc/hosts"]'));
    const res = await ctx.cli(['up', '--json'], wt);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(1);
    expect((res.json!.error as { message: string }).message).toMatch(/sync\.include|escapes/);
    rmSync(wt, { recursive: true, force: true });
  });

  it('a sqlite datastore key with .. is rejected', async () => {
    const wt = makeWt(stackWith('datastores:\n  "../../../evil":\n    driver: sqlite\n    create: "true"\n    presets: [dev]'));
    const res = await ctx.cli(['up', '--json'], wt);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(1);
    expect((res.json!.error as { message: string }).message).toMatch(/must not contain/);
    rmSync(wt, { recursive: true, force: true });
  });
});

describe('state-dir + socket permissions (sec 1)', () => {
  const ctx = makeContext();
  const wt = makeWt(stackWith());
  afterAll(() => {
    ctx.cleanup();
    rmSync(wt, { recursive: true, force: true });
  });

  it('the state dir is 0700 and the socket is 0600 — owner only', async () => {
    await ctx.cli(['status'], wt); // spawns the daemon
    expect(statSync(ctx.stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(ctx.stateDir, 'daemon.sock')).mode & 0o777).toBe(0o600);
  });
});

/**
 * `auth.logins` may declare one login or several, and the ctx blob has to serve
 * both without making a consumer branch on which form the manifest used.
 *
 * The contract this pins: `logins` is the PRIMARY login and stays a single
 * object forever — a consumer reading `ctx.logins.user` must not break when a
 * stack grows a second login — while `allLogins` carries the full set in
 * manifest order. A one-login stack therefore reports the same object twice
 * (once as `logins`, once as the only `allLogins` entry), which is the point:
 * enumerating never needs a shape check.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) {
    try {
      process.kill(Number(readFileSync(join(d, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* not a state dir */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

/** An isolated daemon + worktree carrying the given `auth:` block verbatim. */
function ctx(authBlock: string) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-auth-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-auth-wt-'));
  dirs.push(stateDir, wt);
  writeFileSync(
    join(wt, 'srv.mjs'),
    `import{createServer}from'node:http';console.log('up');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT));\n`,
  );
  writeFileSync(
    join(wt, 'backlot.yml'),
    `name: authstack\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }\n${authBlock}`,
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '300' };
  const cli = (args: string[]) =>
    new Promise<{ json?: Record<string, unknown> }>((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 16 * 1024 * 1024 }, (_e, stdout) => {
        try {
          resolve({ json: JSON.parse(String(stdout)) });
        } catch {
          resolve({});
        }
      });
    });
  return { cli };
}

describe('auth.logins in the ctx blob', () => {
  it('reports the single-object form unchanged, and mirrors it into allLogins', async () => {
    const { cli } = ctx('auth:\n  logins: { user: qa-admin, password: "Demo!1234" }\n');
    const up = await cli(['up', '--json']);
    // The original contract: still a single object at `logins`.
    expect(up.json?.logins).toEqual({ user: 'qa-admin', password: 'Demo!1234' });
    // ...and enumerable without knowing the manifest used the short form.
    expect(up.json?.allLogins).toEqual([{ user: 'qa-admin', password: 'Demo!1234' }]);
    await cli(['release', '--json']);
  }, 120_000);

  it('reports every login of a list, first as primary, carrying role and description', async () => {
    const { cli } = ctx(
      'auth:\n' +
        '  logins:\n' +
        '    - { user: qa-admin, password: "Demo!1234", role: admin, description: all rights }\n' +
        '    - { user: qa-readonly, password: "Demo!1234", description: read-only }\n',
    );
    const up = await cli(['up', '--json']);
    // Primary = manifest entry 0, so `logins.user` keeps naming the login a
    // one-login stack advertised before the list was introduced.
    expect((up.json?.logins as Record<string, unknown>)?.user).toBe('qa-admin');
    const all = up.json?.allLogins as Array<Record<string, unknown>>;
    expect(all).toHaveLength(2);
    expect(all.map((l) => l.user)).toEqual(['qa-admin', 'qa-readonly']);
    // The purpose fields survive the round trip — they are the reason a
    // consumer can pick the right login without reading the seed.
    expect(all[0]).toEqual({ user: 'qa-admin', password: 'Demo!1234', role: 'admin', description: 'all rights' });
    expect(all[1]!.description).toBe('read-only');
    // `ctx` re-reads the same blob without a re-bind; it must agree.
    const later = await cli(['ctx', '--json']);
    expect(later.json?.allLogins).toEqual(all);
    await cli(['release', '--json']);
  }, 120_000);

  it('omits both fields when the stack declares no login at all', async () => {
    const { cli } = ctx('');
    const up = await cli(['up', '--json']);
    // null, not a fabricated empty object — "no login declared" is a real state.
    expect(up.json?.logins ?? null).toBeNull();
    expect(up.json?.allLogins ?? []).toEqual([]);
    await cli(['release', '--json']);
  }, 120_000);
});

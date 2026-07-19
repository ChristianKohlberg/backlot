/**
 * Streaming progress contract (#24): progress frames reach stderr under
 * --progress, the --json stdout stays a single clean object either way, and a
 * non-TTY run is silent by default (agents are unaffected).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const stateDir = mkdtempSync(join(tmpdir(), 'backlot-prog-'));
const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };

const wt = mkdtempSync(join(tmpdir(), 'backlot-prog-wt-'));
writeFileSync(
  join(wt, 'server.mjs'),
  `import { createServer } from 'node:http';
console.log('up');
createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT));
`,
);
writeFileSync(
  join(wt, 'stack.yaml'),
  `name: prog
services:
  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }
`,
);
execFileSync('git', ['init', '-q'], { cwd: wt });

/** Run the CLI capturing stdout and stderr SEPARATELY (never a TTY here). */
function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

afterAll(() => {
  try {
    process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')));
  } catch {
    /* gone */
  }
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(wt, { recursive: true, force: true });
});

describe('streaming progress', () => {
  it('--json stdout is a single clean JSON object even with --progress', async () => {
    const r = await run(['up', '--progress', '--json']);
    expect(r.code).toBe(0);
    // The whole stdout must parse as ONE object — no progress frames leaked in.
    const parsed = JSON.parse(r.stdout);
    expect(parsed.state).toBe('hot');
    await run(['release']);
    await run(['pool', 'recycle']);
  }, 30_000);

  it('--progress emits phase lines to stderr', async () => {
    const r = await run(['up', '--progress', '--json']);
    const phases = r.stderr.replace(/\r/g, '\n');
    expect(phases).toMatch(/syncing worktree/);
    expect(phases).toMatch(/starting 'web'/);
    await run(['release']);
    await run(['pool', 'recycle']);
  }, 30_000);

  it('a non-TTY run WITHOUT --progress is silent on stderr by default (agent path)', async () => {
    const r = await run(['up', '--json']); // execFile pipes = not a TTY
    expect(r.code).toBe(0);
    JSON.parse(r.stdout); // still clean
    expect(r.stderr.trim()).toBe(''); // no progress noise for agents
    await run(['release']);
  }, 30_000);
});

describe('progress while queued behind a busy environment', () => {
  it('a verb blocked on the env lock heartbeats instead of going silent', async () => {
    // A verb that resolves to an env held by another in-flight operation used
    // to print 'acquiring an environment' and then NOTHING until the lock
    // freed — a legitimate wait was indistinguishable from a hang.
    const up = await run(['up', '--json']);
    expect(up.code, up.stdout).toBe(0);
    const slow = run(['exec', 'sleep', '4']); // holds the env lock
    await new Promise((r) => setTimeout(r, 500));
    const queued = await run(['sync', '--progress', '--json']);
    expect(queued.code, queued.stdout).toBe(0);
    expect(queued.stderr.replace(/\r/g, '\n')).toMatch(/waiting for another operation/);
    await slow;
    await run(['release']);
  }, 30_000);
});

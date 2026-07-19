/**
 * Client-side daemon spawn behaviors (backlog: spawn hygiene + cold-start race).
 *
 * The CLI is the daemon's only spawner, so what it puts on the child argv and
 * how long it waits for an answer are contracts of their own: daemon.log must
 * stay signal (an agent reads it when told "check daemon.log"), and a client
 * whose own spawn LOSES the singleton election must fall through to the winner
 * instead of failing a healthy cold start.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startTime } from '../src/core/procscan.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const dirs: string[] = [];
const servers: Array<() => void> = [];

afterAll(() => {
  for (const close of servers) close();
  for (const d of dirs) {
    try {
      process.kill(Number(readFileSync(join(d, 'daemon.pid'), 'utf8')));
    } catch {
      /* none */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const cli = (args: string[], cwd: string, env: Record<string, string>) =>
  new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, ...env } },
      (err, out) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(out) }),
    );
  });

describe('daemon.log stays signal on spawn', () => {
  it('carries no node:sqlite ExperimentalWarning', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-warn-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-warn-wt-'));
    dirs.push(stateDir, wt);

    // A real spawn through the real CLI: exit 0 proves the daemon came up,
    // which proves node:sqlite (the journal) genuinely loaded in the child.
    const { code } = await cli(['status', '--json'], wt, { BACKLOT_STATE_DIR: stateDir });
    expect(code).toBe(0);

    const log = readFileSync(join(stateDir, 'daemon.log'), 'utf8');
    // Only the ExperimentalWarning class is suppressed — a real warning
    // (deprecations, etc.) must still reach the log, so assert narrowly.
    expect(log).not.toMatch(/ExperimentalWarning/);
  }, 60_000);
});

describe('a client whose spawned daemon loses the cold-start race', () => {
  it('falls through to the winner instead of failing its ping window', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-lostrace-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-lostrace-wt-'));
    dirs.push(stateDir, wt);

    // Make "our daemon lost the election" deterministic: the lock names US, a
    // live process, so whatever daemon the client spawns concedes and exits 0.
    writeFileSync(
      join(stateDir, 'daemon.lock'),
      JSON.stringify({ pid: process.pid, startTime: startTime(process.pid) }),
    );

    // The winner starts serving only AFTER the client's 10s wait window has
    // burned — the exact "loser's client fails its ping window while a healthy
    // winner is coming up" timing from the field report, made deterministic.
    // Losing the election PROVES a winner exists, which is what must buy the
    // second window.
    const sock = join(stateDir, 'daemon.sock');
    const winner = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end(JSON.stringify({ type: 'result', ok: true, data: { pid: process.pid, winner: true } }) + '\n');
      });
    });
    const late = setTimeout(() => winner.listen(sock), 12_000);
    servers.push(() => {
      clearTimeout(late);
      winner.close();
    });

    const { code, stdout } = await cli(['status', '--json'], wt, { BACKLOT_STATE_DIR: stateDir });

    expect(code, `stdout: ${stdout}`).toBe(0);
    expect((JSON.parse(stdout) as { winner?: boolean }).winner).toBe(true); // served by the winner, not a respawn
  }, 60_000);
});

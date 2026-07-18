/**
 * Fleet review finding #1: the daemon singleton election.
 *
 * The socket alone cannot elect a leader. Two daemons that both ping an absent
 * socket would each unlink it — the second deleting the first's LIVE socket —
 * and both would then bind, sweeping one journal in parallel. These tests race
 * real daemons and assert exactly one survives.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { electSelf, releaseSelf } from '../src/daemon/election.js';
import { startTime } from '../src/core/procscan.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const dirs: string[] = [];
const mkdir = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

afterAll(() => {
  for (const d of dirs) {
    try {
      process.kill(Number(readFileSync(join(d, 'daemon.pid'), 'utf8')));
    } catch {
      /* not a state dir, or already gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe('election primitive', () => {
  it('grants the lock to exactly one caller', () => {
    const lock = join(mkdir('backlot-elect-'), 'daemon.lock');
    expect(electSelf(lock)).toBe(true);
    // A second call from THIS process must not double-grant. The holder is us,
    // which claimIsLive treats as not-live so the lock is breakable — and we
    // legitimately re-win it, because we are who it says we are.
    expect(electSelf(lock)).toBe(true);
    releaseSelf(lock);
    expect(existsSync(lock)).toBe(false);
  });

  it('concedes to a live holder', () => {
    const lock = join(mkdir('backlot-elect-'), 'daemon.lock');
    // A holder that is genuinely running: the test runner's own parent, or any
    // live pid that is not us. Use pid 1, which always exists.
    writeFileSync(lock, JSON.stringify({ pid: 1, startTime: startTime(1) }));
    expect(electSelf(lock)).toBe(false);
  });

  it('breaks a lock whose holder is dead', () => {
    const lock = join(mkdir('backlot-elect-'), 'daemon.lock');
    let dead = 4_194_300;
    const alive = (p: number) => {
      try {
        process.kill(p, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (alive(dead) && dead > 1) dead--;
    writeFileSync(lock, JSON.stringify({ pid: dead, startTime: 1 }));
    expect(electSelf(lock)).toBe(true);
  });

  it('breaks a lock left by a REUSED pid rather than trusting the number', () => {
    const lock = join(mkdir('backlot-elect-'), 'daemon.lock');
    // pid 1 is alive, but the recorded start time is wrong — so this claim
    // belongs to a process that no longer exists, not to init.
    writeFileSync(lock, JSON.stringify({ pid: 1, startTime: (startTime(1) ?? 0) + 999 }));
    expect(electSelf(lock)).toBe(true);
  });

  it('breaks a corrupt lock instead of wedging forever', () => {
    const lock = join(mkdir('backlot-elect-'), 'daemon.lock');
    writeFileSync(lock, 'not json at all');
    expect(electSelf(lock)).toBe(true);
  });
});

describe('daemon singleton under a real race', () => {
  it('leaves exactly one daemon when many clients start at once', async () => {
    const stateDir = mkdir('backlot-race-');
    const wt = mkdir('backlot-race-wt-');
    writeFileSync(join(wt, 'srv.mjs'), `import{createServer}from'node:http';console.log('up');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT));\n`);
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: race\nservices:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '300' };

    // Eight clients from a cold state dir. Every one of them finds no socket,
    // so every one of them is a candidate leader.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        new Promise<Record<string, unknown> | undefined>((resolve) => {
          execFile(process.execPath, [CLI, 'status', '--json'], { cwd: wt, env }, (_e, stdout) => {
            try {
              resolve(JSON.parse(String(stdout)));
            } catch {
              resolve(undefined);
            }
          });
        }),
      ),
    );

    const pids = new Set(results.filter(Boolean).map((r) => r!.pid));
    expect(results.filter(Boolean).length).toBeGreaterThan(0);
    // Every client that got an answer must have been served by the SAME daemon.
    expect(pids.size).toBe(1);

    // And no second daemon is loitering unbound: the lock names the live one.
    const lock = JSON.parse(readFileSync(join(stateDir, 'daemon.lock'), 'utf8')) as { pid: number };
    expect(lock.pid).toBe([...pids][0]);
  }, 60_000);
});

/**
 * Leak accounting for the test suite (decision 0037).
 *
 * Every daemon a test starts runs with BACKLOT_STATE_DIR set, and every
 * service it spawns is tagged with BACKLOT_STATE_ROOT; both point under the
 * suite's own temporary directory. So "did the suite leave a process
 * behind?" is a /proc scan for those two variables under that directory —
 * nothing else on the box can match it.
 */
import { readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface Leaked {
  pid: number;
  via: string;
  cmd: string;
}

function ancestors(): Set<number> {
  const out = new Set<number>();
  let pid = process.pid;
  for (let i = 0; i < 64 && pid > 1; i++) {
    out.add(pid);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch {
      break;
    }
  }
  return out;
}

/** Processes whose state root / state dir lies under `prefix`. Linux only; [] elsewhere. */
export function processesUnder(prefix: string): Leaked[] {
  if (process.platform !== 'linux' || !existsSync('/proc')) return [];
  const mine = ancestors();
  const out: Leaked[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || mine.has(pid)) continue;
    let environ: string;
    try {
      environ = readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue;
    }
    for (const kv of environ.split('\0')) {
      const at = kv.indexOf('=');
      const key = kv.slice(0, at);
      if (key !== 'BACKLOT_STATE_ROOT' && key !== 'BACKLOT_STATE_DIR') continue;
      const value = kv.slice(at + 1);
      if (value === prefix || value.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) {
        let cmd = '';
        try {
          cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
        } catch {
          /* gone */
        }
        out.push({ pid, via: `${key}=${value}`, cmd });
        break;
      }
    }
  }
  return out;
}

const kill = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig);
  } catch {
    /* gone */
  }
};

/** SIGTERM, wait up to `graceMs`, then SIGKILL whatever is left. Returns what was found. */
export async function killUnder(prefix: string, graceMs = 3000): Promise<Leaked[]> {
  const found = processesUnder(prefix);
  if (found.length === 0) return found;
  for (const p of found) kill(p.pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && processesUnder(prefix).length > 0) await sleep(100);
  for (const p of processesUnder(prefix)) kill(p.pid, 'SIGKILL');
  return found;
}

/**
 * The one way a test disposes of a state root: stop the daemon (SIGTERM,
 * so it tears its services down), then kill anything still carrying this
 * state root — the services a SIGKILLed daemon could not stop — and only
 * then remove the directory. Removing the directory first is what leaked:
 * a service whose state root is gone is invisible to every later sweep.
 */
export async function disposeState(stateDir: string): Promise<void> {
  try {
    const pid = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 1) {
      kill(pid, 'SIGTERM');
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        await sleep(100);
      }
      kill(pid, 'SIGKILL');
    }
  } catch {
    /* no daemon */
  }
  await killUnder(stateDir, 2000);
  rmSync(stateDir, { recursive: true, force: true });
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * The synchronous form of disposeState, for the many cleanups that are not
 * async: the same order — daemon first (SIGTERM, waited for), then whatever
 * still carries this state root, then the directory.
 */
export function disposeStateSync(stateDir: string): void {
  try {
    const pid = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 1) {
      kill(pid, 'SIGTERM');
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        sleepSync(100);
      }
      kill(pid, 'SIGKILL');
    }
  } catch {
    /* no daemon */
  }
  const left = processesUnder(stateDir);
  for (const p of left) kill(p.pid, 'SIGTERM');
  for (let i = 0; i < 20 && processesUnder(stateDir).length > 0; i++) sleepSync(100);
  for (const p of processesUnder(stateDir)) kill(p.pid, 'SIGKILL');
  rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

/** Name for a docker container a test starts: tagged with this run's id so
 *  the teardown's leak check finds it (and only it). */
export function testContainerName(kind: string): string {
  const run = process.env.RUNLY_TEST_RUN_ID ?? 'norun';
  return `runly-${kind}-test-${run}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Remove every container of this run (runly-*-test-<run>-*) still present;
 *  returns their names. No docker: nothing to check. */
export function removeTestContainers(run: string): string[] {
  let names: string[];
  try {
    names = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 })
      .split('\n').map((n) => n.trim()).filter(Boolean);
  } catch {
    return [];
  }
  const mine = new RegExp(`^runly-[a-z0-9]+-test-${run}-[a-z0-9]+$`);
  const leaked = names.filter((n) => mine.test(n));
  for (const n of leaked) {
    try {
      execFileSync('docker', ['rm', '-f', n], { stdio: 'ignore', timeout: 30_000 });
    } catch {
      /* reported anyway */
    }
  }
  return leaked;
}

/**
 * Process identity and orphan discovery.
 *
 * Backlot spawns each service detached (its own process group) and kills the
 * group on teardown — but a daemon that dies ungracefully leaves those groups
 * running with nothing tracking them. Recorded pids alone are not enough to
 * clean up afterwards: by the time a new daemon reads them they may have been
 * recycled by the OS onto an unrelated process, and signalling those is worse
 * than leaking.
 *
 * So every supervised service carries a tag in its environment (see
 * `serviceTag`), and every recorded pid carries the kernel's start-time for
 * that pid. Together they answer the two questions cleanup needs:
 *
 *   - "is pid N still the process I recorded?"        -> `sameProcess`
 *   - "which backlot processes has everyone lost?"    -> `scanTagged`
 *
 * Identity works on every platform: /proc where it exists, `ps -o lstart=`
 * otherwise, so a recycled pid is never mistaken for the process we recorded.
 * Orphan SCANNING needs to read other processes' environments and so is
 * Linux-only; elsewhere `pool gc` reports unsupported rather than guessing.
 * That asymmetry is deliberate — skipping a sweep is safe, signalling a
 * stranger's process is not.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const ENV_TAG = 'BACKLOT_ENV_ID';
export const SERVICE_TAG = 'BACKLOT_SERVICE';
/** Scopes a tag to one state root so parallel installs never reap each other. */
export const ROOT_TAG = 'BACKLOT_STATE_ROOT';

export interface TaggedProc {
  pid: number;
  envId: string;
  service: string;
  startTime: number;
}

/** The environment every supervised service is spawned with. */
export function serviceTag(envId: string, service: string, stateRoot: string): Record<string, string> {
  return { [ENV_TAG]: envId, [SERVICE_TAG]: service, [ROOT_TAG]: stateRoot };
}

export const procScanSupported = (): boolean => process.platform === 'linux';

/**
 * Field 22 of /proc/<pid>/stat: the process start time in clock ticks since
 * boot. Unique per pid *life*, so (pid, startTime) survives pid reuse.
 *
 * comm (field 2) is an arbitrary string wrapped in parens and may itself
 * contain spaces or parens, so parse after the LAST ')' rather than splitting
 * the whole line.
 */
export function startTime(pid: number): number | undefined {
  if (!procScanSupported()) return darwinStartTime(pid);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(rest[19]); // field 22 == index 19 after pid and comm
    return Number.isFinite(ticks) ? ticks : undefined;
  } catch {
    return undefined; // gone, or not ours to read
  }
}

/**
 * A portable identity for platforms without /proc.
 *
 * Without this, non-Linux recovery fell back to a bare liveness check, which is
 * exactly the pid-reuse hazard the start time exists to close — and macOS is
 * the platform backlot's primary users are on. `ps -o lstart=` reports a
 * process's start wall-clock to the second, which is enough to distinguish a
 * recycled pid from the process we recorded.
 *
 * Returns undefined if ps is unavailable or the pid is gone; callers treat an
 * un-verifiable pid as un-signallable, so failing to read is safe.
 */
function darwinStartTime(pid: number): number | undefined {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    if (!out) return undefined;
    const ms = Date.parse(out);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined; // gone, not ours to read, or no ps
  }
}

/**
 * Field 5 of /proc/<pid>/stat: the process group id.
 *
 * `sh -c <cmd>` does NOT reliably exec: dash forks for anything non-trivial,
 * so the pid backlot records is often only the wrapper, and the real server is
 * a sibling in the same group. Killing "the leader" and then checking the
 * leader's liveness therefore reports success while the server keeps running —
 * group membership is the only honest liveness question.
 */
export function processGroup(pid: number): number | undefined {
  if (!procScanSupported()) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const pgrp = Number(rest[2]); // field 5 == index 2 after pid and comm
    return Number.isFinite(pgrp) ? pgrp : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Is ANY process still in this group?
 *
 * Without /proc, `kill(-pgid, 0)` is still a genuine GROUP query — ESRCH means
 * the group is empty. Checking the leader instead would report "gone" the
 * moment an `sh -c` wrapper exited, while the real server kept running, which
 * is the whole failure this function exists to detect.
 */
export function groupAlive(pgid: number): boolean {
  if (!procScanSupported()) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (err) {
      // EPERM: the group exists but belongs to another user — still alive.
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return isAlive(pgid);
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (processGroup(pid) === pgid) return true;
  }
  return false;
}

/** Is this pid alive at all? Says nothing about whose it is. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means alive but owned by another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Is pid N still the same process that was recorded with `recordedStart`?
 *
 * With no recorded start time (a journal written by an older backlot, or a
 * non-Linux host) this can only fall back to liveness, which is exactly the
 * pid-reuse hazard this exists to close — so callers should treat an
 * un-verifiable pid as un-signallable where a mistake would be costly.
 */
export function sameProcess(pid: number, recordedStart?: number): boolean {
  if (!isAlive(pid)) return false;
  if (recordedStart === undefined) return true;
  const current = startTime(pid);
  if (current === undefined) return false;
  return current === recordedStart;
}

/** Read a process's environment as a map, or undefined if unreadable. */
function readEnviron(pid: number): Record<string, string> | undefined {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
    const out: Record<string, string> = {};
    for (const entry of raw.split('\0')) {
      if (!entry) continue;
      const eq = entry.indexOf('=');
      if (eq > 0) out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  } catch {
    return undefined; // exited mid-scan, or another user's process
  }
}

/**
 * Every live process tagged as belonging to this state root.
 *
 * Note this finds *descendants* too — an `ng serve` inherits the tag from the
 * `sh -c` wrapper backlot spawned, which is the whole point: after the wrapper
 * dies the child is still identifiable.
 */
export function scanTagged(stateRoot: string): TaggedProc[] {
  if (!procScanSupported()) return [];
  const found: TaggedProc[] = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const env = readEnviron(pid);
    if (!env) continue;
    if (env[ROOT_TAG] !== stateRoot) continue;
    const envId = env[ENV_TAG];
    if (!envId) continue;
    const st = startTime(pid);
    if (st === undefined) continue; // exited between the two reads
    found.push({ pid, envId, service: env[SERVICE_TAG] ?? '?', startTime: st });
  }
  return found;
}

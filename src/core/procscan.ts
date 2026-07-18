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
 * Both rely on /proc, so they are Linux-only; on other platforms identity
 * degrades to a bare liveness check and orphan scanning reports unsupported.
 * That is deliberate: it is better to skip a sweep than to guess at identity
 * and signal someone else's process.
 */
import { readFileSync, readdirSync } from 'node:fs';

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
  if (!procScanSupported()) return undefined;
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
 * Is ANY process still in this group? On a platform without /proc this can
 * only fall back to the leader, which is the weaker guarantee.
 */
export function groupAlive(pgid: number): boolean {
  if (!procScanSupported()) return isAlive(pgid);
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

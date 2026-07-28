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
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
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
  // `kill(-pgid, 0)` is a SINGLE syscall and an authoritative group query:
  // ESRCH means no process remains in the group. An earlier version walked all
  // of /proc here, which is O(processes) file reads per call — and
  // killGroupVerified polls this every 50ms, so on a busy host a single reap
  // issued hundreds of thousands of reads and stalled the daemon.
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    // EPERM: the group exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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

/**
 * Field 7 of /proc/<pid>/stat: the controlling terminal, 0 for none.
 *
 * Backlot spawns every service with `stdio: ['ignore', 'pipe', 'pipe']` and
 * detached, so it and all its descendants have NO controlling terminal. A human's
 * interactive shell always has one. That difference is the only cheap evidence
 * available for "is a person sitting in front of this process".
 */
function hasControllingTty(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ttyNr = Number(rest[4]); // field 7 == index 4 after pid and comm
    return Number.isFinite(ttyNr) && ttyNr !== 0;
  } catch {
    return false; // unreadable — the caller's other guards decide
  }
}

/**
 * Every live process whose working directory sits inside `prefix` AND which has
 * no controlling terminal.
 *
 * The tag scan above misses a descendant that scrubbed its environment (a
 * process launched through `env -i`, a re-exec that rebuilds environ, some
 * language runtimes' worker pools). Those still have to live SOMEWHERE, and for
 * a service backlot started that somewhere is the environment tree.
 *
 * Linux keeps the cwd link readable after the directory is unlinked, appending
 * " (deleted)" to the target — which is precisely the shape of the leak this
 * exists to catch: hundreds of service children still running out of an
 * environment tree that was removed a day earlier. The suffix is stripped so a
 * deleted tree still matches its prefix.
 *
 * The tty exclusion is not a nicety. cwd is NOT proof of ownership — a developer
 * who runs `cd <env-tree>` to look around matches this scan exactly, and callers
 * signal a matched process's whole GROUP, so without the exclusion a teardown
 * would kill that person's shell and every job in it. That is the one outcome
 * this module exists to prevent (see the header): skipping a sweep is safe,
 * signalling a stranger's process is not. A backlot service can never be
 * excluded by it, because it never has a terminal to begin with.
 *
 * Even so, deliberately NOT used on the quiesce path: a warm environment's tree
 * stays on disk and may legitimately be occupied. Only teardown, which is about
 * to delete the tree anyway, may reap by cwd.
 */
export function scanByCwd(prefix: string): Array<{ pid: number; startTime: number; cwd: string }> {
  if (!procScanSupported()) return [];
  const self = process.pid;
  const found: Array<{ pid: number; startTime: number; cwd: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === self) continue;
    let cwd: string;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue; // exited, or another user's process — not ours to touch
    }
    const path = cwd.endsWith(' (deleted)') ? cwd.slice(0, -' (deleted)'.length) : cwd;
    // Prefix match on a path BOUNDARY, so `…/env-1` never matches `…/env-10`.
    if (path !== prefix && !path.startsWith(prefix.endsWith('/') ? prefix : prefix + '/')) continue;
    if (hasControllingTty(pid)) continue; // a person is using this one
    const st = startTime(pid);
    if (st === undefined) continue; // exited between the two reads
    found.push({ pid, startTime: st, cwd });
  }
  return found;
}

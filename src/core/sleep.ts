/**
 * Kernel-record sleep detection (macOS).
 *
 * The sweeper's original sleep pardon inferred suspend from wall-clock
 * outrunning performance.now(). That is correct on Linux, where
 * CLOCK_MONOTONIC halts through suspend — but INERT on Apple Silicon, where
 * mach_absolute_time keeps advancing through real sleep: a genuine lid-close
 * test (2026-07-19) produced no divergence, no pardon, no event of any kind,
 * and a dead lease. On darwin the daemon therefore reads the kernel's OWN
 * record of the last sleep/wake transition instead:
 *
 *   $ sysctl -n kern.sleeptime kern.waketime
 *   { sec = 1784497430, usec = 123456 } Sat Jul 19 23:43:50 2026
 *   { sec = 1784499830, usec = 654321 } Sun Jul 20 00:23:50 2026
 *
 * The parsing and the pardon decision are pure exported functions (the
 * policy()/pendingUpkeep() pattern) because a real lid close cannot be
 * automated and this repo forbids test-only interleaving hooks — the unit
 * tests in tests/sleep-pardon.test.ts encode the confirmed scenario; the
 * end-to-end proof remains the manual lid-close protocol (docs/soak.md).
 */
import { execFileSync } from 'node:child_process';

/**
 * Cap on a kernel-reported sleep gap. A pardon shifts EVERY lease and idle
 * deadline by the gap, so a corrupt or absurd record (bad clock at sleep time,
 * garbage sysctl) must not push deadlines out by years. Past the cap we prefer
 * letting deadlines lapse — losing a lease is designed to be worthless (§10):
 * the env returns warm and the next verb rebinds.
 */
export const MAX_KERNEL_PARDON_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Parse one sysctl timeval line — `{ sec = 1784497430, usec = 123456 } Sat
 * Jul 19 23:43:50 2026` — to milliseconds since the epoch. Returns null on
 * anything else: a missing or garbage sysctl must never break the sweep.
 */
export function parseSysctlTimeval(line: string | null | undefined): number | null {
  if (typeof line !== 'string') return null;
  const m = /\{\s*sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\s*\}/.exec(line);
  if (!m) return null;
  const sec = Number(m[1]);
  const usec = Number(m[2]);
  if (!Number.isFinite(sec) || !Number.isFinite(usec)) return null;
  return sec * 1000 + Math.floor(usec / 1000);
}

export interface KernelSleepArgs {
  /** kern.sleeptime as epoch ms, or null when unreadable. */
  sleeptime: number | null;
  /** kern.waketime as epoch ms, or null when unreadable. */
  waketime: number | null;
  /** waketime of the last sleep this daemon already pardoned (0 = none yet). */
  lastPardonedWake: number;
  /** Wall-clock instant of the PREVIOUS sweep tick. */
  lastSweepWall: number;
}

/**
 * The pardon decision: did the kernel record a wake that happened since the
 * previous sweep tick, for a sleep this daemon has not pardoned yet? Returns
 * the gap to pardon (waketime − sleeptime) or null.
 *
 * Guards, in order:
 *  - unreadable record → null (fall back to the wall-vs-monotonic detector);
 *  - wake already pardoned → null (the two detectors must not double-pardon
 *    one sleep — the caller tracks the last pardoned waketime);
 *  - wake at/before the previous sweep tick → null (a stale record: the
 *    machine's last wake predates this daemon's current sweep window, e.g.
 *    the boot-era record seen on daemon start, or a sleep the wall-vs-mono
 *    detector already pardoned on an earlier sweep);
 *  - sleeptime not strictly before waketime → null (mid-transition/corrupt);
 *  - gap beyond MAX_KERNEL_PARDON_MS → null (absurd value).
 */
export function kernelSleepGap(a: KernelSleepArgs): number | null {
  if (a.sleeptime === null || a.waketime === null) return null;
  if (a.waketime <= a.lastPardonedWake) return null;
  if (a.waketime <= a.lastSweepWall) return null;
  if (a.sleeptime >= a.waketime) return null;
  const gap = a.waketime - a.sleeptime;
  if (gap > MAX_KERNEL_PARDON_MS) return null;
  return gap;
}

/**
 * Read the kernel's sleep/wake record. Synchronous and cheap (~1 ms) at the
 * 15 s sweep cadence; darwin-only callers. Any failure — missing binary,
 * unknown OID, timeout — returns null legs: the sweep falls back to the
 * wall-vs-monotonic detector and must never be broken by sysctl.
 */
export function readKernelSleepRecord(): { sleeptime: number | null; waketime: number | null } {
  try {
    const out = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.sleeptime', 'kern.waketime'], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    const [sleepLine, wakeLine] = out.split('\n');
    return { sleeptime: parseSysctlTimeval(sleepLine), waketime: parseSysctlTimeval(wakeLine) };
  } catch {
    return { sleeptime: null, waketime: null };
  }
}

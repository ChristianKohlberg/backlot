/**
 * Kernel-record sleep detection (macOS) — the sleep pardon was CONFIRMED inert
 * on Apple Silicon by a real lid-close test (2026-07-19): performance.now()
 * (mach_absolute_time) keeps advancing through real sleep there, so the
 * wall-vs-monotonic divergence the sweeper watched for never appeared, the gap
 * was never pardoned, and a lease died mid-sleep with NO event of any kind.
 *
 * A real lid close cannot be automated and this repo forbids test-only
 * interleaving hooks, so the fix is structured like policy()/pendingUpkeep():
 * the sysctl parsing and the pardon decision are pure exported functions,
 * unit-tested here; the sweeper wires them up. The END-TO-END proof remains
 * the manual lid-close protocol recorded in docs/soak.md.
 */
import { describe, it, expect } from 'vitest';
import { parseSysctlTimeval, kernelSleepGap, MAX_KERNEL_PARDON_MS } from '../src/core/sleep.js';

const MIN = 60_000;

describe('parseSysctlTimeval', () => {
  it('parses the real `sysctl -n kern.waketime` line shape to epoch ms', () => {
    // Verbatim shape from macOS: `{ sec = 1784497430, usec = 123456 } Sat Jul 19 23:43:50 2026`
    expect(parseSysctlTimeval('{ sec = 1784497430, usec = 123456 } Sat Jul 19 23:43:50 2026')).toBe(
      1_784_497_430_000 + 123,
    );
  });

  it('parses the never-slept-since-boot record (epoch zero) to 0', () => {
    expect(parseSysctlTimeval('{ sec = 0, usec = 0 } Thu Jan  1 01:00:00 1970')).toBe(0);
  });

  it('tolerates whitespace variance', () => {
    expect(parseSysctlTimeval('{sec = 1784497430,usec = 0} whatever')).toBe(1_784_497_430_000);
  });

  it('returns null for garbage, empty, and missing input — a broken sysctl must never break the sweep', () => {
    expect(parseSysctlTimeval('')).toBeNull();
    expect(parseSysctlTimeval('sysctl: unknown oid \'kern.sleeptime\'')).toBeNull();
    expect(parseSysctlTimeval('{ sec = , usec = }')).toBeNull();
    expect(parseSysctlTimeval('{ sec = abc, usec = 12 }')).toBeNull();
    expect(parseSysctlTimeval(undefined)).toBeNull();
    expect(parseSysctlTimeval(null)).toBeNull();
  });
});

describe('kernelSleepGap — the pardon decision', () => {
  // The CONFIRMED scenario: a sweep ticks, the lid closes 5s later, the
  // machine sleeps 40 minutes (bracketing a 30-minute lease expiry), wakes,
  // and the next sweep runs shortly after wake. The kernel record must yield
  // the full sleep duration as the pardon gap.
  const sweep = 1_784_495_000_000; // previous sweep's wall instant
  const slept = sweep + 5_000;
  const woke = slept + 40 * MIN;

  it('a wake since the previous sweep whose sleep bracketed a lease expiry yields the gap', () => {
    expect(
      kernelSleepGap({ sleeptime: slept, waketime: woke, lastPardonedWake: 0, lastSweepWall: sweep }),
    ).toBe(40 * MIN);
  });

  it('a wake already pardoned yields null — the two detectors must not double-pardon one sleep', () => {
    expect(
      kernelSleepGap({ sleeptime: slept, waketime: woke, lastPardonedWake: woke, lastSweepWall: sweep }),
    ).toBeNull();
  });

  it('a wake that predates the previous sweep is stale (e.g. the machine last woke before the daemon started) and yields null', () => {
    expect(
      kernelSleepGap({ sleeptime: slept - 2 * MIN, waketime: slept - MIN, lastPardonedWake: 0, lastSweepWall: sweep }),
    ).toBeNull();
  });

  it('the never-slept-since-boot record (both zero) yields null', () => {
    expect(kernelSleepGap({ sleeptime: 0, waketime: 0, lastPardonedWake: 0, lastSweepWall: sweep })).toBeNull();
  });

  it('sleeptime >= waketime (mid-transition or corrupt record) yields null', () => {
    expect(
      kernelSleepGap({ sleeptime: woke, waketime: woke, lastPardonedWake: 0, lastSweepWall: sweep }),
    ).toBeNull();
    expect(
      kernelSleepGap({ sleeptime: woke + 1_000, waketime: woke, lastPardonedWake: 0, lastSweepWall: sweep }),
    ).toBeNull();
  });

  it('an unparseable sysctl (null legs) yields null — fall back to the wall-vs-monotonic detector', () => {
    expect(kernelSleepGap({ sleeptime: null, waketime: woke, lastPardonedWake: 0, lastSweepWall: sweep })).toBeNull();
    expect(kernelSleepGap({ sleeptime: slept, waketime: null, lastPardonedWake: 0, lastSweepWall: sweep })).toBeNull();
    expect(kernelSleepGap({ sleeptime: null, waketime: null, lastPardonedWake: 0, lastSweepWall: sweep })).toBeNull();
  });

  it('an absurd gap (beyond the cap) yields null rather than shifting every deadline by a corrupt value', () => {
    expect(
      kernelSleepGap({
        sleeptime: sweep - MAX_KERNEL_PARDON_MS - 10 * MIN,
        waketime: woke,
        lastPardonedWake: 0,
        lastSweepWall: sweep,
      }),
    ).toBeNull();
    // ... while a long-but-real sleep inside the cap is pardoned in full.
    expect(
      kernelSleepGap({
        sleeptime: woke - MAX_KERNEL_PARDON_MS,
        waketime: woke,
        lastPardonedWake: 0,
        lastSweepWall: sweep,
      }),
    ).toBe(MAX_KERNEL_PARDON_MS);
  });
});

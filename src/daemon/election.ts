/**
 * Daemon singleton election.
 *
 * The socket cannot elect a leader by itself. A daemon that finds a socket file
 * must decide whether it is live or a leftover from a crash, and the only way
 * to answer that is to ping it — but between the ping and the bind, a second
 * daemon can win the socket, and unlinking "the stale socket" then deletes a
 * LIVE one. Both daemons end up bound, both sweep the same journal, and each
 * reaps the other's processes.
 *
 * So election happens on a lock file first, using the same identity rule as
 * process reclaim (decision 0019): a holder is real only if its recorded pid
 * AND start time still match a live process. Only the winner is allowed to
 * touch the socket.
 */
import { openSync, writeSync, closeSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { lockPath } from '../core/paths.js';
import { sameProcess, startTime } from '../core/procscan.js';

interface Claim {
  pid: number;
  startTime?: number;
}

const readClaim = (path: string): Claim | undefined => {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Claim;
    return typeof raw?.pid === 'number' ? raw : undefined;
  } catch {
    return undefined; // absent, truncated, or mid-write
  }
};

const selfClaim = (): Claim => ({ pid: process.pid, startTime: startTime(process.pid) });

/** Is this claim held by a process that is genuinely still running? */
function claimIsLive(claim: Claim | undefined): boolean {
  if (!claim) return false;
  if (claim.pid === process.pid) return false; // our own stale lock from a previous life
  return sameProcess(claim.pid, claim.startTime);
}

/**
 * Try to become the daemon for this state root.
 *
 * Returns true if we own it and may proceed to bind the socket, false if a
 * live daemon already holds it and we should concede.
 */
export function electSelf(path = lockPath()): boolean {
  for (let attempt = 0; attempt < 5; attempt++) {
    // Atomic create-if-absent: the kernel picks exactly one winner.
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify(selfClaim()));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    const held = readClaim(path);
    if (claimIsLive(held)) return false; // a real daemon owns this state root

    // The holder is dead (or the file is corrupt). Break the lock by writing a
    // fresh claim to a private path and renaming it over the lock — rename is
    // atomic, so concurrent breakers cannot interleave a partial file. Several
    // may rename; the last one wins, and everyone re-reads to find out who that
    // was. Only the process that reads its own pid back proceeds.
    const tmp = `${path}.${process.pid}`;
    try {
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeSync(fd, JSON.stringify(selfClaim()));
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* best-effort */
      }
      continue;
    }

    const now = readClaim(path);
    if (now?.pid === process.pid) return true;
    if (claimIsLive(now)) return false;
    // Another breaker won the rename but has since died — go round again.
  }
  // Contention that never settled. Conceding is the safe answer: a missing
  // daemon is a clear error the client reports, whereas two daemons corrupt
  // shared state silently.
  return false;
}

/** Release the lock, but only if it is still ours. */
export function releaseSelf(path = lockPath()): void {
  const held = readClaim(path);
  if (held?.pid !== process.pid) return;
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

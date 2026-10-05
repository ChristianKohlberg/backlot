/**
 * The automatic tether (decision 0035). A lease or copy tied to a holder
 * process is torn down once that process has been gone for the grace period
 * (BACKLOT_TETHER_GRACE_MS, default 60 s). The CLI exits per invocation, so
 * the holder must be the long-lived caller; when none is given, the agent
 * this CLI runs under is used if it can be found:
 *
 *   - Claude Code exports CLAUDE_PID, the pid of the `claude` process every
 *     Bash tool call descends from. It is used when it is alive AND an
 *     ancestor of this CLI — a stale value inherited into an unrelated
 *     process tree (a daemon, a nohup'd job) is never trusted.
 *
 * BACKLOT_TETHER=off opts out (the environment then lives by its TTL).
 * --holder-pid / BACKLOT_HOLDER_PID always win.
 */
import { readFileSync } from 'node:fs';
import { isAlive } from '../core/procscan.js';

function parentOf(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 4, after the parenthesised command (which may contain spaces).
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(rest[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  } catch {
    return undefined;
  }
}

/** Is `ancestor` this process or one of its ancestors? Linux only (/proc). */
export function isAncestor(ancestor: number, of = process.pid): boolean {
  let pid: number | undefined = of;
  for (let i = 0; pid !== undefined && i < 64; i++) {
    if (pid === ancestor) return true;
    if (pid === 1) return false;
    pid = parentOf(pid);
  }
  return false;
}

export function autoTether(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const mode = (env.BACKLOT_TETHER ?? '').trim().toLowerCase();
  if (mode === 'off' || mode === '0' || mode === 'false') return undefined;
  const raw = env.CLAUDE_PID;
  if (!raw) return undefined;
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid)) return undefined;
  return isAncestor(pid) ? pid : undefined;
}

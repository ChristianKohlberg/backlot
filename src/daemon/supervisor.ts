/**
 * Daemon-as-parent service supervision (decision 0009/0010): spawn with env
 * injection, capture logs, probe readiness (http/log/cmd) with fatal-log
 * fast-fail, restart session services with bounded backoff, and never let a
 * crash pass silently.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrokerError, now, safeJoin } from '../core/util.js';
import { stateRoot } from '../core/paths.js';
import { groupAlive, processGroup, sameProcess, serviceTag, startTime } from '../core/procscan.js';
import type { ReadySpec, ServiceSpec } from '../core/manifest.js';
import type { ServicePid } from '../core/types.js';

export interface ServiceEvent {
  at: number;
  service: string;
  event: string;
}

interface Running {
  proc: ChildProcess;
  buf: string;
  restarts: number;
  expectedExit: boolean;
  /** Pending restart timer — must be cancellable by stopAll so it can't orphan. */
  restartTimer: NodeJS.Timeout | null;
  /** Kernel start time of `proc.pid`, captured at spawn (pid-reuse guard). */
  startTime?: number;
  /** When the current process was launched — the restart budget resets after STABLE_MS. */
  startedAt: number;
  /** A spawn 'error' is being handled; 'exit' may or may not follow it. */
  spawnFailed?: boolean;
}

/** Uptime past which a crash counts as fresh rather than part of a flap. */
const STABLE_MS = (): number => Number(process.env.BACKLOT_STABLE_MS ?? 60_000);

export class EnvSupervisor {
  private services = new Map<string, Running>();
  readonly events: ServiceEvent[] = [];

  constructor(
    readonly envId: string,
    private readonly envTree: string,
    private readonly logDir: string,
    /** Fired when a service flaps past its restart budget (decision 0007/0010). */
    private readonly onDegraded?: (service: string) => void,
    /** Fired whenever a service's pid changes (start/restart) so the journal
     * stays truthful for recovery — a stale pid gets an innocent SIGTERM and
     * misses the real orphan holding the port. */
    private readonly onPidsChanged?: () => void,
  ) {
    mkdirSync(logDir, { recursive: true });
  }

  private note(service: string, event: string): void {
    this.events.push({ at: Date.now(), service, event });
    if (this.events.length > 100) this.events.shift();
  }

  logPath(name: string): string {
    return join(this.logDir, `${name}.log`);
  }

  logs(name: string): string {
    return this.services.get(name)?.buf ?? '';
  }

  pids(): Record<string, ServicePid> {
    const out: Record<string, ServicePid> = {};
    for (const [name, r] of this.services) {
      if (r.proc?.pid && r.proc.exitCode === null) out[name] = { pid: r.proc.pid, startTime: r.startTime };
    }
    return out;
  }

  allHealthyPids(): boolean {
    return [...this.services.values()].every((r) => r.proc.exitCode === null);
  }

  start(name: string, spec: ServiceSpec, env: Record<string, string>, watchMode: boolean): void {
    const cmd = watchMode && spec.watch_run ? spec.watch_run : spec.run;
    // A repo can already run arbitrary shell here, so this is not a privilege
    // boundary — it makes an ACCIDENT loud. `cwd: ../sibling` silently ran the
    // service outside its environment tree, against files backlot never synced.
    const cwd = spec.cwd ? safeJoin(this.envTree, spec.cwd, `service '${name}' cwd`) : this.envTree;
    const running: Running = { proc: null as unknown as ChildProcess, buf: '', restarts: 0, expectedExit: false, restartTimer: null, startedAt: now() };
    const launch = () => {
      running.restartTimer = null;
      // A teardown that landed while this restart was pending: do not respawn.
      if (running.expectedExit) return;
      const proc = spawn('sh', ['-c', cmd], {
        cwd,
        // The tag rides in the environment so it is INHERITED by every
        // descendant. After an ungraceful death the sh -c wrapper is gone but
        // the real server still carries it, which is what lets a later daemon
        // find and reclaim an orphan it never spawned itself (issue #5).
        env: { ...process.env, ...env, ...serviceTag(this.envId, name, stateRoot()) },
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so signals reach the service and not just the
        // sh -c wrapper. On Linux (dash) the wrapper forks instead of
        // exec-ing, so killing only proc.pid orphaned the actual server —
        // it kept the port and every rebind-to-same-port flow failed with
        // "occupied by a foreign process" (BACKLOG P1, 2026-07-11).
        // Services still survive a daemon crash (crash-recovery contract):
        // nothing signals the group when the daemon itself dies.
        detached: true,
      });
      running.proc = proc;
      running.startedAt = now();
      // Capture identity immediately: once the pid exits this is unreadable,
      // and an un-pinned pid is one the reaper must refuse to signal.
      running.startTime = proc.pid ? startTime(proc.pid) : undefined;
      this.onPidsChanged?.();
      const sink = (d: Buffer) => {
        const s = d.toString();
        running.buf = (running.buf + s).slice(-64_000);
        try {
          appendFileSync(this.logPath(name), s);
        } catch {
          /* log dir gone mid-teardown */
        }
      };
      proc.stdout!.on('data', sink);
      proc.stderr!.on('data', sink);
      // A spawn failure (EAGAIN/EMFILE under fleet load) emits 'error'; with no
      // listener it becomes an uncaught exception that kills the whole daemon.
      proc.on('error', (err) => {
        this.note(name, `spawn error: ${err.message}`);
        // A spawn failure emits 'error' with NO 'exit', so the restart logic
        // below never ran: supervision simply stopped while the environment
        // stayed 'hot' and reported healthy. Drive the same path as an exit.
        if (running.expectedExit || running.spawnFailed) return;
        running.spawnFailed = true;
        this.onPidsChanged?.();
        if (running.restarts < 3) {
          running.restarts++;
          this.note(name, `restarting after spawn failure (attempt ${running.restarts})`);
          running.restartTimer = setTimeout(() => {
            running.spawnFailed = false;
            launch();
          }, 500 * running.restarts);
          running.restartTimer.unref();
        } else {
          this.note(name, 'spawn keeps failing — giving up (environment degraded)');
          this.onDegraded?.(name);
        }
      });
      proc.on('exit', (code) => {
        if (running.expectedExit) return;
        this.note(name, `exited (${code})`);
        this.onPidsChanged?.(); // the dead pid must leave the journal
        // The budget is for FLAPPING — a tight crash loop — not for a service's
        // whole lifetime. Without this reset, three unrelated crashes hours
        // apart degraded a long-lived environment that was never unhealthy.
        if (now() - running.startedAt > STABLE_MS()) running.restarts = 0;
        // Bounded restart for long-lived services (decision 0010).
        if (running.restarts < 3) {
          running.restarts++;
          this.note(name, `restarting (attempt ${running.restarts})`);
          running.restartTimer = setTimeout(launch, 500 * running.restarts);
          running.restartTimer.unref();
        } else {
          this.note(name, 'flapping — giving up (environment degraded)');
          this.onDegraded?.(name);
        }
      });
    };
    launch();
    this.services.set(name, running);
    this.note(name, 'started');
  }

  async waitReady(name: string, spec: ServiceSpec, url: string | undefined, env: Record<string, string>): Promise<void> {
    const ready: ReadySpec = spec.ready ?? (spec.port ? { http: '/' } : { log: '.' });
    const timeoutMs = (ready.timeout ?? 120) * 1000;
    const fatal = spec.fatal_logs ? new RegExp(spec.fatal_logs) : undefined;
    const start = Date.now();
    const running = this.services.get(name);
    if (!running) throw new BrokerError('env-error', `service '${name}' was never started`, name);

    for (;;) {
      const buf = running.buf;
      if (fatal && fatal.test(buf)) {
        throw new BrokerError('work-error', `service '${name}' hit a fatal log marker during boot`, name, tail(buf));
      }
      if (running.proc.exitCode !== null && running.restarts >= 3) {
        throw new BrokerError('work-error', `service '${name}' exited during boot (${running.proc.exitCode})`, name, tail(buf));
      }
      if (ready.http && url) {
        try {
          const res = await fetch(`${url}${ready.http}`, { signal: AbortSignal.timeout(1500) });
          if (res.status === 200) return;
        } catch {
          /* not yet */
        }
      } else if (ready.log) {
        if (new RegExp(ready.log).test(buf)) return;
      } else if (ready.cmd) {
        const ok = await new Promise<boolean>((resolve) => {
          execFile('sh', ['-c', ready.cmd!], { cwd: this.envTree, env: { ...process.env, ...env } }, (err) =>
            resolve(!err),
          );
        });
        if (ok) return;
      }
      if (Date.now() - start > timeoutMs) {
        throw new BrokerError('env-error', `service '${name}' not ready after ${ready.timeout ?? 120}s`, name, tail(running.buf));
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /** Stop every service; returns any that refused to die (empty is the norm). */
  async stopAll(): Promise<Record<string, ServicePid>> {
    const survivors: Record<string, ServicePid> = {};
    for (const [name, r] of this.services) {
      r.expectedExit = true;
      // Cancel any pending restart BEFORE it can fire — otherwise launch()
      // respawns an untracked process that squats the port after teardown.
      if (r.restartTimer) {
        clearTimeout(r.restartTimer);
        r.restartTimer = null;
      }
      // NOTE the exitCode check is deliberately absent: `sh -c` forks, so the
      // wrapper can be gone while the real server lives on in its group. The
      // identity check inside killGroupVerified fails safe for a dead leader, so
      // survivors get RECORDED for tag reclaim instead of vanishing silently.
      if (r.proc && r.proc.pid) {
        // Verify the group is actually gone rather than resolving as soon as
        // SIGKILL is *sent* — the caller goes on to delete the env root and
        // drop the pid, so a survivor here becomes an untrackable orphan.
        const dead = await killGroupVerified(r.proc.pid, r.startTime);
        if (!dead) {
          this.note(name, `still running after SIGKILL (pid ${r.proc.pid})`);
          survivors[name] = { pid: r.proc.pid, startTime: r.startTime };
        }
      }
      this.note(name, survivors[name] ? 'stop failed' : 'stopped');
    }
    this.services.clear();
    return survivors;
  }
}

const tail = (s: string, n = 600): string => s.slice(-n);

/** Signal a whole process group, falling back to the single pid we know of. */
function signalGroup(pgid: number, pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Not a group leader (or the group is already gone) — at minimum reach the
    // one process we can name.
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * SIGTERM a group, wait for it to actually die, then SIGKILL and confirm.
 *
 * The previous recovery path fired one SIGTERM and moved on, which anything
 * with a graceful-shutdown handler (a .NET host, `ng serve` under a trapping
 * shell) simply outlives — and since the caller then dropped the pid, the
 * survivor became unreachable forever. Escalation plus a verified verdict is
 * what makes "reaped" mean reaped.
 *
 * Returns true if the leader is confirmed gone.
 */
export async function killGroupVerified(
  pid: number,
  recordedStart?: number,
  graceMs = 2000,
): Promise<boolean> {
  if (!sameProcess(pid, recordedStart)) {
    // The pid is no longer the process we recorded. Whatever now sits in that
    // group may be a stranger's — our old children and an unrelated new leader
    // are indistinguishable by pid alone — so signalling it is never safe.
    // Report gone only if the group is genuinely empty; otherwise leave it
    // unresolved for tag-based reclaim, which pid reuse cannot confuse.
    return !groupAlive(pid);
  }
  // Resolve the group BEFORE signalling: once the leader exits its /proc entry
  // is gone and the surviving siblings become unattributable.
  const pgid = processGroup(pid) ?? pid;
  const gone = () => !groupAlive(pgid);

  signalGroup(pgid, pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    if (gone()) return true;
  }
  // The leader dying is NOT the success condition. `sh -c` commonly forks, so
  // the wrapper exits on SIGTERM while the real server — which ignored it —
  // keeps its port and its ~1 GB. Escalate against the whole group.
  signalGroup(pgid, pid, 'SIGKILL');
  // SIGKILL is not instantaneous: the kernel still has to tear the group down,
  // and reporting "reaped" early would let the caller drop the pid one poll
  // before the process is actually off the table.
  const hard = Date.now() + 2000;
  while (Date.now() < hard) {
    await new Promise((r) => setTimeout(r, 50));
    if (gone()) return true;
  }
  return gone();
}

/**
 * Kill PIDs recorded by a previous daemon life (recovery, decision 0009).
 *
 * Returns the entries that were NOT confirmed dead. The caller must keep those
 * in the journal — a forgotten pid is an orphan nobody can ever reclaim.
 */
export async function reapPids(pids: Record<string, ServicePid>): Promise<Record<string, ServicePid>> {
  const survivors: Record<string, ServicePid> = {};
  await Promise.all(
    Object.entries(pids).map(async ([name, rec]) => {
      // Recorded pids are group leaders (services spawn detached) — signal the
      // group so the actual server dies too, not just the sh -c wrapper.
      const dead = await killGroupVerified(rec.pid, rec.startTime);
      if (!dead) survivors[name] = rec;
    }),
  );
  return survivors;
}

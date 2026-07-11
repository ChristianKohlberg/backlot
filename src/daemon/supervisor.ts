/**
 * Daemon-as-parent service supervision (decision 0009/0010): spawn with env
 * injection, capture logs, probe readiness (http/log/cmd) with fatal-log
 * fast-fail, restart session services with bounded backoff, and never let a
 * crash pass silently.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrokerError } from '../core/util.js';
import type { ReadySpec, ServiceSpec } from '../core/manifest.js';

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
}

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

  pids(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, r] of this.services) if (r.proc.pid && r.proc.exitCode === null) out[name] = r.proc.pid;
    return out;
  }

  allHealthyPids(): boolean {
    return [...this.services.values()].every((r) => r.proc.exitCode === null);
  }

  start(name: string, spec: ServiceSpec, env: Record<string, string>, watchMode: boolean): void {
    const cmd = watchMode && spec.watch_run ? spec.watch_run : spec.run;
    const cwd = spec.cwd ? join(this.envTree, spec.cwd) : this.envTree;
    const running: Running = { proc: null as unknown as ChildProcess, buf: '', restarts: 0, expectedExit: false, restartTimer: null };
    const launch = () => {
      running.restartTimer = null;
      // A teardown that landed while this restart was pending: do not respawn.
      if (running.expectedExit) return;
      const proc = spawn('sh', ['-c', cmd], {
        cwd,
        env: { ...process.env, ...env },
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
      });
      proc.on('exit', (code) => {
        if (running.expectedExit) return;
        this.note(name, `exited (${code})`);
        this.onPidsChanged?.(); // the dead pid must leave the journal
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

  async stopAll(): Promise<void> {
    for (const [name, r] of this.services) {
      r.expectedExit = true;
      // Cancel any pending restart BEFORE it can fire — otherwise launch()
      // respawns an untracked process that squats the port after teardown.
      if (r.restartTimer) {
        clearTimeout(r.restartTimer);
        r.restartTimer = null;
      }
      if (r.proc && r.proc.exitCode === null) {
        await new Promise<void>((resolve) => {
          r.proc.once('exit', () => resolve());
          killGroup(r.proc);
          setTimeout(() => {
            killGroup(r.proc, 'SIGKILL');
            resolve();
          }, 2000).unref();
        });
      }
      this.note(name, 'stopped');
    }
    this.services.clear();
  }
}

const tail = (s: string, n = 600): string => s.slice(-n);

/** Signal a service's whole process group; fall back to the leader alone. */
function killGroup(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!proc.pid) return;
  try {
    process.kill(-proc.pid, signal); // detached spawn => pid is the group leader
  } catch {
    try {
      proc.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** Kill PIDs recorded by a previous daemon life (recovery, decision 0009). */
export function reapPids(pids: Record<string, number>): void {
  for (const pid of Object.values(pids)) {
    // Recorded pids are group leaders (services spawn detached) — signal the
    // group so the actual server dies too, not just the sh -c wrapper.
    try {
      process.kill(-pid);
    } catch {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  }
}

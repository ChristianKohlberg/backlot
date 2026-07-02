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
}

export class EnvSupervisor {
  private services = new Map<string, Running>();
  readonly events: ServiceEvent[] = [];

  constructor(
    readonly envId: string,
    private readonly envTree: string,
    private readonly logDir: string,
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
    const running: Running = { proc: null as unknown as ChildProcess, buf: '', restarts: 0, expectedExit: false };
    const launch = () => {
      const proc = spawn('sh', ['-c', cmd], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
      running.proc = proc;
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
      proc.on('exit', (code) => {
        if (running.expectedExit) return;
        this.note(name, `exited (${code})`);
        // Bounded restart for long-lived services (decision 0010).
        if (running.restarts < 3) {
          running.restarts++;
          this.note(name, `restarting (attempt ${running.restarts})`);
          setTimeout(launch, 500 * running.restarts).unref();
        } else {
          this.note(name, 'flapping — giving up (environment degraded)');
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
      if (r.proc.exitCode === null) {
        await new Promise<void>((resolve) => {
          r.proc.once('exit', () => resolve());
          r.proc.kill();
          setTimeout(() => {
            r.proc.kill('SIGKILL');
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

/** Kill PIDs recorded by a previous daemon life (recovery, decision 0009). */
export function reapPids(pids: Record<string, number>): void {
  for (const pid of Object.values(pids)) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
}

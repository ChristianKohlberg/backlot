/** Request-local bind explanations. Never persist commands or environment values. */
export interface BindDiagnostics {
  durationMs: number;
  phasesMs: Record<BindPhase, number>;
  /**
   * `reused`: the environment was already running in the requested shape and
   * nothing asked for a restart, so nothing was built or restarted; `rebound`:
   * the ordinary prepare/build/start path; `refreshed`: hot-reload services kept
   * running (they read the worktree themselves).
   */
  reuse: 'reused' | 'rebound' | 'refreshed';
  reasons: string[];
  upkeep: { ran: number; skipped: number };
  /**
   * The services whose `build:` ran in this bind. runly keeps no build cache
   * (decision 0032): every bind that starts a service with a `build:` runs it,
   * and the build tool decides what is already up to date.
   */
  builds: Array<{ service: string; durationMs: number }>;
}

type BindPhase = 'queue' | 'prepare' | 'appliances' | 'upkeep' | 'stop' | 'data' | 'build' | 'ready' | 'finalize';

export class BindTrace {
  readonly result: BindDiagnostics = {
    durationMs: 0,
    phasesMs: { queue: 0, prepare: 0, appliances: 0, upkeep: 0, stop: 0, data: 0, build: 0, ready: 0, finalize: 0 },
    reuse: 'rebound', reasons: [],
    upkeep: { ran: 0, skipped: 0 }, builds: [],
  };
  private started = performance.now();
  private marked = this.started;
  private current: BindPhase = 'prepare';

  phase(next: BindPhase): void {
    const at = performance.now();
    this.result.phasesMs[this.current] += at - this.marked;
    this.marked = at;
    this.current = next;
  }

  finish(): BindDiagnostics {
    this.phase('finalize');
    this.result.durationMs = performance.now() - this.started;
    return this.result;
  }
}

/** Request-local bind explanations. Never persist commands or environment values. */
export interface BindDiagnostics {
  durationMs: number;
  phasesMs: Record<BindPhase, number>;
  /**
   * `reused`: the services kept running — every build ran and none changed a
   * service's declared outputs; `restarted`: the services kept running except
   * `restarted`, whose build output changed (or which declare none); `rebound`:
   * the full stop/data/build/start path.
   */
  reuse: 'reused' | 'restarted' | 'rebound';
  /** The services an `up` restarted because their build output changed. */
  restarted: string[];
  reasons: string[];
  upkeep: { ran: number; skipped: number };
  /**
   * Every `build:` that ran in this operation — all of them, every `up`
   * (decision 0032: runly keeps no build cache; the build tool decides what is
   * current) — and whether its service was restarted, with why:
   * `outputs-changed`, `outputs-unchanged`, `no-outputs-declared` (always
   * restarted) or `full-rebind`.
   */
  builds: Array<{ service: string; durationMs: number; restart: boolean; reason: 'outputs-changed' | 'outputs-unchanged' | 'no-outputs-declared' | 'full-rebind' }>;
}

type BindPhase = 'queue' | 'prepare' | 'appliances' | 'upkeep' | 'stop' | 'data' | 'build' | 'ready' | 'finalize';

export class BindTrace {
  readonly result: BindDiagnostics = {
    durationMs: 0,
    phasesMs: { queue: 0, prepare: 0, appliances: 0, upkeep: 0, stop: 0, data: 0, build: 0, ready: 0, finalize: 0 },
    reuse: 'rebound', restarted: [], reasons: [],
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

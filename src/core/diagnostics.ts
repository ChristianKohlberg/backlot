/** Request-local bind explanations. Never persist commands or environment values. */
export interface BindDiagnostics {
  durationMs: number;
  phasesMs: Record<BindPhase, number>;
  reuse: 'reused' | 'rebound' | 'projected';
  reasons: string[];
  sync: { files: number; copied: number; deleted: number };
  upkeep: { ran: number; skipped: number };
  builds: Array<{ service: string; cache: 'hit' | 'miss' | 'skipped'; reason: string }>;
}

type BindPhase = 'queue' | 'prepare' | 'appliances' | 'sync' | 'upkeep' | 'stop' | 'data' | 'build' | 'ready' | 'finalize';

export class BindTrace {
  readonly result: BindDiagnostics = {
    durationMs: 0,
    phasesMs: { queue: 0, prepare: 0, appliances: 0, sync: 0, upkeep: 0, stop: 0, data: 0, build: 0, ready: 0, finalize: 0 },
    reuse: 'rebound', reasons: [], sync: { files: 0, copied: 0, deleted: 0 },
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

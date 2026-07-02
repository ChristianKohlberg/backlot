/**
 * Structured daemon event log (task: observability). Failures used to vanish
 * into swallowed catches; this makes them visible. Append-only JSONL under the
 * state dir, size-capped in place, read back by `status`/`doctor`.
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from './paths.js';

export type EventLevel = 'info' | 'warn' | 'error';
export interface DaemonEvent {
  at: number;
  level: EventLevel;
  kind: string;
  envId?: string;
  detail?: string;
}

const logPath = () => join(stateRoot(), 'events.jsonl');
const CAP = 512 * 1024;

export function logEvent(e: Omit<DaemonEvent, 'at'>): void {
  const line = JSON.stringify({ at: Date.now(), ...e }) + '\n';
  try {
    const p = logPath();
    try {
      if (statSync(p).size > CAP) {
        const kept = readFileSync(p, 'utf8').split('\n').slice(-500).join('\n');
        writeFileSync(p, kept);
      }
    } catch {
      /* no file yet */
    }
    appendFileSync(p, line);
  } catch {
    /* logging must never throw into a caller */
  }
}

export function recentEvents(limit = 30): DaemonEvent[] {
  try {
    return readFileSync(logPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l) as DaemonEvent);
  } catch {
    return [];
  }
}

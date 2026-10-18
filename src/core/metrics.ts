/** Bounded, best-effort measurements. Never activity; never stores payloads or errors. */
import { readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { stateRoot } from './paths.js';

export interface MetricLabels {
  stack?: string;
  envId?: string;
  service?: string;
  datastore?: string;
  outcome?: string;
  reason?: string;
  operationId?: string;
}
const RETENTION = 24 * 60 * 60 * 1000;
const MINUTE = 60_000;
const MAX_BUCKETS = 12_000;
const MAX_OPERATIONS = 200;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
// Upper bounds in the metric's unit (durations use milliseconds).
const BOUNDS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000];
interface Bucket {
  at: number;
  name: string;
  labels: MetricLabels;
  count: number;
  total: number;
  min: number;
  max: number;
  histogram: number[];
}
export interface Operation { at: number; name: string; value: number; labels: MetricLabels }
export interface Collection {
  startedAt: number;
  lastFlushAt: number | null;
  droppedObservations: number;
  storageErrors: number;
  historyTruncated: boolean;
  flushIntervalMs: number;
}
interface Store {
  root: string;
  buckets: Map<string, Bucket>;
  recentOperations: Operation[];
  collection: Collection;
  dirty: boolean;
  timer?: NodeJS.Timeout;
  prunedAt?: number;
}
export interface MetricSeries {
  name: string;
  labels: MetricLabels;
  count: number;
  total: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
}
export interface MetricsReport {
  version: 1;
  generatedAt: number;
  window: { since: number; until: number; retentionMs: number; bucketMs: number };
  quantiles: 'histogram-upper-bound';
  collection: Collection & {
    /** Earliest retained minute in this scope, not a promise of gap-free coverage. */
    retainedSince: number | null;
  };
  series: MetricSeries[];
  recentOperations: Operation[];
}
const context = new AsyncLocalStorage<MetricLabels>();
export function withMetricContext<T>(labels: MetricLabels, fn: () => T): T {
  return context.run({ ...context.getStore(), ...labels }, fn);
}
let current: Store | undefined;
function labelValue(value: string): string {
  // Keep names bounded without merging distinct long names or stripping the
  // worktree identity at the end of a long stack name. Filters use this too.
  return value.length <= 160 ? value : `${value.slice(0, 127)}~${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}
function cleanLabels(labels: MetricLabels, operation = false): MetricLabels {
  const out: MetricLabels = {};
  for (const key of ['stack', 'envId', 'service', 'datastore', 'outcome', 'reason', ...(operation ? ['operationId'] : [])] as (keyof MetricLabels)[]) {
    const value = labels[key];
    if (typeof value === 'string') out[key] = labelValue(value);
  }
  return out;
}
function keyOf(b: Pick<Bucket, 'name' | 'labels'>, at?: number): string {
  return JSON.stringify([at, b.name, b.labels]);
}
function prune(s: Store, now: number): void {
  if (s.prunedAt !== undefined && now - s.prunedAt < MINUTE && now >= s.prunedAt) return;
  s.prunedAt = now;
  const minute = Math.floor(now / MINUTE) * MINUTE;
  for (const [key, b] of s.buckets) {
    // A wall-clock rollback makes future buckets impossible to place in a
    // truthful window. Discard them explicitly instead of retaining them until
    // the clock catches up (which could exceed our retention indefinitely).
    if (b.at > minute) {
      s.collection.droppedObservations += b.count;
      s.collection.historyTruncated = true;
    }
    if (b.at > minute || b.at + MINUTE <= now - RETENTION) { s.buckets.delete(key); s.dirty = true; }
  }
  const operations = s.recentOperations.filter((o) => o.at >= now - RETENTION && o.at <= now).slice(-MAX_OPERATIONS);
  if (operations.length !== s.recentOperations.length) s.dirty = true;
  s.recentOperations = operations;
}
function store(): Store {
  // Resolve without the mkdir/chmod in stateRoot: traffic must do no disk I/O.
  const requested = process.env.BACKLOT_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'backlot');
  if (current?.root === requested) return current;
  const root = stateRoot();
  if (current) { persist(current); clearTimeout(current.timer); }
  const s: Store = { root, buckets: new Map(), recentOperations: [], dirty: false,
    collection: { startedAt: Date.now(), lastFlushAt: null, droppedObservations: 0, storageErrors: 0, historyTruncated: false, flushIntervalMs: 5_000 } };
  try {
    const path = join(root, 'metrics.json');
    if (statSync(path).size > MAX_FILE_BYTES) throw new Error('metrics size');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed.version !== 1 || !Array.isArray(parsed.buckets) || parsed.buckets.length > MAX_BUCKETS) throw new Error('metrics format');
    for (const b of parsed.buckets) {
      if (typeof b.name !== 'string' || !b.labels || !Number.isFinite(b.at) || !Number.isFinite(b.total) || !Number.isFinite(b.min) || !Number.isFinite(b.max) || !Number.isSafeInteger(b.count) || b.count < 1 || !Array.isArray(b.histogram) || b.histogram.length !== BOUNDS.length + 1 || b.histogram.some((n: unknown) => !Number.isSafeInteger(n) || (n as number) < 0)) throw new Error('metrics bucket');
      b.labels = cleanLabels(b.labels);
      s.buckets.set(keyOf(b, b.at), b);
    }
    if (parsed.collection && Number.isFinite(parsed.collection.startedAt)) {
      for (const key of ['startedAt', 'droppedObservations', 'storageErrors'] as const) {
        if (Number.isFinite(parsed.collection[key]) && parsed.collection[key] >= 0) s.collection[key] = parsed.collection[key];
      }
      s.collection.lastFlushAt = Number.isFinite(parsed.collection.lastFlushAt) ? parsed.collection.lastFlushAt : null;
      s.collection.historyTruncated = parsed.collection.historyTruncated === true;
    }
    if (Array.isArray(parsed.recentOperations)) s.recentOperations = parsed.recentOperations.slice(-MAX_OPERATIONS).filter((o: Operation) => typeof o.name === 'string' && Number.isFinite(o.at) && Number.isFinite(o.value) && o.labels).map((o: Operation) => ({ at: o.at, name: o.name.slice(0, 100), value: o.value, labels: cleanLabels(o.labels, true) }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { s.collection.storageErrors++; s.collection.historyTruncated = true; s.buckets.clear(); }
  }
  prune(s, Date.now());
  current = s;
  return s;
}
function persist(s: Store): void {
  prune(s, Date.now());
  if (!s.dirty) return;
  try {
    const at = Date.now();
    const serialize = () => JSON.stringify({ version: 1, buckets: [...s.buckets.values()], recentOperations: s.recentOperations, collection: { ...s.collection, lastFlushAt: at } });
    let text = serialize();
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
      // Character limits do not bound UTF-8 bytes. Trim oldest history in one
      // pass, reserving room for the updated truncation counters. Repeatedly
      // serializing the whole store after each eviction would be quadratic.
      let bytes = Buffer.byteLength(text);
      const target = MAX_FILE_BYTES - 1024;
      for (const [key, bucket] of [...s.buckets].sort((a, b) => a[1].at - b[1].at)) {
        if (bytes <= target) break;
        bytes -= Buffer.byteLength(JSON.stringify(bucket)) + 1;
        s.buckets.delete(key);
        s.collection.droppedObservations += bucket.count;
        s.collection.historyTruncated = true;
      }
      // Operation samples are separately bounded, but trim them defensively
      // too if a future metadata addition makes them exceed the file budget.
      while (bytes > target && s.recentOperations.length) {
        bytes -= Buffer.byteLength(JSON.stringify(s.recentOperations.shift())) + 1;
        s.collection.historyTruncated = true;
      }
      text = serialize();
      if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('metrics size');
    }
    const path = join(s.root, 'metrics.json');
    writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    s.collection.lastFlushAt = at;
    s.dirty = false;
  } catch { s.collection.storageErrors++; }
}
export function recordMetric(name: string, value: number, labels: MetricLabels = {}): void {
  try {
    labels = { ...context.getStore(), ...labels };
    const s = store();
    if (!/^[a-z][a-z0-9_.-]{0,99}$/.test(name) || !Number.isFinite(value) || value < 0) { s.collection.droppedObservations++; s.dirty = true; return; }
    const now = Date.now();
    prune(s, now);
    const at = Math.floor(now / MINUTE) * MINUTE;
    const safe = cleanLabels(labels);
    const key = keyOf({ name, labels: safe }, at);
    let b = s.buckets.get(key);
    if (!b) {
      if (s.buckets.size >= MAX_BUCKETS) {
        // Remove oldest bucket rather than refusing measurements of new worktrees.
        let oldest: string | undefined; let oldestAt = Infinity;
        for (const [k, bucket] of s.buckets) if (bucket.at < oldestAt) { oldestAt = bucket.at; oldest = k; }
        if (oldest !== undefined) { s.collection.droppedObservations += s.buckets.get(oldest)!.count; s.buckets.delete(oldest); }
        s.collection.historyTruncated = true;
      }
      b = { at, name, labels: safe, count: 0, total: 0, min: value, max: value, histogram: Array(BOUNDS.length + 1).fill(0) };
      s.buckets.set(key, b);
    }
    b.count++; b.total += value; b.min = Math.min(b.min, value); b.max = Math.max(b.max, value);
    const index = BOUNDS.findIndex((bound) => value <= bound);
    b.histogram[index < 0 ? BOUNDS.length : index]!++;
    if (labels.operationId) {
      s.recentOperations.push({ at: now, name, value, labels: cleanLabels(labels, true) });
      if (s.recentOperations.length > MAX_OPERATIONS) s.recentOperations.shift();
    }
    s.dirty = true;
    if (!s.timer) {
      s.timer = setTimeout(() => { s.timer = undefined; persist(s); }, 5_000);
      s.timer.unref();
    }
  } catch { /* Telemetry cannot fail a service operation, even with an inaccessible state root. */ }
}
export async function measureMetric<T>(name: string, labels: MetricLabels, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    recordMetric(name, performance.now() - start, { ...labels, outcome: 'success' });
    return result;
  } catch (error) {
    recordMetric(name, performance.now() - start, { ...labels, outcome: 'error' });
    throw error;
  }
}
export function flushMetrics(): void {
  if (current) { clearTimeout(current.timer); current.timer = undefined; persist(current); }
}
export function metricsSnapshot(options: { sinceMs?: number; stack?: string } = {}): MetricsReport {
  const s = store(); const now = Date.now(); prune(s, now);
  const stack = options.stack === undefined ? undefined : labelValue(options.stack);
  const duration = Number.isFinite(options.sinceMs) && options.sinceMs! > 0 ? Math.min(options.sinceMs!, RETENTION) : RETENTION;
  // Include the entire boundary minute and expose the rounded effective window.
  const since = Math.floor((now - duration) / MINUTE) * MINUTE;
  const grouped = new Map<string, Bucket>();
  let retainedSince: number | null = null;
  for (const b of s.buckets.values()) {
    if (b.at > now || (stack !== undefined && b.labels.stack !== stack)) continue;
    retainedSince = retainedSince === null ? b.at : Math.min(retainedSince, b.at);
    if (b.at < since) continue;
    const key = keyOf(b); const existing = grouped.get(key);
    if (!existing) grouped.set(key, { ...b, labels: { ...b.labels }, histogram: [...b.histogram] });
    else {
      existing.count += b.count; existing.total += b.total; existing.min = Math.min(existing.min, b.min); existing.max = Math.max(existing.max, b.max);
      b.histogram.forEach((n, i) => { existing.histogram[i]! += n; });
    }
  }
  const quantile = (b: Bucket, q: number): number => {
    let count = 0;
    for (let i = 0; i < b.histogram.length; i++) { count += b.histogram[i]!; if (count >= Math.ceil(b.count * q)) return Math.min(BOUNDS[i] ?? b.max, b.max); }
    return b.max;
  };
  return { version: 1, generatedAt: now, window: { since, until: now, retentionMs: RETENTION, bucketMs: MINUTE }, quantiles: 'histogram-upper-bound', collection: { ...s.collection, retainedSince },
    series: [...grouped.values()].map((b) => ({ name: b.name, labels: b.labels, count: b.count, total: b.total, min: b.min, max: b.max, p50: quantile(b, .5), p95: quantile(b, .95) })).sort((a, b) => a.name.localeCompare(b.name)),
    recentOperations: s.recentOperations.filter((o) => o.at >= since && o.at <= now && (stack === undefined || o.labels.stack === stack)).map((o) => ({ ...o, labels: { ...o.labels } })) };
}

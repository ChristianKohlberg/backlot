import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { flushMetrics, measureMetric, metricsSnapshot, recordMetric, withMetricContext } from '../src/core/metrics.js';

let root: string;
const original = process.env.BACKLOT_STATE_DIR;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metrics-'));
  process.env.BACKLOT_STATE_DIR = root;
});
afterEach(() => {
  flushMetrics();
  vi.useRealTimers();
  if (original === undefined) delete process.env.BACKLOT_STATE_DIR;
  else process.env.BACKLOT_STATE_DIR = original;
  rmSync(root, { recursive: true, force: true });
});

describe('bounded local metrics', () => {
  it('aggregates exact counts/totals and histogram upper bounds, with stack isolation', () => {
    for (const value of [3, 4, 7, 14]) recordMetric('wake_ms', value, { stack: 'a' });
    recordMetric('wake_ms', 200, { stack: 'b' });
    const report = metricsSnapshot({ stack: 'a' });
    expect(report.series).toEqual([{ name: 'wake_ms', labels: { stack: 'a' }, count: 4, total: 28, min: 3, max: 14, p50: 5, p95: 14 }]);
    expect(report.quantiles).toBe('histogram-upper-bound');
  });
  it('persists and reloads after switching state roots, without cross-root measurements', () => {
    recordMetric('proxy.bytes_in', 50, { stack: 'a' });
    flushMetrics();
    expect(JSON.parse(readFileSync(join(root, 'metrics.json'), 'utf8')).buckets).toHaveLength(1);
    process.env.BACKLOT_STATE_DIR = join(root, 'other');
    expect(metricsSnapshot().series).toEqual([]);
    recordMetric('proxy.bytes_in', 400);
    flushMetrics();
    process.env.BACKLOT_STATE_DIR = root;
    expect(metricsSnapshot().series[0]?.total).toBe(50);
  });
  it('keeps long shared-prefix stack and service identities distinct and queryable after reload', () => {
    const prefix = 'a'.repeat(170);
    const stackA = `${prefix}-worktree-a`;
    const stackB = `${prefix}-worktree-b`;
    recordMetric('build_ms', 10, { stack: stackA, service: `${prefix}-web`, operationId: 'a' });
    recordMetric('build_ms', 20, { stack: stackA, service: `${prefix}-api`, operationId: 'a' });
    recordMetric('build_ms', 300, { stack: stackB, service: `${prefix}-web`, operationId: 'b' });
    flushMetrics();
    process.env.BACKLOT_STATE_DIR = join(root, 'other');
    metricsSnapshot();
    process.env.BACKLOT_STATE_DIR = root;
    const a = metricsSnapshot({ stack: stackA });
    expect(a.series).toHaveLength(2);
    expect(a.series.map((s) => s.total).sort((x, y) => x - y)).toEqual([10, 20]);
    expect(new Set(a.series.map((s) => s.labels.service)).size).toBe(2);
    expect(a.recentOperations.map((o) => o.labels.operationId)).toEqual(['a', 'a']);
    expect(metricsSnapshot({ stack: stackB }).series.map((s) => s.total)).toEqual([300]);
    expect(metricsSnapshot({ stack: `${prefix}-unknown` }).series).toEqual([]);
    expect(a.series.every((s) => s.labels.stack!.length <= 160 && s.labels.service!.length <= 160)).toBe(true);
  });
  it('rounds the requested window to minute buckets and expires old measurements', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:05Z'));
    recordMetric('wake_ms', 20);
    vi.setSystemTime(new Date('2026-01-01T12:02:10Z'));
    recordMetric('wake_ms', 40);
    const recent = metricsSnapshot({ sinceMs: 60_000 });
    expect(recent.window.since).toBe(Date.parse('2026-01-01T12:01:00Z'));
    expect(recent.series[0]?.count).toBe(1);
    vi.setSystemTime(new Date('2026-01-02T12:03:00Z'));
    expect(metricsSnapshot().series).toEqual([]);
    flushMetrics();
    expect(JSON.parse(readFileSync(join(root, 'metrics.json'), 'utf8')).buckets).toEqual([]);
  });
  it('preserves result/error and correlates child observations without high-cardinality series', async () => {
    const secret = new Error('secret password');
    await withMetricContext({ stack: 'a', operationId: 'up-1' }, async () => {
      expect(await measureMetric('build_ms', {}, async () => 42)).toBe(42);
      await expect(measureMetric('build_ms', { service: 'web' }, async () => { throw secret; })).rejects.toBe(secret);
    });
    withMetricContext({ stack: 'a', operationId: 'up-2' }, () => recordMetric('build_ms', 4, { outcome: 'success' }));
    const report = metricsSnapshot();
    expect(report.series).toHaveLength(2);
    expect(report.series.find((s) => s.labels.outcome === 'success')?.count).toBe(2);
    expect(report.recentOperations.map((o) => o.labels.operationId)).toEqual(['up-1', 'up-1', 'up-2']);
    expect(JSON.stringify(report)).not.toContain('secret password');
  });
  it('discards future history after clock rollback and reports the resulting gap', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T12:00:05Z'));
    recordMetric('wake_ms', 20, { operationId: 'before-clock-correction' });
    flushMetrics();
    vi.setSystemTime(new Date('2026-01-01T12:00:05Z'));
    const report = metricsSnapshot({ sinceMs: 60_000 });
    expect(report.series).toEqual([]);
    expect(report.recentOperations).toEqual([]);
    expect(report.collection.historyTruncated).toBe(true);
    expect(report.collection.droppedObservations).toBe(1);
    recordMetric('wake_ms', 40, { operationId: 'after-clock-correction' });
    flushMetrics();
    const persisted = JSON.parse(readFileSync(join(root, 'metrics.json'), 'utf8'));
    expect(persisted.buckets).toHaveLength(1);
    expect(persisted.buckets[0].total).toBe(40);
    expect(persisted.recentOperations.map((o: { labels: { operationId: string } }) => o.labels.operationId)).toEqual(['after-clock-correction']);
  });
  it('bounds history and correlation samples, exposing dropped data', () => {
    for (let i = 0; i < 12_010; i++) recordMetric('build_ms', 1, { service: `s${i}`, operationId: `op${i}` });
    const report = metricsSnapshot();
    expect(report.series).toHaveLength(12_000);
    expect(report.recentOperations).toHaveLength(200);
    expect(report.collection.historyTruncated).toBe(true);
    expect(report.collection.droppedObservations).toBe(10);
  });
  it('reports persistence failures without interrupting operations', () => {
    recordMetric('wake_ms', 2);
    mkdirSync(join(root, 'metrics.json.tmp'));
    expect(() => flushMetrics()).not.toThrow();
    expect(metricsSnapshot().collection.storageErrors).toBe(1);
    expect(metricsSnapshot().series[0]?.count).toBe(1);
    rmSync(join(root, 'metrics.json.tmp'), { recursive: true });
    flushMetrics();
    expect(metricsSnapshot().collection.lastFlushAt).not.toBeNull();
  });
  it('trims oldest history to the UTF-8 byte cap and persists the remaining Unicode measurements', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:05Z'));
    recordMetric('oldest_ms', 1);
    vi.setSystemTime(new Date('2026-01-01T12:01:05Z'));
    const label = '界'.repeat(160);
    for (let i = 0; i < 6000; i++) recordMetric('build_ms', 1, {
      stack: label, envId: label, datastore: label, outcome: label, reason: label,
      service: `${'界'.repeat(152)}${i}`, operationId: `operation-${i}`,
    });
    flushMetrics();
    expect(statSync(join(root, 'metrics.json')).size).toBeLessThanOrEqual(16 * 1024 * 1024);
    const report = metricsSnapshot();
    expect(report.collection.storageErrors).toBe(0);
    expect(report.collection.historyTruncated).toBe(true);
    expect(report.collection.droppedObservations).toBeGreaterThan(0);
    expect(report.series.length).toBeGreaterThan(0);
    expect(report.series.length).toBeLessThan(6000);
    expect(report.series.some((s) => s.name === 'oldest_ms')).toBe(false);
    expect(report.collection.retainedSince).toBe(Date.parse('2026-01-01T12:01:00Z'));
    process.env.BACKLOT_STATE_DIR = join(root, 'other');
    metricsSnapshot();
    process.env.BACKLOT_STATE_DIR = root;
    const loaded = metricsSnapshot();
    expect(loaded.collection.storageErrors).toBe(0);
    expect(loaded.collection.droppedObservations).toBe(report.collection.droppedObservations);
    expect(loaded.series).toEqual(report.series);
  });
  it('reports earliest retained data per scope independently of the requested window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:05Z'));
    recordMetric('wake_ms', 1, { stack: 'a' });
    vi.setSystemTime(new Date('2026-01-01T12:03:05Z'));
    recordMetric('wake_ms', 2, { stack: 'b' });
    const a = metricsSnapshot({ stack: 'a', sinceMs: 60_000 });
    expect(a.series).toEqual([]);
    expect(a.collection.retainedSince).toBe(Date.parse('2026-01-01T12:00:00Z'));
    expect(metricsSnapshot({ stack: 'b' }).collection.retainedSince).toBe(Date.parse('2026-01-01T12:03:00Z'));
    expect(metricsSnapshot({ stack: 'unknown' }).collection.retainedSince).toBeNull();
  });
  it('recovers from corrupt storage, reports a gap, and rejects invalid observations', () => {
    writeFileSync(join(root, 'metrics.json'), 'broken');
    recordMetric('wake_ms', NaN);
    recordMetric('wake_ms', -1);
    recordMetric('wake_ms', 5);
    const report = metricsSnapshot();
    expect(report.collection.storageErrors).toBe(1);
    expect(report.collection.historyTruncated).toBe(true);
    expect(report.collection.droppedObservations).toBe(2);
    expect(report.series[0]?.count).toBe(1);
  });
});

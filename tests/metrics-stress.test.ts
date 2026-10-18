import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordMetric, metricsSnapshot, flushMetrics } from '../src/core/metrics.js';
import { VERSION } from '../src/core/version.js';
import { disposeStateSync } from './support/leaks.js';
import { Writable } from 'node:stream';
import { monitorStats, type StatsData } from '../src/cli/metrics.js';

afterEach(() => vi.useRealTimers());

describe('monitor output flow control', () => {
  it('does not request another snapshot until the previous one drains', async () => {
    vi.useFakeTimers();
    let acknowledge: (() => void) | undefined;
    const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { acknowledge = callback; } });
    const fetch = vi.fn(async () => ({ series: ['x'.repeat(1000)] }) as unknown as StatsData);
    const pending = monitorStats(fetch, { json: true, intervalMs: 250, timeoutMs: 3000, output });
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(output.writableLength).toBeGreaterThan(1000);
    acknowledge!();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1250);
    expect(await pending).toEqual({ outputInterrupted: true });
    expect(output.destroyed).toBe(true);
    expect(output.listenerCount('drain')).toBe(0);
    expect(output.listenerCount('error')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    output.destroy();
  });

  it('releases a pending drain when the output closes without an error', async () => {
    const output = new Writable({ highWaterMark: 1, write() { /* reader never acknowledges */ } });
    const pending = monitorStats(async () => ({}) as StatsData, { json: true, intervalMs: 250, output });
    await new Promise<void>((resolve) => setImmediate(resolve));
    output.destroy();
    await expect(pending).resolves.toEqual({ outputInterrupted: true });
    expect(output.listenerCount('drain')).toBe(0);
    expect(output.listenerCount('close')).toBe(0);
  });

  it('stops cleanly when a consumer closes its pipe', async () => {
    const error = Object.assign(new Error('pipe closed'), { code: 'EPIPE' });
    const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { callback(error); } });
    const fetch = vi.fn(async () => ({}) as StatsData);
    await expect(monitorStats(fetch, { json: true, intervalMs: 250, output })).resolves.toEqual({ outputInterrupted: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(output.listenerCount('error')).toBe(0);
    expect(output.listenerCount('drain')).toBe(0);
  });

  it('surfaces output failures without hanging or leaking listeners', async () => {
    const error = new Error('disk failed');
    const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { callback(error); } });
    await expect(monitorStats(async () => ({}) as StatsData, { json: true, intervalMs: 250, output })).rejects.toBe(error);
    expect(output.listenerCount('error')).toBe(0);
    expect(output.listenerCount('drain')).toBe(0);
  });
});


describe('monitor subprocess output cancellation', () => {
  it.each(['timeout', 'SIGINT', 'SIGTERM'] as const)('exits on %s even when a pipe consumer never reads its large snapshot', async (stop) => {
    const root = mkdtempSync(join(tmpdir(), 'monitor-pipe-'));
    let signalTimer: NodeJS.Timeout | undefined;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const ping = JSON.parse(body).verb === 'ping';
        res.end(JSON.stringify({ type: 'result', ok: true, data:
          ping ? { version: VERSION } : { large: 'x'.repeat(2 * 1024 * 1024) },
        }) + '\n');
        if (!ping && stop !== 'timeout') signalTimer = setTimeout(() => child.kill(stop), 150);
      });
    });
    await new Promise<void>((resolve) => server.listen(join(root, 'daemon.sock'), resolve));
    const child = spawn(process.execPath, [join(import.meta.dirname, '../dist/cli/index.js'),
      'monitor', '--all', '--json', ...(stop === 'timeout' ? ['--timeout', '500ms'] : [])], {
      cwd: root, env: { ...process.env, BACKLOT_STATE_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Deliberately never consume stdout; 2 MB exceeds the OS pipe capacity.
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      expect(await exited, stderr).toEqual({ code: 0, signal: null });
      expect(stderr).toBe('');
    } finally {
      clearTimeout(watchdog);
      clearTimeout(signalTimer);
      child.kill('SIGKILL');
      child.stdout.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      disposeStateSync(root);
    }
  });
});


describe('persisted measurement integrity', () => {
  it.each(['histogram', 'negative', 'range', 'name', 'minute', 'total-range', 'histogram-range'] as const)(
    'rejects a corrupt %s bucket rather than publishing misleading percentiles', (corruption) => {
      const root = mkdtempSync(join(tmpdir(), 'metrics-integrity-'));
      const original = process.env.BACKLOT_STATE_DIR;
      try {
        process.env.BACKLOT_STATE_DIR = root;
        recordMetric('wake_ms', 10);
        flushMetrics();
        const path = join(root, 'metrics.json');
        const persisted = JSON.parse(readFileSync(path, 'utf8'));
        const bucket = persisted.buckets[0];
        if (corruption === 'histogram') bucket.histogram.fill(0);
        if (corruption === 'negative') bucket.total = -1;
        if (corruption === 'range') bucket.min = bucket.max + 1;
        if (corruption === 'name') bucket.name = '\u001b[2J';
        if (corruption === 'minute') bucket.at += 1;
        if (corruption === 'total-range') bucket.total = 1000;
        if (corruption === 'histogram-range') { bucket.histogram.fill(0); bucket.histogram[0] = 1; }
        process.env.BACKLOT_STATE_DIR = join(root, 'other');
        metricsSnapshot();
        writeFileSync(path, JSON.stringify(persisted));
        process.env.BACKLOT_STATE_DIR = root;
        const report = metricsSnapshot();
        expect(report.series).toEqual([]);
        expect(report.collection.storageErrors).toBe(1);
        expect(report.collection.historyTruncated).toBe(true);
        recordMetric('wake_ms', 20);
        expect(metricsSnapshot().series[0]?.total).toBe(20);
      } finally {
        flushMetrics();
        if (original === undefined) delete process.env.BACKLOT_STATE_DIR;
        else process.env.BACKLOT_STATE_DIR = original;
        rmSync(root, { force: true, recursive: true });
      }
    },
  );
});


it('evicts chronological oldest history after loading reordered persisted buckets', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-eviction-'));
  const original = process.env.BACKLOT_STATE_DIR;
  vi.useFakeTimers();
  try {
    process.env.BACKLOT_STATE_DIR = root;
    vi.setSystemTime(new Date('2026-10-18T12:00:05Z'));
    recordMetric('oldest_ms', 1);
    vi.setSystemTime(new Date('2026-10-18T12:01:05Z'));
    for (let i = 0; i < 11999; i++) recordMetric('build_ms', 1, { service: `s${i}` });
    flushMetrics();
    const path = join(root, 'metrics.json');
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    persisted.buckets.reverse();
    process.env.BACKLOT_STATE_DIR = join(root, 'other');
    metricsSnapshot();
    writeFileSync(path, JSON.stringify(persisted));
    process.env.BACKLOT_STATE_DIR = root;
    recordMetric('newest_ms', 1);
    const report = metricsSnapshot();
    expect(report.series).toHaveLength(12000);
    expect(report.series.some((s) => s.name === 'oldest_ms')).toBe(false);
    expect(report.series.some((s) => s.name === 'newest_ms')).toBe(true);
    expect(report.collection.droppedObservations).toBe(1);
  } finally {
    flushMetrics();
    vi.useRealTimers();
    if (original === undefined) delete process.env.BACKLOT_STATE_DIR;
    else process.env.BACKLOT_STATE_DIR = original;
    rmSync(root, { force: true, recursive: true });
  }
});


it('prunes a minute crossed during a rollback inside the prune throttle window', () => {
  const root = mkdtempSync(join(tmpdir(), 'metrics-rollback-'));
  const original = process.env.BACKLOT_STATE_DIR;
  vi.useFakeTimers();
  try {
    process.env.BACKLOT_STATE_DIR = root;
    vi.setSystemTime(new Date('2026-10-18T12:00:50Z'));
    recordMetric('old_ms', 1);
    vi.setSystemTime(new Date('2026-10-18T12:01:10Z'));
    recordMetric('future_ms', 1);
    vi.setSystemTime(new Date('2026-10-18T12:00:55Z'));
    recordMetric('new_ms', 1);
    const report = metricsSnapshot();
    expect(report.collection.droppedObservations).toBe(1);
    expect(report.collection.historyTruncated).toBe(true);
    vi.setSystemTime(new Date('2026-10-18T12:01:15Z'));
    expect(metricsSnapshot().series.some((s) => s.name === 'future_ms')).toBe(false);
  } finally {
    flushMetrics();
    vi.useRealTimers();
    if (original === undefined) delete process.env.BACKLOT_STATE_DIR;
    else process.env.BACKLOT_STATE_DIR = original;
    rmSync(root, { recursive: true, force: true });
  }
});

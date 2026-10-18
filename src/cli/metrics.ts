import type { Engine } from '../daemon/engine.js';
import { formatDuration, formatSize } from '../core/units.js';

export type StatsData = ReturnType<Engine['stats']>;

export function statsLines(report: StatsData): string[] {
  const lines = [
    'Runly statistics — ' + report.scope,
    new Date(report.window.since).toISOString() + ' → ' + new Date(report.window.until).toISOString(),
    'Minute buckets; p50/p95 are histogram estimates. First-byte timing is per TCP connection.',
  ];
  if (report.collection.historyTruncated || report.collection.storageErrors || report.collection.droppedObservations) {
    lines.push('Partial history: ' + report.collection.droppedObservations + ' dropped observations; ' +
      report.collection.storageErrors + ' storage errors; retention/cap truncation=' + report.collection.historyTruncated);
  }
  if (!report.series.length) lines.push('No measurements in this window. Monitoring does not wake services.');
  for (const metric of report.series) {
    const labels = [metric.labels.stack, metric.labels.envId, metric.labels.service, metric.labels.datastore,
      metric.labels.outcome, metric.labels.reason].filter(Boolean).join(' / ');
    const value = metric.name.endsWith('_ms')
      ? 'n=' + metric.count + ' avg=' + formatDuration(metric.total / metric.count) +
        ' p50≈' + formatDuration(metric.p50) + ' p95≈' + formatDuration(metric.p95) +
        ' max=' + formatDuration(metric.max)
      : 'total=' + (metric.name.endsWith('_bytes') ? formatSize(metric.total) : metric.total);
    lines.push(metric.name + ' [' + labels + '] ' + value);
  }
  lines.push('Live (machine budget): ' + report.live.budget.waiting + ' queued; declared running costs ' +
    formatSize(report.live.budget.committedMemoryBytes) + ', ' + report.live.budget.committedCpu + ' CPU');
  for (const env of report.live.environments) {
    for (const [port, proxy] of Object.entries(env.proxy)) {
      lines.push(env.id + '/' + (proxy.service ?? port) + ': ' + proxy.state +
        ', open=' + proxy.open + ', held=' + proxy.held);
    }
  }
  return lines;
}

/** Sequential snapshots, one request at a time. Ctrl-C releases the timer/listeners. */
export async function monitorStats(
  fetch: (signal: AbortSignal) => Promise<StatsData>,
  options: { json: boolean; intervalMs: number; timeoutMs?: number },
): Promise<void> {
  let stopped = false;
  const controller = new AbortController();
  let wake: (() => void) | undefined;
  const stop = () => { stopped = true; controller.abort(); wake?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const timeout = options.timeoutMs === undefined ? undefined : setTimeout(stop, options.timeoutMs);
  try {
    while (!stopped) {
      let report: StatsData;
      try { report = await fetch(controller.signal); }
      catch (err) { if (stopped) break; throw err; }
      if (stopped) break;
      if (options.json) console.log(JSON.stringify(report));
      else {
        if (process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
        console.log(statsLines(report).join('\n'));
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, options.intervalMs);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
  } finally {
    clearTimeout(timeout);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

import { expect, it } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProxyHub } from '../src/daemon/proxy.js';
import { allocateInBlock } from '../src/core/ports.js';
import { flushMetrics, metricsSnapshot, withMetricContext } from '../src/core/metrics.js';

it('listener callbacks never inherit the completed bind operation or its labels', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proxy-metric-context-'));
  const previous = process.env.BACKLOT_STATE_DIR;
  process.env.BACKLOT_STATE_DIR = root;
  const hub = new ProxyHub();
  let client: ReturnType<typeof connect> | undefined;
  try {
    const port = (await allocateInBlock({ lo: 29000, hi: 29999 }, new Set()))!;
    hub.setMetricScope('env', 'stack');
    await withMetricContext({ stack: 'old-stack', envId: 'old-env', service: 'old-service', datastore: 'old-store', outcome: 'old-outcome', reason: 'old-reason', operationId: 'completed-bind' },
      () => hub.listen('env', 'web', port));
    client = connect(port, '127.0.0.1');
    client.on('error', () => {});
    client.resume();
    const closed = once(client, 'close');
    client.end('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await closed;
    const report = metricsSnapshot();
    expect(report.series.find(s => s.name === 'proxy.accepted')?.labels).toEqual({ stack: 'stack', envId: 'env', service: 'web' });
    expect(report.recentOperations).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('old-');
  } finally {
    client?.destroy();
    hub.closeAll();
    flushMetrics();
    if (previous === undefined) delete process.env.BACKLOT_STATE_DIR;
    else process.env.BACKLOT_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

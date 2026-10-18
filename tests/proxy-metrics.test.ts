import { afterEach, expect, it, vi } from 'vitest';
import { connect, createServer, type Socket, type Server } from 'node:net';
import { once } from 'node:events';
import { ProxyHub } from '../src/daemon/proxy.js';
import { allocateInBlock } from '../src/core/ports.js';
import { sleep, waitFor } from './support/context.js';

const { measurements } = vi.hoisted(() => ({ measurements: [] as { name: string; value: number; labels: Record<string, string> }[] }));
vi.mock('../src/core/metrics.js', () => ({ recordMetric: (name: string, value: number, labels: Record<string, string>) => measurements.push({ name, value, labels }) }));
const sockets: Socket[] = [];
const servers: Server[] = [];
const hubs: ProxyHub[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const h of hubs.splice(0)) h.closeAll();
  for (const s of servers.splice(0)) s.close();
  await sleep(20);
  measurements.length = 0;
});
async function fixture(handler: (s: Socket) => void) {
  const server = createServer(s => { sockets.push(s); s.on('error', () => {}); handler(s); });
  servers.push(server);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const internal = (server.address() as { port: number }).port;
  const port = (await allocateInBlock({ lo: 29000, hi: 29999 }, new Set()))!;
  const hub = new ProxyHub(); hubs.push(hub); hub.setMetricScope('env', 'stack');
  await hub.listen('env', 'web', port);
  return { hub, port, internal };
}
async function client(port: number) {
  const s = connect(port, '127.0.0.1'); sockets.push(s); s.on('error', () => {});
  await once(s, 'connect'); return s;
}
const values = (name: string) => measurements.filter(m => m.name === name);
const sum = (name: string) => values(name).reduce((total, m) => total + m.value, 0);

it('counts raw bidirectional streams once per connection and reads do not create activity', async () => {
  const { hub, port, internal } = await fixture(s => s.pipe(s));
  hub.up('env', 'web', internal, 'web');
  const c = await client(port); let bytes = 0; c.on('data', b => bytes += b.length);
  c.write(Buffer.from([0, 1, 2, 3]));
  expect(await waitFor(() => bytes === 4, 2000)).toBe(true);
  c.write(Buffer.from([4, 5]));
  expect(await waitFor(() => bytes === 6, 2000)).toBe(true);
  const activity = hub.activity('env');
  hub.flushMetrics(); hub.stats('env'); hub.flushMetrics();
  expect(hub.activity('env')).toEqual(activity);
  expect(sum('proxy.accepted')).toBe(1);
  expect(sum('proxy.client_bytes')).toBe(6);
  expect(sum('proxy.server_bytes')).toBe(6);
  expect(values('proxy.first_byte_ms')).toHaveLength(1);
  expect(values('proxy.hold_ms')).toHaveLength(0);
  expect(values('proxy.first_byte_ms')[0]!.labels).toEqual({ stack: 'stack', envId: 'env', service: 'web', datastore: undefined, outcome: undefined, operationId: undefined, reason: undefined });
  c.destroy();
  expect(await waitFor(() => values('proxy.closed').length === 1, 2000)).toBe(true);
  expect(sum('proxy.client_bytes')).toBe(6);
});

it('measures the startup hold separately and includes it in connection first-byte time', async () => {
  const { hub, port, internal } = await fixture(s => s.pipe(s));
  hub.starting('env', 'web', 'web');
  const c = await client(port); let received = ''; c.on('data', b => received += b);
  c.write('hello');
  expect(await waitFor(() => hub.stats('env').web!.held === 1, 2000)).toBe(true);
  await sleep(60);
  hub.up('env', 'web', internal, 'web');
  expect(await waitFor(() => received === 'hello', 2000)).toBe(true);
  expect(values('proxy.hold_ms')).toHaveLength(1);
  expect(values('proxy.hold_ms')[0]!.value).toBeGreaterThanOrEqual(50);
  expect(values('proxy.first_byte_ms')[0]!.value).toBeGreaterThanOrEqual(values('proxy.hold_ms')[0]!.value);
  c.destroy(); await sleep(30);
  expect(values('proxy.hold_ms')).toHaveLength(1);
});

it('safe replay records a retry without double-counting bytes or first responses', async () => {
  let attempts = 0;
  const { hub, port, internal } = await fixture(s => {
    const attempt = ++attempts;
    s.once('data', () => { if (attempt === 1) s.destroy(); else s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'); });
  });
  hub.up('env', 'web', internal, 'web');
  const c = await client(port); let received = ''; c.on('data', b => received += b);
  const request = 'GET /secret-path HTTP/1.1\r\nHost: private\r\n\r\n'; c.write(request);
  expect(await waitFor(() => received.endsWith('ok'), 3000)).toBe(true);
  hub.flushMetrics();
  expect(attempts).toBe(2);
  expect(sum('proxy.accepted')).toBe(1);
  expect(sum('proxy.retry')).toBe(1);
  expect(sum('proxy.client_bytes')).toBe(Buffer.byteLength(request));
  expect(values('proxy.first_byte_ms')).toHaveLength(1);
  expect(JSON.stringify(measurements)).not.toContain('secret-path');
});

it('a rejected connection never produces a successful first-byte sample', async () => {
  const { hub, port } = await fixture(s => s.end('unexpected'));
  const c = await client(port); let received = ''; c.on('data', b => received += b);
  c.write('GET / HTTP/1.1\r\nHost: private\r\n\r\n');
  expect(await waitFor(() => received.includes('503'), 2000)).toBe(true);
  expect(sum('proxy.rejected')).toBe(1);
  expect(values('proxy.first_byte_ms')).toHaveLength(0);
  expect(await waitFor(() => values('proxy.closed').length === 1, 2000)).toBe(true);
  expect(values('proxy.closed')[0]!.labels.reason).toBe('rejected');
  expect(hub.stats('env').web!.held).toBe(0);
});

it('correlates the connection that triggers a cold wake through hold and first response', async () => {
  const { hub, port, internal } = await fixture(s => s.pipe(s));
  let operationId: string | undefined;
  hub.setWakeHook((envId, key, id) => {
    operationId = id;
    hub.starting(envId, key, 'web');
    return true;
  });
  const c = await client(port); let received = ''; c.on('data', b => received += b);
  c.write('hello');
  expect(await waitFor(() => hub.stats('env').web!.held === 1, 2000)).toBe(true);
  expect(operationId).toBeTruthy();
  hub.up('env', 'web', internal, 'web');
  expect(await waitFor(() => received === 'hello', 2000)).toBe(true);
  expect(values('proxy.hold_ms')[0]!.labels.operationId).toBe(operationId);
  expect(values('proxy.first_byte_ms')[0]!.labels.operationId).toBe(operationId);
  c.destroy();
  expect(await waitFor(() => values('proxy.closed').length === 1, 2000)).toBe(true);
  expect(values('proxy.closed')[0]!.labels.operationId).toBe(operationId);
  expect(values('proxy.client_bytes')[0]!.labels.operationId).toBeUndefined();
});

it('periodically flushes streaming bytes for a held connection transferred to a new listener', async () => {
  const { hub, port, internal } = await fixture(s => s.pipe(s));
  hub.starting('env', 'web', 'web');
  const c = await client(port); let received = ''; c.on('data', b => received += b);
  c.write('held-stream');
  expect(await waitFor(() => hub.stats('env').web!.held === 1, 2000)).toBe(true);
  const movedPort = (await allocateInBlock({ lo: 29000, hi: 29999 }, new Set([port])))!;
  await hub.listen('env', 'web', movedPort);
  hub.up('env', 'web', internal, 'web');
  expect(await waitFor(() => received === 'held-stream', 2000)).toBe(true);
  // No new connection, stats flush or close: the migrated stream must flush itself.
  expect(await waitFor(() => sum('proxy.server_bytes') === 11, 6500)).toBe(true);
  expect(sum('proxy.client_bytes')).toBe(11);
  expect(c.destroyed).toBe(false);
}, 10_000);

/** Proxy (decision 0033) under stress: half-close, a large upload, byte counting, many held connections, ::1. */
import { describe, it, expect, afterAll } from 'vitest';
import { createServer, connect, type Socket } from 'node:net';
import { ProxyHub } from '../../src/daemon/proxy.js';

const hub = new ProxyHub();
const servers: Array<{ close: () => void }> = [];
afterAll(() => { hub.closeAll(); for (const s of servers) s.close(); });

/** Reads everything, answers with the byte count only after the client half-closes. */
function countingServer(): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer({ allowHalfOpen: true }, (s) => {
      let n = 0;
      s.on('data', (d) => (n += d.length));
      s.on('end', () => s.end(`got ${n}`));
    });
    servers.push(srv);
    srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port));
  });
}
const freePort = () => new Promise<number>((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

function roundTrip(port: number, payload: Buffer, host = '127.0.0.1'): Promise<string> {
  return new Promise((resolve, reject) => {
    const c: Socket = connect({ port, host, allowHalfOpen: true }, () => { c.end(payload); });
    let out = '';
    c.on('data', (d) => (out += d.toString()));
    c.on('end', () => resolve(out));
    c.on('error', reject);
  });
}

describe('proxy', () => {
  it('half-close + 64 MB upload, counted exactly, over IPv4 and ::1', async () => {
    const internal = await countingServer();
    const pub = await freePort();
    await hub.listen('e1', 'web', pub);
    hub.up('e1', 'web', internal, 'web');
    const big = Buffer.alloc(64 * 1024 * 1024, 7);
    expect(await roundTrip(pub, big)).toBe(`got ${big.length}`);
    expect(await roundTrip(pub, Buffer.from('hello'), '::1')).toBe('got 5');
    expect(hub.stats('e1').web!.clientBytes).toBe(big.length + 5);
  }, 60_000);

  it('holds 400 connections while starting and forwards all of them on up', async () => {
    const internal = await countingServer();
    const pub = await freePort();
    await hub.listen('e2', 'web', pub);
    hub.starting('e2', 'web', 'web');
    // Connect in bursts of 100: macOS caps the listen backlog at 128
    // (kern.ipc.somaxconn) and resets a burst beyond it before Node accepts.
    const all: Array<Promise<string>> = [];
    for (let b = 0; b < 4; b++) {
      for (let i = 0; i < 100; i++) all.push(roundTrip(pub, Buffer.from(`req-${b * 100 + i}`)));
      for (let t = 0; t < 50 && hub.stats('e2').web!.held < all.length; t++) await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.stats('e2').web!.held).toBe(400);
    hub.up('e2', 'web', internal, 'web');
    const res = await Promise.all(all);
    expect(res.every((r) => /^got \d+$/.test(r))).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(hub.stats('e2').web!.open).toBe(0); // no leaked piped sockets
  }, 60_000);
});

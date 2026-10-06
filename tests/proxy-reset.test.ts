/**
 * B4 (decision 0039): a service that accepts a connection and then dies
 * before answering — the window between a crash and the supervisor noticing
 * it, or the stop an `up` does before a restart — must look to the client
 * like any other refused forward: held and retried, its request replayed to
 * the next process. Before, the client got an empty reply.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { ProxyHub } from '../src/daemon/proxy.js';

const open: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const o of open.splice(0)) o.close();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)));
}

/** A tiny HTTP/1.0 exchange on a raw socket: the whole reply, or '' for an empty one. */
function request(port: number, body = 'GET / HTTP/1.0\r\nHost: x\r\n\r\n'): Promise<string> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    let got = '';
    s.on('data', (d) => (got += d.toString()));
    s.on('error', () => resolve(got));
    s.on('close', () => resolve(got));
    s.write(body);
  });
}

async function hub(): Promise<{ hub: ProxyHub; port: number }> {
  const h = new ProxyHub();
  const probe = createServer();
  const port = await listen(probe);
  await new Promise<void>((r) => probe.close(() => r()));
  await h.listen('env', 'web', port);
  open.push({ close: () => h.closeAll() });
  return { hub: h, port };
}

describe('the proxy retries a connection its service dropped before answering (B4)', () => {
  it('a reset before the first byte is retried and the request replayed', async () => {
    let accepted = 0;
    const seen: string[] = [];
    const service = createServer((sock: Socket) => {
      accepted++;
      if (accepted <= 2) {
        // The process "died" with the connection accepted: reset, nothing written.
        sock.once('data', () => sock.resetAndDestroy());
        return;
      }
      sock.once('data', (d) => {
        seen.push(d.toString());
        sock.end('HTTP/1.0 200 OK\r\n\r\nhello');
      });
    });
    const internal = await listen(service);
    open.push({ close: () => service.close() });
    const { hub: h, port } = await hub();
    h.up('env', 'web', internal, 'web');
    const reply = await request(port);
    expect(reply).toMatch(/200 OK[\s\S]*hello/);
    expect(accepted).toBe(3);
    expect(seen[0]).toMatch(/^GET \/ HTTP\/1.0/); // the replayed request, intact
  });

  it('a close before the first byte while the service restarts is held until it is up again', async () => {
    const dying = createServer((sock: Socket) => sock.once('data', () => sock.destroy()));
    const dyingPort = await listen(dying);
    open.push({ close: () => dying.close() });
    const { hub: h, port } = await hub();
    h.up('env', 'web', dyingPort, 'web');
    const pending = request(port);
    // The supervisor notices the crash: the port holds connections …
    await new Promise((r) => setTimeout(r, 50));
    h.starting('env', 'web', 'web');
    // … and the relaunched process answers on a new internal port.
    const next = createServer((sock: Socket) => sock.once('data', () => sock.end('HTTP/1.0 200 OK\r\n\r\nback')));
    const nextPort = await listen(next);
    open.push({ close: () => next.close() });
    await new Promise((r) => setTimeout(r, 300));
    h.up('env', 'web', nextPort, 'web');
    expect(await pending).toMatch(/200 OK[\s\S]*back/);
  });

  it('a service that keeps closing unanswered while up is believed after a few tries', async () => {
    let accepted = 0;
    const rude = createServer((sock: Socket) => {
      accepted++;
      sock.once('data', () => sock.end());
    });
    const rudePort = await listen(rude);
    open.push({ close: () => rude.close() });
    const { hub: h, port } = await hub();
    h.up('env', 'web', rudePort, 'web');
    const t0 = Date.now();
    expect(await request(port)).toBe('');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(accepted).toBeGreaterThan(1);
    expect(accepted).toBeLessThanOrEqual(7);
  });

  it('an answered connection is piped as before (half-close included)', async () => {
    const svc = createServer({ allowHalfOpen: true }, (sock: Socket) => {
      let got = '';
      sock.on('data', (d) => (got += d.toString()));
      sock.on('end', () => sock.end(`echo:${got}`));
    });
    const svcPort = await listen(svc);
    open.push({ close: () => svc.close() });
    const { hub: h, port } = await hub();
    h.up('env', 'web', svcPort, 'web');
    const reply = await new Promise<string>((resolve) => {
      const s = connect({ port, host: '127.0.0.1', allowHalfOpen: true });
      let got = '';
      s.on('data', (d) => (got += d.toString()));
      s.on('close', () => resolve(got));
      s.end('ping');
    });
    expect(reply).toBe('echo:ping');
  });
});

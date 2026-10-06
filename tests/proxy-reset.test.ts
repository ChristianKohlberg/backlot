/**
 * B4 (decision 0039): a service that accepts a connection and then dies
 * before answering — the window between a crash and the supervisor noticing
 * it, or the stop an `up` does before a restart — must look to the client
 * like any other refused forward: held and retried, its request replayed to
 * the next process. Before, the client got an empty reply.
 *
 * 0.18.1: a replay is only safe when the dead process cannot have acted on
 * the request — nothing reached it, or an idempotent HTTP method — and goes
 * to one relaunch at most.
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
  it('an idempotent request reset before the first byte is replayed once', async () => {
    let accepted = 0;
    const seen: string[] = [];
    const service = createServer((sock: Socket) => {
      accepted++;
      if (accepted <= 1) {
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
    expect(accepted).toBe(2);
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
    expect(accepted).toBeLessThanOrEqual(2); // one replay at most (0.18.1)
  });

  it('a non-idempotent request the service received is never replayed (0.18.1)', async () => {
    let accepted = 0;
    const svc = createServer((sock: Socket) => {
      accepted++;
      // It acted on the request, then died before answering.
      sock.once('data', () => sock.resetAndDestroy());
    });
    const svcPort = await listen(svc);
    open.push({ close: () => svc.close() });
    const { hub: h, port } = await hub();
    h.up('env', 'web', svcPort, 'web');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      accepted = 0;
      expect(await request(port, `${method} /charge HTTP/1.0\r\nContent-Length: 2\r\n\r\n42`)).toBe('');
      expect(accepted, method).toBe(1);
    }
    // Not HTTP (a database or TLS wire protocol): the same.
    accepted = 0;
    expect(await request(port, '\x16\x03\x01\x00\x05hello')).toBe('');
    expect(accepted).toBe(1);
  });

  it('an idempotent request is carried to one relaunch, never more (0.18.1)', async () => {
    let accepted = 0;
    const poison = createServer((sock: Socket) => {
      accepted++;
      sock.once('data', () => sock.resetAndDestroy());
    });
    const poisonPort = await listen(poison);
    open.push({ close: () => poison.close() });
    const { hub: h, port } = await hub();
    h.up('env', 'web', poisonPort, 'web');
    expect(await request(port)).toBe('');
    expect(accepted).toBe(2);
  });

  it('a refused connect is retried for any request — nothing reached a process (0.18.1)', async () => {
    const dead = createServer();
    const deadPort = await listen(dead);
    await new Promise<void>((r) => dead.close(() => r()));
    const { hub: h, port } = await hub();
    h.up('env', 'web', deadPort, 'web');
    const pending = request(port, 'POST /charge HTTP/1.0\r\nContent-Length: 2\r\n\r\n42');
    let accepted = 0;
    const svc = createServer((sock: Socket) => {
      accepted++;
      sock.once('data', () => sock.end('HTTP/1.0 201 Created\r\n\r\nok'));
    });
    const svcPort = await listen(svc);
    open.push({ close: () => svc.close() });
    await new Promise((r) => setTimeout(r, 300));
    h.up('env', 'web', svcPort, 'web');
    expect(await pending).toMatch(/201 Created/);
    expect(accepted).toBe(1);
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

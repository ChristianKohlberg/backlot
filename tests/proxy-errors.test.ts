import { expect, it } from 'vitest';
import { connect, createServer } from 'node:net';
import { ProxyHub } from '../src/daemon/proxy.js';
import { PreviewGate } from '../src/daemon/preview-gate.js';
import { allocateInBlock } from '../src/core/ports.js';
import { sleep } from './support/context.js';

async function fixture() {
  const hub = new ProxyHub();
  const port = (await allocateInBlock({lo: 29000, hi: 29999}, new Set()))!;
  await hub.listen('e', 'web', port);
  return { hub, port };
}
function request(port: number, chunks: string[]) {
  return new Promise<string>((resolve) => {
    const client = connect(port, '127.0.0.1');
    let text = '';
    client.on('data', data => text += data.toString());
    client.on('error', () => {});
    client.on('close', () => resolve(text));
    client.once('connect', async () => {
      for (const chunk of chunks) { if (client.destroyed) break; client.write(chunk); await sleep(20); }
    });
  });
}
it('fragmented HTTP and websocket handshakes receive a safe 503 when wake fails', async () => {
  const {hub, port} = await fixture();
  try {
    hub.setWakeHook(() => {
      hub.starting('e', 'web');
      setTimeout(() => hub.down('e', 'web', 'Local failure; inspect runly logs web'), 80);
      return true;
    });
    const response = await request(port, ['GE', 'T / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n']);
    expect(response).toContain('HTTP/1.1 503');
    expect(response).toContain('Retry-After: 2');
    expect(response).toContain('RUNLY_SERVICE_UNAVAILABLE');
    expect(response).not.toContain('Local failure');
    expect(hub.stats('e').web?.lastError).toContain('runly logs web');
  } finally {hub.closeAll();}
});
it('HTTP gets a timeout error, while raw TCP never receives injected HTTP', async () => {
  const {hub, port} = await fixture();
  const prior = process.env.BACKLOT_PROXY_HOLD_MS;
  process.env.BACKLOT_PROXY_HOLD_MS = '80';
  try {
    hub.starting('e', 'web');
    expect(await request(port, ['GET / HTTP/1.1\r\nHost: localhost\r\n\r\n'])).toContain('503 Service Unavailable');
    expect(await request(port, ['\x16\x03\x01\x00\x00'])).toBe('');
    expect(hub.stats('e').web?.lastError).toContain('deadline');
  } finally {
    hub.closeAll();
    if (prior === undefined) delete process.env.BACKLOT_PROXY_HOLD_MS; else process.env.BACKLOT_PROXY_HOLD_MS = prior;
  }
});
it('the public deadline closes existing streams without stopping the private service', async () => {
  const server = createServer(socket => {socket.on('error',()=>{}); socket.pipe(socket);});
  await new Promise<void>(resolve=>server.listen(0,'localhost',resolve));
  const port = (server.address() as {port:number}).port;
  const gate = await PreviewGate.open(port, Date.now()+400);
  const publicPort = Number(new URL(gate.url).port);
  const socket = connect(publicPort, 'localhost');
  socket.on('error',()=>{});
  try {
    let response = '';
    socket.on('data',chunk=>response+=chunk);
    const closed = new Promise<void>(resolve=>socket.once('close',resolve));
    await new Promise<void>(resolve=>socket.once('connect',resolve));
    socket.write('stream');
    await closed;
    expect(response).toBe('stream');
    const direct = connect(port,'localhost');
    await new Promise<void>((resolve,reject)=>{direct.once('connect',resolve);direct.once('error',reject);});
    direct.destroy();
  } finally {socket.destroy();gate.close();server.close();}
});

it('a wall-clock deadline rejects stream bytes before a delayed timer runs', async () => {
  const { vi } = await import('vitest');
  let received = '';
  const server = createServer(socket => {socket.on('error',()=>{});socket.on('data',data=>received+=data.toString());});
  await new Promise<void>(resolve=>server.listen(0,'localhost',resolve));
  const deadline = Date.now() + 60_000;
  const gate = await PreviewGate.open((server.address() as {port:number}).port, deadline);
  const socket = connect(Number(new URL(gate.url).port),'localhost');
  socket.on('error',()=>{});
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await new Promise<void>(resolve=>socket.once('connect',resolve));
    const closed = new Promise<void>(resolve=>socket.once('close',resolve));
    clock = vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
    socket.write('must not reach service');
    await closed;
    expect(received).toBe('');
  } finally {clock?.mockRestore();socket.destroy();gate.close();server.close();}
});

it('the expiring origin preserves TCP half-close request/response protocols', async () => {
  const server = createServer({allowHalfOpen:true}, socket => {
    let body='';
    socket.on('error',()=>{});
    socket.on('data', data=>body+=data.toString());
    socket.on('end', ()=>socket.end('reply:'+body));
  });
  await new Promise<void>(resolve=>server.listen(0,'localhost',resolve));
  const gate = await PreviewGate.open((server.address() as {port:number}).port,Date.now()+5000);
  const socket = connect(Number(new URL(gate.url).port),'localhost');
  socket.on('error',()=>{});
  try {
    let reply='';
    socket.on('data',data=>reply+=data.toString());
    const closed=new Promise<void>(resolve=>socket.once('close',resolve));
    await new Promise<void>(resolve=>socket.once('connect',resolve));
    socket.end('request');
    await closed;
    expect(reply).toBe('reply:request');
  } finally {socket.destroy();gate.close();server.close();}
});

it('an expiring origin drains a large response after the upstream gracefully closes', async () => {
  const payload = Buffer.alloc(8 * 1024 * 1024, 97);
  const server = createServer(socket => {
    socket.on('error', () => {});
    socket.resume();
    socket.on('end', () => socket.end(payload));
  });
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  const gate = await PreviewGate.open((server.address() as {port:number}).port, Date.now() + 10_000);
  const socket = connect(Number(new URL(gate.url).port), 'localhost');
  socket.on('error', () => {});
  try {
    let received = 0;
    socket.on('data', chunk => { received += chunk.length; });
    const closed = new Promise<void>(resolve => socket.once('close', resolve));
    await new Promise<void>(resolve => socket.once('connect', resolve));
    socket.pause();
    socket.end('request');
    await sleep(200);
    socket.resume();
    await closed;
    expect(received).toBe(payload.length);
  } finally { socket.destroy(); gate.close(); server.close(); }
});

it('renewing a live gate preserves its stream past the old deadline and closes it at the new one', async () => {
  const server = createServer(socket => { socket.on('error', () => {}); socket.pipe(socket); });
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  const oldDeadline = Date.now() + 1000;
  const gate = await PreviewGate.open((server.address() as {port:number}).port, oldDeadline);
  const socket = connect(Number(new URL(gate.url).port), 'localhost');
  socket.on('error', () => {});
  try {
    let response = '';
    socket.on('data', data => response += data.toString());
    const closed = new Promise<void>(resolve => socket.once('close', resolve));
    await new Promise<void>(resolve => socket.once('connect', resolve));
    const newDeadline = Date.now() + 2000;
    expect(gate.renew(newDeadline)).toBe(true);
    await sleep(Math.max(0, oldDeadline - Date.now()) + 100);
    expect(socket.destroyed).toBe(false);
    socket.write('still the same connection');
    await closed;
    expect(response).toBe('still the same connection');
    expect(Date.now()).toBeGreaterThanOrEqual(newDeadline);
    expect(gate.renew(Date.now() + 5000)).toBe(false);
  } finally { socket.destroy(); gate.close(); server.close(); }
});

it('wall-clock expiry also blocks server-initiated stream bytes before its timer runs', async () => {
  const { vi } = await import('vitest');
  let send: (() => void) | undefined;
  const server = createServer(socket => {
    socket.on('error', () => {});
    send = () => socket.write('must not reach public client');
  });
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  const deadline = Date.now() + 60_000;
  const gate = await PreviewGate.open((server.address() as {port:number}).port, deadline);
  const socket = connect(Number(new URL(gate.url).port), 'localhost');
  socket.on('error', () => {});
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  try {
    let response = '';
    socket.on('data', data => response += data.toString());
    const closed = new Promise<void>(resolve => socket.once('close', resolve));
    for (let i = 0; !send && i < 100; i++) await sleep(10);
    expect(send).toBeDefined();
    clock = vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
    send!();
    await closed;
    expect(response).toBe('');
  } finally { clock?.mockRestore(); socket.destroy(); gate.close(); server.close(); }
});

it('keeps one startup deadline across a held connection and refused forwards', async () => {
  const { hub, port } = await fixture();
  const prior = process.env.BACKLOT_PROXY_HOLD_MS;
  process.env.BACKLOT_PROXY_HOLD_MS = '1000';
  const server = createServer(socket => socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const unavailable = (await allocateInBlock({lo: 28000, hi: 28999}, new Set()))!;
  try {
    hub.starting('e', 'web');
    const response = request(port, ['GET / HTTP/1.1\r\nHost: localhost\r\n\r\n']);
    await sleep(700);
    hub.up('e', 'web', unavailable, 'web');
    await sleep(500);
    hub.up('e', 'web', (server.address() as {port:number}).port, 'web');
    expect(await response).toContain('503 Service Unavailable');
  } finally {
    hub.closeAll(); server.close();
    if (prior === undefined) delete process.env.BACKLOT_PROXY_HOLD_MS; else process.env.BACKLOT_PROXY_HOLD_MS = prior;
  }
});

it('removes timed-out held connections from the replacement listener after a port move', async () => {
  const { hub, port } = await fixture();
  const prior = process.env.BACKLOT_PROXY_HOLD_MS;
  process.env.BACKLOT_PROXY_HOLD_MS = '200';
  try {
    hub.starting('e', 'web');
    const response = request(port, ['GET / HTTP/1.1\r\nHost: localhost\r\n\r\n']);
    for (let i = 0; hub.stats('e').web?.held !== 1 && i < 50; i++) await sleep(10);
    expect(hub.stats('e').web?.held).toBe(1);
    expect(hub.stats('e').web?.open).toBe(0);
    const moved = (await allocateInBlock({lo: 29000, hi: 29999}, new Set([port])))!;
    await hub.listen('e', 'web', moved);
    expect(await response).toContain('503 Service Unavailable');
    expect(hub.stats('e').web?.held).toBe(0);
  } finally {
    hub.closeAll();
    if (prior === undefined) delete process.env.BACKLOT_PROXY_HOLD_MS; else process.env.BACKLOT_PROXY_HOLD_MS = prior;
  }
});

it('moves a held retry without destroying the previously forwarded client stream', async () => {
  const { hub, port } = await fixture();
  const dying = createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => { hub.starting('e', 'web'); socket.resetAndDestroy(); });
  });
  const recovered = createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'));
  });
  await Promise.all([dying, recovered].map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
  try {
    hub.up('e', 'web', (dying.address() as {port:number}).port, 'web');
    const response = request(port, ['GET / HTTP/1.1\r\nHost: localhost\r\n\r\n']);
    for (let i = 0; hub.stats('e').web?.held !== 1 && i < 100; i++) await sleep(10);
    expect(hub.stats('e').web?.held).toBe(1);
    expect(hub.stats('e').web?.open).toBe(0);
    const moved = (await allocateInBlock({lo: 29000, hi: 29999}, new Set([port])))!;
    await hub.listen('e', 'web', moved);
    hub.up('e', 'web', (recovered.address() as {port:number}).port, 'web');
    expect(await response).toContain('200 OK');
    expect(hub.stats('e').web?.held).toBe(0);
  } finally { hub.closeAll(); dying.close(); recovered.close(); }
});

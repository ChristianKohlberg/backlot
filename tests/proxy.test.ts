/**
 * The daemon's L4 proxy and the port blocks (decision 0033).
 *
 * Each case drives the real CLI against an isolated daemon. The service under
 * test listens on whatever `{{ports.web}}` gives it — the INTERNAL port — and
 * clients only ever use the public port `ctx` reports.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer, connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/core/journal.js';
import { scanTagged } from '../src/core/procscan.js';
import { ProxyHub } from '../src/daemon/proxy.js';
import { allocateInBlock, DEFAULT_INTERNAL_BLOCK, DEFAULT_PUBLIC_BLOCK, DEFAULT_TUNNEL_BLOCK, ephemeralRange } from '../src/core/ports.js';
import { disposeStateSync } from './support/leaks.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

type CliResult = { exitCode: number; json?: Record<string, unknown>; stdout: string; stderr: string };

function daemonCtx(extra: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-proxy-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, ...extra };
  const cli = (args: string[], cwd: string): Promise<CliResult> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const cleanup = () => {
    let pid = 0;
    try {
      pid = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
      process.kill(pid);
    } catch {
      /* gone */
    }
    // A stopping daemon still writes logs while it stops services; removing the
    // state dir under it races (ENOTEMPTY). Wait for it, bounded.
    const deadline = Date.now() + 5000;
    while (pid > 0 && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    for (const p of scanTagged(stateDir)) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    disposeStateSync(stateDir);
  };
  return { stateDir, cli, cleanup };
}

/** A service that answers `ok <its own port>` after an optional boot delay. */
const HTTP_SERVER = `import { createServer } from 'node:http';
const delay = Number(process.env.BOOT_DELAY_MS ?? 0);
setTimeout(() => {
  createServer((q, s) => s.end('ok ' + process.env.PORT)).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening'));
}, delay);
`;

/** A minimal RFC 6455 echo server, so the WebSocket case needs no dependency. */
const WS_SERVER = `import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const srv = createServer((q, s) => s.end('plain'));
srv.on('upgrade', (req, sock) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  let buf = Buffer.alloc(0);
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      buf = buf.subarray(off + 4 + len);
      if (op === 8) { sock.end(Buffer.from([0x88, 0])); return; }
      const text = Buffer.from('echo:' + Buffer.from(payload).toString());
      sock.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
    }
  });
});
srv.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('listening'));
`;

function makeWorktree(name: string, services: Record<string, string> = { web: 'server.mjs' }, extraEnv = ''): string {
  const dir = mkdtempSync(join(tmpdir(), `runly-proxy-${name}-`));
  writeFileSync(join(dir, 'server.mjs'), HTTP_SERVER);
  writeFileSync(join(dir, 'ws.mjs'), WS_SERVER);
  const lines = Object.entries(services).map(
    ([svc, file]) =>
      `  ${svc}: { run: node ${file}, port: ${svc}, env: { PORT: "{{ports.${svc}}}"${extraEnv} }, ready: { log: listening, timeout: 20 } }`,
  );
  writeFileSync(join(dir, 'runly.yml'), `name: ${name}\nservices:\n${lines.join('\n')}\n`);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

async function get(port: number, timeoutMs = 20_000): Promise<string> {
  const res = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(timeoutMs) });
  return res.text();
}

/** Send raw bytes over TCP, read the reply until the server closes. */
function raw(port: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    let out = '';
    sock.on('data', (d) => (out += d.toString()));
    // A reset (a held connection closed) reads as an empty reply.
    sock.on('error', () => resolve(out));
    sock.on('close', () => resolve(out));
    sock.on('connect', () => sock.write(payload));
  });
}

type ProxyStat = { port: number; state: string; clientBytes: number; lastActivityAt: number | null; accepted: number; internalPort?: number };
const proxyOf = (r: CliResult): Record<string, ProxyStat> => (r.json?.proxy ?? {}) as Record<string, ProxyStat>;
const portsOf = (r: CliResult): Record<string, number> => (r.json?.ports ?? {}) as Record<string, number>;

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups.reverse()) c();
});
function track<T extends { cleanup: () => void }>(x: T): T {
  cleanups.push(x.cleanup);
  return x;
}
function trackDir(dir: string): string {
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('port blocks', () => {
  it('are disjoint from each other and from the ephemeral range of this machine', () => {
    const blocks = [DEFAULT_PUBLIC_BLOCK, DEFAULT_INTERNAL_BLOCK, DEFAULT_TUNNEL_BLOCK];
    const eph = ephemeralRange();
    const overlap = (a: { lo: number; hi: number }, b: { lo: number; hi: number }) => a.lo <= b.hi && b.lo <= a.hi;
    for (const b of blocks) expect(overlap(b, eph), `${b.lo}-${b.hi} vs ephemeral ${eph.lo}-${eph.hi}`).toBe(false);
    // macOS / BSD default ephemeral range
    for (const b of blocks) expect(overlap(b, { lo: 49152, hi: 65535 })).toBe(false);
    expect(overlap(blocks[0]!, blocks[1]!) || overlap(blocks[0]!, blocks[2]!) || overlap(blocks[1]!, blocks[2]!)).toBe(false);
    expect(DEFAULT_PUBLIC_BLOCK).toEqual({ lo: 20000, hi: 29999 });
  });

  it('allocation skips taken and busy ports and reports exhaustion', async () => {
    const block = { lo: 20000, hi: 20004 };
    const busy = new Set([20001, 20003]);
    const seen = new Set<number>();
    for (let i = 0; i < 3; i++) {
      const p = await allocateInBlock(block, seen, async (port) => !busy.has(port));
      expect(p).toBeDefined();
      expect(busy.has(p!)).toBe(false);
      seen.add(p!);
    }
    expect([...seen].sort()).toEqual([20000, 20002, 20004]);
    expect(await allocateInBlock(block, seen, async (port) => !busy.has(port))).toBeUndefined();
  });
});

describe('ProxyHub (unit)', () => {
  it('holds a connection while starting, then forwards it once up', async () => {
    const hub = new ProxyHub();
    const upstream: Server = createServer((s) => s.end('hello'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const internal = (upstream.address() as { port: number }).port;
    const pub = await allocateInBlock({ lo: 29000, hi: 29999 }, new Set());
    await hub.listen('e1', 'web', pub!);
    hub.starting('e1', 'web', 'web');
    const reply = raw(pub!, 'x');
    await new Promise((r) => setTimeout(r, 300));
    expect(hub.stats('e1').web?.held).toBe(1);
    hub.up('e1', 'web', internal, 'web');
    expect(await reply).toBe('hello');
    expect(hub.stats('e1').web?.clientBytes).toBe(1);
    hub.closeAll();
    upstream.close();
  });

  it('closes held connections when the start fails, and bounds the hold', async () => {
    process.env.BACKLOT_PROXY_HOLD_MS = '400';
    try {
      const hub = new ProxyHub();
      const pub = await allocateInBlock({ lo: 29000, hi: 29999 }, new Set());
      await hub.listen('e1', 'web', pub!);
      hub.starting('e1', 'web', 'web');
      const t0 = Date.now();
      expect(await raw(pub!, 'x')).toBe('');
      const waited = Date.now() - t0;
      expect(waited).toBeGreaterThanOrEqual(350);
      expect(waited).toBeLessThan(5000);
      const held = raw(pub!, 'y');
      await new Promise((r) => setTimeout(r, 100));
      hub.settle('e1');
      expect(await held).toBe('');
      expect(hub.state('e1', 'web')).toBe('down');
      hub.closeAll();
    } finally {
      delete process.env.BACKLOT_PROXY_HOLD_MS;
    }
  });

  it('refuses at once while down unless the wake hook claims the connection', async () => {
    const hub = new ProxyHub();
    const pub = await allocateInBlock({ lo: 29000, hi: 29999 }, new Set());
    await hub.listen('e1', 'web', pub!);
    const t0 = Date.now();
    expect(await raw(pub!, 'x')).toBe('');
    expect(Date.now() - t0).toBeLessThan(1000);
    const upstream: Server = createServer((s) => s.end('woken'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const internal = (upstream.address() as { port: number }).port;
    const wakes: string[] = [];
    hub.setWakeHook((envId, key) => {
      wakes.push(`${envId}/${key}`);
      hub.starting(envId, key);
      setTimeout(() => hub.up(envId, key, internal), 200);
      return true;
    });
    expect(await raw(pub!, 'x')).toBe('woken');
    expect(wakes).toEqual(['e1/web']);
    hub.closeAll();
    upstream.close();
  });
});

describe('the proxy in front of a real environment', () => {
  it('keeps the public port across a restart and holds a client connected during it', async () => {
    const d = track(daemonCtx());
    const wt = trackDir(makeWorktree('restart', { web: 'server.mjs' }, ', BOOT_DELAY_MS: "2500"'));
    const up = await d.cli(['up', '--json'], wt);
    expect(up.exitCode, up.stderr).toBe(0);
    const pub = portsOf(up).web!;
    expect(pub).toBeGreaterThanOrEqual(20000);
    expect(pub).toBeLessThanOrEqual(29999);
    expect((up.json?.urls as Record<string, string>).web).toBe(`http://localhost:${pub}`);
    const firstInternal = proxyOf(up).web!.internalPort!;
    expect(firstInternal).toBeGreaterThanOrEqual(30000);
    expect(firstInternal).toBeLessThanOrEqual(31999);
    expect(await get(pub)).toBe(`ok ${firstInternal}`);

    // reset-data stops and restarts the service; the new one boots for 2.5 s.
    const reset = d.cli(['reset-data', '--json'], wt);
    await new Promise((r) => setTimeout(r, 800));
    const during = get(pub, 30_000);
    const after = await reset;
    expect(after.exitCode, after.stderr).toBe(0);
    expect(portsOf(after).web).toBe(pub);
    const body = await during;
    const secondInternal = proxyOf(after).web!.internalPort!;
    expect(secondInternal).not.toBe(firstInternal);
    expect(body).toBe(`ok ${secondInternal}`);

    // And a further bind keeps it.
    expect((await d.cli(['up', '--json'], wt)).json?.ports).toEqual({ web: pub });
  }, 90_000);

  it('holds a client across the restart an `up` does when a build output changed', async () => {
    const d = track(daemonCtx());
    const wt = trackDir(makeWorktree('rebuild'));
    // No outputs declared: every `up` restarts the service after its build.
    writeFileSync(
      join(wt, 'runly.yml'),
      `name: rebuild\nservices:\n  web: { build: "true", run: node server.mjs, port: web, env: { PORT: "{{ports.web}}", BOOT_DELAY_MS: "2500" }, ready: { log: listening, timeout: 20 } }\n`,
    );
    const up = await d.cli(['up', '--json'], wt);
    expect(up.exitCode, up.stderr).toBe(0);
    const pub = portsOf(up).web!;
    const second = d.cli(['up', '--json'], wt);
    await new Promise((r) => setTimeout(r, 800));
    const during = get(pub, 30_000);
    const after = await second;
    expect(after.exitCode, after.stderr).toBe(0);
    expect((after.json?.bindDiagnostics as { reuse?: string } | undefined)?.reuse).toBe('restarted');
    expect(portsOf(after).web).toBe(pub);
    expect(await during).toBe(`ok ${proxyOf(after).web!.internalPort}`);
  }, 90_000);

  it('counts client bytes and never the readiness probes', async () => {
    const d = track(daemonCtx());
    const wt = trackDir(makeWorktree('bytes'));
    // An http readiness probe, so there IS probe traffic that must not count.
    writeFileSync(join(wt, 'runly.yml'), `name: bytes\nservices:\n  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }\n`);
    const up = await d.cli(['up', '--json'], wt);
    expect(up.exitCode, up.stderr).toBe(0);
    const before = proxyOf(up).web!;
    expect(before.state).toBe('up');
    expect(before.clientBytes).toBe(0);
    expect(before.accepted).toBe(0);
    expect(before.lastActivityAt).toBeNull();

    const request = 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n';
    const reply = await raw(portsOf(up).web!, request);
    expect(reply).toMatch(/ok \d+$/);
    const ctx = await d.cli(['ctx', '--json'], wt);
    const after = proxyOf(ctx).web!;
    expect(after.clientBytes).toBe(Buffer.byteLength(request));
    expect(after.accepted).toBe(1);
    expect(after.lastActivityAt).toBeGreaterThan(Date.now() - 60_000);
    // status carries the same counters, per environment.
    const st = await d.cli(['status', '--json'], wt);
    const envs = st.json?.envs as Array<{ proxy: Record<string, ProxyStat> }>;
    expect(envs[0]!.proxy.web!.clientBytes).toBe(Buffer.byteLength(request));
  }, 60_000);

  it('passes WebSockets through untouched', async () => {
    const d = track(daemonCtx());
    const wt = trackDir(makeWorktree('ws', { web: 'ws.mjs' }));
    const up = await d.cli(['up', '--json'], wt);
    expect(up.exitCode, up.stderr).toBe(0);
    const pub = portsOf(up).web!;
    const ws = new WebSocket(`ws://localhost:${pub}/`);
    const replies: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.onerror = () => reject(new Error('websocket error'));
      ws.onopen = () => {
        ws.send('one');
        ws.send('two');
      };
      ws.onmessage = (ev) => {
        replies.push(String(ev.data));
        if (replies.length === 2) resolve();
      };
    });
    ws.close();
    expect(replies).toEqual(['echo:one', 'echo:two']);
  }, 60_000);

  it('never hands the same public port to two stacks, and re-binds them after a daemon restart', async () => {
    // A machine-wide cap above three, so the third stack fails on ports, not capacity
    // (a small CI runner's heuristic cap is 2).
    const d = track(daemonCtx({ BACKLOT_PORT_RANGE: '27100-27103', BACKLOT_POOL_MAX_TOTAL: '8' }));
    const a = trackDir(makeWorktree('alloc-a', { web: 'server.mjs', api: 'server.mjs' }));
    const b = trackDir(makeWorktree('alloc-b', { web: 'server.mjs', api: 'server.mjs' }));
    const [ua, ub] = await Promise.all([d.cli(['up', '--json'], a), d.cli(['up', '--json'], b)]);
    expect(ua.exitCode, ua.stderr).toBe(0);
    expect(ub.exitCode, ub.stderr).toBe(0);
    const all = [...Object.values(portsOf(ua)), ...Object.values(portsOf(ub))];
    expect(new Set(all).size).toBe(4);
    for (const p of all) {
      expect(p).toBeGreaterThanOrEqual(27100);
      expect(p).toBeLessThanOrEqual(27103);
    }
    // The block is full now: a third stack is refused, naming the block.
    const c = trackDir(makeWorktree('alloc-c'));
    const uc = await d.cli(['up', '--json'], c);
    expect(uc.exitCode).not.toBe(0);
    expect(uc.stdout + uc.stderr).toMatch(/no free public port left in 27100-27103/);

    // Daemon restart: every recorded public port is held again before any bind.
    expect((await d.cli(['daemon', 'stop'], a)).exitCode).toBe(0);
    const st = await d.cli(['status', '--json'], a);
    const envs = st.json?.envs as Array<{ ports: Record<string, number>; proxy: Record<string, ProxyStat> }>;
    for (const e of envs) {
      for (const [key, port] of Object.entries(e.ports)) {
        expect(e.proxy[key]?.port).toBe(port);
        expect(e.proxy[key]?.state).toBe('down');
      }
    }
    // Held: nothing else can bind them.
    for (const p of all) {
      const probe = createServer();
      const err = await new Promise<string | null>((r) => {
        probe.once('error', (e: NodeJS.ErrnoException) => r(e.code ?? 'error'));
        probe.listen(p, '127.0.0.1', () => probe.close(() => r(null)));
      });
      expect(err, `port ${p} must be held by the daemon`).toBe('EADDRINUSE');
    }
    // And the next bind brings the service back on the same public port.
    const again = await d.cli(['up', '--json'], a);
    expect(again.exitCode, again.stderr).toBe(0);
    expect(portsOf(again)).toEqual(portsOf(ua));
    expect(await get(portsOf(again).web!)).toMatch(/^ok \d+$/);
  }, 90_000);

  it('moves a public port that a foreign process took while the daemon was down, and leaves that process alone', async () => {
    const d = track(daemonCtx());
    const wt = trackDir(makeWorktree('foreign'));
    const up = await d.cli(['up', '--json'], wt);
    expect(up.exitCode, up.stderr).toBe(0);
    const old = portsOf(up).web!;
    expect((await d.cli(['daemon', 'stop'], wt)).exitCode).toBe(0);

    const squatter = createServer((s) => s.end('foreign'));
    await new Promise<void>((r) => squatter.listen(old, '127.0.0.1', () => r()));
    cleanups.push(() => squatter.close());

    const again = await d.cli(['up', '--json'], wt);
    expect(again.exitCode, again.stderr).toBe(0);
    const moved = portsOf(again).web!;
    expect(moved).not.toBe(old);
    expect(moved).toBeGreaterThanOrEqual(20000);
    expect(moved).toBeLessThanOrEqual(29999);
    expect(await get(moved)).toMatch(/^ok \d+$/);
    // The foreign listener still answers on its port: runly took nothing from it.
    expect(await raw(old, '')).toBe('foreign');
    const events = readFileSync(join(d.stateDir, 'events.jsonl'), 'utf8');
    expect(events).toMatch(new RegExp(`moved ${old} → ${moved}: the old one was taken by another process`));
    expect(new Journal(join(d.stateDir, 'journal.db')).allEnvs()[0]!.ports.web).toBe(moved);
  }, 60_000);

  it('reallocates ports a 0.13 journal recorded outside the public block, once, at the first start', async () => {
    const d = track(daemonCtx());
    const wt = trackDir(makeWorktree('migrate'));
    const up = await d.cli(['up', '--json'], wt);
    expect(up.exitCode, up.stderr).toBe(0);
    expect((await d.cli(['daemon', 'stop'], wt)).exitCode).toBe(0);

    // What 0.13 left behind: an OS-ephemeral port on the row.
    const journal = new Journal(join(d.stateDir, 'journal.db'));
    const row = journal.allEnvs()[0]!;
    row.ports = { web: 45123 };
    journal.saveEnv(row);

    const st = await d.cli(['status', '--json'], wt);
    const env = (st.json?.envs as Array<{ ports: Record<string, number> }>)[0]!;
    expect(env.ports.web).toBeGreaterThanOrEqual(20000);
    expect(env.ports.web).toBeLessThanOrEqual(29999);
    const events = readFileSync(join(d.stateDir, 'events.jsonl'), 'utf8');
    expect(events).toMatch(/moved 45123 → \d+: the old one was outside the public block/);

    const again = await d.cli(['up', '--json'], wt);
    expect(again.exitCode, again.stderr).toBe(0);
    expect(portsOf(again).web).toBe(env.ports.web);
    expect(await get(env.ports.web!)).toMatch(/^ok \d+$/);
  }, 60_000);
});

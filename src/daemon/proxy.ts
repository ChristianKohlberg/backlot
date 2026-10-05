/**
 * The daemon's L4 proxy (decision 0033).
 *
 * Every service port of an environment has two numbers: the PUBLIC port, which
 * this module listens on (127.0.0.1 and ::1) for the environment's whole life,
 * and an INTERNAL port the service is started on, fresh at every start. Bytes
 * are piped between the two without looking at them — no HTTP awareness, so
 * WebSockets, gRPC, a database wire protocol all pass the same way.
 *
 * What the indirection buys:
 * - the public port survives every restart (an `up` that rebuilt, reset-data,
 *   a quiesce and the next bind), so a URL handed out once stays good;
 * - a connection that arrives while its service is (re)starting is HELD,
 *   bounded, and forwarded once the service is ready, instead of being refused;
 * - client→server bytes and the time of the last of them are counted per
 *   environment and port — the activity signal idle detection reads (step 6 of
 *   the lifecycle work). runly's own readiness probes go to the internal port,
 *   so they never count.
 *
 * It holds no policy. The engine says when a target is starting, up (on which
 * internal port) or down; an optional wake hook lets a later change start a
 * stopped environment on the first connection.
 */
import { createServer, connect, type Server, type Socket } from 'node:net';
import { logEvent } from '../core/events.js';

export type TargetState = 'down' | 'starting' | 'up';

export interface ProxyStats {
  /** The public port (what ctx reports). */
  port: number;
  /** The service currently behind it, when known. */
  service?: string;
  state: TargetState;
  /** Where the service listens right now (diagnostics only — never hand it out). */
  internalPort?: number;
  /** Client→server bytes since the daemon started proxying this port. */
  clientBytes: number;
  /** Epoch ms of the last client→server byte; null when none arrived yet. */
  lastActivityAt: number | null;
  /** Connections currently piped. */
  open: number;
  /** Connections currently held while the service starts. */
  held: number;
  /** Connections accepted in total. */
  accepted: number;
}

/**
 * Called when a connection arrives for a target that is DOWN. Returning true
 * means "a start has been requested" — the engine must then move the target to
 * `starting` and later `up`; the connection is held meanwhile. Returning false
 * (the default) closes it at once, which is what a client saw before the proxy
 * existed: nothing listening.
 */
export type WakeHook = (envId: string, key: string) => boolean;

/** How long a connection may wait for its service to become ready. */
export const HOLD_MS = (): number => Number(process.env.BACKLOT_PROXY_HOLD_MS ?? 90_000);
/** Per-target bound on held connections, so a client retry storm cannot exhaust fds. */
const MAX_HELD = 512;

interface Waiter {
  socket: Socket;
  timer: NodeJS.Timeout;
}

class Target {
  servers: Server[] = [];
  state: TargetState = 'down';
  internalPort?: number;
  service?: string;
  clientBytes = 0;
  lastActivityAt: number | null = null;
  accepted = 0;
  readonly open = new Set<Socket>();
  waiters: Waiter[] = [];

  constructor(
    readonly envId: string,
    readonly key: string,
    readonly port: number,
    private readonly hub: ProxyHub,
  ) {}

  stats(): ProxyStats {
    return {
      port: this.port,
      service: this.service,
      state: this.state,
      internalPort: this.state === 'up' ? this.internalPort : undefined,
      clientBytes: this.clientBytes,
      lastActivityAt: this.lastActivityAt,
      open: this.open.size,
      held: this.waiters.length,
      accepted: this.accepted,
    };
  }

  onConnection(client: Socket): void {
    this.accepted++;
    // Never let a peer reset crash the daemon.
    client.on('error', () => client.destroy());
    if (this.state === 'up' && this.internalPort !== undefined) {
      this.forward(client, this.internalPort);
      return;
    }
    if (this.state === 'down' && !this.hub.wake(this.envId, this.key)) {
      client.destroy();
      return;
    }
    this.hold(client);
  }

  private hold(client: Socket): void {
    if (this.waiters.length >= MAX_HELD) {
      client.destroy();
      return;
    }
    // A paused socket buffers what the client sends (and TCP backpressure
    // stops it beyond that), so nothing is lost while it waits.
    client.pause();
    const waiter: Waiter = {
      socket: client,
      timer: setTimeout(() => {
        this.dropWaiter(waiter);
        client.destroy();
      }, HOLD_MS()),
    };
    waiter.timer.unref();
    client.once('close', () => this.dropWaiter(waiter));
    this.waiters.push(waiter);
  }

  private dropWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    const i = this.waiters.indexOf(waiter);
    if (i >= 0) this.waiters.splice(i, 1);
  }

  /** Release every held connection: forward them, or close them when the target is not up. */
  flush(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      if (w.socket.destroyed) continue;
      if (this.state === 'up' && this.internalPort !== undefined) this.forward(w.socket, this.internalPort);
      else w.socket.destroy();
    }
  }

  private forward(client: Socket, internalPort: number): void {
    this.open.add(client);
    client.once('close', () => this.open.delete(client));
    connectInternal(internalPort, (err, upstream) => {
      if (err || !upstream) {
        client.destroy();
        return;
      }
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      // Count before piping: both listeners receive every chunk.
      client.on('data', (chunk: Buffer) => {
        this.clientBytes += chunk.length;
        this.lastActivityAt = Date.now();
        this.hub.noteActivity(this.envId, this.key);
      });
      client.pipe(upstream);
      upstream.pipe(client);
      // Half-closes travel through pipe(); a full close of either side ends the pair.
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => {
        if (!client.destroyed) client.end();
        setTimeout(() => client.destroy(), 10_000).unref();
      });
      client.resume();
    });
  }

  close(): void {
    for (const s of this.servers) s.close();
    this.servers = [];
    this.state = 'down';
    this.flush();
    for (const s of this.open) s.destroy();
    this.open.clear();
  }
}

/**
 * Connect to a service's internal port. A service told to listen on
 * `localhost` may have bound IPv4, IPv6, or both, so try each loopback.
 */
function connectInternal(port: number, done: (err: Error | null, sock?: Socket) => void): void {
  const hosts = ['127.0.0.1', '::1'];
  const attempt = (i: number, lastErr: Error | null) => {
    if (i >= hosts.length) return done(lastErr ?? new Error('no loopback answered'));
    const sock = connect({ port, host: hosts[i], allowHalfOpen: true });
    const onError = (err: Error) => {
      sock.destroy();
      attempt(i + 1, err);
    };
    sock.once('error', onError);
    sock.once('connect', () => {
      sock.off('error', onError);
      done(null, sock);
    });
  };
  attempt(0, null);
}

export class PortInUse extends Error {
  constructor(readonly port: number, readonly host: string) {
    super(`port ${port} is already in use on ${host}`);
  }
}

/** Bind one listener; resolves false when the address family is absent (no IPv6). */
function listenOn(server: Server, port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') reject(new PortInUse(port, host));
      else if (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') resolve(false);
      else reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // exclusive: a second daemon (another state root) must collide, not share.
    server.listen({ port, host, exclusive: true });
  });
}

export class ProxyHub {
  private targets = new Map<string, Target>();
  private wakeHook?: WakeHook;
  private activityHook?: (envId: string, key: string) => void;

  private id(envId: string, key: string): string {
    return `${envId}\u0000${key}`;
  }

  /** Step 6 installs this: start a stopped environment on its first connection. */
  setWakeHook(hook: WakeHook | undefined): void {
    this.wakeHook = hook;
  }

  /** Optional observer of client bytes (idle bookkeeping lives with the caller). */
  setActivityHook(hook: ((envId: string, key: string) => void) | undefined): void {
    this.activityHook = hook;
  }

  wake(envId: string, key: string): boolean {
    try {
      return this.wakeHook?.(envId, key) ?? false;
    } catch {
      return false;
    }
  }

  noteActivity(envId: string, key: string): void {
    this.activityHook?.(envId, key);
  }

  /** Is the public listener for this env/key currently held, on this port? */
  holds(envId: string, key: string, port: number): boolean {
    const t = this.targets.get(this.id(envId, key));
    return t !== undefined && t.port === port && t.servers.length > 0;
  }

  /** Every public port this daemon is listening on. */
  heldPorts(): Set<number> {
    const out = new Set<number>();
    for (const t of this.targets.values()) if (t.servers.length > 0) out.add(t.port);
    return out;
  }

  /** Every internal port currently assigned to a target (up or not), so none is handed out twice. */
  assignedInternalPorts(): Set<number> {
    const out = new Set<number>();
    for (const t of this.targets.values()) if (t.internalPort !== undefined) out.add(t.internalPort);
    return out;
  }

  /**
   * Listen on `port` for env/key (idempotent). Throws PortInUse when another
   * process holds it; any previous listener for this env/key on a different
   * port is closed first, and its counters carried over.
   */
  async listen(envId: string, key: string, port: number): Promise<void> {
    const id = this.id(envId, key);
    const existing = this.targets.get(id);
    if (existing && existing.port === port && existing.servers.length > 0) return;
    const target = new Target(envId, key, port, this);
    if (existing) {
      target.clientBytes = existing.clientBytes;
      target.lastActivityAt = existing.lastActivityAt;
      target.accepted = existing.accepted;
      target.state = existing.state;
      target.internalPort = existing.internalPort;
      target.service = existing.service;
    }
    const servers: Server[] = [];
    try {
      for (const host of ['127.0.0.1', '::1']) {
        const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, (sock) => target.onConnection(sock));
        if (await listenOn(server, port, host)) {
          server.on('error', (err) => logEvent({ level: 'warn', kind: 'proxy', envId, detail: `listener ${host}:${port} failed: ${err.message}` }));
          servers.push(server);
        }
      }
      if (servers.length === 0) throw new PortInUse(port, 'loopback');
    } catch (err) {
      for (const s of servers) s.close();
      throw err;
    }
    if (existing) {
      // Move held connections too: they are waiting for the SERVICE, not the port.
      target.waiters = existing.waiters;
      existing.waiters = [];
      existing.close();
    }
    target.servers = servers;
    this.targets.set(id, target);
  }

  /** New connections are held until `up` (or dropped by `down`). */
  starting(envId: string, key: string, service?: string): void {
    const t = this.targets.get(this.id(envId, key));
    if (!t) return;
    t.state = 'starting';
    if (service) t.service = service;
  }

  /** The service behind env/key is ready on `internalPort`; held connections go through. */
  up(envId: string, key: string, internalPort: number, service?: string): void {
    const t = this.targets.get(this.id(envId, key));
    if (!t) return;
    t.state = 'up';
    t.internalPort = internalPort;
    if (service) t.service = service;
    t.flush();
  }

  /** Nothing is (or will soon be) behind env/key: held connections are closed. */
  down(envId: string, key: string): void {
    const t = this.targets.get(this.id(envId, key));
    if (!t) return;
    t.state = 'down';
    t.internalPort = undefined;
    t.flush();
  }

  /** A service was stopped: its targets go down unless a restart already marked them starting. */
  serviceStopped(envId: string, service: string): void {
    for (const t of this.targets.values()) {
      if (t.envId === envId && t.service === service && t.state === 'up') {
        t.state = 'down';
        t.internalPort = undefined;
        t.flush();
      }
    }
  }

  /** Every `starting` target of an env that never reached `up` goes down (a failed bind). */
  settle(envId: string): void {
    for (const t of this.targets.values()) {
      if (t.envId === envId && t.state === 'starting') {
        t.state = 'down';
        t.internalPort = undefined;
        t.flush();
      }
    }
  }

  state(envId: string, key: string): TargetState | undefined {
    return this.targets.get(this.id(envId, key))?.state;
  }

  /** Close one env/key listener (a port key the manifest dropped). */
  closeKey(envId: string, key: string): void {
    const id = this.id(envId, key);
    this.targets.get(id)?.close();
    this.targets.delete(id);
  }

  /** Release every listener of an environment (teardown). */
  closeEnv(envId: string): void {
    for (const [id, t] of this.targets) {
      if (t.envId === envId) {
        t.close();
        this.targets.delete(id);
      }
    }
  }

  closeAll(): void {
    for (const t of this.targets.values()) t.close();
    this.targets.clear();
  }

  /** Stats by port key for one environment. */
  stats(envId: string): Record<string, ProxyStats> {
    const out: Record<string, ProxyStats> = {};
    for (const t of this.targets.values()) if (t.envId === envId) out[t.key] = t.stats();
    return out;
  }
}

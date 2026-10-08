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
 * internal port) or down; the wake hook (decision 0035) lets the engine start
 * a stopped service on the first connection, which is held meanwhile.
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
 * means "a start has been requested" — the connection is held (bounded by
 * BACKLOT_PROXY_HOLD_MS) until the engine calls `up` (forwarded) or `down`
 * (closed). Returning false closes it at once, which is what a client saw
 * before the proxy existed: nothing listening.
 */
export type WakeHook = (envId: string, key: string) => boolean;

/** How long a connection may wait for its service to become ready. */
export const HOLD_MS = (): number => Number(process.env.BACKLOT_PROXY_HOLD_MS ?? 90_000);
/** Per-target bound on held connections, so a client retry storm cannot exhaust fds. */
const MAX_HELD = 512;

interface Waiter {
  socket: Socket;
  timer: NodeJS.Timeout;
  /** A connection being retried after its service reset it: what it already sent, to replay. */
  carry?: Carry;
}

/**
 * What a connection sent before its service answered with a single byte —
 * kept so that a service that dies under it can be replaced transparently:
 * the bytes are replayed to the next process. Replaying is safe only when the
 * dead process provably did not act on them (see `replayable`). Bounded; past
 * the bound the connection is no longer retryable and behaves like a plain pipe.
 */
interface Carry {
  chunks: Buffer[];
  bytes: number;
  /** The client half-closed: the replay ends with a FIN too. */
  ended: boolean;
  /** Retries while the target still said `up` (a service that closes on purpose must not loop). */
  resets: number;
  /**
   * Times bytes that already reached a process were sent to another one. At
   * most MAX_REPLAYS: a request that kills every process it reaches (a poison
   * request) must not be fed to each relaunch until the restart budget is gone.
   */
  replays: number;
  deadline: number;
  /** It outgrew its own or the global replay cap: never retried again, nothing kept. */
  capped?: boolean;
}

/** Client bytes kept for a replay; a request larger than this is not retried. */
const MAX_REPLAY_BYTES = 1024 * 1024;
/**
 * Every connection's carried bytes together, across the daemon (0.19): 1 MB
 * each times a few hundred held uploads was unbounded memory. Past this, a
 * connection that would carry more is no longer retryable and keeps nothing.
 */
const replayCapBytes = (): number => {
  const v = Number(process.env.BACKLOT_PROXY_REPLAY_CAP_BYTES);
  return Number.isFinite(v) && v >= 0 ? v : 64 * 1024 * 1024;
};
let carriedTotal = 0;
/** What every connection carries for a replay right now (tests, `status`). */
export const replayCarriedBytes = (): number => carriedTotal;
/** Give back what `carry` holds; idempotent. */
function dropCarry(carry: Carry): void {
  carriedTotal = Math.max(0, carriedTotal - carry.bytes);
  carry.bytes = 0;
  carry.chunks = [];
}
/** Resets tolerated while the target is still `up` (the supervisor has not seen the exit yet). */
const MAX_UP_RESETS = 5;
/** Relaunches one connection's delivered bytes may be carried to. */
const MAX_REPLAYS = 1;
/** HTTP methods that are safe to repeat (RFC 9110 §9.2.1/§9.2.2) — no side effect a second run could double. */
const IDEMPOTENT = /^(GET|HEAD|OPTIONS) /;

/**
 * May bytes a process already received be sent to the next one? Only when the
 * connection's first bytes are an HTTP request with a method that is safe to
 * repeat: the dead process may have acted on what it read (charged a card,
 * inserted a row) before it died, and a replay would act a second time. Any
 * other request — POST, PUT, PATCH, DELETE, a database or TLS wire protocol,
 * a first chunk too short to tell — is not replayed once delivered.
 */
export function replayable(chunks: readonly Buffer[]): boolean {
  const head = Buffer.concat(chunks.length > 1 ? chunks.slice(0, 4) : chunks).subarray(0, 8).toString('latin1');
  return IDEMPOTENT.test(head);
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

  private hold(client: Socket, carry?: Carry): void {
    if (this.waiters.length >= MAX_HELD) {
      client.destroy();
      return;
    }
    // A paused socket buffers what the client sends (and TCP backpressure
    // stops it beyond that), so nothing is lost while it waits.
    client.pause();
    const waiter: Waiter = {
      socket: client,
      carry,
      timer: setTimeout(() => {
        this.dropWaiter(waiter);
        client.destroy();
      }, carry ? Math.max(0, carry.deadline - Date.now()) : HOLD_MS()),
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
      if (this.state === 'up' && this.internalPort !== undefined) this.forward(w.socket, this.internalPort, w.carry);
      else w.socket.destroy();
    }
  }

  /**
   * Pipe `client` to the service on `internalPort`.
   *
   * Until the service sends its first byte back, the client's bytes are also
   * kept (`carry`). A service that dies in the window before the supervisor
   * notices — the kernel accepted the connection, then the process exited and
   * the socket was reset or closed with nothing written — looks to the client
   * like a refused connect, and is retried and held the same way (decision
   * 0035) when that is safe:
   * - nothing of the client's reached the process (refused, or lost before
   *   the proxy wrote a byte upstream): always — it cannot have acted;
   * - bytes reached it: only for an idempotent HTTP request (`replayable`),
   *   and only to ONE more process (`MAX_REPLAYS`).
   * Otherwise the client sees the close or reset, as it would without a proxy
   * (decision 0039, corrected in 0.18.1).
   */
  private forward(client: Socket, internalPort: number, carry?: Carry): void {
    if (!this.open.has(client)) {
      this.open.add(client);
      client.once('close', () => this.open.delete(client));
    }
    const replay: Carry = carry ?? { chunks: [], bytes: 0, ended: false, resets: 0, replays: 0, deadline: Date.now() + HOLD_MS() };
    if (!carry) client.once('close', () => dropCarry(replay));
    connectInternal(internalPort, (err, upstream) => {
      if (err || !upstream) {
        this.refused(client, replay);
        return;
      }
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      let answered = false;
      let retryable = replay.bytes <= MAX_REPLAY_BYTES && !replay.capped;
      let settled = false;
      // Did any client byte reach this process? Before one did, it cannot have
      // acted on the request, so a retry is not a replay.
      let delivered = replay.chunks.length > 0;
      // May this connection be retried if the process goes away unanswered?
      const canRetry = () =>
        !answered && retryable && (!delivered || (replay.replays < MAX_REPLAYS && replayable(replay.chunks)));
      // Bytes the client sent while it waited (or before a reset) go first.
      for (const chunk of replay.chunks) upstream.write(chunk);
      if (replay.ended) upstream.end();
      const onData = (chunk: Buffer) => {
        // Count before forwarding.
        this.clientBytes += chunk.length;
        this.lastActivityAt = Date.now();
        this.hub.noteActivity(this.envId, this.key);
        if (!answered && retryable) {
          if (replay.bytes + chunk.length > MAX_REPLAY_BYTES || carriedTotal + chunk.length > replayCapBytes()) {
            retryable = false;
            replay.capped = true;
            dropCarry(replay);
          } else {
            replay.chunks.push(chunk);
            replay.bytes += chunk.length;
            carriedTotal += chunk.length;
          }
        }
        delivered = true;
        if (!upstream.write(chunk)) client.pause();
      };
      const onDrain = () => client.resume();
      const onEnd = () => {
        replay.ended = true;
        upstream.end();
      };
      const onClientClose = () => upstream.destroy();
      const detach = () => {
        client.off('data', onData);
        client.off('end', onEnd);
        client.off('close', onClientClose);
        upstream.off('drain', onDrain);
        upstream.unpipe(client);
      };
      // The service went away before it said anything, and retrying is safe
      // (canRetry): retry like a refusal.
      const lost = () => {
        if (settled) return;
        settled = true;
        if (delivered) replay.replays++;
        detach();
        upstream.destroy();
        if (client.destroyed) return;
        client.pause();
        this.refused(client, replay, true);
      };
      upstream.once('data', () => {
        answered = true;
        dropCarry(replay);
      });
      upstream.on('error', () => {
        if (canRetry()) lost();
        else client.destroy();
      });
      upstream.on('drain', onDrain);
      client.on('data', onData);
      client.on('end', onEnd);
      client.on('close', onClientClose);
      upstream.pipe(client, { end: false });
      // Half-closes travel on (the service's FIN ends the client's side), and
      // a full close of either side ends the pair — unless the service closed
      // before it said anything and retrying is safe: a lost connection, retried above.
      const finish = (closed: boolean) => {
        if (canRetry() && !client.destroyed) {
          lost();
          return;
        }
        if (settled) return;
        if (!client.destroyed) client.end();
        if (!closed) return;
        settled = true;
        setTimeout(() => client.destroy(), 10_000).unref();
      };
      upstream.once('end', () => finish(false));
      upstream.once('close', () => finish(true));
      client.resume();
    });
  }

  /**
   * The service did not accept, or accepted and went away before answering:
   * it may have just crashed, with the supervisor about to relaunch it (the
   * self-restart gap, decision 0035). The connection is held — retried while
   * the target still says `up`, held while it is `starting`, woken when it
   * went `down` — until the hold deadline; only then is it closed. A service
   * that keeps closing connections unanswered while it is `up` is believed
   * after a few tries: that is its answer, not a crash.
   */
  private refused(client: Socket, carry: Carry, reset = false): void {
    if (client.destroyed) return;
    if (Date.now() >= carry.deadline) {
      client.destroy();
      return;
    }
    if (this.state === 'starting') {
      this.hold(client, carry);
      return;
    }
    if (this.state === 'down') {
      if (this.hub.wake(this.envId, this.key)) this.hold(client, carry);
      else client.destroy();
      return;
    }
    if (reset && ++carry.resets > MAX_UP_RESETS) {
      // Up all along and still closing on us: pass its close on.
      client.end();
      setTimeout(() => client.destroy(), 10_000).unref();
      return;
    }
    setTimeout(() => {
      if (client.destroyed) return;
      if (this.state === 'up' && this.internalPort !== undefined) this.forward(client, this.internalPort, carry);
      else this.refused(client, carry);
    }, 200).unref();
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
  /**
   * Internal ports handed to a start that is not `up` yet, by env/key. A port
   * is probed free when it is allocated, and the service binds it seconds
   * later; without this, two starts in that window were given the same port
   * and one environment's public URL served the other's process.
   */
  private reservedInternal = new Map<string, number>();
  private wakeHook?: WakeHook;
  private activityHook?: (envId: string, key: string) => void;

  private id(envId: string, key: string): string {
    return `${envId}\u0000${key}`;
  }

  /** The engine installs this (decision 0035): start a stopped service on its first connection. */
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

  /** Where the service behind env/key listens, also while it restarts (decision 0035). */
  internalPortOf(envId: string, key: string): number | undefined {
    return this.targets.get(this.id(envId, key))?.internalPort;
  }

  /** Start a target's activity clock from the journal, so a daemon restart keeps it (decision 0035). */
  seedActivity(envId: string, key: string, at: number): void {
    const t = this.targets.get(this.id(envId, key));
    if (t && (t.lastActivityAt === null || t.lastActivityAt < at)) t.lastActivityAt = at;
  }

  /** The last client byte per port key of an environment (null = none yet). */
  activity(envId: string): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    for (const t of this.targets.values()) if (t.envId === envId) out[t.key] = t.lastActivityAt;
    return out;
  }

  /** Every env id with a listener (doctor's stale-listener check, decision 0037). */
  envIds(): Set<string> {
    return new Set([...this.targets.values()].map((t) => t.envId));
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

  /** Every internal port currently assigned to a target (up or not) or reserved for a start, so none is handed out twice. */
  assignedInternalPorts(): Set<number> {
    const out = new Set<number>(this.reservedInternal.values());
    for (const t of this.targets.values()) if (t.internalPort !== undefined) out.add(t.internalPort);
    return out;
  }

  /** Hold `port` for the start of env/key until it is `up` (then the target owns it) or goes down. */
  reserveInternal(envId: string, key: string, port: number): void {
    this.reservedInternal.set(this.id(envId, key), port);
  }

  private release(id: string): void {
    this.reservedInternal.delete(id);
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
    this.reservedInternal.set(this.id(envId, key), internalPort);
    if (service) t.service = service;
    t.flush();
  }

  /** Nothing is (or will soon be) behind env/key: held connections are closed. */
  down(envId: string, key: string): void {
    this.release(this.id(envId, key));
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
        this.release(this.id(t.envId, t.key));
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
        this.release(this.id(t.envId, t.key));
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
    this.release(id);
  }

  /** The port keys this daemon holds a listener for, for one environment. */
  keysOf(envId: string): string[] {
    return [...this.targets.values()].filter((t) => t.envId === envId).map((t) => t.key);
  }

  /** Release every listener of an environment (teardown). */
  closeEnv(envId: string): void {
    for (const [id, t] of this.targets) {
      if (t.envId === envId) {
        t.close();
        this.targets.delete(id);
      }
    }
    for (const id of [...this.reservedInternal.keys()]) if (id.startsWith(`${envId}\u0000`)) this.reservedInternal.delete(id);
  }

  closeAll(): void {
    for (const t of this.targets.values()) t.close();
    this.targets.clear();
    this.reservedInternal.clear();
  }

  /** Stats by port key for one environment. */
  stats(envId: string): Record<string, ProxyStats> {
    const out: Record<string, ProxyStats> = {};
    for (const t of this.targets.values()) if (t.envId === envId) out[t.key] = t.stats();
    return out;
  }
}

import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';

/**
 * Is `port` genuinely free?
 *
 * Binding only 127.0.0.1 misses a foreign process listening on the WILDCARD
 * address: on Linux that bind collides and reports busy, but on macOS it
 * succeeds, so the "port occupied by a foreign process" guard never fired
 * there and the service started into a port someone else already held.
 * Probing the wildcard as well is what makes the two platforms agree.
 */
export function probeFree(port: number): Promise<boolean> {
  const bind = (host: string) =>
    new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, host, () => srv.close(() => resolve(true)));
    });
  return bind('127.0.0.1').then((loopback) => (loopback ? bind('0.0.0.0') : false));
}

/**
 * Port blocks (decision 0033). Three disjoint blocks, all below every common
 * OS ephemeral range (Linux 32768–60999, macOS/BSD 49152–65535), so an
 * outbound connection's source port can never sit on a port runly is about to
 * hand out:
 *
 * - PUBLIC  20000–29999: what users, child services, `ctx` and tunnels see. The
 *   daemon's proxy holds each one for the environment's lifetime.
 * - INTERNAL 30000–31999: where a service actually listens, chosen fresh at
 *   every start. Only the proxy and runly's own readiness probes connect here.
 * - TUNNEL  32000–32767: tailnet HTTPS ports a preview publisher derives.
 *
 * Each is overridable (`BACKLOT_PORT_RANGE`, `BACKLOT_INTERNAL_PORT_RANGE`,
 * `BACKLOT_TUNNEL_PORT_RANGE`, form `LO-HI`) for a box whose own layout
 * collides; the daemon logs a warning when a block overlaps the ephemeral range
 * it reads from /proc.
 */
export interface PortBlock {
  lo: number;
  hi: number;
}

export const DEFAULT_PUBLIC_BLOCK: PortBlock = { lo: 20000, hi: 29999 };
export const DEFAULT_INTERNAL_BLOCK: PortBlock = { lo: 30000, hi: 31999 };
export const DEFAULT_TUNNEL_BLOCK: PortBlock = { lo: 32000, hi: 32767 };

function blockFromEnv(name: string, fallback: PortBlock): PortBlock {
  const raw = process.env[name];
  if (!raw) return fallback;
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(raw);
  if (!m) return fallback;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (!(lo >= 1024 && hi <= 65535 && lo <= hi)) return fallback;
  return { lo, hi };
}

export const publicBlock = (): PortBlock => blockFromEnv('BACKLOT_PORT_RANGE', DEFAULT_PUBLIC_BLOCK);
export const internalBlock = (): PortBlock => blockFromEnv('BACKLOT_INTERNAL_PORT_RANGE', DEFAULT_INTERNAL_BLOCK);
export const tunnelBlock = (): PortBlock => blockFromEnv('BACKLOT_TUNNEL_PORT_RANGE', DEFAULT_TUNNEL_BLOCK);

export const inBlock = (port: number, block: PortBlock): boolean => port >= block.lo && port <= block.hi;

/**
 * The OS ephemeral (outbound source-port) range. Linux publishes it; other
 * platforms get the IANA range their kernels use by default.
 */
export function ephemeralRange(): PortBlock {
  try {
    const [lo, hi] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
    if (lo && hi && lo <= hi) return { lo, hi };
  } catch {
    /* not Linux */
  }
  return { lo: 49152, hi: 65535 };
}

/** Human-readable overlaps of the configured blocks with each other and the ephemeral range. */
export function blockConflicts(): string[] {
  const eph = ephemeralRange();
  const blocks: Array<[string, PortBlock]> = [['public', publicBlock()], ['internal', internalBlock()], ['tunnel', tunnelBlock()]];
  const overlap = (a: PortBlock, b: PortBlock) => a.lo <= b.hi && b.lo <= a.hi;
  const out: string[] = [];
  for (const [name, b] of blocks) {
    if (overlap(b, eph)) out.push(`the ${name} port block ${b.lo}-${b.hi} overlaps the OS ephemeral range ${eph.lo}-${eph.hi}; ports in the overlap are skipped`);
  }
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const [an, a] = blocks[i]!;
      const [bn, b] = blocks[j]!;
      if (overlap(a, b)) out.push(`the ${an} port block ${a.lo}-${a.hi} overlaps the ${bn} block ${b.lo}-${b.hi}`);
    }
  }
  return out;
}

/**
 * The first port of `block` that is not in `taken`, not ephemeral, and probes
 * free, scanning from a random offset so concurrent daemons (and a daemon
 * restarted with an empty memory) do not all start at the bottom. Returns
 * undefined when the block has nothing left — the caller names the block.
 */
export async function allocateInBlock(block: PortBlock, taken: Set<number>, probe: (port: number) => Promise<boolean> = probeFree): Promise<number | undefined> {
  const eph = ephemeralRange();
  const span = block.hi - block.lo + 1;
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = block.lo + ((start + i) % span);
    if (taken.has(port) || inBlock(port, eph)) continue;
    if (await probe(port)) return port;
  }
  return undefined;
}

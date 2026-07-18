import { createServer } from 'node:net';

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

/** OS-allocated free port — stable per environment once recorded (decision 0004). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    // net.Server emits 'error' asynchronously; with no listener Node rethrows
    // it as an uncaught exception and the whole daemon dies. Under fd
    // exhaustion (EMFILE) that is exactly when every environment in the pool
    // needs the daemon alive to reclaim.
    srv.once('error', (err) => {
      try {
        srv.close();
      } catch {
        /* never listened */
      }
      reject(err);
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') srv.close(() => resolve(addr.port));
      else srv.close(() => reject(new Error('no port allocated')));
    });
  });
}

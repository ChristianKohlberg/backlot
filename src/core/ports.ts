import { createServer } from 'node:net';

export function probeFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** OS-allocated free port — stable per environment once recorded (decision 0004). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') srv.close(() => resolve(addr.port));
      else srv.close(() => reject(new Error('no port allocated')));
    });
  });
}

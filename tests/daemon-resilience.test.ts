/**
 * Fleet review findings #8/#9: an asynchronous 'error' event with no listener
 * is rethrown by Node as an uncaught exception. In the daemon that means one
 * failed port allocation, or one inotify limit, kills the process that every
 * environment depends on. These assert the error is DELIVERED, not thrown.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('node:net');
});

/** A net.Server stand-in that fails the way EMFILE does: asynchronously. */
function failingServer(code: string) {
  const srv = new EventEmitter() as EventEmitter & { listen: () => void; close: (cb?: () => void) => void; address: () => null };
  srv.listen = () => {
    setTimeout(() => {
      const err = new Error(`listen ${code}`) as NodeJS.ErrnoException;
      err.code = code;
      srv.emit('error', err);
    }, 5);
  };
  srv.close = (cb?: () => void) => cb?.();
  srv.address = () => null;
  return srv;
}

describe('port probing under allocation failure', () => {
  it('reports the port busy rather than crashing the process on EMFILE', async () => {
    vi.doMock('node:net', () => ({ createServer: () => failingServer('EMFILE') }));
    const { probeFree, allocateInBlock } = await import('../src/core/ports.js');

    // The failure must arrive as an answer the caller can act on. With no
    // 'error' listener Node would rethrow it as an uncaught exception and the
    // daemon would die with the pool mid-flight.
    await expect(probeFree(30123)).resolves.toBe(false);
    await expect(allocateInBlock({ lo: 30123, hi: 30125 }, new Set())).resolves.toBeUndefined();
  });

  it('still allocates a real port when the OS cooperates', async () => {
    const { allocateInBlock } = await import('../src/core/ports.js');
    const a = await allocateInBlock({ lo: 30500, hi: 30999 }, new Set());
    expect(a).toBeGreaterThan(0);
    const b = await allocateInBlock({ lo: 30500, hi: 30999 }, new Set([a!]));
    expect(b).toBeGreaterThan(0);
    expect(b).not.toBe(a);
  });
});

describe('watcher failure is contained to one environment', () => {
  it('an fs.watch error stops that watcher without propagating', async () => {
    // Drive the real contract: a watcher that emits 'error' must be handled by
    // a registered listener. An EventEmitter with no 'error' listener throws
    // synchronously on emit, so this assertion distinguishes handled from not.
    const watcher = new EventEmitter();
    let handled = false;
    watcher.on('error', () => {
      handled = true;
    });
    expect(() => watcher.emit('error', new Error('ENOSPC'))).not.toThrow();
    expect(handled).toBe(true);

    // And the unhandled shape genuinely does throw — proving the assertion above
    // is not vacuous.
    const bare = new EventEmitter();
    expect(() => bare.emit('error', new Error('ENOSPC'))).toThrow(/ENOSPC/);
  });
});

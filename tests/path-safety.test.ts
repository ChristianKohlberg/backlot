/**
 * Fleet review, security cluster.
 *
 * These are NOT a privilege boundary — a stack.yaml can already run arbitrary
 * shell, so anyone who controls it owns the environment anyway. They matter
 * because an ACCIDENT ("cwd: ../sibling", a datastore key with a slash) used to
 * silently operate outside the environment tree or the state root instead of
 * failing loudly.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDatastore } from '../src/drivers/datastores.js';
import { socketPath } from '../src/core/paths.js';
import { classifyClientError } from '../src/cli/client.js';
import { safeJoin } from '../src/core/util.js';

describe('datastore keys cannot escape the state root', () => {
  it('rejects a separator or .. in the key, for every driver', () => {
    const sqlite = { driver: 'sqlite', file: 'a.db', create: 'true' } as never;
    const pg = { driver: 'postgres', url: 'postgres://h/{{ns}}', create: 'true' } as never;
    for (const spec of [sqlite, pg]) {
      expect(() => makeDatastore('../escape', spec, 'stk')).toThrow(/path separators|\.\./);
      expect(() => makeDatastore('a/b', spec, 'stk')).toThrow(/path separators|\.\./);
    }
    // The command family builds .baked marker paths from the key too, which is
    // why this check had to move out of the sqlite driver.
    expect(() => makeDatastore('fine_name', pg, 'stk')).not.toThrow();
  });
});

describe('a socket path over the AF_UNIX sun_path limit fails loudly', () => {
  // sun_path is 104 bytes on macOS, 108 on Linux — and BOTH sides of the RPC
  // truncate identically, so a too-deep BACKLOT_STATE_DIR *appears* to work
  // while actually colliding with any sibling state dir sharing the prefix.
  const withStateDir = <T>(dir: string, fn: () => T): T => {
    const prev = process.env.BACKLOT_STATE_DIR;
    process.env.BACKLOT_STATE_DIR = dir;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.BACKLOT_STATE_DIR;
      else process.env.BACKLOT_STATE_DIR = prev;
    }
  };

  it('throws an error naming the limit and the offending path', () => {
    const base = mkdtempSync(join(tmpdir(), 'backlot-sun-'));
    const deep = join(base, 'x'.repeat(120)); // socket path lands well past 104 bytes
    try {
      const err = withStateDir(deep, () => {
        let thrown: unknown;
        try {
          socketPath();
        } catch (e) {
          thrown = e;
        }
        return thrown;
      });
      expect(err, 'socketPath() must refuse a path the OS would silently truncate').toBeTruthy();
      expect(String((err as Error).message)).toMatch(/sun_path/);
      expect(String((err as Error).message)).toContain(deep); // names the offending path
      // The classification contract: a bad state dir is infrastructure, never
      // "recycle an environment".
      expect(classifyClientError(err)).toBe('infra-error');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('leaves an ordinary state dir alone', () => {
    const base = mkdtempSync(join(tmpdir(), 'backlot-sun-ok-'));
    try {
      expect(withStateDir(base, () => socketPath())).toBe(join(base, 'daemon.sock'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('a cwd outside the environment tree is refused, not silently used', () => {
  it('safeJoin rejects traversal and absolute paths', () => {
    expect(() => safeJoin('/env/tree', '../sibling', 'service cwd')).toThrow();
    expect(() => safeJoin('/env/tree', '/etc', 'service cwd')).toThrow();
    expect(safeJoin('/env/tree', 'apps/web', 'service cwd')).toBe('/env/tree/apps/web');
  });
});

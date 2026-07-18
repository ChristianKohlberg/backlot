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
import { makeDatastore } from '../src/drivers/datastores.js';
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

describe('a cwd outside the environment tree is refused, not silently used', () => {
  it('safeJoin rejects traversal and absolute paths', () => {
    expect(() => safeJoin('/env/tree', '../sibling', 'service cwd')).toThrow();
    expect(() => safeJoin('/env/tree', '/etc', 'service cwd')).toThrow();
    expect(safeJoin('/env/tree', 'apps/web', 'service cwd')).toBe('/env/tree/apps/web');
  });
});

/**
 * Sync-layer unit properties: stat-gated hashing stays CORRECT — copies happen
 * exactly when content differs, env-side mutations are healed (the reset
 * guarantee), deletions mirror, caches survive.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncIntoEnv } from '../src/core/sync.js';
import type { Manifest } from '../src/core/manifest.js';

const src = mkdtempSync(join(tmpdir(), 'infront-sync-src-'));
const env = mkdtempSync(join(tmpdir(), 'infront-sync-env-'));
afterAll(() => {
  rmSync(src, { recursive: true, force: true });
  rmSync(env, { recursive: true, force: true });
});

const manifest: Manifest = { name: 'x', services: { s: { run: 'true' } }, caches: ['node_modules'] };

describe('syncIntoEnv (stat-gated hashing)', () => {
  it('first sync copies everything; unchanged re-sync copies nothing', () => {
    writeFileSync(join(src, 'a.txt'), 'alpha');
    writeFileSync(join(src, 'b.txt'), 'beta');
    execFileSync('git', ['init', '-q'], { cwd: src });
    const first = syncIntoEnv(src, env, manifest);
    expect(first.copied).toBe(2);
    const second = syncIntoEnv(src, env, manifest);
    expect(second.copied).toBe(0);
    expect(second.sourceHash).toBe(first.sourceHash);
  });

  it('touched-but-identical source (mtime drift) re-hashes but does not copy', () => {
    const t = new Date(Date.now() + 5000);
    utimesSync(join(src, 'a.txt'), t, t);
    const res = syncIntoEnv(src, env, manifest);
    expect(res.copied).toBe(0);
  });

  it('changed content copies and changes the source identity', () => {
    writeFileSync(join(src, 'a.txt'), 'alpha v2');
    const before = syncIntoEnv(src, env, manifest).sourceHash;
    expect(readFileSync(join(env, 'a.txt'), 'utf8')).toBe('alpha v2');
    writeFileSync(join(src, 'a.txt'), 'alpha v3');
    const res = syncIntoEnv(src, env, manifest);
    expect(res.copied).toBe(1);
    expect(res.sourceHash).not.toBe(before);
  });

  it('the reset guarantee: an env-side mutation of a tracked file is healed', () => {
    writeFileSync(join(env, 'b.txt'), 'poisoned by a check');
    const res = syncIntoEnv(src, env, manifest);
    expect(res.copied).toBe(1);
    expect(readFileSync(join(env, 'b.txt'), 'utf8')).toBe('beta');
  });

  it('deletions mirror; caches survive', () => {
    mkdirSync(join(env, 'node_modules'), { recursive: true });
    writeFileSync(join(env, 'node_modules', 'dep.js'), 'cached');
    rmSync(join(src, 'b.txt'));
    const res = syncIntoEnv(src, env, manifest);
    expect(res.deleted).toBe(1);
    expect(readFileSync(join(env, 'node_modules', 'dep.js'), 'utf8')).toBe('cached');
  });
});

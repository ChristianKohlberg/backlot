/**
 * Fleet review: the stat gate trusted (size, mtime) equality, so a same-size
 * rewrite landing in the same filesystem timestamp tick as the recorded stat
 * was invisible — and stayed invisible, because the stat never drifts again on
 * its own. The environment silently served stale content.
 *
 * This was not theoretical: tests/sync.test.ts failed roughly 2 runs in 6 on
 * this machine for exactly this reason.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncIntoEnv } from '../src/core/sync.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const manifest = { name: 'racy', services: {}, checks: {} } as never;

function repo() {
  const src = mkdtempSync(join(tmpdir(), 'backlot-racy-src-'));
  const env = mkdtempSync(join(tmpdir(), 'backlot-racy-env-'));
  dirs.push(src, env);
  execFileSync('git', ['init', '-q'], { cwd: src });
  return { src, env };
}

describe('same-size edits inside one timestamp tick are not missed', () => {
  it('re-syncs a file whose recorded stat still matches after a same-size edit', () => {
    const { src, env } = repo();
    const file = join(src, 'app.txt');

    writeFileSync(file, 'alpha-v1'); // 8 bytes
    const first = syncIntoEnv(src, env, manifest);
    expect(first.copied).toBeGreaterThan(0);
    expect(readFileSync(join(env, 'app.txt'), 'utf8')).toBe('alpha-v1');

    // The adversarial state, constructed exactly rather than raced for: the
    // file now holds DIFFERENT content of the SAME size, while the cache still
    // records a stat that matches it and the hash of the old content. That is
    // precisely what a rewrite inside one timestamp tick leaves behind, and by
    // stat alone it is indistinguishable from a file already in sync.
    writeFileSync(file, 'alpha-v2'); // also 8 bytes
    const cachePath = join(env, '.backlot-synced.json');
    const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      syncedAt: number;
      entries: Record<string, { srcSize: number; srcMtime: number }>;
    };
    const live = statSync(file);
    const entry = cache.entries['app.txt']!;
    entry.srcSize = live.size;
    entry.srcMtime = live.mtimeMs;
    // The cache was written no later than the file's mtime -> "racily clean".
    cache.syncedAt = live.mtimeMs;
    writeFileSync(cachePath, JSON.stringify(cache));

    const second = syncIntoEnv(src, env, manifest);
    expect(second.copied).toBeGreaterThan(0);
    expect(readFileSync(join(env, 'app.txt'), 'utf8')).toBe('alpha-v2');
  });

  it('still trusts the stat gate for a genuinely unchanged file', () => {
    const { src, env } = repo();
    writeFileSync(join(src, 'stable.txt'), 'unchanging');
    syncIntoEnv(src, env, manifest);
    // Past the racy window, an untouched file must NOT be re-copied — the fix
    // must not degrade into "hash everything, every time".
    const before = statSync(join(env, 'stable.txt')).mtimeMs;
    const again = syncIntoEnv(src, env, manifest);
    expect(again.copied).toBe(0);
    expect(statSync(join(env, 'stable.txt')).mtimeMs).toBe(before);
  });

  it('reads a cache written by the previous format without losing deletions', () => {
    const { src, env } = repo();
    writeFileSync(join(src, 'a.txt'), 'one');
    writeFileSync(join(src, 'b.txt'), 'two');
    syncIntoEnv(src, env, manifest);

    // Downgrade the cache to the old top-level-entries shape on disk.
    const cachePath = join(env, '.backlot-synced.json');
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as { entries: Record<string, unknown> };
    writeFileSync(cachePath, JSON.stringify(parsed.entries));

    // Deletion mirroring reads that cache; an unreadable one would silently
    // stop mirroring deletions rather than fail.
    rmSync(join(src, 'b.txt'));
    const after = syncIntoEnv(src, env, manifest);
    expect(after.deleted).toBe(1);
    expect(existsSync(join(env, 'b.txt'))).toBe(false);
  });
});

describe('file modes reach the environment', () => {
  it('propagates chmod +x on an otherwise unchanged file', () => {
    const { src, env } = repo();
    const script = join(src, 'run.sh');
    writeFileSync(script, '#!/bin/sh\necho hi\n');
    syncIntoEnv(src, env, manifest);
    expect(statSync(join(env, 'run.sh')).mode & 0o111).toBe(0);

    // chmod moves ctime, not mtime, and the content is identical — so neither
    // the stat gate nor the hash comparison saw anything. The service then
    // failed with 'Permission denied', blamed on the repo.
    chmodSync(script, 0o755);
    const after = syncIntoEnv(src, env, manifest);

    expect(statSync(join(env, 'run.sh')).mode & 0o111).not.toBe(0);
    expect(after.copied).toBeGreaterThan(0); // reported as a real change
  });

  it('does not report a change when nothing moved', () => {
    const { src, env } = repo();
    writeFileSync(join(src, 'plain.txt'), 'x');
    syncIntoEnv(src, env, manifest);
    expect(syncIntoEnv(src, env, manifest).copied).toBe(0);
  });
});

describe('symlinks do not crash enumeration', () => {
  it('walks a tree containing a dangling symlink instead of throwing', () => {
    const { src, env } = repo();
    writeFileSync(join(src, 'real.txt'), 'here');
    symlinkSync(join(src, 'nowhere.txt'), join(src, 'broken-link'));

    // bind --ref extracts via `git archive | tar -x` into a NON-git dir, so
    // enumeration falls through to walkAll — which used to stat() the dangling
    // link and throw ENOENT, failing the whole bind.
    expect(() => syncIntoEnv(src, env, manifest)).not.toThrow();
    expect(readFileSync(join(env, 'real.txt'), 'utf8')).toBe('here');
  });
});

/**
 * The worktree fingerprint (decision 0032): environments run in the caller's
 * worktree, so what is left of the old projection is its source identity —
 * one hash over (path, content) that tells the engine whether the running
 * services and the build output are from this state. These are the properties
 * the projection's own tests held it to, kept for the part that survived:
 * stat-gated hashing that never misses a change, and enumeration that never
 * crashes on a live tree.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintWorktree, hashOutputs } from '../src/core/worktree.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const manifest = { name: 'wt', services: {}, checks: {} } as never;

function repo() {
  const src = mkdtempSync(join(tmpdir(), 'runly-wt-src-'));
  const cache = mkdtempSync(join(tmpdir(), 'runly-wt-cache-'));
  dirs.push(src, cache);
  execFileSync('git', ['init', '-q'], { cwd: src });
  return { src, cache };
}

describe('the source identity', () => {
  it('is stable while nothing changes, and moves with content', () => {
    const { src, cache } = repo();
    writeFileSync(join(src, 'a.txt'), 'alpha');
    writeFileSync(join(src, 'b.txt'), 'beta');
    const first = fingerprintWorktree(src, manifest, cache);
    expect(first.files).toEqual(['a.txt', 'b.txt']);
    expect(fingerprintWorktree(src, manifest, cache).sourceHash).toBe(first.sourceHash);
    writeFileSync(join(src, 'a.txt'), 'alpha v2');
    expect(fingerprintWorktree(src, manifest, cache).sourceHash).not.toBe(first.sourceHash);
  });

  it('a touched-but-identical file re-reads but keeps the identity', () => {
    const { src, cache } = repo();
    writeFileSync(join(src, 'a.txt'), 'alpha');
    const before = fingerprintWorktree(src, manifest, cache).sourceHash;
    const t = new Date(Date.now() + 5000);
    utimesSync(join(src, 'a.txt'), t, t);
    const after = fingerprintWorktree(src, manifest, cache);
    expect(after.hashed).toBe(1);
    expect(after.sourceHash).toBe(before);
  });

  it('follows deletions, and ignores what git ignores unless sync.include names it', () => {
    const { src, cache } = repo();
    writeFileSync(join(src, 'a.txt'), 'alpha');
    writeFileSync(join(src, 'gone.txt'), 'x');
    writeFileSync(join(src, '.gitignore'), 'node_modules/\n.env.local\n');
    mkdirSync(join(src, 'node_modules'));
    writeFileSync(join(src, 'node_modules', 'dep.js'), 'installed');
    writeFileSync(join(src, '.env.local'), 'A=1');
    rmSync(join(src, 'gone.txt'));
    expect(fingerprintWorktree(src, manifest, cache).files).toEqual(['.gitignore', 'a.txt']);
    const withInclude = { name: 'wt', services: {}, sync: { include: ['.env.local'] } } as never;
    const before = fingerprintWorktree(src, withInclude, cache);
    expect(before.files).toContain('.env.local');
    writeFileSync(join(src, '.env.local'), 'A=2');
    expect(fingerprintWorktree(src, withInclude, cache).sourceHash).not.toBe(before.sourceHash);
  });

  it('keeps its stat cache in the state root, never in the worktree', () => {
    const { src, cache } = repo();
    writeFileSync(join(src, 'a.txt'), 'alpha');
    fingerprintWorktree(src, manifest, cache);
    expect(execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: src, encoding: 'utf8' })).toBe('?? a.txt\n');
    expect(JSON.parse(readFileSync(join(cache, 'hashes.json'), 'utf8')).root).toBe(src);
  });
});

describe('same-size edits inside one timestamp tick are not missed', () => {
  // Fleet review of the projection: the stat gate trusted (size, mtime)
  // equality, so a same-size rewrite in the same timestamp tick as the
  // recorded stat was invisible forever. Running in place, the same miss would
  // let the engine believe running services serve content they do not.
  it('re-reads a file whose recorded stat still matches after a same-size edit', () => {
    const { src, cache } = repo();
    const file = join(src, 'app.txt');
    writeFileSync(file, 'alpha-v1'); // 8 bytes
    const first = fingerprintWorktree(src, manifest, cache);

    // The adversarial state, constructed exactly rather than raced for:
    // different content of the SAME size, a cache stat that matches it, and
    // the hash of the old content.
    writeFileSync(file, 'alpha-v2');
    const cachePath = join(cache, 'hashes.json');
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as { writtenAt: number; entries: Record<string, { size: number; mtime: number }> };
    const live = statSync(file);
    parsed.entries['app.txt']!.size = live.size;
    parsed.entries['app.txt']!.mtime = live.mtimeMs;
    parsed.writtenAt = live.mtimeMs; // written no later than the file's mtime -> "racily clean"
    writeFileSync(cachePath, JSON.stringify(parsed));

    expect(fingerprintWorktree(src, manifest, cache).sourceHash).not.toBe(first.sourceHash);
  });

  it('still trusts the stat gate for a genuinely unchanged file', () => {
    const { src, cache } = repo();
    writeFileSync(join(src, 'stable.txt'), 'unchanging');
    fingerprintWorktree(src, manifest, cache);
    // Past the racy window an untouched file must not be re-read — the fix
    // must not degrade into "hash everything, every time".
    const parsed = JSON.parse(readFileSync(join(cache, 'hashes.json'), 'utf8')) as { writtenAt: number };
    parsed.writtenAt += 10_000;
    writeFileSync(join(cache, 'hashes.json'), JSON.stringify(parsed));
    expect(fingerprintWorktree(src, manifest, cache).hashed).toBe(0);
  });
});

describe('enumeration survives a live tree', () => {
  it('a dangling symlink in a non-git tree does not throw', () => {
    const src = mkdtempSync(join(tmpdir(), 'runly-wt-nogit-'));
    const cache = mkdtempSync(join(tmpdir(), 'runly-wt-cache-'));
    dirs.push(src, cache);
    writeFileSync(join(src, 'real.txt'), 'here');
    symlinkSync(join(src, 'nowhere.txt'), join(src, 'broken-link'));
    expect(fingerprintWorktree(src, manifest, cache).files).toEqual(['real.txt']);
  });

  it('a checked-out submodule is part of the source; an edit inside it moves the identity', () => {
    // The projection refused submodules because their contents never reached
    // the environment. In place they are simply there — so they must count.
    const { src, cache } = repo();
    const inner = mkdtempSync(join(tmpdir(), 'runly-wt-sub-'));
    dirs.push(inner);
    execFileSync('git', ['init', '-q'], { cwd: inner });
    writeFileSync(join(inner, 'lib.txt'), 'from submodule');
    execFileSync('git', ['add', '-A'], { cwd: inner });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: inner });
    writeFileSync(join(src, 'root.txt'), 'root');
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'vendor/dep'], { cwd: src });

    const before = fingerprintWorktree(src, manifest, cache);
    expect(before.files).toContain('vendor/dep/lib.txt');
    writeFileSync(join(src, 'vendor', 'dep', 'lib.txt'), 'edited in the submodule');
    expect(fingerprintWorktree(src, manifest, cache).sourceHash).not.toBe(before.sourceHash);
  }, 60_000);
});

describe('declared outputs', () => {
  it('hashes what exists, reports null for what does not, and refuses to leave the worktree', () => {
    const { src } = repo();
    writeFileSync(join(src, 'lock.json'), '{}');
    const h = hashOutputs(src, ['lock.json', 'missing.ts', '../escape.txt']);
    expect(typeof h['lock.json']).toBe('string');
    expect(h['missing.ts']).toBeNull();
    expect('../escape.txt' in h).toBe(false);
  });
});

describe('declared caches are output, not source', () => {
  it('a build writing under caches: does not move the source identity', () => {
    const { src, cache } = repo();
    writeFileSync(join(src, 'app.txt'), 'source');
    const m = { name: 'wt', services: {}, caches: ['.build', '**/obj'] } as never;
    const before = fingerprintWorktree(src, m, cache);
    mkdirSync(join(src, '.build'));
    writeFileSync(join(src, '.build', 'count'), '1');
    mkdirSync(join(src, 'svc', 'obj'), { recursive: true });
    writeFileSync(join(src, 'svc', 'obj', 'project.assets.json'), '{}');
    const after = fingerprintWorktree(src, m, cache);
    expect(after.files).toEqual(['app.txt']);
    expect(after.sourceHash).toBe(before.sourceHash);
  });
});

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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncIntoEnv, changedOutputs, pullOutputs } from '../src/core/sync.js';

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

describe('env-side droppings are swept only on a clean-slate bind', () => {
  it('removes untracked env files when the caller asked for a reset', () => {
    const { src, env } = repo();
    writeFileSync(join(src, 'tracked.txt'), 'v1');
    syncIntoEnv(src, env, manifest);

    // A check/service/exec wrote these INSIDE the environment. The deletion
    // mirror never saw them, because it only knows what a previous sync wrote.
    writeFileSync(join(env, 'poison.txt'), 'left by a previous holder');
    writeFileSync(join(env, 'artifact.log'), 'noise');

    const after = syncIntoEnv(src, env, manifest, true);

    expect(existsSync(join(env, 'poison.txt'))).toBe(false);
    expect(existsSync(join(env, 'artifact.log'))).toBe(false);
    expect(after.deleted).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(env, 'tracked.txt'), 'utf8')).toBe('v1'); // tracked files survive
  });

  it('leaves droppings alone on a plain reuse bind', () => {
    const { src, env } = repo();
    writeFileSync(join(src, 'tracked.txt'), 'v1');
    syncIntoEnv(src, env, manifest);
    writeFileSync(join(env, 'build-output.bin'), 'expensive');

    syncIntoEnv(src, env, manifest); // reuse: no sweep

    // This is the whole reason the sweep is gated: an undeclared build artifact
    // must not be destroyed on every ordinary bind.
    expect(existsSync(join(env, 'build-output.bin'))).toBe(true);
  });

  it('purges a stray .git and an undeclared node_modules on a clean-slate bind', () => {
    const { src, env } = repo();
    writeFileSync(join(src, 'tracked.txt'), 'v1');
    syncIntoEnv(src, env, manifest);

    // A check ran `git clone` and an undeclared install INSIDE the environment.
    // walkAll's name-skip of .git/node_modules serves SOURCE enumeration, so
    // these survived every clean-slate bind — contradicting architecture.md §6
    // ("a poisoned env tree self-heals on the next clean-slate bind"). Empty
    // directories survived too, since walkAll never emits directories.
    mkdirSync(join(env, 'clone', '.git'), { recursive: true });
    writeFileSync(join(env, 'clone', '.git', 'HEAD'), 'ref: refs/heads/main');
    writeFileSync(join(env, 'clone', 'file.txt'), 'cloned');
    mkdirSync(join(env, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(env, 'node_modules', 'left-pad', 'index.js'), 'x');
    mkdirSync(join(env, 'empty-dir'), { recursive: true });

    syncIntoEnv(src, env, manifest, true);

    expect(existsSync(join(env, 'clone'))).toBe(false);
    expect(existsSync(join(env, 'node_modules'))).toBe(false);
    expect(existsSync(join(env, 'empty-dir'))).toBe(false);
    expect(readFileSync(join(env, 'tracked.txt'), 'utf8')).toBe('v1');
  });

  it('a node_modules DECLARED under caches: still survives the sweep', () => {
    const { src, env } = repo();
    writeFileSync(join(src, 'tracked.txt'), 'v1');
    const withCache = { name: 'racy', services: {}, checks: {}, caches: ['node_modules'] } as never;
    syncIntoEnv(src, env, withCache);

    mkdirSync(join(env, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(env, 'node_modules', 'left-pad', 'index.js'), 'x');

    syncIntoEnv(src, env, withCache, true);

    expect(readFileSync(join(env, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('x');
  });

  it('never sweeps declared caches or sync.keep, even on a reset', () => {
    const { src, env } = repo();
    writeFileSync(join(src, 'tracked.txt'), 'v1');
    const withCaches = { name: 'racy', services: {}, checks: {}, caches: ['vendor/**'], sync: { keep: ['.env.local'] } } as never;
    syncIntoEnv(src, env, withCaches);

    mkdirSync(join(env, 'vendor'), { recursive: true });
    writeFileSync(join(env, 'vendor', 'dep.js'), 'cached');
    writeFileSync(join(env, '.env.local'), 'SECRET=1');

    syncIntoEnv(src, env, withCaches, true);

    expect(existsSync(join(env, 'vendor', 'dep.js'))).toBe(true);
    expect(existsSync(join(env, '.env.local'))).toBe(true);
  });
});

describe('outputs write-back respects the worktree as source of truth', () => {
  it('does not report a worktree-only edit as an environment change', () => {
    const { src, env } = repo();
    const m = { name: 'o', services: {}, checks: {}, outputs: ['gen.txt'] } as never;
    writeFileSync(join(src, 'gen.txt'), 'v1');
    syncIntoEnv(src, env, m);

    // The user edits the worktree AFTER binding. The environment never touched
    // it. Comparing env-vs-worktree called that an "env change", and pull then
    // copied the stale bind-time copy over the newer worktree content.
    writeFileSync(join(src, 'gen.txt'), 'v2-from-user');

    expect(changedOutputs(src, env, m)).toEqual([]);
    pullOutputs(src, env, m);
    expect(readFileSync(join(src, 'gen.txt'), 'utf8')).toBe('v2-from-user');
  });

  it('still reports and pulls a genuine environment change', () => {
    const { src, env } = repo();
    const m = { name: 'o', services: {}, checks: {}, outputs: ['gen.txt'] } as never;
    writeFileSync(join(src, 'gen.txt'), 'v1');
    syncIntoEnv(src, env, m);

    writeFileSync(join(env, 'gen.txt'), 'built-in-env'); // a build wrote it
    expect(changedOutputs(src, env, m)).toEqual(['gen.txt']);
    pullOutputs(src, env, m);
    expect(readFileSync(join(src, 'gen.txt'), 'utf8')).toBe('built-in-env');
  });

  it('refuses to overwrite when BOTH sides moved since the bind', () => {
    const { src, env } = repo();
    const m = { name: 'o', services: {}, checks: {}, outputs: ['gen.txt'] } as never;
    writeFileSync(join(src, 'gen.txt'), 'v1');
    syncIntoEnv(src, env, m);

    writeFileSync(join(env, 'gen.txt'), 'built-in-env');
    writeFileSync(join(src, 'gen.txt'), 'edited-by-user');

    // Silently reverting the user's edit is data loss, not a write-back.
    expect(() => pullOutputs(src, env, m)).toThrow(/BOTH the environment and the worktree/);
    expect(readFileSync(join(src, 'gen.txt'), 'utf8')).toBe('edited-by-user');
  });

  it('a second pull over already-pulled content is a no-op, not a conflict', () => {
    const { src, env } = repo();
    const m = { name: 'o', services: {}, checks: {}, outputs: ['gen.txt'] } as never;
    writeFileSync(join(src, 'gen.txt'), 'v1');
    syncIntoEnv(src, env, m);

    writeFileSync(join(env, 'gen.txt'), 'built-in-env');
    pullOutputs(src, env, m);
    expect(readFileSync(join(src, 'gen.txt'), 'utf8')).toBe('built-in-env');

    // An agent retry (or a retry after a timed-out first attempt) pulls again.
    // The worktree hash now equals the env hash but differs from the bind-time
    // baseline — byte-identical content is not a both-sides conflict.
    expect(() => pullOutputs(src, env, m)).not.toThrow();
    expect(readFileSync(join(src, 'gen.txt'), 'utf8')).toBe('built-in-env');
  });
});

describe('submodules are refused, not silently omitted', () => {
  it('fails with an actionable error naming the submodule', () => {
    const { src, env } = repo();
    const inner = mkdtempSync(join(tmpdir(), 'backlot-sub-'));
    dirs.push(inner);
    execFileSync('git', ['init', '-q'], { cwd: inner });
    writeFileSync(join(inner, 'lib.txt'), 'from submodule');
    execFileSync('git', ['add', '-A'], { cwd: inner });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: inner });

    writeFileSync(join(src, 'root.txt'), 'root');
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'vendor/dep'], { cwd: src });

    // A gitlink stats as a directory, so the isFile filter dropped it and the
    // subtree simply never reached the environment — the build then failed
    // with a work-error blaming the repo and no hint about the cause.
    expect(() => syncIntoEnv(src, env, manifest)).toThrow(/submodule/i);
    expect(() => syncIntoEnv(src, env, manifest)).toThrow(/vendor\/dep/);
  }, 60_000);

  // `git update-index --add --cacheinfo 160000,<sha>,<path>` fabricates a
  // gitlink without a network clone; the on-disk files under it are what
  // sync.include projects (ls-files --others does not descend past a gitlink).
  function gitlinkRepo() {
    const { src, env } = repo();
    writeFileSync(join(src, 'root.txt'), 'root');
    execFileSync('git', ['add', 'root.txt'], { cwd: src });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: src });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${sha},vendor/dep`], { cwd: src });
    mkdirSync(join(src, 'vendor', 'dep'), { recursive: true });
    writeFileSync(join(src, 'vendor', 'dep', 'lib.txt'), 'from submodule');
    return { src, env };
  }

  it('admits a gitlink whose needed files are declared under sync.include', () => {
    const { src, env } = gitlinkRepo();
    // The refusal's own remedy: "declare the paths you need under sync.include".
    // The gitlink check used to throw BEFORE include was consulted, so the
    // advertised escape hatch was unreachable.
    const m = { name: 'racy', services: {}, checks: {}, sync: { include: ['vendor/dep/lib.txt'] } } as never;
    expect(() => syncIntoEnv(src, env, m)).not.toThrow();
    expect(readFileSync(join(env, 'vendor', 'dep', 'lib.txt'), 'utf8')).toBe('from submodule');
    expect(readFileSync(join(env, 'root.txt'), 'utf8')).toBe('root');
  });

  it('still refuses a gitlink with no covering include entry', () => {
    const { src, env } = gitlinkRepo();
    // An include elsewhere in the repo does not cover the gitlink's subtree.
    const m = { name: 'racy', services: {}, checks: {}, sync: { include: ['root.txt'] } } as never;
    expect(() => syncIntoEnv(src, env, m)).toThrow(/submodule/i);
    expect(() => syncIntoEnv(src, env, m)).toThrow(/vendor\/dep/);
  });

  it('an include entry that is not an existing FILE does not disarm the refusal', () => {
    const { src, env } = gitlinkRepo();
    // A directory entry (or a typo) beneath the gitlink would be silently
    // dropped by the include push (files only) — admitting the gitlink on its
    // say-so projects NOTHING, recreating the silent omission the refusal
    // exists to prevent, now with no error at all.
    for (const bad of ['vendor/dep', 'vendor/dep/nope.txt']) {
      const m = { name: 'racy', services: {}, checks: {}, sync: { include: [bad] } } as never;
      expect(() => syncIntoEnv(src, env, m), `include: ['${bad}']`).toThrow(/submodule/i);
    }
  });
});

describe('case-only renames', () => {
  it('mirrors the deletion on a case-SENSITIVE filesystem', () => {
    const { src, env } = repo();
    writeFileSync(join(src, 'README.md'), 'docs');
    syncIntoEnv(src, env, manifest);
    expect(existsSync(join(env, 'README.md'))).toBe(true);

    rmSync(join(src, 'README.md'));
    writeFileSync(join(src, 'Readme.md'), 'docs');
    syncIntoEnv(src, env, manifest);

    // On Linux these are two distinct files, so the old one must be removed.
    // On macOS APFS they are the SAME file and removing it would destroy the
    // just-synced content — which is what the probe distinguishes.
    expect(existsSync(join(env, 'Readme.md'))).toBe(true);
    expect(readFileSync(join(env, 'Readme.md'), 'utf8')).toBe('docs');
  });

  it('the clean-slate sweep does not eat a case-renamed file on an insensitive fs', () => {
    const { src, env } = repo();
    writeFileSync(join(src, 'README.md'), 'docs');
    syncIntoEnv(src, env, manifest);

    rmSync(join(src, 'README.md'));
    writeFileSync(join(src, 'Readme.md'), 'docs');
    // Clean-slate: on APFS the disk entry may keep the OLD casing while the
    // sync cache holds the new key — the sweep must use the same
    // case-insensitivity probe as the deletion mirror, or it deletes the file
    // sync just guaranteed.
    syncIntoEnv(src, env, manifest, true);
    expect(existsSync(join(env, 'Readme.md'))).toBe(true);
    expect(readFileSync(join(env, 'Readme.md'), 'utf8')).toBe('docs');
  });
});

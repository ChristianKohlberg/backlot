/**
 * What runly still reads from the caller's worktree (decision 0032): the files
 * the declared upkeep `when:` globs match, and nothing else. There is no
 * whole-worktree source identity and no build cache; these are the properties
 * the trigger reading is held to — it reads only matching files, never misses a
 * change to one, keeps its small cache out of the worktree, and never crashes
 * on a live tree.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enumerateSource, snapshotOutputs } from '../src/core/worktree.js';
import { triggerFiles, triggerHash, triggerSet } from '../src/core/upkeep.js';
import { disposeStateSync } from './support/leaks.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) disposeStateSync(d);
});

const manifest = { name: 'wt', services: {} } as never;
const withRules = (...whens: string[]) =>
  ({ name: 'wt', services: {}, upkeep: whens.map((when) => ({ when, run: 'true' })) }) as never;

function repo() {
  const src = mkdtempSync(join(tmpdir(), 'runly-wt-src-'));
  const cache = mkdtempSync(join(tmpdir(), 'runly-wt-cache-'));
  dirs.push(src, cache);
  execFileSync('git', ['init', '-q'], { cwd: src });
  return { src, cache };
}

describe('enumeration', () => {
  it('follows deletions, and ignores what git ignores unless sync.include names it', () => {
    const { src } = repo();
    writeFileSync(join(src, 'a.txt'), 'alpha');
    writeFileSync(join(src, 'gone.txt'), 'x');
    writeFileSync(join(src, '.gitignore'), 'node_modules/\n.env.local\n');
    mkdirSync(join(src, 'node_modules'));
    writeFileSync(join(src, 'node_modules', 'dep.js'), 'installed');
    writeFileSync(join(src, '.env.local'), 'A=1');
    rmSync(join(src, 'gone.txt'));
    expect(enumerateSource(src, manifest)).toEqual(['.gitignore', 'a.txt']);
    const withInclude = { name: 'wt', services: {}, sync: { include: ['.env.local'] } } as never;
    expect(enumerateSource(src, withInclude)).toContain('.env.local');
  });

  it('filters by the given globs before it looks at a file', () => {
    const { src } = repo();
    writeFileSync(join(src, 'pnpm-lock.yaml'), 'lock');
    mkdirSync(join(src, 'migrations'));
    writeFileSync(join(src, 'migrations', '001.sql'), 'create');
    writeFileSync(join(src, 'app.ts'), 'code');
    expect(enumerateSource(src, manifest, ['pnpm-lock.yaml', 'migrations/**'])).toEqual(['migrations/001.sql', 'pnpm-lock.yaml']);
  });

  it('a dangling symlink in a non-git tree does not throw', () => {
    const src = mkdtempSync(join(tmpdir(), 'runly-wt-nogit-'));
    dirs.push(src);
    writeFileSync(join(src, 'real.txt'), 'here');
    symlinkSync(join(src, 'nowhere.txt'), join(src, 'broken-link'));
    expect(enumerateSource(src, manifest)).toEqual(['real.txt']);
  });

  it('a checked-out submodule is enumerated, so a trigger inside it fires', () => {
    const { src } = repo();
    const inner = mkdtempSync(join(tmpdir(), 'runly-wt-sub-'));
    dirs.push(inner);
    execFileSync('git', ['init', '-q'], { cwd: inner });
    writeFileSync(join(inner, 'lib.lock'), 'from submodule');
    execFileSync('git', ['add', '-A'], { cwd: inner });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: inner });
    writeFileSync(join(src, 'root.txt'), 'root');
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'vendor/dep'], { cwd: src });

    const m = withRules('vendor/dep/lib.lock');
    const before = triggerHash(src, triggerFiles(src, m), 'vendor/dep/lib.lock');
    expect(triggerFiles(src, m)).toEqual(['vendor/dep/lib.lock']);
    writeFileSync(join(src, 'vendor', 'dep', 'lib.lock'), 'edited in the submodule');
    expect(triggerHash(src, triggerFiles(src, m), 'vendor/dep/lib.lock')).not.toBe(before);
  }, 60_000);

  it('a build writing under caches: is never a trigger', () => {
    const { src } = repo();
    const m = { name: 'wt', services: {}, caches: ['**/obj'], upkeep: [{ when: '**/*.json', run: 'true' }] } as never;
    writeFileSync(join(src, 'package.json'), '{}');
    mkdirSync(join(src, 'svc', 'obj'), { recursive: true });
    writeFileSync(join(src, 'svc', 'obj', 'project.assets.json'), '{}');
    expect(triggerFiles(src, m)).toEqual(['package.json']);
  });
});

describe('trigger hashing', () => {
  it('reads only the files a when: glob matches, and asks git nothing without rules', () => {
    const { src } = repo();
    writeFileSync(join(src, 'pnpm-lock.yaml'), 'lock');
    writeFileSync(join(src, 'app.ts'), 'code');
    expect(triggerFiles(src, manifest)).toEqual([]);
    const m = withRules('pnpm-lock.yaml');
    const set = triggerSet(src, m);
    expect(set.files).toEqual(['pnpm-lock.yaml']);
    const before = triggerHash(src, set, 'pnpm-lock.yaml');
    // An edit outside every glob changes nothing runly looks at.
    writeFileSync(join(src, 'app.ts'), 'code v2');
    expect(triggerHash(src, triggerSet(src, m), 'pnpm-lock.yaml')).toBe(before);
    writeFileSync(join(src, 'pnpm-lock.yaml'), 'lock v2');
    expect(triggerHash(src, triggerSet(src, m), 'pnpm-lock.yaml')).not.toBe(before);
  });

  it('keeps its small cache in the state root, never in the worktree, and only for trigger files', () => {
    const { src, cache } = repo();
    writeFileSync(join(src, 'pnpm-lock.yaml'), 'lock');
    writeFileSync(join(src, 'app.ts'), 'code');
    triggerSet(src, withRules('pnpm-lock.yaml'), cache);
    expect(execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: src, encoding: 'utf8' })).toBe('?? app.ts\n?? pnpm-lock.yaml\n');
    const written = JSON.parse(readFileSync(join(cache, 'triggers.json'), 'utf8')) as { root: string; entries: Record<string, unknown> };
    expect(written.root).toBe(src);
    expect(Object.keys(written.entries)).toEqual(['pnpm-lock.yaml']);
  });

  it('re-reads a trigger whose recorded stat still matches after a same-size edit (racily clean)', () => {
    const { src, cache } = repo();
    const m = withRules('lock.txt');
    const file = join(src, 'lock.txt');
    writeFileSync(file, 'alpha-v1'); // 8 bytes
    const first = triggerHash(src, triggerSet(src, m, cache), 'lock.txt');

    // The adversarial state, constructed exactly rather than raced for:
    // different content of the SAME size, a cache stat that matches it, and
    // the hash of the old content.
    writeFileSync(file, 'alpha-v2');
    const cachePath = join(cache, 'triggers.json');
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as { writtenAt: number; entries: Record<string, { size: number; mtime: number }> };
    const live = statSync(file);
    parsed.entries['lock.txt']!.size = live.size;
    parsed.entries['lock.txt']!.mtime = live.mtimeMs;
    parsed.writtenAt = live.mtimeMs; // written no later than the file's mtime -> "racily clean"
    writeFileSync(cachePath, JSON.stringify(parsed));

    expect(triggerHash(src, triggerSet(src, m, cache), 'lock.txt')).not.toBe(first);
  });

  it('trusts the stat gate for a genuinely unchanged trigger', () => {
    const { src, cache } = repo();
    const m = withRules('lock.txt');
    writeFileSync(join(src, 'lock.txt'), 'unchanging');
    const first = triggerHash(src, triggerSet(src, m, cache), 'lock.txt');
    // Past the racy window, the recorded hash is used without reading the
    // file: plant a different hash and see it come back.
    const cachePath = join(cache, 'triggers.json');
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as { writtenAt: number; entries: Record<string, { hash: string }> };
    parsed.writtenAt += 10_000;
    parsed.entries['lock.txt']!.hash = 'planted';
    writeFileSync(cachePath, JSON.stringify(parsed));
    expect(triggerHash(src, triggerSet(src, m, cache), 'lock.txt')).not.toBe(first);
  });
});

describe('declared outputs (snapshotOutputs)', () => {
  it('changes when a matched file is rewritten, added or removed, and only then', () => {
    const { src } = repo();
    mkdirSync(join(src, 'bin', 'Debug'), { recursive: true });
    writeFileSync(join(src, 'bin', 'Debug', 'app.dll'), 'v1');
    writeFileSync(join(src, 'unrelated.txt'), 'x');
    const globs = ['bin/**'];
    const first = snapshotOutputs(src, globs);
    expect(first).toContain('bin/Debug/app.dll');
    expect(snapshotOutputs(src, globs)).toBe(first); // stable when nothing changed
    writeFileSync(join(src, 'unrelated.txt'), 'changed outside the outputs');
    expect(snapshotOutputs(src, globs)).toBe(first);
    writeFileSync(join(src, 'bin', 'Debug', 'app.dll'), 'version 2');
    const second = snapshotOutputs(src, globs);
    expect(second).not.toBe(first);
    writeFileSync(join(src, 'bin', 'Debug', 'new.dll'), 'n');
    const third = snapshotOutputs(src, globs);
    expect(third).not.toBe(second);
    rmSync(join(src, 'bin', 'Debug', 'new.dll'));
    expect(snapshotOutputs(src, globs)).toBe(second);
  });

  it('takes a literal file or a literal directory, skips what is absent, and refuses to leave the worktree', () => {
    const { src } = repo();
    mkdirSync(join(src, 'dist', 'nested'), { recursive: true });
    writeFileSync(join(src, 'dist', 'nested', 'main.js'), 'm');
    writeFileSync(join(src, 'lock.json'), '{}');
    const snap = snapshotOutputs(src, ['dist', 'lock.json', 'missing.ts', '../escape.txt']);
    expect(snap.split('\n').map((l) => l.slice(0, l.indexOf(':'))).sort()).toEqual(['dist/nested/main.js', 'lock.json']);
    expect(snapshotOutputs(src, ['missing/**'])).toBe('');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStack, type Manifest } from '../src/core/manifest.js';
import { runUpkeep } from '../src/core/upkeep.js';

const dirs: string[] = [];
function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'backlot-upkeep-timeout-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'input'), 'one');
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('per-rule upkeep deadlines and live progress', () => {
  it('validates positive seconds and keeps existing rules valid', () => {
    const dir = tree();
    for (const timeout of [undefined, 0.1, 1200]) {
      writeFileSync(join(dir, 'stack.yaml'), JSON.stringify({ name: 'timeout', services: { web: { run: 'true' } }, upkeep: [{ when: 'input', run: 'true', timeout }] }));
      expect(loadStack(dir).manifest.upkeep?.[0].timeout).toBe(timeout);
    }
    for (const timeout of [0, -1, '1200']) {
      writeFileSync(join(dir, 'stack.yaml'), JSON.stringify({ name: 'timeout', services: { web: { run: 'true' } }, upkeep: [{ when: 'input', run: 'true', timeout }] }));
      expect(() => loadStack(dir)).toThrow(/invalid/);
    }
  });

  it('kills a command at its own deadline and retries without advancing its fingerprint', async () => {
    vi.stubEnv('BACKLOT_CMD_TIMEOUT_S', '');
    const dir = tree();
    const manifest: Manifest = { name: 'timeout', upkeep: [{ when: 'input', run: 'sleep 1; echo escaped > escaped', timeout: 0.1 }] };
    const previous = {};
    await expect(runUpkeep(dir, ['input'], manifest, previous)).rejects.toThrow(/timed out after 0.1s/);
    expect(previous).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(() => readFileSync(join(dir, 'escaped'))).toThrow();
    manifest.upkeep![0].run = 'echo retried > result';
    const result = await runUpkeep(dir, ['input'], manifest, previous);
    expect(result.ran).toHaveLength(1);
    expect(readFileSync(join(dir, 'result'), 'utf8')).toBe('retried\n');
  });

  it('preserves the global override over a longer explicit deadline', async () => {
    vi.stubEnv('BACKLOT_CMD_TIMEOUT_S', '0.1');
    const manifest: Manifest = { name: 'timeout', upkeep: [{ when: 'input', run: 'sleep 2', timeout: 1200 }] };
    await expect(runUpkeep(tree(), ['input'], manifest, {})).rejects.toThrow(/timed out after 0.1s/);
  });

  it('reports start before completion and elapsed heartbeats without exposing command or output', async () => {
    vi.stubEnv('BACKLOT_CMD_TIMEOUT_S', '');
    const dir = tree();
    const manifest: Manifest = { name: 'timeout', upkeep: [{ when: 'input', run: 'echo secret-token; sleep 5.2', timeout: 15 }] };
    const progress: string[] = [];
    const pending = runUpkeep(dir, ['input'], manifest, {}, (phase) => progress.push(phase));
    expect(progress).toEqual(['upkeep rule 1: starting (timeout 15s)']);
    const result = await pending;
    const heartbeats = progress.slice(1, -1);
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    for (const phase of heartbeats) expect(phase).toMatch(/^upkeep rule 1: running \(\d+s elapsed\)$/);
    expect(progress.at(-1)).toMatch(/^upkeep rule 1: finished \(\d+s elapsed\)$/);
    expect(progress.join('\n')).not.toMatch(/secret-token|echo|sleep/);
    progress.length = 0;
    await runUpkeep(dir, ['input'], manifest, result.fingerprints, (phase) => progress.push(phase));
    expect(progress).toEqual([]);
  });

  it('drops a rule from the ledger BEFORE it runs, so a half-applied rule is never vouched for', async () => {
    vi.stubEnv('BACKLOT_CMD_TIMEOUT_S', '');
    const dir = tree();
    // Succeeds for the first trigger content, fails for the second.
    const manifest: Manifest = { name: 'commit', upkeep: [{ when: 'input', run: 'test "$(cat input)" = one' }] };
    const commits: Array<Record<string, string>> = [];
    const ok = await runUpkeep(dir, ['input'], manifest, {}, undefined, { commit: (fps) => commits.push({ ...fps }) });
    expect(commits).toEqual([{}, ok.fingerprints]);
    // The trigger moves, and the install fails half-way: the old hash must not
    // survive, or a revert to the old trigger would skip the repair.
    writeFileSync(join(dir, 'input'), 'two');
    commits.length = 0;
    await expect(runUpkeep(dir, ['input'], manifest, ok.fingerprints, undefined, { commit: (fps) => commits.push({ ...fps }) })).rejects.toThrow(/upkeep rule failed/);
    expect(commits).toEqual([{}]);
  });

  it('skips @ built-ins when asked, and reports each rule\'s outcome', async () => {
    const dir = tree();
    const manifest: Manifest = { name: 'warm', upkeep: [{ when: 'input', run: 'true' }, { when: 'input', run: '@rebake-template main' }] };
    const first = await runUpkeep(dir, ['input'], manifest, {}, undefined, { builtins: false });
    expect(first.steps.map((s) => s.status)).toEqual(['ran', 'skipped']);
    expect(first.rebakeTemplates).toEqual([]);
    const second = await runUpkeep(dir, ['input'], manifest, first.fingerprints, undefined, { builtins: false });
    expect(second.steps.map((s) => s.status)).toEqual(['fresh', 'skipped']);
  });
});

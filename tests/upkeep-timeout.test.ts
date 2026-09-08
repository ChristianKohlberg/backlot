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
    expect(progress.some((phase) => /^upkeep rule 1: running \(\d+s elapsed\)$/.test(phase))).toBe(true);
    expect(progress.at(-1)).toMatch(/finished/);
    expect(progress.join('\n')).not.toMatch(/secret-token|echo|sleep/);
    expect(progress.length).toBeLessThanOrEqual(3);
    progress.length = 0;
    await runUpkeep(dir, ['input'], manifest, result.fingerprints, (phase) => progress.push(phase));
    expect(progress).toEqual([]);
  });
});

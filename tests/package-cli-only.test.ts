import { expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

it('packs a working CLI without stale adapter outputs from an older build', async () => {
  const root = mkdtempSync(join(tmpdir(), 'backlot-pack-'));
  const repo = join(import.meta.dirname, '..');
  try {
    for (const entry of ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'scripts', 'schema', 'README.md', 'LICENSE']) {
      cpSync(join(repo, entry), join(root, entry), { recursive: true });
    }
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
    mkdirSync(join(root, 'dist', 'mcp'), { recursive: true });
    writeFileSync(join(root, 'dist', 'mcp', 'index.js'), 'throw new Error("stale adapter");\n');
    writeFileSync(join(root, 'dist', 'mcp', 'index.js.map'), '{}');
    // Keep Vitest's event loop responsive and bound each child itself;
    // prepack needs enough time to compile on a loaded CI runner.
    const packed = JSON.parse((await run('npm', ['pack', '--json'], {
      cwd: root, encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL',
    })).stdout);
    const files = packed[0].files.map((file: { path: string }) => file.path);
    expect(files.some((path: string) => path.startsWith('dist/mcp/'))).toBe(false);
    expect(files).toContain('dist/cli/index.js');
    expect(files).toContain('dist/daemon/index.js');
    await run('tar', ['-xzf', packed[0].filename], { cwd: root, timeout: 10_000, killSignal: 'SIGKILL' });
    const manifest = JSON.parse(readFileSync(join(root, 'package', 'package.json'), 'utf8'));
    expect(manifest.bin).toEqual({ runly: 'dist/cli/index.js', backlot: 'dist/cli/index.js' });
    const { stdout: help } = await run(process.execPath, [join(root, 'package', manifest.bin.backlot), '--help'], {
      encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
    });
    expect(help).toContain('runly up');
    expect(help).toContain('runly run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 150_000);

import { expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

it('packs a working CLI without stale adapter outputs from an older build', () => {
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
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json'], { cwd: root, encoding: 'utf8' }));
    const files = packed[0].files.map((file: { path: string }) => file.path);
    expect(files.some((path: string) => path.startsWith('dist/mcp/'))).toBe(false);
    expect(files).toContain('dist/cli/index.js');
    expect(files).toContain('dist/daemon/index.js');
    execFileSync('tar', ['-xzf', packed[0].filename], { cwd: root });
    const manifest = JSON.parse(readFileSync(join(root, 'package', 'package.json'), 'utf8'));
    expect(manifest.bin).toEqual({ backlot: 'dist/cli/index.js' });
    const help = execFileSync(process.execPath, [join(root, 'package', manifest.bin.backlot), '--help'], { encoding: 'utf8' });
    expect(help).toContain('backlot up');
    expect(help).toContain('backlot run');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

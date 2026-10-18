import { expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

it.each([false, true])('detects a scoped npm install (project-local: %s)', (local) => {
  const base = mkdtempSync(join(tmpdir(), 'runly-install-'));
  try {
    const root = join(base, 'node_modules', '@theford', 'runly');
    const cli = join(root, 'dist', 'cli');
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    if (local) writeFileSync(join(base, 'package.json'), '{}');
    const module = join(cli, 'install.js');
    copyFileSync(join(import.meta.dirname, '..', 'dist', 'cli', 'install.js'), module);
    const info = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { installKind } from ${JSON.stringify(pathToFileURL(module).href)}; console.log(JSON.stringify(installKind()));`,
    ], { encoding: 'utf8' }));
    expect(info.kind).toBe(local ? 'node_modules' : 'npm-global');
    expect(info.upgradeHint).toBe(local
      ? 'npm install @theford/runly@latest (this is a project-local install; update the dependency)'
      : 'npm install -g @theford/runly@latest');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

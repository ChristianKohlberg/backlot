/**
 * Where this runly came from, and therefore what command upgrades it.
 *
 * runly does not install itself. It brokers environments and refuses to own
 * what it did not create — the same rule that makes appliances "ensured, not
 * owned" (decision 0018) and services commands rather than containers
 * (decision 0012). Applied to its own binary: a self-updater that shelled out
 * to `npm i -g` would be wrong for a pnpm install, wrong for npx, and actively
 * destructive in a git checkout, where `dist/` is tsc output and the next
 * `npm run build` is the only thing that should write it.
 *
 * So this reports a command for a human to run. It is a HINT, derived from the
 * install's own path, and it is never executed.
 */
import { dirname, join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type InstallKind = 'npm-global' | 'pnpm' | 'node_modules' | 'checkout' | 'unknown';

export interface InstallInfo {
  kind: InstallKind;
  /** The package root: the directory holding package.json and dist/. */
  root: string;
  /** What a human should run to get the newest release. Never run by runly. */
  upgradeHint: string;
}

export function installKind(): InstallInfo {
  // dist/cli/install.js -> dist/cli -> dist -> <package root>
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const parts = root.split(sep);
  const inNodeModules = parts.includes('node_modules');
  if (inNodeModules) {
    // pnpm materialises packages under a `.pnpm` store and links them, so the
    // real path names it even when the link does not.
    if (parts.some((p) => p === '.pnpm')) {
      return { kind: 'pnpm', root, upgradeHint: 'pnpm add -g @theford/runly@latest' };
    }
    // A global npm root is a node_modules with no package.json ABOVE it; a
    // project-local install always has the consuming project's manifest there.
    // Scoped packages add an @scope directory beneath node_modules.
    const packageParent = dirname(root);
    const modulesRoot = packageParent.split(sep).at(-1)?.startsWith('@')
      ? dirname(packageParent) : packageParent;
    const projectManifest = join(modulesRoot, '..', 'package.json');
    if (existsSync(projectManifest)) {
      return {
        kind: 'node_modules',
        root,
        upgradeHint: 'npm install @theford/runly@latest (this is a project-local install; update the dependency)',
      };
    }
    return { kind: 'npm-global', root, upgradeHint: 'npm install -g @theford/runly@latest' };
  }
  // A checkout: dist/ is built from src/ in place, so the upgrade is a pull and
  // a rebuild. Never suggest npm here — it would install a second copy over the
  // one being developed.
  if (existsSync(join(root, 'src')) && existsSync(join(root, 'tsconfig.json'))) {
    return { kind: 'checkout', root, upgradeHint: 'git pull && npm ci && npm run build' };
  }
  return { kind: 'unknown', root, upgradeHint: 'update runly however it was installed, then run: runly update' };
}

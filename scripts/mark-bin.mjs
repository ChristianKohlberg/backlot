// tsc writes dist/ without the executable bit, and clean-dist has just removed
// the files npm marked executable at install time. A checkout install links its
// bin straight at dist/cli/index.js, so without this every rebuild leaves
// `runly` failing with "Permission denied" until someone chmods it by hand —
// including the rebuild `runly update` itself tells you to run.
import { chmodSync, readFileSync } from 'node:fs';
import { URL } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
for (const rel of new Set(Object.values(pkg.bin ?? {}))) {
  chmodSync(new URL(`../${rel}`, import.meta.url), 0o755);
}

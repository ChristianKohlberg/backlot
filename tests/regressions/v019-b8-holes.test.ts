/**
 * rv018 bug hunt — (fixed in 0.19, failed on 0.18.1) B8 (copies_only) validation holes, at unit level.
 *  (a) `--preset NAME` shorthand still counts copies_only datastores, so a
 *      stack with ONE environment datastore and a copies_only lane refuses it.
 *  (b) the load-time check scans only run/build/env of services: auth.token
 *      (and other templated fields) can still name a copies_only datastore,
 *      which an environment never has.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePresetArgs } from '../../src/core/presets.js';
import { loadStack } from '../../src/core/manifest.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const DS = `datastores:
  main: { driver: sqlite, create: 'true', template: true, presets: [dev] }
  integration: { driver: postgres, copies_only: true, url: "file:///x/{{ns}}", presets: [legacy], create: 'true', template_restore: 'true', drop: 'true' }
`;

describe('B8 copies_only holes', () => {
  it('(a) --preset NAME names the only datastore an environment has', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'v019-b8-')));
    dirs.push(d);
    writeFileSync(join(d, 'runly.yml'), `name: b8\nservices:\n  web: { run: "true" }\n${DS}`);
    const m = loadStack(d).manifest;
    expect(() => parsePresetArgs(m, ['dev'])).not.toThrow();
  });

  it('(b) an auth.token that templates a copies_only datastore is refused at load', () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'v019-b8b-')));
    dirs.push(d);
    writeFileSync(join(d, 'runly.yml'), `name: b8b\nservices:\n  web: { run: "true" }\nauth:\n  token: 'echo {{datastores.integration.url}}'\n${DS}`);
    expect(() => loadStack(d)).toThrow(/copies_only/);
  });
});

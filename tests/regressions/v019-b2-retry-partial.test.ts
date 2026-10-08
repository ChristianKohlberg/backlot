/**
 * rv018 bug hunt — (fixed in 0.19, failed on 0.18.1) B2: the new "retry the failed restore as it is" does not
 * drop what the failed attempt left behind. A transient failure in the middle
 * of a restore (the target database already created) makes the retry fail on
 * "already exists" (MSSQL RESTORE / CREATE DATABASE semantics), which then
 * costs a full rebake — and the restore after the rebake fails the same way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let state: string;
let server: string;
beforeAll(() => {
  state = realpathSync(mkdtempSync(join(tmpdir(), 'v019-b2p-state-')));
  server = realpathSync(mkdtempSync(join(tmpdir(), 'v019-b2p-srv-')));
  process.env.BACKLOT_STATE_DIR = state;
});
afterAll(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(server, { recursive: true, force: true });
});
const lines = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);

describe('B2 a transient restore failure after a partial restore', () => {
  it('is retried into a clean target, without a rebake', async () => {
    writeFileSync(join(server, 'bake.sh'), `#!/bin/sh\nmkdir -p "${server}/$1"\necho data > "${server}/$1/rows"\necho "bake $1" >> "${server}/bakes.log"\n`);
    // Like RESTORE DATABASE: refuses an existing target; the first attempt
    // anywhere creates the target and then fails (a lock wait timed out).
    writeFileSync(join(server, 'restore.sh'), `#!/bin/sh
[ -e "${server}/$2" ] && { echo "database $2 already exists" >&2; exit 1; }
mkdir "${server}/$2"
if mkdir "${server}/.failed-once" 2>/dev/null; then echo "transient: lock wait timed out" >&2; exit 1; fi
cp "${server}/$1/rows" "${server}/$2/rows"
`);
    const { makeDatastore } = await import('../../src/drivers/datastores.js');
    const ds = makeDatastore('main', {
      driver: 'postgres',
      url: `file://${server}/{{ns}}`,
      presets: ['dev'],
      create: `sh ${server}/bake.sh "{{ns}}" "{{preset}}"`,
      template_restore: `sh ${server}/restore.sh "{{template}}" "{{ns}}"`,
      drop: `rm -rf "${server}/{{ns}}"`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, 'stackP', 'kp');
    const h = { envId: 'p1', cwd: server, dataDir: server };
    const r = await ds.ensure(h, 'dev', true, false).then(() => 'ok', (e: Error) => `error: ${e.message}`);
    console.log('ensure:', r, '| bakes:', lines(join(server, 'bakes.log')).length);
    expect(r).toBe('ok');
    expect(lines(join(server, 'bakes.log')), 'a transient failure cost a rebake').toHaveLength(1);
  }, 60_000);
});

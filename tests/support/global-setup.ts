/**
 * Suite-wide setup: one private temporary directory for the whole run, and
 * a leak check at the end (decision 0037).
 *
 * TMPDIR is pointed at a fresh directory BEFORE the workers start, so every
 * mkdtemp(tmpdir()) of every test — and with it every state root, daemon and
 * service — lives under it. At teardown anything still running with a state
 * root under it was leaked by a test: it is killed, listed, and the run fails
 * (BACKLOT_LEAK_CHECK=report only reports). The count is written to
 * <dir>.leaks.json for scripts.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { killUnder, removeTestContainers } from './leaks.js';

export default function setup() {
  // Short: every state root below it must still fit a unix socket path (103
  // bytes, 104 on macOS), and macOS's own tmpdir is already ~50 of them.
  const dir = mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'rs-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  // Docker containers a test starts carry this run's id in their name
  // (runly-<kind>-test-<run>-<rand>), so the teardown can find exactly this
  // run's containers without touching a parallel run's.
  const run = basename(dir).replace(/^rs-/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  process.env.RUNLY_TEST_RUN_ID = run;
  return async () => {
    const leaked = await killUnder(dir, 5000);
    const containers = removeTestContainers(run);
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    writeFileSync(`${dir}.leaks.json`, JSON.stringify({ leaked: leaked.length + containers.length, processes: leaked, containers }, null, 2));
    if (leaked.length + containers.length === 0) rmSync(`${dir}.leaks.json`, { force: true });
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    // eslint-disable-next-line no-console
    console.log(`\nleak check: ${leaked.length} process(es), ${containers.length} container(s) left behind by the suite`);
    if (leaked.length + containers.length > 0) {
      for (const p of leaked) console.log(`  pid ${p.pid} (${p.via}): ${p.cmd.slice(0, 160)}`);
      for (const c of containers) console.log(`  container ${c} (removed)`);
      if (process.env.BACKLOT_LEAK_CHECK !== 'report') throw new Error(`${leaked.length} process(es), ${containers.length} container(s) leaked by the test suite (listed above)`);
    }
  };
}

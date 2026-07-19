/**
 * The appliance VERB family through the real CLI (`appliance ls|start|stop`).
 *
 * tests/appliances.test.ts proves the DRIVER (ensureAppliance, locks, probe
 * semantics) in-process — but the verbs that expose it were never executed
 * anywhere: engine.applianceLs/Start/Stop, the CLI's `appliance` dispatch, and
 * the ls contract (probe/up/startable/stoppable) agents branch on. A wiring
 * regression there — a renamed RPC verb, a dropped error class, the stop
 * guard vanishing — would ship invisibly with the driver tests all green.
 *
 * Regressions this catches:
 *  - `appliance ls` misreporting up/startable/stoppable (an agent would then
 *    try to start an unstartable appliance, or skip a needed start);
 *  - `appliance start` losing its started/up idempotence or its work-error
 *    classification for an undeclared name (exit-code contract, decision 0010);
 *  - `appliance stop` without a name no longer refusing (stopping every
 *    shared backing server implicitly is the exact accident the guard exists
 *    to prevent).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const dirs: string[] = [];

afterAll(async () => {
  for (const d of dirs) {
    // Stop any appliance the flow left behind (its pidfile names it).
    try {
      process.kill(Number(readFileSync(join(d, 'appl.pid'), 'utf8')));
    } catch {
      /* not started, or already stopped by the test */
    }
    // Graceful stop first (SIGTERM has a handler): a SIGKILL'd daemon loses
    // its NODE_V8_COVERAGE dump, which is how several exercised paths were
    // invisible to the coverage map this test comes from.
    try {
      const pid = Number(readFileSync(join(d, 'daemon.pid'), 'utf8'));
      process.kill(pid);
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          break; // gone
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    } catch {
      /* no daemon here */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

interface CliResult {
  code: number;
  json?: Record<string, unknown>;
  stdout: string;
}

function makeStack(port: number) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-applv-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-applv-wt-'));
  dirs.push(stateDir, wt);
  // A tiny TCP listener that daemonizes the way real appliance starts do
  // (`docker run -d` style): the start command backgrounds it and returns.
  // It records its pid so stop: can kill exactly it.
  writeFileSync(
    join(wt, 'appl.mjs'),
    `import { createServer } from 'node:net';\n` +
      `import { writeFileSync } from 'node:fs';\n` +
      `createServer(() => {}).listen(${port}, '127.0.0.1', () => writeFileSync(process.argv[2], String(process.pid)));\n`,
  );
  writeFileSync(
    join(wt, 'stack.yaml'),
    [
      'name: applv',
      'services:',
      '  web: { run: "echo ready; sleep 300", ready: { log: ready, timeout: 20 } }',
      'appliances:',
      '  fake:',
      `    probe: 127.0.0.1:${port}`,
      `    start: "node appl.mjs ${join(wt, 'appl.pid')} > /dev/null 2>&1 &"`,
      `    stop: "kill $(cat ${join(wt, 'appl.pid')})"`,
      '    timeout: 15',
    ].join('\n') + '\n',
  );
  execFileSync('git', ['init', '-q'], { cwd: wt });
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '60000' };
  const cli = (args: string[]): Promise<CliResult> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json output */
        }
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json, stdout: String(stdout) });
      });
    });
  return { cli, wt };
}

describe('the appliance verb family (ls / start / stop) through the CLI', () => {
  it('reports, starts, adopts, and stops an appliance — with the documented guards', async () => {
    const port = await freePort();
    const { cli, wt } = makeStack(port);

    // ls BEFORE anything runs: down, but startable and stoppable — this is the
    // exact contract an agent reads to decide whether `appliance start` can help.
    const before = await cli(['appliance', 'ls', '--json']);
    expect(before.code).toBe(0);
    const listed = (before.json as { appliances: Record<string, { probe: string; up: boolean; startable: boolean; stoppable: boolean }> }).appliances;
    expect(listed.fake).toEqual({ probe: `127.0.0.1:${port}`, up: false, startable: true, stoppable: true });

    // start: the one-shot start path — the appliance answers afterwards.
    const started = await cli(['appliance', 'start', '--json']);
    expect(started.code).toBe(0);
    expect((started.json as { results: Record<string, string> }).results.fake).toBe('started');
    expect(existsSync(join(wt, 'appl.pid'))).toBe(true);

    // A second start must ADOPT the running one ('up'), not start a twin —
    // ENSURE, NOT OWN (decision 0018).
    const again = await cli(['appliance', 'start', 'fake', '--json']);
    expect(again.code).toBe(0);
    expect((again.json as { results: Record<string, string> }).results.fake).toBe('up');

    const during = await cli(['appliance', 'ls', '--json']);
    expect((during.json as { appliances: Record<string, { up: boolean }> }).appliances.fake.up).toBe(true);

    // stop with NO name is a usage error (64): stopping every shared backing
    // server implicitly is exactly what the guard forbids.
    const bare = await cli(['appliance', 'stop']);
    expect(bare.code).toBe(64);

    // A name the manifest never declared is the caller's mistake: work-error, exit 1.
    const unknown = await cli(['appliance', 'start', 'nosuch', '--json']);
    expect(unknown.code).toBe(1);
    expect((unknown.json as { error: { class: string } }).error.class).toBe('work-error');

    // Explicit stop is the ONLY sanctioned stop path — and it must work.
    const stopped = await cli(['appliance', 'stop', 'fake', '--json']);
    expect(stopped.code).toBe(0);
    expect((stopped.json as { stopped: string }).stopped).toBe('fake');
    // The kill signal races the next probe by a few ms — poll briefly rather
    // than asserting on the exact instant.
    let downYet = false;
    for (let i = 0; i < 25 && !downYet; i++) {
      const after = await cli(['appliance', 'ls', '--json']);
      downYet = (after.json as { appliances: Record<string, { up: boolean }> }).appliances.fake.up === false;
      if (!downYet) await new Promise((r) => setTimeout(r, 200));
    }
    expect(downYet, 'appliance still answering its probe after an explicit stop').toBe(true);
  }, 120_000);

  it('a bind ensures the appliance before starting services', async () => {
    const port = await freePort();
    const { cli, wt } = makeStack(port);

    // No appliance is running. `up` must bring it up as part of the bind
    // (engine.bindAndStart's ensureAppliance hookup) — a regression here means
    // every service boots against a dead backing server and the failure
    // surfaces later as an unrelated work-error.
    const up = await cli(['up', '--json']);
    expect(up.code).toBe(0);
    expect((up.json as { state: string }).state).toBe('hot');
    expect(existsSync(join(wt, 'appl.pid'))).toBe(true);
    const ls = await cli(['appliance', 'ls', '--json']);
    expect((ls.json as { appliances: Record<string, { up: boolean }> }).appliances.fake.up).toBe(true);

    await cli(['release', '--json']);
    await cli(['appliance', 'stop', 'fake', '--json']);
  }, 120_000);
});

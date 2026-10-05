/**
 * Cleanup (decision 0037): drop recipes recorded on the environment row,
 * templates collected by reference with a grace, `runly pool doctor` dry
 * run vs --fix touching only what is runly's, and the automatic tether
 * (decision 0035).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneTemplates } from '../src/core/retention.js';
import { procScanSupported } from '../src/core/procscan.js';
import { autoTether, isAncestor } from '../src/cli/tether.js';
import { makeCtx, SERVER, sleep, waitFor, type Ctx } from './support/context.js';
import { disposeStateSync } from './support/leaks.js';

const ctxs: Ctx[] = [];
const dirs: string[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
  for (const d of dirs) disposeStateSync(d);
});

/** A server-shaped datastore whose namespaces are directories under `server`. */
const serverStack = (name: string, server: string) => `name: ${name}
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /, timeout: 20 }
datastores:
  main:
    driver: postgres
    url: "file://${server}/{{ns}}"
    create: 'mkdir -p "${server}/{{ns}}"'
    template: true
    template_restore: 'cp -r "${server}/{{template}}" "${server}/{{ns}}"'
    drop: 'rm -rf "${server}/{{ns}}"'
    list: 'ls -1 "${server}"'
`;

describe('drop recipes on the environment row', () => {
  it("drops an environment's server-side data with the recorded command even after its manifest is gone", async () => {
    const server = realpathSync(mkdtempSync(join(tmpdir(), 'runly-cl-server-')));
    dirs.push(server);
    const c = makeCtx({ BACKLOT_TETHER_GRACE_MS: '0' });
    ctxs.push(c);
    const wt = c.worktree({ 'runly.yml': serverStack('recipes', server), 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const env = c.journal().allEnvs()[0]!;
    expect(env.dropRecipes?.main?.cmd).toContain(env.datastoreNs.main);
    expect(existsSync(join(server, env.datastoreNs.main!))).toBe(true);
    // The manifest goes (a checkout of a branch without it) along with the worktree.
    rmSync(wt, { recursive: true, force: true });
    expect(await waitFor(() => !existsSync(join(server, env.datastoreNs.main!)) && c.journal().allEnvs().length === 0, 20_000)).toBe(true);
  }, 60_000);
});

describe('templates are collected by reference (decision 0037)', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'runly-cl-tpl-'));
    dirs.push(root);
    const dir = join(root, 'stk');
    mkdirSync(dir);
    const at = (f: string, minutesAgo: number) => {
      writeFileSync(join(dir, f), 'x');
      const t = new Date(Date.now() - minutesAgo * 60_000);
      utimesSync(join(dir, f), t, t);
    };
    return { root, dir, at };
  };

  it('keeps the newest per datastore+preset and every referenced one; the rest go after the grace', async () => {
    const { root, dir, at } = setup();
    at('main-dev@a.db', 300);   // superseded, referenced by an environment
    at('main-dev@b.db', 200);   // superseded, unreferenced, past the grace -> goes
    at('main-dev@c.db', 10);    // superseded, unreferenced, inside the grace -> stays for now
    at('main-dev@d.db', 1);     // current
    at('main-demo@e.db', 400);  // current of ANOTHER preset: stays however old
    at('audit-dev@f.db', 500);  // current of another datastore: stays
    const refs = { referenced: new Set(['stk/main-dev@a.db']), stackAlive: () => true };
    expect(await pruneTemplates({ templatesKeep: 1, templateGraceMs: 60 * 60_000 }, root, new Set(), refs)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(['audit-dev@f.db', 'main-demo@e.db', 'main-dev@a.db', 'main-dev@c.db', 'main-dev@d.db']);
    // With no grace, the inside-grace one goes too; the referenced one never does.
    expect(await pruneTemplates({ templatesKeep: 1, templateGraceMs: 0 }, root, new Set(), refs)).toBe(1);
    expect(readdirSync(dir)).toContain('main-dev@a.db');
  });

  it('a stack that can never be bound again keeps no current template', async () => {
    const { root, at } = setup();
    at('main-dev@a.db', 300);
    at('main-dev@b.db', 200);
    const refs = { referenced: new Set<string>(), stackAlive: () => false };
    expect(await pruneTemplates({ templatesKeep: 1, templateGraceMs: 60_000 }, root, new Set(), refs)).toBe(2);
    expect(existsSync(join(root, 'stk'))).toBe(false);
  });
});

describe('runly pool doctor (decision 0037)', () => {
  it("lists what runly left behind; --fix removes only runly's own, and a clean run finds nothing", async () => {
    const server = realpathSync(mkdtempSync(join(tmpdir(), 'runly-cl-doc-')));
    dirs.push(server);
    // No sweeper during the test: doctor must find these, not the GC.
    const c = makeCtx({ BACKLOT_SWEEP_MS: '600000' });
    ctxs.push(c);
    const wt = c.worktree({ 'runly.yml': serverStack('doctor', server), 'server.mjs': SERVER });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const env = c.journal().allEnvs()[0]!;
    const sid = env.stack.replace(/[^A-Za-z0-9_]/g, '_');
    const live = new Set(readdirSync(server)); // the env's namespace and its template

    // Leftovers runly owns…
    mkdirSync(join(server, `backlot_${sid}_e99_main`));
    mkdirSync(join(c.stateDir, 'envs', `${env.stack}-e99`), { recursive: true });
    mkdirSync(join(c.stateDir, 'dbs', 'main-deadbeef'), { recursive: true });
    const orphan = spawn('sleep', ['300'], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, BACKLOT_ENV_ID: `${env.stack}-e98`, BACKLOT_SERVICE: 'web', BACKLOT_STATE_ROOT: c.stateDir },
    });
    orphan.unref();
    // …and things that are not its to touch.
    mkdirSync(join(server, 'backlot_someoneelse_e1_main'));
    mkdirSync(join(server, 'customer_db'));
    await sleep(200);

    const dry = await c.cli(['pool', 'doctor', '--json'], wt);
    expect(dry.code, dry.stderr + dry.stdout).toBe(0);
    expect(dry.json.fix).toBe(false);
    expect(dry.json.clean).toBe(false);
    const kinds = (dry.json.findings as Array<{ kind: string; what: string }>).map((f) => `${f.kind}:${f.what.split('/').pop()}`).sort();
    expect(kinds).toEqual([
      'copy-dir:main-deadbeef',
      `env-dir:${env.stack}-e99`,
      'foreign-namespace:backlot_someoneelse_e1_main',
      `namespace:backlot_${sid}_e99_main`,
      // Tagged processes are found by a /proc scan: Linux only.
      ...(procScanSupported() ? [`process:pid ${orphan.pid}`] : []),
    ].sort());
    // A dry run changed nothing.
    expect(existsSync(join(server, `backlot_${sid}_e99_main`))).toBe(true);
    expect(() => process.kill(orphan.pid!, 0)).not.toThrow();
    const human = await c.cli(['pool', 'doctor'], wt);
    expect(human.stdout).toMatch(/dry run/);

    const fix = await c.cli(['pool', 'doctor', '--fix', '--json'], wt);
    expect(fix.code, fix.stderr + fix.stdout).toBe(0);
    for (const f of fix.json.findings as Array<{ kind: string; fixed?: boolean }>) {
      expect(f.fixed ?? false, f.kind).toBe(f.kind !== 'foreign-namespace');
    }
    if (procScanSupported()) {
      expect(await waitFor(() => {
        try {
          process.kill(orphan.pid!, 0);
          return false;
        } catch {
          return true;
        }
      }, 10_000)).toBe(true);
    } else {
      process.kill(orphan.pid!, 'SIGKILL');
    }
    expect(new Set(readdirSync(server))).toEqual(new Set([...live, 'backlot_someoneelse_e1_main', 'customer_db']));
    // The live environment was not touched.
    expect((await fetch(up.json.urls.web)).ok).toBe(true);

    const again = await c.cli(['pool', 'doctor', '--json'], wt);
    expect(again.json.clean).toBe(true);
  }, 60_000);
});

describe('automatic tether (decision 0035)', () => {
  it('uses CLAUDE_PID only when it is a live ancestor; BACKLOT_TETHER=off opts out', () => {
    expect(isAncestor(process.pid)).toBe(true);
    expect(isAncestor(process.ppid)).toBe(true);
    expect(autoTether({ CLAUDE_PID: String(process.ppid) })).toBe(process.ppid);
    expect(autoTether({ CLAUDE_PID: String(process.ppid), BACKLOT_TETHER: 'off' })).toBeUndefined();
    expect(autoTether({})).toBeUndefined();
    const stranger = spawn('sleep', ['30'], { stdio: 'ignore' });
    try {
      expect(autoTether({ CLAUDE_PID: String(stranger.pid) })).toBeUndefined(); // alive, but not an ancestor
    } finally {
      stranger.kill('SIGKILL');
    }
    expect(autoTether({ CLAUDE_PID: '999999999' })).toBeUndefined();
  });

  it('a lease made under a CLAUDE_PID ancestor is tethered to it', async () => {
    const c = makeCtx();
    ctxs.push(c);
    const wt = c.worktree({ 'runly.yml': `name: tether\nservices:\n  web: { run: node server.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { http: /, timeout: 20 } }\n`, 'server.mjs': SERVER });
    // The test process is an ancestor of the CLI it spawns, like the claude process is of a Bash tool call.
    const up = await c.cli(['up', '--json'], wt, { CLAUDE_PID: String(process.pid), BACKLOT_TETHER: '' });
    expect(up.code, up.stderr + up.stdout).toBe(0);
    expect(c.journal().allLeases()[0]!.holderPid).toBe(process.pid);
  }, 60_000);
});

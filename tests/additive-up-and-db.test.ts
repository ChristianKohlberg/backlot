/**
 * Decision 0034: `up` is additive and `down` stops just what it names; a
 * `--preset` reloads one datastore and restarts the services that use it; no
 * preset keeps the data; `runly db` makes database copies outside any
 * environment, reaped like environments; `runly ps` shows both; `--data-only`
 * is gone, and data-only environments from an older journal are migrated.
 * Driven through the real CLI against an isolated state dir.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from '../src/core/journal.js';
import { disposeStateSync } from './support/leaks.js';

const CLI = join(import.meta.dirname, '..', 'dist', 'cli', 'index.js');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json?: any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeContext(extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'runly-db-'));
  const env: NodeJS.ProcessEnv = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '600000', BACKLOT_TETHER_GRACE_MS: '0', ...extraEnv };
  delete env.BACKLOT_HOLDER_PID;
  const cli = (args: string[], cwd: string, more: Record<string, string> = {}): Promise<CliResult> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...more }, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout, stderr) => {
        let json: unknown;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* human output */
        }
        resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr), json });
      });
    });
  const daemonPid = (): number | undefined => {
    try {
      return Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
    } catch {
      return undefined;
    }
  };
  const stopDaemon = async (cwd: string) => {
    const pid = daemonPid();
    await cli(['daemon', 'stop', '--json'], cwd);
    for (let i = 0; i < 200 && pid; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await sleep(50);
    }
  };
  const cleanup = async (cwd: string) => {
    await cli(['pool', 'recycle', '--force', '--json'], cwd);
    await stopDaemon(cwd);
    disposeStateSync(stateDir);
  };
  const journal = () => new Journal(join(stateDir, 'journal.db'));
  return { stateDir, cli, cleanup, stopDaemon, daemonPid, journal };
}

const SERVER = `import { createServer } from 'node:http';
createServer((q, s) => s.end(String(process.pid))).listen(Number(process.env.PORT), '127.0.0.1');
`;
const SEED = `import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('DROP TABLE IF EXISTS marker; CREATE TABLE marker(value TEXT)');
db.prepare('INSERT INTO marker VALUES (?)').run(process.argv[3]);
db.close();
`;

/** Two services, each handed ITS OWN datastore — so "uses it" is readable from the manifest. */
const STACK = (name: string) => `name: ${name}
services:
  a: { run: node server.mjs, port: a, env: { PORT: "{{ports.a}}", DB: "{{datastores.main.url}}" }, ready: { http: /, timeout: 20 } }
  b: { run: node server.mjs, port: b, env: { PORT: "{{ports.b}}", DB: "{{datastores.audit.url}}" }, ready: { http: /, timeout: 20 } }
datastores:
  main: { driver: sqlite, create: 'node seed.mjs "{{ns}}" "{{preset}}"', template: true, presets: [dev, alt] }
  audit: { driver: sqlite, create: 'node seed.mjs "{{ns}}" "{{preset}}"', template: true, presets: [dev, alt] }
`;

function worktree(yaml: string, files: Record<string, string> = {}): string {
  const wt = realpathSync(mkdtempSync(join(tmpdir(), 'runly-db-wt-')));
  writeFileSync(join(wt, 'server.mjs'), SERVER);
  writeFileSync(join(wt, 'seed.mjs'), SEED);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(wt, name), content);
  writeFileSync(join(wt, 'runly.yml'), yaml);
  execFileSync('git', ['init', '-q'], { cwd: wt });
  return wt;
}

const marker = (path: string): string => {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare('SELECT value FROM marker').get() as { value: string }).value;
  } finally {
    db.close();
  }
};
const mutate = (path: string, value: string): void => {
  const db = new DatabaseSync(path);
  db.prepare('UPDATE marker SET value = ?').run(value);
  db.close();
};
const pidOf = async (url: string): Promise<string> => (await fetch(url.replace('localhost', '127.0.0.1'), { signal: AbortSignal.timeout(3000) })).text();

describe('up is additive, down stops just what it names', () => {
  const ctx = makeContext();
  const wt = worktree(STACK('additive'));
  afterAll(async () => {
    await ctx.cleanup(wt);
    rmSync(wt, { recursive: true, force: true });
  });

  it('up a, then up b, keeps a running (same pid); down b keeps a, the lease and the ports', async () => {
    const first = await ctx.cli(['up', 'a', '--json'], wt);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.json.services).toEqual({ a: 'running', b: 'down' });
    expect(Object.keys(first.json.urls)).toEqual(['a']);
    const aPid = await pidOf(first.json.urls.a);

    const second = await ctx.cli(['up', 'b', '--json'], wt);
    expect(second.code, second.stdout + second.stderr).toBe(0);
    expect(second.json.services).toEqual({ a: 'running', b: 'running' });
    expect(second.json.bindDiagnostics.reuse).toBe('reused');
    expect(second.json.bindDiagnostics.started).toEqual(['b']);
    expect(second.json.bindDiagnostics.reasons).toEqual([]);
    expect(await pidOf(second.json.urls.a)).toBe(aPid);
    expect(second.json.lease.id).toBe(first.json.lease.id);

    // A bare up adds the default set (every service) — here nothing new — and
    // still stops nothing.
    const bare = await ctx.cli(['up', '--json'], wt);
    expect(bare.json.bindDiagnostics.reuse).toBe('reused');
    expect(await pidOf(bare.json.urls.a)).toBe(aPid);

    const down = await ctx.cli(['down', 'b', '--json'], wt);
    expect(down.code, down.stdout + down.stderr).toBe(0);
    expect(down.json.stopped).toEqual(['b']);
    expect(down.json.services).toEqual({ a: 'running', b: 'down' });
    expect(down.json.lease.id).toBe(first.json.lease.id);
    expect(down.json.ports).toEqual(second.json.ports);
    expect(await pidOf(down.json.urls.a)).toBe(aPid);
    // b's public port is still HELD by the proxy (nothing else can take it),
    // but nothing is behind it: a connection is closed at once.
    const status = (await ctx.cli(['status', '--json'], wt)).json;
    const proxy = status.envs[0].proxy;
    expect(proxy.b.port).toBe(second.json.ports.b);
    expect(proxy.b.state).toBe('down');
    await expect(fetch(`http://127.0.0.1:${second.json.ports.b}/`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();

    // The lease's wish survives: a later bare `up` brings b back, a untouched.
    const back = await ctx.cli(['up', 'b', '--json'], wt);
    expect(back.json.services).toEqual({ a: 'running', b: 'running' });
    expect(await pidOf(back.json.urls.a)).toBe(aPid);

    // down with no names stops everything and keeps the lease, data and ports.
    const all = await ctx.cli(['down', '--json'], wt);
    expect(all.code, all.stdout + all.stderr).toBe(0);
    expect(all.json.services).toEqual({ a: 'down', b: 'down' });
    expect(all.json.urls).toEqual({});
    expect(all.json.state).toBe('warm');
    expect(all.json.lease.id).toBe(first.json.lease.id);
    expect(all.json.datastores.main.preset).toBe('dev');
    expect(existsSync(all.json.datastores.main.url)).toBe(true);
    // exec still works on an environment whose lease wants no services.
    const exec = await ctx.cli(['exec', 'echo ok'], wt);
    expect(exec.code, exec.stderr).toBe(0);
    // A daemon restart keeps that shape: nothing is restarted behind its back.
    await ctx.stopDaemon(wt);
    const after = await ctx.cli(['ctx', '--json'], wt);
    expect(after.json.services).toEqual({ a: 'down', b: 'down' });
  }, 120_000);

  it('refuses unknown names, and anything that is not a service', async () => {
    const bad = await ctx.cli(['down', 'main', '--json'], wt);
    expect(bad.code).toBe(1);
    expect(bad.json.error.message).toMatch(/no service 'main'/);
    const up = await ctx.cli(['up', 'nope', '--json'], wt);
    expect(up.code).toBe(1);
  }, 60_000);
});

describe('presets: one datastore reloads, the rest keep their data', () => {
  const ctx = makeContext();
  const wt = worktree(STACK('presets'));
  afterAll(async () => {
    await ctx.cleanup(wt);
    rmSync(wt, { recursive: true, force: true });
  });

  it('--preset reloads only that datastore and restarts only the services that use it', async () => {
    const first = await ctx.cli(['up', '--json'], wt);
    expect(first.code, first.stdout + first.stderr).toBe(0);
    const { main, audit } = first.json.datastores;
    expect(marker(main.url)).toBe('dev');
    expect(marker(audit.url)).toBe('dev');
    mutate(main.url, 'user-main');
    mutate(audit.url, 'user-audit');
    const aPid = await pidOf(first.json.urls.a);
    const bPid = await pidOf(first.json.urls.b);

    const reload = await ctx.cli(['up', '--preset', 'main=alt', '--json'], wt);
    expect(reload.code, reload.stdout + reload.stderr).toBe(0);
    expect(reload.json.bindDiagnostics.reasons).toEqual([]);
    expect(reload.json.bindDiagnostics.reloaded).toEqual(['main']);
    expect(reload.json.bindDiagnostics.restarted).toEqual(['a']);
    expect(marker(main.url)).toBe('alt');
    expect(marker(audit.url)).toBe('user-audit');
    expect(await pidOf(reload.json.urls.a)).not.toBe(aPid);
    expect(await pidOf(reload.json.urls.b)).toBe(bPid);
    expect(reload.json.datastores.main.preset).toBe('alt');
    expect(reload.json.datastores.audit.preset).toBe('dev');

    // The SAME preset again is still a reload: it is how one store is reset.
    mutate(main.url, 'user-main-2');
    const again = await ctx.cli(['up', '--preset', 'main=alt', '--json'], wt);
    expect(marker(main.url)).toBe('alt');
    expect(again.json.bindDiagnostics.reloaded).toEqual(['main']);

    // ctx reports what each holds, as JSON and as env lines.
    const env = await ctx.cli(['ctx', '--env'], wt);
    expect(env.stdout).toContain('export RUNLY_DATASTORE_MAIN_PRESET=alt');
    expect(env.stdout).toContain('export RUNLY_DATASTORE_AUDIT_PRESET=dev');
  }, 120_000);

  it('no preset keeps the data — on a plain up, across a release and a fresh holder, and a reset restores what each holds', async () => {
    const cur = (await ctx.cli(['ctx', '--json'], wt)).json;
    mutate(cur.datastores.main.url, 'kept');
    const plain = await ctx.cli(['up', '--json'], wt);
    expect(plain.json.bindDiagnostics.reloaded).toEqual([]);
    expect(marker(cur.datastores.main.url)).toBe('kept');
    await ctx.cli(['release', '--json'], wt);
    const fresh = await ctx.cli(['up', '--holder', 'someone-else', '--json'], wt);
    expect(fresh.code, fresh.stdout + fresh.stderr).toBe(0);
    expect(marker(cur.datastores.main.url)).toBe('kept');
    expect(fresh.json.datastores.main.preset).toBe('alt');
    // reset-data restores every store with the preset it holds — not the default.
    const reset = await ctx.cli(['reset-data', '--holder', 'someone-else', '--json'], wt);
    expect(reset.code, reset.stdout + reset.stderr).toBe(0);
    expect(marker(cur.datastores.main.url)).toBe('alt');
    expect(marker(cur.datastores.audit.url)).toBe('dev');
    // A daemon restart keeps it too.
    mutate(cur.datastores.main.url, 'kept-again');
    await ctx.stopDaemon(wt);
    const restarted = await ctx.cli(['up', '--holder', 'someone-else', '--json'], wt);
    expect(restarted.code, restarted.stdout + restarted.stderr).toBe(0);
    expect(marker(cur.datastores.main.url)).toBe('kept-again');
    expect(restarted.json.datastores.main.preset).toBe('alt');
    await ctx.cli(['release', '--holder', 'someone-else', '--json'], wt);
  }, 120_000);

  it('restarts every running service when the manifest does not say who uses the datastore', async () => {
    const wt2 = worktree(`name: opaque
services:
  a: { run: node server.mjs, port: a, env: { PORT: "{{ports.a}}" }, ready: { http: /, timeout: 20 } }
  b: { run: node server.mjs, port: b, env: { PORT: "{{ports.b}}" }, ready: { http: /, timeout: 20 } }
datastores:
  main: { driver: sqlite, create: 'node seed.mjs "{{ns}}" "{{preset}}"', template: true, presets: [dev, alt] }
`);
    try {
      const first = await ctx.cli(['up', '--json'], wt2);
      expect(first.code, first.stdout + first.stderr).toBe(0);
      const reload = await ctx.cli(['up', '--preset', 'alt', '--json'], wt2);
      expect(reload.code, reload.stdout + reload.stderr).toBe(0);
      expect(reload.json.bindDiagnostics.restarted.sort()).toEqual(['a', 'b']);
      expect(marker(reload.json.datastores.main.url)).toBe('alt');
      await ctx.cli(['release', '--json'], wt2);
      await ctx.cli(['pool', 'recycle', reload.json.envId, '--json'], wt2);
    } finally {
      rmSync(wt2, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('runly db: copies outside any environment', () => {
  const ctx = makeContext({ BACKLOT_SWEEP_MS: '300' });
  const wt = worktree(STACK('copies'));
  afterAll(async () => {
    await ctx.cleanup(wt);
    rmSync(wt, { recursive: true, force: true });
  });

  it('db new gives distinct, seeded copies with no lease, ports or services', async () => {
    const one = await ctx.cli(['db', 'new', 'main', '--json'], wt);
    const two = await ctx.cli(['db', 'new', 'main', '--preset', 'alt', '--json'], wt);
    expect(one.code, one.stdout + one.stderr).toBe(0);
    expect(two.code, two.stdout + two.stderr).toBe(0);
    expect(one.json.name).not.toBe(two.json.name);
    expect(one.json.url).not.toBe(two.json.url);
    expect(marker(one.json.url)).toBe('dev');
    expect(marker(two.json.url)).toBe('alt');
    expect(one.json.preset).toBe('dev');
    expect(two.json.preset).toBe('alt');
    expect(one.json.holder).toBe(wt);
    // No environment, no lease.
    expect((await ctx.cli(['status', '--json'], wt)).json.envs).toEqual([]);
    // Human output names exactly what a script needs.
    const human = await ctx.cli(['db', 'new', 'audit'], wt);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/^name=audit-\w+\nurl=\S+audit\.db\ndatabase=\S+audit\.db\npreset=dev\n$/);
    // Many in parallel.
    const many = await Promise.all([0, 1, 2, 3].map(() => ctx.cli(['db', 'new', 'audit', '--json'], wt)));
    expect(many.every((r) => r.code === 0)).toBe(true);
    expect(new Set(many.map((r) => r.json.name)).size).toBe(4);
    const ls = await ctx.cli(['db', 'ls', '--json'], wt);
    expect(ls.json.copies).toHaveLength(7);
    for (const c of ls.json.copies) {
      const drop = await ctx.cli(['db', 'drop', c.name, '--json'], wt);
      expect(drop.code, drop.stdout + drop.stderr).toBe(0);
      expect(existsSync(c.url)).toBe(false);
    }
    expect((await ctx.cli(['db', 'ls', '--json'], wt)).json.copies).toEqual([]);
    const unknown = await ctx.cli(['db', 'drop', 'main-nope', '--json'], wt);
    expect(unknown.code).toBe(1);
    const noStore = await ctx.cli(['db', 'new', 'nope', '--json'], wt);
    expect(noStore.code).toBe(1);
    expect(noStore.json.error.message).toMatch(/no datastore 'nope'/);
  }, 120_000);

  it('db with runs the command against a copy, drops it on exit, and passes the exit code on', async () => {
    const script = join(wt, 'probe.mjs');
    writeFileSync(script, `import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.RUNLY_DB_URL);
writeFileSync(process.argv[2], JSON.stringify({ url: process.env.RUNLY_DB_URL, name: process.env.RUNLY_DB_NAME, value: db.prepare('SELECT value FROM marker').get().value }));
db.close();
process.exit(Number(process.argv[3]));
`);
    const ok = await ctx.cli(['db', 'with', 'main', '--preset', 'alt', '--', process.execPath, script, join(wt, 'ok.json'), '0'], wt);
    expect(ok.code, ok.stderr).toBe(0);
    const seen = JSON.parse(readFileSync(join(wt, 'ok.json'), 'utf8'));
    expect(seen.value).toBe('alt');
    expect(seen.name).toMatch(/^main-/);
    expect(existsSync(seen.url)).toBe(false);
    const failing = await ctx.cli(['db', 'with', 'main', '--', process.execPath, script, join(wt, 'fail.json'), '3'], wt);
    expect(failing.code).toBe(3);
    expect(existsSync(JSON.parse(readFileSync(join(wt, 'fail.json'), 'utf8')).url)).toBe(false);
    // A single argument is a shell string, as for exec.
    const shell = await ctx.cli(['db', 'with', 'audit', '--', 'test -f "$RUNLY_DB_URL" && exit 5'], wt);
    expect(shell.code).toBe(5);
    expect((await ctx.cli(['db', 'ls', '--json'], wt)).json.copies).toEqual([]);
    const usage = await ctx.cli(['db', 'with', 'main'], wt);
    expect(usage.code).toBe(64);
  }, 120_000);

  it('reaps a copy when its holder dies, and drops a db with copy when the CLI is killed', async () => {
    const holder = spawn('sleep', ['300'], { stdio: 'ignore' });
    const held = await ctx.cli(['db', 'new', 'main', '--holder-pid', String(holder.pid), '--json'], wt);
    expect(held.code, held.stdout + held.stderr).toBe(0);
    expect(held.json.holderPid).toBe(holder.pid);
    expect(held.json.holderAlive).toBe(true);
    holder.kill('SIGKILL');
    for (let i = 0; i < 100 && existsSync(held.json.url); i++) await sleep(100);
    expect(existsSync(held.json.url)).toBe(false);
    expect((await ctx.cli(['db', 'ls', '--json'], wt)).json.copies).toEqual([]);

    // `db with` tethers the copy to its own CLI process.
    const pidFile = join(wt, 'with.pid');
    const killed = spawn(process.execPath, [CLI, 'db', 'with', 'main', '--', `echo $$ > '${pidFile}'; exec sleep 300`], { cwd: wt, env: { ...process.env, BACKLOT_STATE_DIR: ctx.stateDir }, stdio: 'ignore' });
    let copies: Array<{ name: string; url: string; holderPid: number }> = [];
    for (let i = 0; i < 100 && copies.length === 0; i++) {
      await sleep(100);
      copies = (await ctx.cli(['db', 'ls', '--json'], wt)).json.copies;
    }
    expect(copies).toHaveLength(1);
    expect(copies[0]!.holderPid).toBe(killed.pid);
    killed.kill('SIGKILL');
    for (let i = 0; i < 100 && existsSync(copies[0]!.url); i++) await sleep(100);
    expect(existsSync(copies[0]!.url)).toBe(false);
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
  }, 120_000);

  it('reaps a copy whose worktree is removed, with the drop command recorded on the row — also across a daemon restart', async () => {
    // A server-shaped datastore whose namespaces are directories, so the drop
    // is a COMMAND — and one that must still work once the worktree is gone.
    const server = realpathSync(mkdtempSync(join(tmpdir(), 'runly-db-server-')));
    const yaml = `name: removable
services:
  web: { run: "true" }
datastores:
  main:
    driver: postgres
    url: "file://${server}/{{ns}}"
    create: 'mkdir -p "${server}/{{ns}}" && echo {{preset}} > "${server}/{{ns}}/marker"'
    template_restore: 'cp -r "${server}/{{template}}" "${server}/{{ns}}"'
    drop: 'rm -rf "${server}/{{ns}}"'
`;
    const gone = worktree(yaml);
    const restart = worktree(yaml.replace('removable', 'restarted'));
    try {
      const copy = await ctx.cli(['db', 'new', 'main', '--json'], gone);
      expect(copy.code, copy.stdout + copy.stderr).toBe(0);
      const dir = join(server, copy.json.ns);
      expect(readFileSync(join(dir, 'marker'), 'utf8').trim()).toBe('default');
      const row = ctx.journal().getDbCopy(copy.json.name)!;
      expect(row.dropCmd).toContain(copy.json.ns);
      rmSync(gone, { recursive: true, force: true });
      for (let i = 0; i < 100 && existsSync(dir); i++) await sleep(100);
      expect(existsSync(dir)).toBe(false);
      expect(ctx.journal().getDbCopy(copy.json.name)).toBeUndefined();

      // Across a daemon restart: the holder dies while no daemon is looking.
      const holder = spawn('sleep', ['300'], { stdio: 'ignore' });
      const second = await ctx.cli(['db', 'new', 'main', '--holder-pid', String(holder.pid), '--json'], restart);
      expect(second.code, second.stdout + second.stderr).toBe(0);
      const dir2 = join(server, second.json.ns);
      expect(existsSync(dir2)).toBe(true);
      await ctx.stopDaemon(restart);
      holder.kill('SIGKILL');
      await sleep(200);
      expect(existsSync(dir2)).toBe(true);
      // Any verb starts the next daemon, whose recovery reaps it.
      await ctx.cli(['db', 'ls', '--json'], restart);
      for (let i = 0; i < 100 && existsSync(dir2); i++) await sleep(100);
      expect(existsSync(dir2)).toBe(false);
    } finally {
      rmSync(gone, { recursive: true, force: true });
      rmSync(restart, { recursive: true, force: true });
      rmSync(server, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('runly ps', () => {
  const ctx = makeContext();
  const wt = worktree(STACK('ps'));
  afterAll(async () => {
    await ctx.cleanup(wt);
    rmSync(wt, { recursive: true, force: true });
  });

  it('shows the worktree\'s services and database copies, as JSON and as a table', async () => {
    const up = await ctx.cli(['up', 'a', '--json'], wt);
    expect(up.code, up.stdout + up.stderr).toBe(0);
    await pidOf(up.json.urls.a); // one client byte through the proxy
    const copy = await ctx.cli(['db', 'new', 'audit', '--json'], wt);
    const ps = await ctx.cli(['ps', '--json'], wt);
    expect(ps.code, ps.stdout + ps.stderr).toBe(0);
    expect(ps.json.scope).toBe(wt);
    const byName = Object.fromEntries(ps.json.services.map((s: { service: string }) => [s.service, s]));
    expect(byName.a.state).toBe('running');
    expect(byName.a.publicPort).toBe(up.json.ports.a);
    expect(byName.a.internalPort).toBeGreaterThanOrEqual(30000);
    expect(typeof byName.a.pid).toBe('number');
    expect(typeof byName.a.lastActivityAt).toBe('number');
    expect(byName.a.idleMs).toBeGreaterThanOrEqual(0);
    expect(byName.b.state).toBe('down');
    expect(byName.b.pid).toBeNull();
    if (process.platform === 'linux') expect(byName.a.rssBytes).toBeGreaterThan(0);
    expect(ps.json.databases.map((d: { name: string }) => d.name)).toEqual([copy.json.name]);
    expect(ps.json.databases[0].datastore).toBe('audit');

    const human = await ctx.cli(['ps'], wt);
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toMatch(/ENV\s+SERVICE\s+STATE\s+PORT\s+INTERNAL\s+PID\s+IDLE\s+STOPS IN\s+RSS/);
    expect(human.stdout).toMatch(new RegExp(`\\ba\\s+running\\s+${up.json.ports.a}\\b`));
    expect(human.stdout).toMatch(/NAME\s+DATASTORE\s+PRESET\s+STATE\s+HOLDER\s+CREATED/);
    expect(human.stdout).toContain(copy.json.name);

    // Another worktree's view does not include these; --all does.
    const other = worktree(STACK('ps-other'));
    try {
      const mine = await ctx.cli(['ps', '--json'], other);
      expect(mine.json.services).toEqual([]);
      expect(mine.json.databases).toEqual([]);
      const all = await ctx.cli(['ps', '--all', '--json'], other);
      expect(all.json.scope).toBe('server');
      expect(all.json.databases.map((d: { name: string }) => d.name)).toEqual([copy.json.name]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    await ctx.cli(['db', 'drop', copy.json.name, '--json'], wt);
  }, 120_000);
});

describe('--data-only is gone', () => {
  const ctx = makeContext();
  const wt = worktree(STACK('legacy-data'));
  const other = worktree(STACK('legacy-data-free'));
  afterAll(async () => {
    await ctx.cleanup(wt);
    rmSync(wt, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it('is a usage error naming decision 0034 and runly db, answered before the daemon', async () => {
    const res = await ctx.cli(['up', '--data-only', '--json'], wt);
    expect(res.code).toBe(64);
    expect(res.stderr).toContain('decision 0034');
    expect(res.stderr).toContain('runly db new');
    expect(ctx.daemonPid()).toBeUndefined();
  }, 60_000);

});

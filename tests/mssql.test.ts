/**
 * The command-datastore family against a REAL MSSQL (docker-gated; the suite
 * skips cleanly when docker — or the 2.3 GB SQL Server image — is absent, so
 * CI runners never pay the pull). Proves the same loop postgres.test.ts
 * proves, with MSSQL's native clone pair: template bake, `BACKUP DATABASE` +
 * `RESTORE ... WITH MOVE` restore, reset-data, ns drop on recycle — all
 * through the real CLI, all mechanics repo-declared commands.
 *
 * This is the "mssql template_restore needs a real consumer" backlog item:
 * the command pair below is exactly what Revamp's stack.yaml would declare to
 * stop re-seeding (~30-50 s) on every bind.
 *
 * The image is amd64-only; on Apple Silicon it runs under Rosetta emulation,
 * so timeouts here are deliberately generous.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

const IMAGE = 'mcr.microsoft.com/mssql/server:2022-latest';
const PASS = 'Backlot_Test_Pass123'; // throwaway, container-local — not a secret

// Gate on docker AND a locally-present image: unlike postgres:16-alpine, the
// SQL Server image is a 2.3 GB amd64-only pull — CI should skip, not download.
const hasMssql = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 });
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

const CONTAINER = `backlot-mssql-test-${Math.random().toString(36).slice(2, 8)}`;
const SQLCMD = `/opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P ${PASS} -C -b`;
// All mechanics go through docker exec — the url is handed to services but
// never dialed by backlot itself (zero embedded DB clients).
const sql = (q: string, db?: string) =>
  execFileSync(
    'sh',
    ['-c', `docker exec ${CONTAINER} ${SQLCMD}${db ? ` -d ${db}` : ''} -h -1 -Q "SET NOCOUNT ON; ${q}"`],
    { encoding: 'utf8', timeout: 60_000 },
  );
const count = (db: string) => sql('SELECT COUNT(*) FROM items', db).replace(/\s/g, '');

const T = 240_000; // per-test budget: MSSQL under amd64 emulation is slow

describe.skipIf(!hasMssql)('mssql datastore (docker-gated)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-mssql-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-mssql-wt-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };
  const cli = (args: string[]): Promise<{ exitCode: number; json?: Record<string, unknown>; out: string; stdout?: string; stderr?: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json, out: String(stdout), stdout: String(stdout), stderr: String(stderr) });
      });
    });

  beforeAll(async () => {
    execFileSync(
      'docker',
      ['run', '-d', '--rm', '--name', CONTAINER, '--platform', 'linux/amd64',
        '-e', 'ACCEPT_EULA=Y', '-e', `MSSQL_SA_PASSWORD=${PASS}`, '-e', 'MSSQL_PID=Developer', IMAGE],
      { stdio: 'ignore', timeout: 120_000 },
    );
    let up = false;
    for (let i = 0; i < 180; i++) {
      try {
        sql('SELECT 1');
        up = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!up) throw new Error(`${IMAGE} in ${CONTAINER} never answered sqlcmd`);
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: hello-mssql
services:
  app:
    run: node -e 'console.log("app up");setInterval(()=>{},1e9)'
    ready: { log: "app up" }
datastores:
  main:
    driver: mssql
    url: "Server=localhost,1433;Database={{ns}};User Id=sa;Password=${PASS};TrustServerCertificate=True"
    create: docker exec ${CONTAINER} ${SQLCMD} -Q "CREATE DATABASE [{{ns}}]" && docker exec ${CONTAINER} ${SQLCMD} -d {{ns}} -Q "CREATE TABLE items(id int identity primary key, name nvarchar(100)); INSERT INTO items(name) VALUES ('alpha'),('beta'),('gamma')"
    drop: docker exec ${CONTAINER} ${SQLCMD} -Q "IF DB_ID('{{ns}}') IS NOT NULL BEGIN ALTER DATABASE [{{ns}}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [{{ns}}]; END"
    template_restore: docker exec ${CONTAINER} ${SQLCMD} -Q "BACKUP DATABASE [{{template}}] TO DISK='/var/opt/mssql/data/{{template}}.bak' WITH INIT" && docker exec ${CONTAINER} ${SQLCMD} -Q "RESTORE DATABASE [{{ns}}] FROM DISK='/var/opt/mssql/data/{{template}}.bak' WITH MOVE '{{template}}' TO '/var/opt/mssql/data/{{ns}}.mdf', MOVE '{{template}}_log' TO '/var/opt/mssql/data/{{ns}}_log.ldf'"
    presets: [dev]
checks:
  rows:
    run: docker exec ${CONTAINER} ${SQLCMD} -d {{datastores.main.ns}} -h -1 -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM items" | tr -d '[:space:]' | grep -qx 3
`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
  }, 420_000);

  afterAll(async () => {
    try {
      const pid = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
      process.kill(pid);
    } catch {
      /* gone */
    }
    try {
      execFileSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  }, 60_000);

  let ns = '';

  it('up seeds a real mssql db via template bake + BACKUP/RESTORE clone', async () => {
    const res = await cli(['up', '--json']);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    const ds = (res.json!.datastores as Record<string, { url: string; ns: string }>).main;
    ns = ds.ns;
    expect(ns).toMatch(/^backlot_/);
    expect(ds.url).toContain(`Database=${ns};`);
    expect(count(ns)).toBe('3');
    // The template was baked once, machine-global, immutable-keyed.
    const stackTplDir = readdirSync(join(stateDir, 'templates'))[0]!;
    expect(readdirSync(join(stateDir, 'templates', stackTplDir)).some((f) => f.endsWith('.baked'))).toBe(true);
  }, T);

  it('reset-data restores from the template — mutation gone, same ns', async () => {
    sql(`INSERT INTO items(name) VALUES ('mutation')`, ns);
    expect(count(ns)).toBe('4');
    const res = await cli(['reset-data', '--json']);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    expect(count(ns)).toBe('3');
  }, T);

  it('the check templates {{datastores.main.ns}} and passes against live data', async () => {
    const res = await cli(['run', 'rows', '--json']);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    expect(res.json!.ok).toBe(true);
  }, T);

  it('recycle drops the server-side namespace', async () => {
    await cli(['release']);
    const res = await cli(['pool', 'recycle', '--json']);
    expect((res.json!.recycled as string[]).length).toBeGreaterThan(0);
    const list = sql('SELECT name FROM sys.databases');
    expect(list).not.toContain(ns);
  }, T);
});

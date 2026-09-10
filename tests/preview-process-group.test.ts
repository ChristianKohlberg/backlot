import { afterAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CLI = join(import.meta.dirname, '../dist/cli/index.js');
const URL = 'https://wrapper-preview-test.trycloudflare.com';
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups) await cleanup(); });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function waitFor(test: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await sleep(50);
  }
  throw new Error(message);
}

function fixture(quiesce = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-preview-group-')));
  const tree = join(root, 'tree');
  const state = join(root, 'state');
  mkdirSync(tree);
  mkdirSync(state);
  execFileSync('git', ['init', '-q'], { cwd: tree });
  writeFileSync(join(tree, 'backlot.yml'), `name: previewgroup
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: '{{ports.web}}' }
    ready: { http: /, timeout: 10 }
`);
  writeFileSync(join(tree, 'server.mjs'), "import{createServer}from'node:http';createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');\n");
  const child = join(root, 'child.mjs');
  writeFileSync(child, `import{writeFileSync}from'node:fs';writeFileSync(process.env.TEST_PREVIEW_CHILD_PID,String(process.pid));console.error('${URL}');setInterval(()=>{},1000);\n`);
  const launcher = join(root, 'launcher.mjs');
  writeFileSync(launcher, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
writeFileSync(process.env.TEST_PREVIEW_LEADER_PID,String(process.pid));
const child=spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'inherit'});
// Stay alive until the child is reaped, including group-wide teardown. This
// avoids leaving an orphan zombie on hosts whose PID 1 does not reap children.
process.on('SIGTERM',()=>{});child.on('exit',()=>process.exit(0));
`);
  const bin = join(root, 'cloudflared');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${launcher.replaceAll("'", "'\\''")}' "$@"\n`);
  chmodSync(bin, 0o755);
  const env = { ...process.env, BACKLOT_STATE_DIR: state, BACKLOT_CLOUDFLARED: bin,
    BACKLOT_SWEEP_MS: quiesce ? '100' : '60000', BACKLOT_LEASED_IDLE_TTL_MS: quiesce ? '1500' : '3600000',
    TEST_PREVIEW_LEADER_PID: join(root, 'leader.pid'), TEST_PREVIEW_CHILD_PID: join(root, 'child.pid') };
  const cli = (...args: string[]) => new Promise<{ code: number; data: Record<string, unknown>; output: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args, '--json'], { cwd: tree, env, timeout: 20_000 }, (error, stdout, stderr) => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(stdout); } catch { /* error text is retained */ }
      resolve({ code: error ? Number(error.code ?? 1) : 0, data, output: stdout + stderr });
    });
  });
  const pids = () => ['leader', 'child'].map((name) => Number(readFileSync(join(root, `${name}.pid`), 'utf8')));
  const bothAlive = () => pids().every(alive);
  const start = async () => {
    const up = await cli('up', '--holder', 'a');
    expect(up.code, up.output).toBe(0);
    const preview = await cli('preview', 'web', '--holder', 'a');
    expect(preview.code, preview.output).toBe(0);
    expect(preview.data.url).toBe(URL);
    await waitFor(() => existsSync(join(root, 'child.pid')), 'preview child did not start');
    expect(bothAlive()).toBe(true);
    return String(up.data.envId);
  };
  const release = async () => {
    const result = await cli('release', '--holder', 'a');
    expect(result.code, result.output).toBe(0);
    await waitFor(() => pids().every((pid) => !alive(pid)), 'lease release left a preview group member alive');
  };
  cleanups.push(async () => {
    await cli('release', '--holder', 'a');
    const recycled = await cli('pool', 'recycle', '--force');
    const stopped = await cli('daemon', 'stop');
    expect(recycled.code, recycled.output).toBe(0);
    expect(stopped.code, stopped.output).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
  return { tree, state, cli, pids, bothAlive, start, release };
}

describe('leased preview process groups', () => {
  it('preserves a wrapper and child across dirty sync, then releases the whole group', async () => {
    const f = fixture();
    await f.start();
    writeFileSync(join(f.tree, 'change.txt'), 'force service restart');
    const sync = await f.cli('sync', '--holder', 'a');
    expect(sync.code, sync.output).toBe(0);
    expect(f.bothAlive()).toBe(true);
    expect(sync.data.previewUrls).toEqual({ web: URL });
    await f.release();
  });

  it('preserves the same group during quiesce, GC, and doctor', async () => {
    const f = fixture(true);
    await f.start();
    await waitFor(async () => JSON.stringify((await f.cli('pool', 'ls')).data).includes('"warm"'), 'application did not quiesce');
    expect(f.bothAlive()).toBe(true);
    const gc = await f.cli('pool', 'gc');
    expect(gc.code, gc.output).toBe(0);
    expect(gc.data.supported).toBe(process.platform === 'linux');
    expect(f.bothAlive()).toBe(true);
    const doctor = await f.cli('doctor');
    const issues = doctor.data.issues as Array<{ issue: string }>;
    for (const pid of f.pids()) expect(issues.some((i) => i.issue.includes(`orphaned process ${pid} `))).toBe(false);
    await f.release();
  });

  // Orphan scanning reads /proc environments. macOS exercises the shared-group
  // survival/teardown above, but has no tag scan with which to test this case.
  it.skipIf(process.platform !== 'linux')('reclaims another tagged group even with the same preview service label', async () => {
    const f = fixture(true);
    const envId = await f.start();
    await waitFor(async () => JSON.stringify((await f.cli('pool', 'ls')).data).includes('"warm"'), 'application did not quiesce');
    const stray = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, BACKLOT_ENV_ID: envId, BACKLOT_STATE_ROOT: f.state, BACKLOT_SERVICE: 'preview:web' },
    });
    await new Promise<void>((resolve, reject) => { stray.once('spawn', resolve); stray.once('error', reject); });
    try {
      const gc = await f.cli('pool', 'gc');
      expect(gc.code, gc.output).toBe(0);
      await waitFor(() => stray.exitCode !== null || stray.signalCode !== null, 'unowned tagged group was protected by its label');
      expect(f.bothAlive()).toBe(true);
      await f.release();
    } finally {
      if (stray.exitCode === null && stray.signalCode === null && stray.pid) process.kill(-stray.pid, 'SIGKILL');
    }
  });

  it.skipIf(process.platform !== 'linux')('does not exempt tagged processes using a stale preview identity', async () => {
    const f = fixture();
    const envId = await f.start();
    const db = new DatabaseSync(join(f.state, 'journal.db'));
    // Simulate the persisted state after leader PID reuse: the live group's
    // start time no longer matches the lease's recorded identity.
    db.prepare('UPDATE leases SET preview_start = preview_start + 1 WHERE env_id = ?').run(envId);
    db.prepare("UPDATE envs SET state = 'warm' WHERE id = ?").run(envId);
    db.close();
    const gc = await f.cli('pool', 'gc');
    expect(gc.code, gc.output).toBe(0);
    await waitFor(() => f.pids().every((pid) => !alive(pid)), 'stale preview ownership protected a tagged group');
  });
});

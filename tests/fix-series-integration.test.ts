import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CLI = join(import.meta.dirname, '../dist/cli/index.js');
const publicUrl = 'https://integration-preview.trycloudflare.com';
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-series-')));
  const tree = join(root, 'tree'); const alias = join(root, 'alias'); const state = join(root, 'state');
  mkdirSync(tree); symlinkSync(tree, alias, 'dir');
  const manifest = {
    name: 'fix-series',
    services: { web: { run: 'node server.mjs', port: 'web', hot_reload: true, env: { PORT: '{{ports.web}}' }, ready: { http: '/', timeout: 10 } } },
    datastores: { main: { driver: 'sqlite', create: 'node seed.mjs "{{ns}}" "{{preset}}"', template: true, presets: ['dev', 'alternate'] } },
    preview: { forbidden: false },
  };
  const save = () => writeFileSync(join(tree, 'stack.yaml'), JSON.stringify(manifest)); save();
  writeFileSync(join(tree, 'server.mjs'), "import{createServer}from'node:http';createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');\n");
  writeFileSync(join(tree, 'seed.mjs'), "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[2]);d.exec('CREATE TABLE marker(value TEXT)');d.prepare('INSERT INTO marker VALUES (?)').run(process.argv[3]);d.close();\n");
  const child = join(root, 'child.mjs'); const launcher = join(root, 'launcher.mjs'); const bin = join(root, 'cloudflared');
  writeFileSync(child, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(root,'child.pid'))},String(process.pid));console.error('${publicUrl}');setInterval(()=>{},1000);\n`);
  writeFileSync(launcher, `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(join(root,'leader.pid'))},String(process.pid));const c=spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'inherit'});process.on('SIGTERM',()=>{});c.on('exit',()=>process.exit(0));\n`);
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(launcher)} "$@"\n`); chmodSync(bin, 0o755);
  const env = { ...process.env, BACKLOT_STATE_DIR: state, BACKLOT_CLOUDFLARED: bin, BACKLOT_SWEEP_MS: '60000' };
  const cli = (args: string[], cwd = tree) => new Promise<{ code: number; data: any; output: string }>(resolve => {
    execFile(process.execPath, [CLI, ...args, '--json'], { cwd, env, timeout: 25000 }, (error, stdout, stderr) => {
      let data; try { data = JSON.parse(stdout); } catch { data = null; }
      resolve({ code: error ? Number(error.code ?? 1) : 0, data, output: stdout + stderr });
    });
  });
  const pids = () => ['leader', 'child'].map(name => Number(readFileSync(join(root, `${name}.pid`), 'utf8')));
  const value = (ctx: any) => { const db = new DatabaseSync(ctx.datastores.main.url); try { return db.prepare('SELECT value FROM marker').get()!.value; } finally { db.close(); } };
  const cleanup = async () => {
    try {
      await cli(['release']);
      const recycled = await cli(['pool', 'recycle', '--force']); expect(recycled.code, recycled.output).toBe(0);
      const stopped = await cli(['daemon', 'stop']); expect(stopped.code, stopped.output).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  return { root, tree, alias, state, manifest, save, cli, pids, value, cleanup };
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function stopped(pids: number[]) {
  const end = Date.now() + 10000;
  while (pids.some(alive) && Date.now() < end) await new Promise(r => setTimeout(r, 50));
  expect(pids.map(alive)).toEqual(pids.map(() => false));
}

it('composes canonical ownership, selected preset, preview group and preserved deadline across content operations', async () => {
  const f = fixture();
  try {
    const first = await f.cli(['up', '--ttl', '480m', '--preset', 'alternate']); expect(first.code, first.output).toBe(0);
    const check = (r: Awaited<ReturnType<typeof f.cli>>) => {
      expect(r.code, r.output).toBe(0); expect(r.data.envId).toBe(first.data.envId);
      expect(r.data.lease.id).toBe(first.data.lease.id); expect(r.data.lease.expiresAt).toBe(first.data.lease.expiresAt);
      expect(r.data.datastores.main.preset).toBe('alternate'); expect(f.value(r.data)).toBe('alternate');
    };
    check(await f.cli(['ctx'], f.alias));
    const published = await f.cli(['preview', 'web'], f.alias); expect(published.code, published.output).toBe(0);
    const members = f.pids(); expect(members.every(alive)).toBe(true);
    writeFileSync(join(f.tree, 'edit.txt'), 'projection');
    const projected = await f.cli(['sync'], f.alias); check(projected); expect(projected.data.bindDiagnostics.reuse).toBe('projected');
    expect(members.every(alive)).toBe(true); expect(projected.data.previewUrls.web).toBe(publicUrl);
    f.manifest.services.web.hot_reload = false; f.save();
    const full = await f.cli(['sync'], f.alias); check(full); expect(full.data.bindDiagnostics.reuse).not.toBe('projected');
    expect(members.every(alive)).toBe(true);
    check(await f.cli(['reset-data'], f.alias)); expect(members.every(alive)).toBe(true);
    const stop = await f.cli(['daemon', 'stop']); expect(stop.code, stop.output).toBe(0); await stopped(members);
    check(await f.cli(['reset-data'], f.alias));
    const db = new DatabaseSync(join(f.state, 'journal.db'), { readOnly: true });
    try {
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
      expect(db.prepare('PRAGMA table_info(envs)').all().map(r => r.name)).toContain('legacy_stack_root');
      const lease = db.prepare('SELECT presets FROM leases WHERE id=?').get(first.data.lease.id)!;
      expect(JSON.parse(String(lease.presets))).toEqual({ main: 'alternate' });
    } finally { db.close(); }
  } finally { await f.cleanup(); }
}, 60000);

it('enforces current forbidden preview policy through a canonical alias before rejecting invalid presets', async () => {
  const f = fixture();
  try {
    const up = await f.cli(['up', '--preset', 'alternate'], f.alias); expect(up.code, up.output).toBe(0);
    const pub = await f.cli(['preview', 'web']); expect(pub.code, pub.output).toBe(0);
    const members = f.pids(); expect(members.every(alive)).toBe(true);
    f.manifest.preview.forbidden = true; f.save();
    const invalid = await f.cli(['up', '--preset', 'missing'], f.alias);
    expect(invalid.code, invalid.output).toBe(1); expect(invalid.data.error.class).toBe('work-error');
    await stopped(members);
    const ctx = await f.cli(['ctx']); expect(ctx.code, ctx.output).toBe(0); expect(ctx.data.envId).toBe(up.data.envId);
    expect(ctx.data.previewUrls?.web).toBeUndefined(); expect(f.value(ctx.data)).toBe('alternate');
  } finally { await f.cleanup(); }
}, 60000);

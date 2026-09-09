import { afterAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '../dist/cli/index.js');
interface Result { code: number; data: any; stdout: string; stderr: string }
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups) await cleanup(); });

function fixture(total: number, perStack: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-convert-')));
  const state = join(root, 'state');
  const gate = join(root, 'gate');
  mkdirSync(gate);
  const env = { ...process.env, BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX: String(perStack),
    BACKLOT_POOL_MAX_TOTAL: String(total), BACKLOT_POOL_MAX_DATA_ONLY: '4',
    BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '1000', BACKLOT_TEST_GATE_DIR: gate };
  const cli = (cwd: string, ...args: string[]) => new Promise<Result>((resolve) => {
    execFile(process.execPath, [CLI, ...args, '--json'], { cwd, env, timeout: 20_000 }, (error, stdout, stderr) => {
      let data: unknown;
      try { data = JSON.parse(stdout); } catch { data = null; }
      resolve({ code: error ? Number(error.code ?? 1) : 0, data, stdout, stderr });
    });
  });
  const stack = (name: string) => {
    const tree = join(root, name);
    mkdirSync(tree);
    execFileSync('git', ['init', '-q'], { cwd: tree });
    writeFileSync(join(tree, 'server.mjs'), "import{createServer}from'node:http';createServer((q,s)=>s.end('alive')).listen(Number(process.env.PORT),'127.0.0.1');\n");
    writeFileSync(join(tree, 'seed.mjs'), "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[2]);d.exec('CREATE TABLE IF NOT EXISTS t(x)');d.close();\n");
    writeFileSync(join(tree, 'barrier.mjs'), "import{writeFileSync,existsSync}from'node:fs';import{join}from'node:path';const d=process.env.BACKLOT_TEST_GATE_DIR;writeFileSync(join(d,'entered'),'');const t=setInterval(()=>{if(existsSync(join(d,'release'))){clearInterval(t);process.exit(23)}},20);\n");
    writeFileSync(join(tree, 'backlot.yml'), `name: ${name}
services:
  web:
    run: node server.mjs
    port: web
    env: { PORT: '{{ports.web}}' }
    ready: { http: /, timeout: 10 }
datastores:
  main:
    driver: sqlite
    create: node seed.mjs {{ns}}
`);
    return tree;
  };
  cleanups.push(async () => {
    writeFileSync(join(gate, 'release'), '');
    const recycled = await cli(root, 'pool', 'recycle', '--force');
    const stopped = await cli(root, 'daemon', 'stop');
    expect(recycled.code, recycled.stdout + recycled.stderr).toBe(0);
    expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
  const alive = async (context: any) => {
    const r = await fetch(context.urls.web.replace('localhost', '127.0.0.1'), { signal: AbortSignal.timeout(2000) });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('alive');
  };
  const waitEntered = async () => {
    for (let i = 0; i < 250; i++) {
      if (existsSync(join(gate, 'entered'))) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('upkeep barrier was not entered');
  };
  return { root, gate, cli, stack, alive, waitEntered };
}

describe('application capacity survives an unfinished data-only conversion', () => {
  it('keeps the per-stack charge after early upkeep failure and permits returning to the app', async () => {
    const f = fixture(2, 1);
    const tree = f.stack('app');
    const original = readFileSync(join(tree, 'backlot.yml'), 'utf8');
    const first = await f.cli(tree, 'up', '--holder', 'a');
    expect(first.code, first.stdout + first.stderr).toBe(0);
    writeFileSync(join(tree, 'backlot.yml'), original + 'upkeep:\n  - { when: backlot.yml, run: "false" }\n');
    const failed = await f.cli(tree, 'up', '--holder', 'a', '--data-only');
    expect(failed.code, failed.stdout + failed.stderr).toBe(1);
    await f.alive(first.data);
    writeFileSync(join(tree, 'backlot.yml'), original);
    const competing = await f.cli(tree, 'up', '--holder', 'b');
    expect(competing.code, competing.stdout + competing.stderr).toBe(2);
    await f.alive(first.data);
    // This environment already holds the application slot. Returning to its
    // prior shape must not try to allocate a second slot and refuse itself.
    const restored = await f.cli(tree, 'up', '--holder', 'a');
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
    expect(restored.data.envId).toBe(first.data.envId);
    expect(restored.data.dataOnly).toBe(false);
    await f.alive(restored.data);
  });

  it('keeps the machine charge during preparation and releases it only after services stop', async () => {
    const f = fixture(1, 2);
    const tree = f.stack('app');
    const other = f.stack('other');
    const original = readFileSync(join(tree, 'backlot.yml'), 'utf8');
    const first = await f.cli(tree, 'up', '--holder', 'a');
    expect(first.code, first.stdout + first.stderr).toBe(0);
    writeFileSync(join(tree, 'backlot.yml'), original + 'upkeep:\n  - { when: backlot.yml, run: node barrier.mjs }\n');
    const converting = f.cli(tree, 'up', '--holder', 'a', '--data-only');
    let failed: Result;
    try {
      await f.waitEntered();
      await f.alive(first.data);
      const competing = await f.cli(other, 'up', '--holder', 'b');
      expect(competing.code, competing.stdout + competing.stderr).toBe(2);
      await f.alive(first.data);
    } finally {
      writeFileSync(join(f.gate, 'release'), '');
      failed = await converting;
    }
    expect(failed.code, failed.stdout + failed.stderr).toBe(1);
    writeFileSync(join(tree, 'backlot.yml'), original);
    const completed = await f.cli(tree, 'up', '--holder', 'a', '--data-only');
    expect(completed.code, completed.stdout + completed.stderr).toBe(0);
    expect(completed.data.state).toBe('warm');
    expect(completed.data.urls).toEqual({});
    const next = await f.cli(other, 'up', '--holder', 'b');
    expect(next.code, next.stdout + next.stderr).toBe(0);
    await f.alive(next.data);
  });

  it('does not change the shape while an initial application bind can still start services', async () => {
    const f = fixture(1, 2);
    const tree = f.stack('app');
    const original = readFileSync(join(tree, 'backlot.yml'), 'utf8');
    // This barrier completes successfully, so the original bind must retain
    // its application reservation even while still warm and without pids.
    const barrier = join(tree, 'barrier.mjs');
    writeFileSync(barrier, readFileSync(barrier, 'utf8').replace('process.exit(23)', 'process.exit(0)'));
    writeFileSync(join(tree, 'backlot.yml'), original + 'upkeep:\n  - { when: backlot.yml, run: node barrier.mjs }\n');
    const starting = f.cli(tree, 'up', '--holder', 'a');
    let converting: Promise<Result> | undefined;
    try {
      await f.waitEntered();
      converting = f.cli(tree, 'up', '--holder', 'a', '--data-only');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const refused = await Promise.race([
        converting,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('shape change claimed an environment still busy starting the app')), 5000); }),
      ]).finally(() => clearTimeout(timeout));
      expect(refused.code, refused.stdout + refused.stderr).toBe(2);
    } finally {
      writeFileSync(join(f.gate, 'release'), '');
      const started = await starting;
      if (converting) await converting;
      expect(started.code, started.stdout + started.stderr).toBe(0);
    }
    const other = f.stack('other');
    const competing = await f.cli(other, 'up', '--holder', 'b');
    expect(competing.code, competing.stdout + competing.stderr).toBe(2);
  });

});

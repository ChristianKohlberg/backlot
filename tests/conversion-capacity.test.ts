import { afterAll, describe, expect, it, vi } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal, type EnvRow } from '../src/core/journal.js';
import type { ServicePid } from '../src/core/types.js';
import { Engine } from '../dist/daemon/engine.js';
import { killGroupVerified, reapPids } from '../dist/daemon/supervisor.js';
import { groupAlive, isAlive, procScanSupported, processGroup, scanTagged, serviceTag, startTime } from '../src/core/procscan.js';

const CLI = join(import.meta.dirname, '../dist/cli/index.js');
interface Result { code: number; data: any; stdout: string; stderr: string }
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups) await cleanup(); });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture(total: number, perStack: number, opts: { dataOnlyMax?: number; idleTtlMs?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-convert-')));
  const state = join(root, 'state');
  const gate = join(root, 'gate');
  mkdirSync(gate);
  const env = { ...process.env, BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX: String(perStack),
    BACKLOT_POOL_MAX_TOTAL: String(total), BACKLOT_POOL_MAX_DATA_ONLY: String(opts.dataOnlyMax ?? 4),
    BACKLOT_IDLE_TTL_MS: String(opts.idleTtlMs ?? 30 * 60_000),
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
  const journal = () => new Journal(join(state, 'journal.db'));
  const events = (): Array<{ kind: string; envId?: string }> => {
    const p = join(state, 'events.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { kind: string; envId?: string });
  };
  return { root, gate, cli, stack, alive, waitEntered, journal, events };
}

/** The same manifest the CLI fixtures use, for a test that drives the engine in-process. */
function inProcessStack(root: string, name: string) {
  const tree = join(root, name);
  mkdirSync(tree);
  execFileSync('git', ['init', '-q'], { cwd: tree });
  writeFileSync(join(tree, 'server.mjs'), "import{createServer}from'node:http';createServer((q,s)=>s.end('alive')).listen(Number(process.env.PORT),'127.0.0.1');\n");
  writeFileSync(join(tree, 'seed.mjs'), "import{DatabaseSync}from'node:sqlite';const d=new DatabaseSync(process.argv[2]);d.exec('CREATE TABLE IF NOT EXISTS t(x)');d.close();\n");
  writeFileSync(join(tree, 'barrier.mjs'), "import{writeFileSync,existsSync}from'node:fs';import{join}from'node:path';const d=process.env.BACKLOT_TEST_GATE_DIR;writeFileSync(join(d,'entered'),'');const t=setInterval(()=>{if(existsSync(join(d,'release'))){clearInterval(t);process.exit(0)}},20);\n");
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
}

describe('application capacity survives an unfinished data-only conversion', () => {
  it.each(['before GC', 'during discovery'] as const)('retains the original survivor group when its nonleader moves %s', async (moveAt) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-gc-moved-survivor-')));
    const state = join(root, 'state');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX: '1', BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_POOL_MAX_DATA_ONLY: '4', BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100',
    });
    let blocked: number | undefined;
    const engine = new Engine(async (...args: Parameters<typeof killGroupVerified>) => {
      if (args[0] === blocked) {
        if (moveAt === 'before GC') return false;
        writeFileSync(join(root, 'move'), '');
        await waitFor(() => existsSync(join(root, 'moved')));
      }
      return killGroupVerified(...args);
    });
    let leader: ServicePid | undefined;
    let moved: ServicePid | undefined;
    let leaderExit: Promise<unknown[]> | undefined;
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 250; i++) {
        if (predicate()) return;
        await sleep(20);
      }
      throw new Error('moving service did not reach the expected process state');
    };
    try {
      const tree = inProcessStack(root, 'app');
      const other = inProcessStack(root, 'other');
      const first = await engine.up({ cwd: tree, holder: 'a', dataOnly: true });
      const launcher = join(root, 'launcher.mjs');
      writeFileSync(launcher, `import {spawn} from 'node:child_process';
const tagged=spawn('python3',[process.argv[2],process.argv[3]],{stdio:'ignore',env:{...process.env,...JSON.parse(process.argv[4])}});
const untagged=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
let remaining=2;
for(const child of [tagged,untagged])child.on('exit',()=>{if(--remaining===0)process.exit(0)});
process.on('SIGTERM',()=>{});
console.log(JSON.stringify({tagged:tagged.pid,untagged:untagged.pid}));
`);
      const proc = spawn(process.execPath, [launcher, join(import.meta.dirname, 'fixtures/moving-service.py'), root,
        JSON.stringify(serviceTag(first.envId, 'web', state))], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      leader = { pid: proc.pid!, startTime: startTime(proc.pid!) };
      leaderExit = once(proc, 'exit');
      const lines = createInterface({ input: proc.stdout! });
      const [line] = await once(lines, 'line');
      lines.close();
      const members = JSON.parse(line) as { tagged: number; untagged: number };
      await waitFor(() => existsSync(join(root, 'ready')));
      moved = { pid: members.tagged, startTime: startTime(members.tagged), pgid: leader.pid };
      expect(moved.startTime).toBeDefined();
      if (procScanSupported()) expect(processGroup(moved.pid)).toBe(leader.pid);
      const journal = new Journal(join(state, 'journal.db'));
      const row = journal.getEnv(first.envId)!;
      row.dataOnly = false;
      if (!procScanSupported()) row.servicePids.web = moved;
      journal.saveEnv(row);
      blocked = moved.pid;
      await expect(engine.up({ cwd: tree, holder: 'a', dataOnly: true })).rejects.toThrow(/unreaped service processes/);
      const retained = journal.getEnv(first.envId)!.servicePids;
      expect(Object.values(retained)).toEqual([moved]);
      blocked = undefined;
      writeFileSync(join(root, 'move'), '');
      await waitFor(() => existsSync(join(root, 'moved')));
      expect(Number(readFileSync(join(root, 'moved'), 'utf8'))).toBe(moved.pid);
      const gc = await engine.poolGc(false);
      if (procScanSupported()) {
        if (moveAt === 'before GC') expect(gc.reclaimed).toContainEqual({ pid: moved.pid, envId: first.envId, service: 'web' });
      } else {
        expect(gc.supported).toBe(false);
        expect(await killGroupVerified(moved.pid, moved.startTime)).toBe(true);
        expect(await reapPids(retained)).toEqual(retained);
      }
      expect(isAlive(moved.pid)).toBe(false);
      expect(groupAlive(leader.pid)).toBe(true);
      expect(isAlive(members.untagged)).toBe(true);
      expect(journal.getEnv(first.envId)?.servicePids).toEqual(retained);
      const report = await engine.doctor();
      const ownedIssues = report.issues.filter(issue => issue.envId === first.envId);
      expect(ownedIssues.some(issue => issue.issue.includes(`retained live process group ${leader!.pid}`))).toBe(true);
      expect(ownedIssues.some(issue => issue.issue.includes('recovery drift'))).toBe(false);
      await expect(engine.up({ cwd: other, holder: 'b' })).rejects.toThrow(/cap/);
      (engine as unknown as { supervisor(env: EnvRow): unknown }).supervisor(journal.getEnv(first.envId)!);
      await engine.shutdown();
      expect(journal.getEnv(first.envId)?.servicePids).toEqual(retained);
      expect(isAlive(members.untagged)).toBe(true);
      expect(await killGroupVerified(leader.pid, leader.startTime)).toBe(true);
      await leaderExit;
      expect((await engine.up({ cwd: tree, holder: 'a', dataOnly: true })).dataOnly).toBe(true);
      expect(journal.getEnv(first.envId)?.servicePids).toEqual({});
      expect((await engine.up({ cwd: other, holder: 'b' })).dataOnly).toBe(false);
    } finally {
      blocked = undefined;
      if (moved) await killGroupVerified(moved.pid, moved.startTime);
      if (leader) await killGroupVerified(leader.pid, leader.startTime);
      if (leaderExit) await leaderExit;
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains failed eviction ownership and releases it after confirmed cwd cleanup', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-eviction-survivors-')));
    const state = join(root, 'state');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX: '1', BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_POOL_MAX_DATA_ONLY: '4', BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100', BACKLOT_IDLE_TTL_MS: '1',
    });
    const blocked = new Map<number, ServicePid>();
    let trigger: number | undefined;
    const kill = vi.fn(async (...args: Parameters<typeof killGroupVerified>) => {
      if (args[0] === trigger) {
        for (const rec of blocked.values()) await killGroupVerified(rec.pid, rec.startTime);
      }
      if (blocked.has(args[0]) && isAlive(args[0])) return false;
      return killGroupVerified(...args);
    });
    const engine = new Engine(kill);
    const children: Array<{ rec: ServicePid; exit: Promise<unknown[]> }> = [];
    const spawnChild = async (cwd: string, tags: Record<string, string> = {}) => {
      const proc = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(() => {}, 1000)'], {
        cwd, detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...tags },
      });
      const entry = { rec: { pid: proc.pid!, startTime: startTime(proc.pid!) }, exit: once(proc, 'exit') };
      children.push(entry);
      await once(proc.stdout!, 'data');
      entry.rec.startTime = startTime(entry.rec.pid);
      return entry.rec;
    };
    try {
      const tree = inProcessStack(root, 'app');
      const other = inProcessStack(root, 'other');
      const first = await engine.up({ cwd: tree, holder: 'a' });
      const journal = new Journal(join(state, 'journal.db'));
      const original = journal.getEnv(first.envId)!;
      const database = readFileSync(original.datastoreNs.main);
      const tagged = await spawnChild(original.root, serviceTag(first.envId, 'web', state));
      blocked.set(tagged.pid, tagged);
      if (!procScanSupported()) {
        original.servicePids.escapee = tagged;
        journal.saveEnv(original);
      }
      await expect(engine.up({ cwd: tree, holder: 'a', dataOnly: true })).rejects.toThrow(/unreaped service processes/);
      const cwdOnly = await spawnChild(original.root);
      blocked.set(cwdOnly.pid, cwdOnly);
      await engine.release(tree, 'a');
      const released = journal.getEnv(first.envId)!;
      released.lastUsedAt = Date.now() - 60_000;
      if (!procScanSupported()) released.servicePids.cwd = cwdOnly;
      journal.saveEnv(released);
      await expect(engine.up({ cwd: other, holder: 'b' })).rejects.toThrow(/cap/);
      const retained = journal.getEnv(first.envId)!;
      expect(retained.state).toBe('warm');
      expect(retained.dataOnly).toBe(true);
      expect(Object.values(retained.servicePids).map((r) => r.pid).sort()).toEqual([tagged.pid, cwdOnly.pid].sort());
      expect(journal.leaseForEnv(first.envId)).toBeUndefined();
      expect(journal.allEnvs()).toHaveLength(1);
      expect(readFileSync(original.datastoreNs.main)).toEqual(database);
      expect(existsSync(original.root)).toBe(true);
      expect(children.every(({ rec }) => isAlive(rec.pid))).toBe(true);
      const reason = `environment ${first.envId} has unreaped service processes — ownership and capacity retained; run 'backlot doctor' to inspect them, then retry recycling once they can be reclaimed`;
      await expect(engine.poolRecycle({ envId: first.envId, force: true })).rejects.toMatchObject({ message: reason });
      for (const force of [true, false]) {
        expect(await engine.poolRecycle({ force })).toEqual({ recycled: [], skipped: [{ envId: first.envId, reason }] });
      }
      expect(journal.getEnv(first.envId)?.servicePids).toEqual(retained.servicePids);
      expect(readFileSync(original.datastoreNs.main)).toEqual(database);
      expect(children.every(({ rec }) => isAlive(rec.pid))).toBe(true);
      if (procScanSupported()) {
        trigger = (await spawnChild(original.root)).pid;
      } else {
        for (const rec of blocked.values()) await killGroupVerified(rec.pid, rec.startTime);
      }
      const admitted = await engine.up({ cwd: other, holder: 'b' });
      expect(admitted.dataOnly).toBe(false);
      expect(journal.getEnv(first.envId)).toBeUndefined();
      expect(existsSync(original.root)).toBe(false);
      expect(children.every(({ rec }) => !groupAlive(rec.pid))).toBe(true);
      if (trigger) expect(kill.mock.calls.some(([pid]) => pid === trigger)).toBe(true);
    } finally {
      blocked.clear();
      for (const child of children) {
        await killGroupVerified(child.rec.pid, child.rec.startTime);
        await child.exit;
      }
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves an exited nonleader group across journal upgrade, retry and recovery', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-nonleader-survivors-')));
    const state = join(root, 'state');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX: '1', BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_POOL_MAX_DATA_ONLY: '4', BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100',
    });
    let victim: ServicePid | undefined;
    const kill = async (...args: Parameters<typeof killGroupVerified>) => {
      if (victim && args[0] === victim.pid && isAlive(victim.pid)) {
        process.kill(victim.pid, 'SIGTERM');
        for (let i = 0; i < 250 && isAlive(victim.pid); i++) await sleep(20);
        expect(isAlive(victim.pid)).toBe(false);
        return false;
      }
      return killGroupVerified(...args);
    };
    let engine = new Engine(kill);
    let leader: ServicePid | undefined;
    let leaderExit: Promise<unknown[]> | undefined;
    try {
      const tree = inProcessStack(root, 'app');
      const other = inProcessStack(root, 'other');
      const first = await engine.up({ cwd: tree, holder: 'a', dataOnly: true });
      const launcher = join(root, 'launcher.mjs');
      writeFileSync(launcher, `import {spawn} from 'node:child_process';
const args = ['-e', 'setInterval(() => {}, 1000)'];
const tagged = spawn(process.execPath, args, {stdio:'ignore', env:{...process.env,...JSON.parse(process.argv[2])}});
const untagged = spawn(process.execPath, args, {stdio:'ignore'});
let remaining=2;
for (const child of [tagged,untagged]) child.on('exit',()=>{if (--remaining===0) process.exit(0)});
process.on('SIGTERM',()=>{});
console.log(JSON.stringify({tagged:tagged.pid,untagged:untagged.pid}));
`);
      const proc = spawn(process.execPath, [launcher, JSON.stringify(serviceTag(first.envId, 'web', state))], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      leader = { pid: proc.pid!, startTime: startTime(proc.pid!) };
      leaderExit = once(proc, 'exit');
      const lines = createInterface({ input: proc.stdout! });
      const [line] = await once(lines, 'line');
      lines.close();
      const members = JSON.parse(line) as { tagged: number; untagged: number };
      for (let i = 0; i < 250; i++) {
        if (startTime(members.tagged) !== undefined && (!procScanSupported() || scanTagged(state).some((p) => p.pid === members.tagged))) break;
        await sleep(20);
      }
      victim = { pid: members.tagged, startTime: startTime(members.tagged), pgid: leader.pid };
      expect(victim.startTime).toBeDefined();
      if (procScanSupported()) expect(processGroup(victim.pid)).toBe(leader.pid);
      const journal = new Journal(join(state, 'journal.db'));
      const row = journal.getEnv(first.envId)!;
      row.dataOnly = false;
      if (!procScanSupported()) row.servicePids.web = victim;
      journal.saveEnv(row);
      const bind = () => engine.up({ cwd: tree, holder: 'a', dataOnly: true });
      await expect(bind()).rejects.toThrow(/unreaped service processes/);
      expect(Object.values(journal.getEnv(first.envId)!.servicePids)).toEqual([victim]);
      expect(isAlive(victim.pid)).toBe(false);
      expect(isAlive(members.untagged)).toBe(true);
      const db = new DatabaseSync(join(state, 'journal.db'));
      db.exec('PRAGMA user_version = 2');
      const migrated = new Journal(join(state, 'journal.db'));
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(3);
      db.close();
      expect(Object.values(migrated.getEnv(first.envId)!.servicePids)).toEqual([victim]);
      await expect(bind()).rejects.toThrow(/unreaped service processes/);
      await engine.shutdown();
      engine = new Engine();
      await engine.recover();
      expect(Object.values(migrated.getEnv(first.envId)!.servicePids)).toEqual([victim]);
      await expect(bind()).rejects.toThrow(/unreaped service processes/);
      await expect(engine.up({ cwd: other, holder: 'b' })).rejects.toThrow(/cap/);
      expect(isAlive(members.untagged)).toBe(true);
      expect(await killGroupVerified(leader.pid, leader.startTime)).toBe(true);
      await leaderExit;
      const converted = await bind();
      expect(converted.dataOnly).toBe(true);
      expect(migrated.getEnv(first.envId)?.servicePids).toEqual({});
      expect(isAlive(members.untagged)).toBe(false);
      expect((await engine.up({ cwd: other, holder: 'b' })).dataOnly).toBe(false);
    } finally {
      if (leader) await killGroupVerified(leader.pid, leader.startTime);
      if (leaderExit) await leaderExit;
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('retains same-service detached survivors until every kill is confirmed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-convert-detached-')));
    const state = join(root, 'state');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX: '1', BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_POOL_MAX_DATA_ONLY: '4', BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100',
    });
    const blocked = new Set<number>();
    const staleVerdicts = new Set<number>();
    const kill = vi.fn(async (...args: Parameters<typeof killGroupVerified>) => {
      if (blocked.has(args[0])) return false;
      const dead = await killGroupVerified(...args);
      return staleVerdicts.has(args[0]) ? false : dead;
    });
    const engine = new Engine(kill);
    const children: Array<{ proc: ReturnType<typeof spawn>; exit: Promise<unknown[]>; record: ServicePid }> = [];
    try {
      const tree = inProcessStack(root, 'app');
      const other = inProcessStack(root, 'other');
      const first = await engine.up({ cwd: tree, holder: 'a' });
      const journal = new Journal(join(state, 'journal.db'));
      const original = journal.getEnv(first.envId)!;
      const database = readFileSync(original.datastoreNs.main);
      for (let i = 0; i < 3; i++) {
        const proc = spawn(process.execPath, ['-e', 'console.log("ready");setInterval(() => {}, 1000)'], {
          detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...serviceTag(first.envId, 'web', state) },
        });
        const exit = once(proc, 'exit');
        const record = { pid: proc.pid!, startTime: startTime(proc.pid!) };
        children.push({ proc, exit, record });
        await once(proc.stdout!, 'data');
        record.startTime = startTime(record.pid);
        expect(record.startTime).toBeDefined();
        expect(isAlive(record.pid)).toBe(true);
        if (procScanSupported()) {
          expect(processGroup(record.pid)).toBe(record.pid);
          expect(scanTagged(state).some((p) => p.pid === record.pid && p.service === 'web')).toBe(true);
        } else {
          original.servicePids[`web:${record.pid}`] = record;
        }
        if (i < 2) blocked.add(record.pid);
        else if (procScanSupported()) staleVerdicts.add(record.pid);
      }
      if (!procScanSupported()) journal.saveEnv(original);
      const manifest = readFileSync(join(tree, 'backlot.yml'), 'utf8');
      writeFileSync(join(tree, 'backlot.yml'), manifest.replace('create: node seed.mjs {{ns}}', 'create: "false"'));
      const refuse = () => expect(engine.up({ cwd: tree, holder: 'a', dataOnly: true, hygiene: 'reset-data' })).rejects.toMatchObject({
        message: expect.stringContaining('still has unreaped service processes'),
      });
      await refuse();
      const failed = journal.getEnv(first.envId)!;
      expect(failed.state).toBe('warm');
      expect(failed.dataOnly).toBe(true);
      expect(Object.values(failed.servicePids).sort((a, b) => a.pid - b.pid)).toEqual(children.slice(0, 2).map((c) => c.record).sort((a, b) => a.pid - b.pid));
      expect(isAlive(children[2]!.record.pid)).toBe(false);
      expect(failed.presets).toEqual(original.presets);
      expect(readFileSync(original.datastoreNs.main)).toEqual(database);
      for (const { record } of children) {
        if (procScanSupported()) expect(kill).toHaveBeenCalledWith(record.pid, record.startTime, undefined, record.pid);
        else expect(kill).toHaveBeenCalledWith(record.pid, record.startTime);
      }
      expect(Object.values(original.servicePids).filter((r) => !blocked.has(r.pid)).every((r) => !groupAlive(r.pid))).toBe(true);
      await expect(fetch(first.urls.web.replace('localhost', '127.0.0.1'), { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
      await expect(engine.up({ cwd: other, holder: 'b' })).rejects.toMatchObject({ message: expect.stringMatching(/cap/) });
      blocked.delete(children[0]!.record.pid);
      await refuse();
      expect(isAlive(children[0]!.record.pid)).toBe(false);
      expect(Object.values(journal.getEnv(first.envId)!.servicePids)).toEqual([children[1]!.record]);
      expect(readFileSync(original.datastoreNs.main)).toEqual(database);
      await expect(engine.up({ cwd: other, holder: 'b' })).rejects.toMatchObject({ message: expect.stringMatching(/cap/) });
      blocked.clear();
      writeFileSync(join(tree, 'backlot.yml'), manifest);
      const converted = await engine.up({ cwd: tree, holder: 'a', dataOnly: true, hygiene: 'reset-data' });
      expect(converted.envId).toBe(first.envId);
      expect(converted.state).toBe('warm');
      expect(converted.urls).toEqual({});
      expect(journal.getEnv(first.envId)?.servicePids).toEqual({});
      expect(children.every(({ record }) => !isAlive(record.pid))).toBe(true);
      const admitted = await engine.up({ cwd: other, holder: 'b' });
      const response = await fetch(admitted.urls.web.replace('localhost', '127.0.0.1'), { signal: AbortSignal.timeout(2000) });
      expect(await response.text()).toBe('alive');
    } finally {
      blocked.clear();
      for (const child of children) {
        await killGroupVerified(child.record.pid, child.record.startTime);
        await child.exit;
      }
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reconciles an exited leader after reclaiming its tagged child through bind', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-convert-orphan-')));
    const state = join(root, 'state');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX: '1', BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_POOL_MAX_DATA_ONLY: '4', BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100',
    });
    const engine = new Engine();
    let orphan: { leader: number; child: number } | undefined;
    let childStart: number | undefined;
    let reaper: ReturnType<typeof spawn> | undefined;
    let reaperExit: Promise<unknown[]> | undefined;
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 250; i++) {
        if (predicate()) return;
        await sleep(20);
      }
      throw new Error('orphan fixture did not reach the expected process state');
    };
    try {
      const tree = inProcessStack(root, 'app');
      const other = inProcessStack(root, 'other');
      const first = await engine.up({ cwd: tree, holder: 'a', dataOnly: true });
      const journal = new Journal(join(state, 'journal.db'));
      reaper = spawn('python3', [join(import.meta.dirname, 'fixtures/exited-service-leader.py'),
        process.execPath, JSON.stringify(serviceTag(first.envId, 'web', state))], { stdio: ['ignore', 'pipe', 'pipe'] });
      reaperExit = once(reaper, 'exit');
      const lines = createInterface({ input: reaper.stdout! });
      let stderr = '';
      reaper.stderr!.on('data', (chunk) => { stderr += chunk; });
      const ready = await Promise.race([
        once(lines, 'line').then(([line]) => JSON.parse(line) as { leader: number; child: number }),
        reaperExit.then(() => { throw new Error(`orphan fixture exited before reporting pids: ${stderr}`); }),
      ]);
      orphan = ready;
      lines.close();
      await waitFor(() => startTime(ready.child) !== undefined && (!procScanSupported() ||
        scanTagged(state).some((p) => p.pid === ready.child)));
      childStart = startTime(ready.child);
      expect(isAlive(ready.leader)).toBe(false);
      expect(isAlive(ready.child)).toBe(true);
      expect(groupAlive(ready.leader)).toBe(true);
      if (procScanSupported()) expect(processGroup(ready.child)).toBe(ready.leader);
      const recorded = { web: { pid: ready.leader } };
      expect(await reapPids(recorded)).toEqual(recorded);
      const row = journal.getEnv(first.envId)!;
      row.dataOnly = false;
      row.state = 'warm';
      row.servicePids = recorded;
      journal.saveEnv(row);
      await expect(engine.up({ cwd: other, holder: 'b' })).rejects.toMatchObject({ message: expect.stringMatching(/cap/) });
      if (!procScanSupported()) {
        await expect(engine.up({ cwd: tree, holder: 'a', dataOnly: true })).rejects.toMatchObject({
          message: expect.stringContaining('still has unreaped service processes'),
        });
        expect(journal.getEnv(first.envId)?.servicePids).toEqual(recorded);
        process.kill(ready.child, 'SIGTERM');
        await waitFor(() => !groupAlive(ready.leader));
      }
      const converted = await engine.up({ cwd: tree, holder: 'a', dataOnly: true });
      expect(converted.envId).toBe(first.envId);
      expect(converted.dataOnly).toBe(true);
      expect(converted.state).toBe('warm');
      expect(isAlive(ready.child)).toBe(false);
      expect(groupAlive(ready.leader)).toBe(false);
      expect(journal.getEnv(first.envId)?.servicePids).toEqual({});
      const admitted = await engine.up({ cwd: other, holder: 'b' });
      const response = await fetch(admitted.urls.web.replace('localhost', '127.0.0.1'), { signal: AbortSignal.timeout(2000) });
      expect(await response.text()).toBe('alive');
    } finally {
      if (orphan) {
        if (procScanSupported()) await killGroupVerified(orphan.child, childStart);
        else if (isAlive(orphan.child) && startTime(orphan.child) === childStart) process.kill(orphan.child, 'SIGKILL');
      }
      if (reaperExit) await reaperExit;
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['reuse', 'pristine'] as const)('retains simulated teardown survivors through a %s bind and releases capacity after retry', async (hygiene) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-convert-survivors-')));
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: join(root, 'state'), BACKLOT_POOL_MAX: '1', BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_POOL_MAX_DATA_ONLY: '4', BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100',
    });
    const engine = new Engine();
    const lifecycle = engine as unknown as {
      reapEnvProcesses(env: EnvRow, pids?: Record<string, ServicePid>): Promise<Record<string, ServicePid>>;
    };
    const reap = vi.spyOn(lifecycle, 'reapEnvProcesses');
    try {
      const tree = inProcessStack(root, 'app');
      const other = inProcessStack(root, 'other');
      const first = await engine.up({ cwd: tree, holder: 'a' });
      const journal = new Journal(join(root, 'state', 'journal.db'));
      const original = journal.getEnv(first.envId)!;
      expect(Object.keys(original.servicePids)).toEqual(['web']);
      const database = readFileSync(original.datastoreNs.main);
      reap.mockImplementationOnce(async (env, pids) => {
        expect(env.id).toBe(first.envId);
        expect(pids).toEqual(original.servicePids);
        return original.servicePids;
      });
      await expect(engine.up({ cwd: tree, holder: 'a', dataOnly: true, hygiene })).rejects.toMatchObject({
        message: expect.stringContaining('still has unreaped service processes'),
      });
      const failed = journal.getEnv(first.envId)!;
      expect(failed.dataOnly).toBe(true);
      expect(failed.state).toBe('warm');
      expect(failed.servicePids).toEqual(original.servicePids);
      expect(failed.presets).toEqual(original.presets);
      expect(readFileSync(original.datastoreNs.main)).toEqual(database);
      const competing = await Promise.allSettled([
        engine.up({ cwd: tree, holder: 'b' }),
        engine.up({ cwd: other, holder: 'c' }),
      ]);
      for (const result of competing) {
        expect(result.status).toBe('rejected');
        if (result.status === 'rejected') expect(result.reason.message).toMatch(/cap/);
      }
      expect(journal.allEnvs()).toHaveLength(1);
      expect(journal.getEnv(first.envId)?.servicePids).toEqual(original.servicePids);
      const converted = await engine.up({ cwd: tree, holder: 'a', dataOnly: true, hygiene });
      expect(converted.envId).toBe(first.envId);
      expect(converted.dataOnly).toBe(true);
      expect(converted.state).toBe('warm');
      expect(journal.getEnv(first.envId)?.servicePids).toEqual({});
      const admitted = await engine.up({ cwd: other, holder: 'c' });
      expect(admitted.dataOnly).toBe(false);
      const response = await fetch(admitted.urls.web.replace('localhost', '127.0.0.1'), { signal: AbortSignal.timeout(2000) });
      expect(await response.text()).toBe('alive');
    } finally {
      reap.mockRestore();
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it('releases the application slot when a conversion fails after its services were stopped', async () => {
    const f = fixture(2, 1);
    const tree = f.stack('app');
    const original = readFileSync(join(tree, 'backlot.yml'), 'utf8');
    const first = await f.cli(tree, 'up', '--holder', 'a');
    expect(first.code, first.stdout + first.stderr).toBe(0);
    await f.alive(first.data);
    writeFileSync(join(tree, 'backlot.yml'), original.replace('create: node seed.mjs {{ns}}', 'create: "false"'));
    const failed = await f.cli(tree, 'up', '--holder', 'a', '--data-only', '--reset-data');
    expect(failed.code, failed.stdout + failed.stderr).toBe(1);
    await expect(fetch(first.data.urls.web.replace('localhost', '127.0.0.1'), { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    const row = f.journal().getEnv(first.data.envId);
    expect(row?.state).toBe('warm');
    expect(row?.servicePids).toEqual({});
    writeFileSync(join(tree, 'backlot.yml'), original);
    // Nothing runs on that row any more, so the stack's single application slot
    // is free for another holder — and the failed converter no longer owns it.
    const competing = await f.cli(tree, 'up', '--holder', 'b');
    expect(competing.code, competing.stdout + competing.stderr).toBe(0);
    expect(competing.data.envId).not.toBe(first.data.envId);
    await f.alive(competing.data);
    const returning = await f.cli(tree, 'up', '--holder', 'a');
    expect(returning.code, returning.stdout + returning.stderr).toBe(2);
    expect(String(returning.data?.error?.message ?? '')).toMatch(/change shape to an application environment/);
    await f.alive(competing.data);
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

  it('waits on its own busy environment without evicting idle data-only lanes, and names the operation when the wait runs out', async () => {
    const f = fixture(3, 2, { dataOnlyMax: 1, idleTtlMs: 250 });
    const lane = f.stack('lane');
    const parked = await f.cli(lane, 'up', '--holder', 'l', '--data-only');
    expect(parked.code, parked.stdout + parked.stderr).toBe(0);
    const released = await f.cli(lane, 'release', '--holder', 'l');
    expect(released.code, released.stdout + released.stderr).toBe(0);
    await sleep(400);
    const tree = f.stack('app');
    const barrier = join(tree, 'barrier.mjs');
    writeFileSync(barrier, readFileSync(barrier, 'utf8').replace('process.exit(23)', 'process.exit(0)'));
    writeFileSync(join(tree, 'backlot.yml'), readFileSync(join(tree, 'backlot.yml'), 'utf8') + 'upkeep:\n  - { when: backlot.yml, run: node barrier.mjs }\n');
    const starting = f.cli(tree, 'up', '--holder', 'a');
    let refused: Result;
    let started: Result;
    try {
      await f.waitEntered();
      refused = await f.cli(tree, 'up', '--holder', 'a', '--data-only');
    } finally {
      writeFileSync(join(f.gate, 'release'), '');
      started = await starting;
    }
    expect(started.code, started.stdout + started.stderr).toBe(0);
    expect(refused.code, refused.stdout + refused.stderr).toBe(2);
    const message = String(refused.data?.error?.message ?? '');
    expect(message).toContain(started.data.envId);
    expect(message).toMatch(/a bind is in flight/);
    expect(message).not.toMatch(/cap is what refused/);
    // The data-only lane was idle, cold and evictable, and the deferred conversion
    // must not have spent it: nothing about that lane blocked the holder.
    expect(f.journal().getEnv(parked.data.envId)?.dataOnly).toBe(true);
    expect(f.events().filter((e) => e.kind === 'pool-evict')).toEqual([]);
  });

  it('keeps the application reservation of a claimed bind that has not yet taken the environment lock', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-convert-engine-')));
    const gate = join(root, 'gate');
    mkdirSync(gate);
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: join(root, 'state'), BACKLOT_POOL_MAX: '2', BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_POOL_MAX_DATA_ONLY: '4', BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '30000', BACKLOT_TEST_GATE_DIR: gate,
    });
    const engine = new Engine();
    const journal = () => new Journal(join(root, 'state', 'journal.db'));
    const order: string[] = [];
    let competing: Promise<Awaited<ReturnType<Engine['up']>>> | undefined;
    try {
      const tree = inProcessStack(root, 'app');
      const other = inProcessStack(root, 'other');
      const first = await engine.up({ cwd: tree, holder: 'a', dataOnly: false, services: [] });
      expect(first.dataOnly).toBe(false);
      const parked = await engine.up({ cwd: tree, holder: 'a', dataOnly: true });
      expect(parked.dataOnly).toBe(true);
      expect(parked.state).toBe('warm');
      // The row is warm with nothing recorded. An application rebind claims it and
      // a conversion back is chained straight behind that claim, before the bind
      // has taken the environment lock — the only moment the reservation is not
      // also visible as `busy`. The bind then parks at an upkeep barrier so the
      // window between claim and running services can be observed.
      writeFileSync(join(tree, 'backlot.yml'), readFileSync(join(tree, 'backlot.yml'), 'utf8') + 'upkeep:\n  - { when: backlot.yml, run: node barrier.mjs }\n');
      const app = engine.up({ cwd: tree, holder: 'a', dataOnly: false, services: [] }).finally(() => order.push('app'));
      const back = engine.up({ cwd: tree, holder: 'a', dataOnly: true }).finally(() => order.push('data'));
      const settled = Promise.allSettled([app, back]);
      for (let i = 0; i < 250 && !existsSync(join(gate, 'entered')); i++) {
        if (order.length > 0) break;
        await sleep(20);
      }
      if (order.length > 0) {
        // Whatever is still parked at the barrier must be let go first, or
        // awaiting the pair would hang on it and the timeout would hide the
        // outcome that actually settled early.
        writeFileSync(join(gate, 'release'), '');
        const [outcome] = await settled;
        expect.fail(`the application bind settled before reaching its upkeep barrier (journal dataOnly=${journal().getEnv(first.envId)?.dataOnly}): ${JSON.stringify(outcome)}`);
      }
      expect(existsSync(join(gate, 'entered'))).toBe(true);
      // Persisted shape while the claimed bind is parked: still an application.
      expect(journal().getEnv(first.envId)?.dataOnly).toBe(false);
      // And the machine-wide application cap of one still counts it: another
      // stack must not be admitted while that reservation stands.
      competing = engine.up({ cwd: other, holder: 'b', dataOnly: false, services: [] }).finally(() => order.push('other'));
      competing.catch(() => undefined);
      const early = await Promise.race([
        competing.then(() => 'admitted', () => 'refused'),
        sleep(1500).then(() => 'waiting'),
      ]);
      expect(early).toBe('waiting');
      expect(journal().getEnv(first.envId)?.dataOnly).toBe(false);
      writeFileSync(join(gate, 'release'), '');
      const [appOutcome, backOutcome] = await settled;
      expect(appOutcome.status, JSON.stringify(appOutcome)).toBe('fulfilled');
      const bound = (appOutcome as PromiseFulfilledResult<Awaited<typeof app>>).value;
      expect(bound.dataOnly).toBe(false);
      expect(bound.envId).toBe(first.envId);
      expect(order.indexOf('app')).toBe(0);
      expect(order.indexOf('data')).toBeGreaterThan(0);
      expect(backOutcome.status, JSON.stringify(backOutcome)).toBe('fulfilled');
      const converted = (backOutcome as PromiseFulfilledResult<Awaited<typeof back>>).value;
      expect(converted.dataOnly).toBe(true);
      expect(converted.urls).toEqual({});
      // The other stack is admitted only once the conversion has stopped what
      // the bind started and released the slot.
      const admitted = await competing;
      expect(admitted.dataOnly).toBe(false);
      expect(order.indexOf('other')).toBeGreaterThan(order.indexOf('app'));
      const r = await fetch(admitted.urls.web.replace('localhost', '127.0.0.1'), { signal: AbortSignal.timeout(2000) });
      expect(await r.text()).toBe('alive');
    } finally {
      writeFileSync(join(gate, 'release'), '');
      if (competing) await competing.catch(() => undefined);
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    }
  });

});

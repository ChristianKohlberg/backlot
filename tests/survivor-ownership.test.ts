/**
 * Service processes that outlive a stop — a `down`, a reset or pristine bind, an
 * eviction, a GC pass — stay recorded, keep the environment's ownership and
 * capacity, and are retried until every kill is confirmed. (These cases were
 * first written around data-only conversions, removed by decision 0034; `down`
 * is the stop they now drive.)
 */
import { describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
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
import { disposeStateSync } from './support/leaks.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe('service processes that outlive a stop keep their ownership until every kill is confirmed', () => {
  it.each(['recorded', 'discovered', 'GC', 'both groups'] as const)('retains a newly observed surviving group through %s reclamation and retry', async (path) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-new-group-')));
    const state = join(root, 'state');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100',
    });
    let victim: ServicePid | undefined;
    let child: ServicePid | undefined;
    let leader: ServicePid | undefined;
    let intercept = true;
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 250; i++) {
        if (predicate()) return;
        await sleep(20);
      }
      throw new Error('new-group fixture did not reach expected state');
    };
    let engine = new Engine(async (...args: Parameters<typeof killGroupVerified>) => {
      if (intercept && args[0] === victim?.pid) {
        writeFileSync(join(root, 'move'), '');
        await waitFor(() => existsSync(join(root, 'child')));
        child = { pid: Number(readFileSync(join(root, 'child'), 'utf8')) };
        if (path !== 'both groups') await waitFor(() => !groupAlive(leader!.pid));
        const original = process.kill.bind(process);
        const signal = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
          if (pid === -victim!.pid && sig !== 0) {
            if (isAlive(victim!.pid)) original(victim!.pid, 'SIGKILL');
            return true;
          }
          return original(pid, sig);
        });
        try { return await killGroupVerified(args[0], args[1], 0, args[3], ...args.slice(4)); }
        finally { signal.mockRestore(); intercept = false; }
      }
      return killGroupVerified(...args);
    });
    try {
      const tree = inProcessStack(root, 'app');
      const other = inProcessStack(root, 'other');
      const first = await engine.up({ cwd: tree, holder: 'a' });
      await engine.down({ cwd: tree, holder: 'a', services: [] });
      writeFileSync(join(root, 'move.py'), `import os, sys, time
root=sys.argv[1]
with open(root+'/ready','w') as f: f.write(str(os.getpid()))
while not os.path.exists(root+'/move'): time.sleep(.02)
os.setsid()
pid=os.fork()
if pid == 0:
    os.execve(sys.executable,[sys.executable,'-c','import time; time.sleep(120)'],{})
with open(root+'/child','w') as f: f.write(str(pid))
while True: time.sleep(1)
`);
      const launcher = spawn(process.execPath, ['-e', `const {spawn}=require('child_process');
const p=spawn('python3',process.argv.slice(1),{stdio:'ignore',env:{...process.env,...${JSON.stringify(serviceTag(first.envId, 'web', state))}}});
console.log(p.pid);p.unref();${path === 'both groups' ? 'setInterval(()=>{},1000);' : ''}`, join(root, 'move.py'), root], {
        cwd: root, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env },
      });
      leader = { pid: launcher.pid!, startTime: startTime(launcher.pid!) };
      const exited = once(launcher, 'exit');
      const lines = createInterface({ input: launcher.stdout! });
      const [line] = await once(lines, 'line');
      lines.close();
      if (path !== 'both groups') await exited;
      await waitFor(() => existsSync(join(root, 'ready')));
      victim = { pid: Number(line), startTime: startTime(Number(line)), pgid: leader.pid };
      const journal = new Journal(join(state, 'journal.db'));
      const row = journal.getEnv(first.envId)!;
      if (path !== 'discovered' || !procScanSupported()) row.servicePids.web = victim;
      journal.saveEnv(row);
      if (path === 'GC' && procScanSupported()) await engine.poolGc(false);
      else await expect(engine.down({ cwd: tree, holder: 'a', services: [] })).rejects.toThrow(/unreaped service processes/);
      expect(isAlive(victim.pid)).toBe(false);
      expect(groupAlive(leader.pid)).toBe(path === 'both groups');
      expect(groupAlive(victim.pid)).toBe(true);
      expect(scanTagged(state).some(p => p.pid === child!.pid)).toBe(false);
      let retained = journal.getEnv(first.envId)!.servicePids;
      await engine.shutdown();
      engine = new Engine();
      await engine.recover();
      expect(journal.getEnv(first.envId)!.servicePids).toEqual(retained);
      if (path === 'both groups') {
        expect(Object.values(retained)[0]!.pgids).toContain(victim.pid);
        process.kill(leader.pid, 'SIGKILL');
        await exited;
        retained = await reapPids(retained);
        expect(Object.values(retained)).toEqual([{ pid: victim.pid, startTime: victim.startTime }]);
      }
      expect(Object.keys(retained).length).toBeGreaterThan(0);
      expect(await reapPids(retained)).toEqual(retained);
      await expect(engine.down({ cwd: tree, holder: 'a', services: [] })).rejects.toThrow(/unreaped service processes/);
      await expect(engine.up({ cwd: other, holder: 'b' })).rejects.toThrow(/cap/);
      await engine.shutdown();
      expect(journal.getEnv(first.envId)!.servicePids).toEqual(retained);
      const report = await engine.doctor();
      expect(report.issues.some(i => i.envId === first.envId && i.issue.includes(`retained live process group ${victim!.pid}`))).toBe(true);
      process.kill(child!.pid, 'SIGKILL');
      await waitFor(() => !groupAlive(victim!.pid));
      expect((await engine.down({ cwd: tree, holder: 'a', services: [] })).services).toEqual({ web: 'down' });
      expect(journal.getEnv(first.envId)!.servicePids).toEqual({});
    } finally {
      intercept = false;
      for (const rec of [child, victim, leader]) {
        if (rec) { try { process.kill(rec.pid, 'SIGKILL'); } catch {} }
      }
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      disposeStateSync(root);
    }
  });

  it.each(['before GC', 'during discovery'] as const)('retains the original survivor group when its nonleader moves %s', async (moveAt) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-gc-moved-survivor-')));
    const state = join(root, 'state');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100',
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
      const first = await engine.up({ cwd: tree, holder: 'a' });
      await engine.down({ cwd: tree, holder: 'a', services: [] });
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
      if (!procScanSupported()) row.servicePids.web = moved;
      journal.saveEnv(row);
      blocked = moved.pid;
      await expect(engine.down({ cwd: tree, holder: 'a', services: [] })).rejects.toThrow(/unreaped service processes/);
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
      expect((await engine.down({ cwd: tree, holder: 'a', services: [] })).services).toEqual({ web: 'down' });
      expect(journal.getEnv(first.envId)?.servicePids).toEqual({});
    } finally {
      blocked = undefined;
      if (moved) await killGroupVerified(moved.pid, moved.startTime);
      if (leader) await killGroupVerified(leader.pid, leader.startTime);
      if (leaderExit) await leaderExit;
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      disposeStateSync(root);
    }
  });

  it('retains failed eviction ownership and releases it after confirmed cwd cleanup', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-eviction-survivors-')));
    const state = join(root, 'state');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100', BACKLOT_IDLE_TTL_MS: '1',
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
      await expect(engine.down({ cwd: tree, holder: 'a', services: [] })).rejects.toThrow(/unreaped service processes/);
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
      expect(Object.values(retained.servicePids).map((r) => r.pid).sort()).toEqual([tagged.pid, cwdOnly.pid].sort());
      expect(journal.leaseForEnv(first.envId)).toBeUndefined();
      expect(journal.allEnvs()).toHaveLength(1);
      expect(readFileSync(original.datastoreNs.main)).toEqual(database);
      expect(existsSync(original.root)).toBe(true);
      expect(children.every(({ rec }) => isAlive(rec.pid))).toBe(true);
      const reason = `environment ${first.envId} has unreaped service processes — ownership and capacity retained; run 'runly doctor' to inspect them, then retry recycling once they can be reclaimed`;
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
      disposeStateSync(root);
    }
  });

  it('preserves an exited nonleader group across journal upgrade, retry and recovery', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-nonleader-survivors-')));
    const state = join(root, 'state');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100',
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
      const first = await engine.up({ cwd: tree, holder: 'a' });
      await engine.down({ cwd: tree, holder: 'a', services: [] });
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
      if (!procScanSupported()) row.servicePids.web = victim;
      journal.saveEnv(row);
      const bind = () => engine.down({ cwd: tree, holder: 'a', services: [] });
      await expect(bind()).rejects.toThrow(/unreaped service processes/);
      expect(Object.values(journal.getEnv(first.envId)!.servicePids)).toEqual([victim]);
      expect(isAlive(victim.pid)).toBe(false);
      expect(isAlive(members.untagged)).toBe(true);
      const db = new DatabaseSync(join(state, 'journal.db'));
      db.exec('PRAGMA user_version = 2');
      const migrated = new Journal(join(state, 'journal.db'));
      expect(db.prepare('PRAGMA user_version').get()!.user_version).toBe(4);
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
      expect(migrated.getEnv(first.envId)?.servicePids).toEqual({});
      expect(isAlive(members.untagged)).toBe(false);
    } finally {
      if (leader) await killGroupVerified(leader.pid, leader.startTime);
      if (leaderExit) await leaderExit;
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      disposeStateSync(root);
    }
  });

  it('retains same-service detached survivors until every kill is confirmed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-convert-detached-')));
    const state = join(root, 'state');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100',
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
      const refuse = () => expect(engine.up({ cwd: tree, holder: 'a', hygiene: 'reset-data' })).rejects.toMatchObject({
        message: expect.stringContaining('still has unreaped service processes'),
      });
      await refuse();
      const failed = journal.getEnv(first.envId)!;
      expect(failed.state).toBe('warm');
      expect(Object.values(failed.servicePids).sort((a, b) => a.pid - b.pid)).toEqual(children.slice(0, 2).map((c) => c.record).sort((a, b) => a.pid - b.pid));
      expect(isAlive(children[2]!.record.pid)).toBe(false);
      expect(failed.presets).toEqual(original.presets);
      expect(readFileSync(original.datastoreNs.main)).toEqual(database);
      for (const { record } of children) {
        if (procScanSupported()) expect(kill).toHaveBeenCalledWith(record.pid, record.startTime, undefined, record.pid, expect.any(Function));
        else expect(kill).toHaveBeenCalledWith(record.pid, record.startTime, undefined, undefined, expect.any(Function));
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
      const converted = await engine.up({ cwd: tree, holder: 'a', hygiene: 'reset-data' });
      expect(converted.envId).toBe(first.envId);
      expect(converted.state).toBe('hot');
      expect(Object.keys(converted.urls)).toEqual(['web']);
      expect(Object.keys(journal.getEnv(first.envId)!.servicePids)).toEqual(['web']);
      expect(children.every(({ record }) => !isAlive(record.pid))).toBe(true);
    } finally {
      blocked.clear();
      for (const child of children) {
        await killGroupVerified(child.record.pid, child.record.startTime);
        await child.exit;
      }
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      disposeStateSync(root);
    }
  });

  it.each(['bind', 'GC', 'GC concurrent'] as const)('reconciles an exited leader after reclaiming its tagged child through %s', async (boundary) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-convert-orphan-')));
    const state = join(root, 'state');
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100',
    });
    let duringReap: (() => void) | undefined;
    const engine = new Engine(async (...args: Parameters<typeof killGroupVerified>) => {
      const dead = await killGroupVerified(...args);
      if (duringReap) {
        const update = duringReap;
        duringReap = undefined;
        update();
      }
      return dead;
    });
    let concurrent: ReturnType<typeof spawn> | undefined;
    let concurrentExit: Promise<unknown[]> | undefined;
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
      const first = await engine.up({ cwd: tree, holder: 'a' });
      await engine.down({ cwd: tree, holder: 'a', services: [] });
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
      row.state = 'warm';
      row.servicePids = recorded;
      journal.saveEnv(row);
      await expect(engine.up({ cwd: other, holder: 'b' })).rejects.toMatchObject({ message: expect.stringMatching(/cap/) });
      if (!procScanSupported()) {
        await expect(engine.down({ cwd: tree, holder: 'a', services: [] })).rejects.toMatchObject({
          message: expect.stringContaining('still has unreaped service processes'),
        });
        expect(journal.getEnv(first.envId)?.servicePids).toEqual(recorded);
        process.kill(ready.child, 'SIGTERM');
        await waitFor(() => !groupAlive(ready.leader));
      }
      if (boundary === 'GC concurrent' && procScanSupported()) {
        concurrent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore' });
        concurrentExit = once(concurrent, 'exit');
        const concurrentPid = concurrent.pid!;
        await waitFor(() => startTime(concurrentPid) !== undefined);
        const added = { pid: concurrentPid, startTime: startTime(concurrentPid) };
        duringReap = () => {
          const fresh = journal.getEnv(first.envId)!;
          fresh.servicePids.web = { ...recorded.web, pgids: [concurrentPid] };
          fresh.servicePids.concurrent = added;
          journal.saveEnv(fresh);
        };
        await engine.poolGc(false);
        expect(journal.getEnv(first.envId)?.servicePids).toEqual({
          web: { ...recorded.web, pgids: [concurrentPid] }, concurrent: added,
        });
        await expect(engine.up({ cwd: other, holder: 'b' })).rejects.toThrow(/cap/);
        expect(await killGroupVerified(concurrentPid, added.startTime)).toBe(true);
        await concurrentExit;
        await engine.shutdown();
      } else if (boundary === 'GC' && procScanSupported()) {
        const reclaimed = await engine.poolGc(false);
        expect(reclaimed.reclaimed).toContainEqual({ pid: ready.child, envId: first.envId, service: 'web' });
        expect(journal.getEnv(first.envId)?.state).toBe('warm');
      } else {
        const converted = await engine.down({ cwd: tree, holder: 'a', services: [] });
        expect(converted.envId).toBe(first.envId);
          expect(converted.state).toBe('warm');
      }
      expect(isAlive(ready.child)).toBe(false);
      expect(groupAlive(ready.leader)).toBe(false);
      expect(journal.getEnv(first.envId)?.servicePids).toEqual({});
    } finally {
      duringReap = undefined;
      if (concurrent?.pid) await killGroupVerified(concurrent.pid);
      if (concurrentExit) await concurrentExit;
      if (orphan) {
        if (procScanSupported()) await killGroupVerified(orphan.child, childStart);
        else if (isAlive(orphan.child) && startTime(orphan.child) === childStart) process.kill(orphan.child, 'SIGKILL');
      }
      if (reaperExit) await reaperExit;
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      disposeStateSync(root);
    }
  });

  it.each(['reuse', 'pristine'] as const)('retains simulated teardown survivors through a %s bind and releases capacity after retry', async (hygiene) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-convert-survivors-')));
    const saved = { ...process.env };
    Object.assign(process.env, {
      BACKLOT_STATE_DIR: join(root, 'state'), BACKLOT_POOL_MAX_TOTAL: '1',
      BACKLOT_SWEEP_MS: '60000', BACKLOT_WAIT_MS: '100',
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
      const stopAll = () => (hygiene === 'reuse' ? engine.down({ cwd: tree, holder: 'a', services: [] }) : engine.up({ cwd: tree, holder: 'a', hygiene }));
      await expect(stopAll()).rejects.toMatchObject({
        message: expect.stringContaining('still has unreaped service processes'),
      });
      const failed = journal.getEnv(first.envId)!;
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
        // Holder b shares a's worktree, so it waits for its one environment
        // (decision 0032); c's worktree needs an application slot.
        if (result.status === 'rejected') expect(result.reason.message).toMatch(/cap|exactly one environment/);
      }
      expect(journal.allEnvs()).toHaveLength(1);
      expect(journal.getEnv(first.envId)?.servicePids).toEqual(original.servicePids);
      const converted = await stopAll();
      expect(converted.envId).toBe(first.envId);
      expect(converted.state).toBe(hygiene === 'reuse' ? 'warm' : 'hot');
      if (hygiene === 'reuse') expect(journal.getEnv(first.envId)?.servicePids).toEqual({});
    } finally {
      reap.mockRestore();
      await engine.shutdown();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      disposeStateSync(root);
    }
  });

});

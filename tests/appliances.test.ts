/**
 * Appliances (decision 0018): ensured, never owned. These tests exercise the
 * driver directly — probe adoption, one-shot start with readiness, the
 * machine-wide start lock, infra-error classification — using throwaway TCP
 * listeners as stand-in servers so no real Docker/Postgres is needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { ensureAppliance, stopAppliance, probeTcp } from '../src/drivers/appliances.js';
import { BrokerError } from '../src/core/util.js';
import { tempDir, freePort } from './helpers.js';

const root = join(import.meta.dirname, '..');
const schema = JSON.parse(readFileSync(join(root, 'schema/stack.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true });
const validateSchema = ajv.compile(schema);

const silent = () => undefined;

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

describe('schema: appliances', () => {
  const base = { name: 'x', services: { web: { run: 'true' } } };

  it('accepts a full appliance and a probe-only appliance', () => {
    const ok = validateSchema({
      ...base,
      appliances: {
        postgres: { probe: 'localhost:5433', start: 'docker run -d pg', stop: 'docker rm -f pg', ready: 'pg_isready', timeout: 90 },
        redis: { probe: 'localhost:6380' },
      },
    });
    expect(validateSchema.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('rejects an appliance without probe, or with unknown keys', () => {
    expect(validateSchema({ ...base, appliances: { pg: { start: 'x' } } })).toBe(false);
    expect(validateSchema({ ...base, appliances: { pg: { probe: 'l:1', supervise: true } } })).toBe(false);
  });
});

describe('ensureAppliance', () => {
  let state: { dir: string; cleanup: () => void };
  let servers: Server[] = [];

  beforeEach(() => {
    state = tempDir('appliance-state');
    process.env.BACKLOT_STATE_DIR = state.dir;
  });
  afterEach(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    servers = [];
    delete process.env.BACKLOT_STATE_DIR;
    state.cleanup();
  });

  it('adopts whatever already answers the probe', async () => {
    const port = await freePort();
    servers.push(await listen(port));
    const res = await ensureAppliance('pg', { probe: `127.0.0.1:${port}` }, root, silent);
    expect(res).toBe('up');
  });

  it('is an infra-error when down and no start: is declared', async () => {
    const port = await freePort();
    const err = await ensureAppliance('pg', { probe: `127.0.0.1:${port}` }, root, silent).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.klass).toBe('infra-error');
    expect(err.message).toContain("appliance 'pg'");
  });

  it('starts a declared appliance and waits for the probe to accept', async () => {
    const port = await freePort();
    const work = tempDir('appliance-work');
    // A daemonizing start: a detached node TCP listener that outlives the shell.
    const script = join(work.dir, 'srv.mjs');
    writeFileSync(
      script,
      `import { createServer } from 'node:net'; createServer().listen(${port}, '127.0.0.1');`,
    );
    const start = `nohup node ${script} > /dev/null 2>&1 & echo started`;
    // ready: exercises the post-start gate (a command that must exit 0).
    const res = await ensureAppliance('fake', { probe: `127.0.0.1:${port}`, start, ready: `test -f ${script}`, timeout: 10 }, work.dir, silent);
    expect(res).toBe('started');
    expect(await probeTcp(`127.0.0.1:${port}`)).toBe(true);
    // Second ensure: adopt, do not start twice.
    expect(await ensureAppliance('fake', { probe: `127.0.0.1:${port}`, start: 'false', timeout: 5 }, work.dir, silent)).toBe('up');
    // Cleanup the detached listener.
    const { execFileSync } = await import('node:child_process');
    // execFile, not `sh -c 'pkill -f … || true'`: on Linux, pkill -f matches
    // the sh wrapper's own cmdline (it contains the pattern) and SIGTERMs it
    // before `|| true` applies — execSync then throws "Command failed".
    // pkill never matches its own pid, so calling it directly is safe.
    try {
      execFileSync('pkill', ['-f', script]);
    } catch {
      /* no survivors to kill — pkill exits 1 */
    }
    work.cleanup();
  });

  it('start failure is an infra-error carrying the command output', async () => {
    const port = await freePort();
    const err = await ensureAppliance(
      'broken',
      { probe: `127.0.0.1:${port}`, start: 'echo boom >&2; exit 3', timeout: 5 },
      root,
      silent,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.klass).toBe('infra-error');
    expect(err.logExcerpt).toContain('boom');
  });

  it('start success that never answers the probe is an infra-error after timeout', async () => {
    const port = await freePort();
    const err = await ensureAppliance(
      'ghost',
      { probe: `127.0.0.1:${port}`, start: 'true', timeout: 1 },
      root,
      silent,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.klass).toBe('infra-error');
    expect(err.message).toContain('never answered');
  });

  it('applies the ready: gate on adoption, not only on the start path', async () => {
    const port = await freePort();
    servers.push(await listen(port));
    const work = tempDir('appliance-ready');
    const marker = join(work.dir, 'ready.marker');

    // This test previously asserted the OPPOSITE — that adoption short-circuits
    // before ready: "by design". That contradicts decision 0018, which states
    // ready: exists precisely "because servers like Postgres accept connections
    // before they serve them". An open port is the condition ready: is there to
    // disambiguate, so honouring it only when backlot happened to run start:
    // made the gate meaningless for the common case: a long-lived appliance
    // that is already up.
    const err = await ensureAppliance(
      'db',
      { probe: `127.0.0.1:${port}`, ready: `test -f ${marker}`, timeout: 2 },
      work.dir,
      silent,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.klass).toBe('infra-error'); // 0018: appliance failures are never anyone's code
    expect(err.message).toMatch(/ready: gate never passed/);

    // Once the gate is satisfiable, the same appliance adopts cleanly.
    writeFileSync(marker, '');
    const ok = await ensureAppliance(
      'db',
      { probe: `127.0.0.1:${port}`, ready: `test -f ${marker}`, timeout: 2 },
      work.dir,
      silent,
    );
    expect(ok).toBe('up');
    work.cleanup();
  });

  it('serializes concurrent starters via the machine-wide lock', async () => {
    const port = await freePort();
    const work = tempDir('appliance-race');
    const script = join(work.dir, 'srv.mjs');
    writeFileSync(
      script,
      `import { createServer } from 'node:net'; createServer().listen(${port}, '127.0.0.1');`,
    );
    // Slow start: sleep, then daemonize the listener.
    const start = `sleep 1; nohup node ${script} > /dev/null 2>&1 & echo started`;
    const spec = { probe: `127.0.0.1:${port}`, start, timeout: 15 };
    const [a, b] = await Promise.all([
      ensureAppliance('racy', spec, work.dir, silent),
      ensureAppliance('racy', spec, work.dir, silent),
    ]);
    // Exactly one starter; the other waited and adopted (or found it up).
    expect([a, b].sort()).toContain('started');
    expect([a, b].filter((r) => r === 'started').length).toBe(1);
    const { execFileSync } = await import('node:child_process');
    // execFile, not `sh -c 'pkill -f … || true'`: on Linux, pkill -f matches
    // the sh wrapper's own cmdline (it contains the pattern) and SIGTERMs it
    // before `|| true` applies — execSync then throws "Command failed".
    // pkill never matches its own pid, so calling it directly is safe.
    try {
      execFileSync('pkill', ['-f', script]);
    } catch {
      /* no survivors to kill — pkill exits 1 */
    }
    work.cleanup();
  });
});

describe('stopAppliance', () => {
  it('is a work-error without a stop: command, runs it when declared', async () => {
    const err = await stopAppliance('pg', { probe: 'l:1' }, '/tmp').catch((e) => e);
    expect(err).toBeInstanceOf(BrokerError);
    expect(err.klass).toBe('work-error');

    const work = tempDir('appliance-stop');
    const marker = join(work.dir, 'stopped.marker');
    await stopAppliance('pg', { probe: 'l:1', stop: `touch ${marker}` }, work.dir);
    expect(readFileSync(marker, 'utf8')).toBe('');
    work.cleanup();
  });
});

describe('the appliance start lock is machine-wide, not process-wide', () => {
  let lockState: { dir: string; cleanup: () => void };
  beforeEach(() => {
    lockState = tempDir('appliance-lockstate');
    process.env.BACKLOT_STATE_DIR = lockState.dir;
  });
  afterEach(() => {
    delete process.env.BACKLOT_STATE_DIR;
    lockState.cleanup();
  });

  it('holds the lock as a filesystem artifact under the shared state root', async () => {
    const port = await freePort();
    const work = tempDir('appliance-xproc');
    const script = join(work.dir, 'srv.mjs');
    writeFileSync(script, `import { createServer } from 'node:net'; createServer().listen(${port}, '127.0.0.1');`);
    const lockRoot = join(process.env.BACKLOT_STATE_DIR!, 'appliances');

    // The existing race test used two callers in ONE process, which an
    // in-memory lock would satisfy just as well — it proved nothing about the
    // machine-wide claim. What makes the lock machine-wide is that it lives on
    // disk under the shared state root, where a separate process sees it.
    const start = `sleep 1; nohup node ${script} > /dev/null 2>&1 & echo started`;
    const spec = { probe: `127.0.0.1:${port}`, start, timeout: 20 };

    const inFlight = ensureAppliance('racy', spec, work.dir, silent);
    await new Promise((r) => setTimeout(r, 300));
    const held = readdirSync(lockRoot).filter((f) => f.endsWith('.lock'));
    expect(held.length, 'no lock on disk while a start is in flight').toBeGreaterThan(0);

    await inFlight;
    // Released once the start completes, so the next caller is not blocked.
    const after = readdirSync(lockRoot).filter((f) => f.endsWith('.lock'));
    expect(after.length).toBe(0);
    work.cleanup();
  }, 60_000);
});

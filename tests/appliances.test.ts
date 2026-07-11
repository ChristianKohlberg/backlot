/**
 * Appliances (decision 0018): ensured, never owned. These tests exercise the
 * driver directly — probe adoption, one-shot start with readiness, the
 * machine-wide start lock, infra-error classification — using throwaway TCP
 * listeners as stand-in servers so no real Docker/Postgres is needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

  it('adoption skips the ready: gate (it only guards the start path)', async () => {
    const port = await freePort();
    servers.push(await listen(port));
    const work = tempDir('appliance-ready');
    const marker = join(work.dir, 'ready.marker');
    // Probe answers (listener above) so adoption short-circuits before ready:
    // — the ready gate only guards the start path, by design. Assert that
    // contract: an unsatisfiable ready does not block adoption.
    const res = await ensureAppliance('db', { probe: `127.0.0.1:${port}`, ready: `test -f ${marker}` }, work.dir, silent);
    expect(res).toBe('up');
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

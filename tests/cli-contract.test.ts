/**
 * Fleet review, CLI/RPC contract cluster.
 *
 * The exit code and error class are a MACHINE contract (decision 0010): agents
 * branch on them without reading the message. Misreporting a dead daemon as an
 * environment error tells an agent to recycle an environment, which cannot
 * possibly help — so these assert the classification, not the prose.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyClientError } from '../src/cli/client.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const dirs: string[] = [];
const servers: Array<() => void> = [];

afterAll(() => {
  for (const close of servers) close();
  for (const d of dirs) {
    try {
      process.kill(Number(readFileSync(join(d, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* none */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe('client-side error classification', () => {
  it('reports an unreachable or wedged daemon as infra, never env', () => {
    // env-error means "the environment is bad — recycle it". None of these are
    // fixable that way, so classifying them as env sends an agent in circles.
    expect(classifyClientError(new Error('daemon did not come up — see /x/daemon.log'))).toBe('infra-error');
    expect(classifyClientError(new Error('daemon closed the stream without a result frame'))).toBe('infra-error');
    expect(classifyClientError(Object.assign(new Error('connect ECONNREFUSED'), {}))).toBe('infra-error');
    expect(classifyClientError(new Error('read ECONNRESET'))).toBe('infra-error');
  });

  it('honours an explicitly tagged class over the message heuristic', () => {
    expect(classifyClientError(Object.assign(new Error('anything at all'), { backlotClass: 'infra-error' }))).toBe('infra-error');
    expect(classifyClientError(Object.assign(new Error('daemon closed'), { backlotClass: 'env-error' }))).toBe('env-error');
  });

  it('leaves a genuine environment failure as env-error', () => {
    expect(classifyClientError(new Error('port 3000 is occupied by a foreign process'))).toBe('env-error');
  });
});

describe('a wedged daemon must not hang the caller forever', () => {
  it('destroys the request at the deadline and exits 3', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-wedge-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-wedge-wt-'));
    dirs.push(stateDir, wt);
    writeFileSync(join(wt, 'stack.yaml'), `name: wedge\nservices: {}\nchecks:\n  ok: { run: "true" }\n`);

    // A daemon that is ALIVE (answers ping, so the CLI does not just replace it)
    // but wedged on real work. This is the case req.setTimeout alone did nothing
    // about: Node emits 'timeout' and, with no handler, waits forever.
    const sock = join(stateDir, 'daemon.sock');
    const hung = createHttpServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const verb = (JSON.parse(body || '{}') as { verb?: string }).verb;
        if (verb === 'ping') {
          res.writeHead(200, { 'content-type': 'application/x-ndjson' });
          res.end(JSON.stringify({ type: 'result', ok: true, data: {} }) + '\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' }); // ...and then nothing
      });
    });
    await new Promise<void>((res) => hung.listen(sock, res));
    servers.push(() => hung.close());

    const started = Date.now();
    const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve) => {
      execFile(
        process.execPath,
        [CLI, 'status', '--json'],
        { cwd: wt, env: { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_RPC_TIMEOUT_MS: '1500' } },
        (err, out) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(out) }),
      );
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(30_000); // bounded, not hung
    // Contract: infra-error is exit 3, and the JSON body must agree.
    expect(code).toBe(3);
    const body = JSON.parse(stdout) as { ok: boolean; error: { class: string; message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.class).toBe('infra-error');
    expect(body.error.message).toMatch(/did not respond|wedged/i);
  }, 60_000);
});

describe('exec preserves argument boundaries', () => {
  it('keeps a quoted argument containing spaces as ONE argument', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-exec-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-exec-wt-'));
    dirs.push(stateDir, wt);
    writeFileSync(join(wt, 'stack.yaml'), `name: ex\nservices:\n  idle: { run: "echo ready; sleep 300", ready: { log: "ready", timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`);
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };
    const cli = (args: string[]) =>
      new Promise<string>((resolve) => {
        execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => resolve(String(out)));
      });

    await cli(['up', '--json']);
    // The caller's shell already split argv, so 'a b' is ONE argument and must
    // stay one. Joining on spaces silently turned it into two.
    const out = await cli(['exec', 'printf', '[%s]', 'a b', 'c']);
    expect(out).toContain('[a b]');
    expect(out).toContain('[c]');
    expect(out).not.toContain('[a][b]');
  }, 60_000);

  it('still treats a single token as a shell string, keeping redirection', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-exec2-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-exec2-wt-'));
    dirs.push(stateDir, wt);
    writeFileSync(join(wt, 'stack.yaml'), `name: ex2\nservices:\n  idle: { run: "echo ready; sleep 300", ready: { log: "ready", timeout: 20 } }\nchecks:\n  ok: { run: "true" }\n`);
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '500' };
    const cli = (args: string[]) =>
      new Promise<string>((resolve) => {
        execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 8 * 1024 * 1024 }, (_e, out) => resolve(String(out)));
      });

    await cli(['up', '--json']);
    await cli(['exec', 'echo shell-string-works > proof.txt']);
    const shown = await cli(['exec', 'cat proof.txt']);
    expect(shown).toContain('shell-string-works');
  }, 60_000);
});

describe('bounded flags are validated, not silently coerced', () => {
  it('rejects a non-numeric --lines instead of returning the whole log', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'backlot-lines-'));
    const wt = mkdtempSync(join(tmpdir(), 'backlot-lines-wt-'));
    dirs.push(stateDir, wt);
    writeFileSync(join(wt, 'stack.yaml'), `name: ln\nservices: {}\nchecks:\n  ok: { run: "true" }\n`);
    execFileSync('git', ['init', '-q'], { cwd: wt });
    const code = await new Promise<number>((resolve) => {
      execFile(
        process.execPath,
        [CLI, 'logs', 'web', '--lines', 'abc'],
        { cwd: wt, env: { ...process.env, BACKLOT_STATE_DIR: stateDir } },
        (err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0),
      );
    });
    expect(code).toBe(64); // usage error, per the documented exit-code contract
  }, 60_000);
});

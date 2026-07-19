/**
 * Fleet review, MCP adapter cluster. The adapter is the surface agents actually
 * drive, so a silent wrong default here is worse than an error.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const MCP = join(import.meta.dirname, '..', 'dist', 'mcp', 'index.js');

/**
 * Drive the adapter over stdio the way a real MCP client does. Resolves as soon
 * as every request id has been answered — the fixed 4s kill-and-parse window
 * this replaces was a single-shot guess, and under suite load adapter cold
 * start alone could eat it. These tests assert response SHAPE, not latency, so
 * the deadline is only a backstop against a wedged adapter (resolving whatever
 * arrived, so the assertions fail with the actual traffic in view).
 */
function talk(messages: unknown[], deadlineMs = 30_000): Promise<Record<string, unknown>[]> {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-mcp-'));
  const wanted = new Set(messages.map((m) => (m as { id?: number }).id).filter((id) => id !== undefined));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [MCP], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, BACKLOT_STATE_DIR: stateDir },
    });
    const responses: Record<string, unknown>[] = [];
    const finish = () => {
      clearTimeout(backstop);
      p.kill('SIGKILL');
      rmSync(stateDir, { recursive: true, force: true });
      resolve(responses);
    };
    const backstop = setTimeout(finish, deadlineMs);
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += String(d);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) responses.push(JSON.parse(line) as Record<string, unknown>);
      }
      if ([...wanted].every((id) => responses.some((r) => r.id === id))) finish();
    });
    for (const m of messages) p.stdin.write(JSON.stringify(m) + '\n');
  });
}

describe('MCP adapter', () => {
  it('reports the package version, not a stale literal', async () => {
    const out = await talk([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
    const info = (out.find((m) => m.id === 1)?.result as { serverInfo?: { version?: string } })?.serverInfo;
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version: string };
    // The literal had already drifted (0.4.0 while the package shipped 0.5.0),
    // so clients were told the wrong version of the tool they were driving.
    expect(info?.version).toBe(pkg.version);
  }, 30_000);

  it('refuses a call missing a required argument instead of guessing', async () => {
    const out = await talk([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'backlot_up', arguments: {} } },
    ]);
    const err = out.find((m) => m.id === 2)?.error as { code?: number; message?: string } | undefined;
    // Without cwd the daemon falls back to ITS OWN working directory, which
    // would operate on whatever stack happens to sit above it.
    expect(err?.code).toBe(-32602);
    expect(err?.message).toMatch(/requires: cwd/);
  }, 30_000);

  it('offers a holder so concurrent agents can avoid sharing one lease', async () => {
    const out = await talk([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);
    const tools = (out.find((m) => m.id === 2)?.result as { tools?: Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }> })?.tools ?? [];
    const up = tools.find((t) => t.name === 'backlot_up');
    expect(up).toBeTruthy();
    expect(up!.inputSchema.properties).toHaveProperty('holder');
  }, 30_000);
});

/**
 * Interactive session — unlike talk(), it reads responses as they arrive so a
 * test can poll (submit, then keep asking) the way a real agent does.
 */
function session(env: NodeJS.ProcessEnv) {
  const p = spawn(process.execPath, [MCP], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const responses: Record<string, unknown>[] = [];
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += String(d);
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) responses.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  const send = (msg: Record<string, unknown>) => p.stdin.write(JSON.stringify(msg) + '\n');
  const waitFor = async (id: number): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 300; i++) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`no response for id ${id}; got ${JSON.stringify(responses)}`);
  };
  return { send, waitFor, kill: () => p.kill('SIGKILL') };
}

describe('MCP detached runs (submit-and-poll over the same daemon)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-mcp-job-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir };
  const wt = mkdtempSync(join(tmpdir(), 'backlot-mcp-wt-'));
  cpSync(join(import.meta.dirname, '..', 'examples', 'hello-web'), wt, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: wt });
  execFileSync('git', ['add', '-A'], { cwd: wt });
  afterAll(() => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')));
    } catch {
      /* gone */
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });

  it('exposes the detach and job verbs as tools', async () => {
    const out = await talk([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);
    const names = ((out.find((m) => m.id === 2)?.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name);
    // Without these, an agent driving a slow bind over MCP can only block.
    expect(names).toContain('backlot_run_detach');
    expect(names).toContain('backlot_job');
    expect(names).toContain('backlot_job_ls');
  }, 30_000);

  it('submits a detached run and polls the job to a verdict', async () => {
    const s = session(env);
    try {
      s.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
      await s.waitFor(1);

      s.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'backlot_run_detach', arguments: { cwd: wt, check: 'smoke' } } });
      const submit = await s.waitFor(2);
      const submitBody = submit.result as { content: Array<{ text: string }>; isError: boolean };
      expect(submit.error, JSON.stringify(submit)).toBeUndefined();
      expect(submitBody.isError).toBe(false);
      const { jobId } = JSON.parse(submitBody.content[0]!.text) as { jobId: string };
      expect(jobId).toMatch(/^job-/);

      // The submit returned immediately; a poll loop — not a blocked call —
      // carries the run to its verdict.
      let job: { state?: string; verdict?: { ok?: boolean; check?: string; exitCode?: number } } = {};
      for (let i = 0; i < 100; i++) {
        s.send({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name: 'backlot_job', arguments: { jobId } } });
        const poll = await s.waitFor(10 + i);
        job = JSON.parse((poll.result as { content: Array<{ text: string }> }).content[0]!.text) as typeof job;
        if (job.state === 'done') break;
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(job.state).toBe('done');
      expect(job.verdict?.ok).toBe(true);
      expect(job.verdict?.check).toBe('smoke');
      expect(job.verdict?.exitCode).toBe(0);

      // The listing RPC is surfaced too, and it knows about our job.
      s.send({ jsonrpc: '2.0', id: 200, method: 'tools/call', params: { name: 'backlot_job_ls', arguments: {} } });
      const ls = await s.waitFor(200);
      const { jobs } = JSON.parse((ls.result as { content: Array<{ text: string }> }).content[0]!.text) as { jobs: Array<{ id: string }> };
      expect(jobs.map((j) => j.id)).toContain(jobId);
    } finally {
      s.kill();
    }
  }, 120_000);

  it('refuses backlot_job without a jobId instead of guessing', async () => {
    const out = await talk([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'backlot_job', arguments: {} } },
    ]);
    const err = out.find((m) => m.id === 2)?.error as { code?: number; message?: string } | undefined;
    expect(err?.code).toBe(-32602);
    expect(err?.message).toMatch(/requires: jobId/);
  }, 30_000);
});

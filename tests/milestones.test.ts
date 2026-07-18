/**
 * 0.3 + 0.4 surface: detached submit-and-poll runs, the deliberately-foreign
 * Python consumer, and the MCP adapter — all against the real daemon.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const MCP = join(repo, 'dist', 'mcp', 'index.js');

const hasPython = (() => {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function makeContext() {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-m34-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '400' };
  const cli = (args: string[], cwd: string): Promise<{ exitCode: number; json?: Record<string, unknown>; out: string }> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, json, out: String(stdout), stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const cleanup = async () => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')));
    } catch {
      /* gone */
    }
    rmSync(stateDir, { recursive: true, force: true });
  };
  return { stateDir, env, cli, cleanup };
}

function makeWorktree(example: string): { dir: string; drop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `backlot-wt-${example}-`));
  cpSync(join(repo, 'examples', example), dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return { dir, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------- 0.3

describe('detached runs (submit-and-poll, decision 0015)', () => {
  const ctx = makeContext();
  const wt = makeWorktree('hello-web');
  afterAll(async () => {
    await ctx.cleanup();
    wt.drop();
  });

  it('run --detach returns a jobId immediately; the verdict outlives the client', async () => {
    const submit = await ctx.cli(['run', 'smoke', '--detach', '--json'], wt.dir);
    expect(submit.exitCode, `stdout: ${submit.stdout ?? ''}\nstderr: ${submit.stderr ?? ''}`).toBe(0);
    const jobId = submit.json!.jobId as string;
    expect(jobId).toMatch(/^job-/);

    // The submitting "client" is gone; a NEW client polls until done.
    let job: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      job = (await ctx.cli(['job', jobId, '--json'], wt.dir)).json!;
      if (job.state === 'done') break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(job.state).toBe('done');
    expect((job.verdict as { ok: boolean }).ok).toBe(true);
  });

  it('polling an unknown job is an env-error', async () => {
    const res = await ctx.cli(['job', 'job-nope', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(2);
  });
});

// ---------------------------------------------------------------- 0.4: foreign consumer

describe.skipIf(!hasPython)('the foreign consumer (hello-python)', () => {
  const ctx = makeContext();
  const wt = makeWorktree('hello-python');
  afterAll(async () => {
    await ctx.cleanup();
    wt.drop();
  });

  it('a stdlib-Python stack gets the identical broker loop', async () => {
    const up = await ctx.cli(['up', '--json'], wt.dir);
    expect(up.exitCode, `stdout: ${up.stdout ?? ''}\nstderr: ${up.stderr ?? ''}`).toBe(0);
    const url = (up.json!.urls as Record<string, string>).web!;
    const facts = (await (await fetch(`${url}/api/facts`)).json()) as unknown[];
    expect(facts.length).toBe(3);

    const run = await ctx.cli(['run', 'smoke', '--json'], wt.dir);
    expect(run.exitCode, `stdout: ${run.stdout ?? ''}\nstderr: ${run.stderr ?? ''}`).toBe(0);
    expect(run.json!.ok).toBe(true);
  });
});

// ---------------------------------------------------------------- 0.4: MCP adapter

describe('MCP adapter (thin, over the same daemon)', () => {
  const ctx = makeContext();
  const wt = makeWorktree('hello-web');
  afterAll(async () => {
    await ctx.cleanup();
    wt.drop();
  });

  it('initialize -> tools/list -> tools/call backlot_up + backlot_release', async () => {
    const proc = spawn(process.execPath, [MCP], { env: ctx.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const responses: Record<string, unknown>[] = [];
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });
    const send = (msg: Record<string, unknown>) => proc.stdin.write(JSON.stringify(msg) + '\n');
    const waitFor = async (id: number): Promise<Record<string, unknown>> => {
      for (let i = 0; i < 300; i++) {
        const found = responses.find((r) => r.id === id);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no response for id ${id}; got ${JSON.stringify(responses)}`);
    };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    const init = await waitFor(1);
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('backlot');

    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await waitFor(2);
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toContain('backlot_up');
    expect(tools.map((t) => t.name)).toContain('backlot_run');

    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'backlot_up', arguments: { cwd: wt.dir } } });
    const up = await waitFor(3);
    const content = (up.result as { content: Array<{ text: string }>; isError: boolean });
    expect(content.isError).toBe(false);
    const blob = JSON.parse(content.content[0]!.text);
    expect(blob.state).toBe('hot');
    expect(blob.urls.web).toMatch(/^http:\/\/localhost:\d+$/);
    // The env the MCP tool leased genuinely serves.
    const greetings = (await (await fetch(`${blob.urls.web}/api/greetings`)).json()) as unknown[];
    expect(greetings.length).toBe(3);

    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'backlot_release', arguments: { cwd: wt.dir } } });
    const rel = await waitFor(4);
    expect(JSON.parse((rel.result as { content: Array<{ text: string }> }).content[0]!.text).released).toBe(true);

    proc.kill();
  }, 60_000);
});

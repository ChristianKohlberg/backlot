/**
 * Integration: the REAL product loop through the REAL CLI — daemon auto-spawn,
 * lease/bind/run/ctx/sync/exec/reset-data/release, crash recovery, lease
 * expiry, and the multi-service topology. Each block gets an isolated state
 * dir (its own daemon), exactly how a consumer machine would look.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: Record<string, unknown>;
}

function makeContext(extraEnv: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-it-'));
  const env = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '400', ...extraEnv };
  const cli = (args: string[], cwd: string): Promise<CliResult> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json verb */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr), json });
      });
    });
  const cleanup = async () => {
    try {
      const pid = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
      process.kill(pid);
    } catch {
      /* daemon already gone */
    }
    rmSync(stateDir, { recursive: true, force: true });
  };
  return { stateDir, cli, cleanup };
}

/** A consumer worktree: a git-initialized copy of an example (agents edit HERE). */
function makeWorktree(example: string): { dir: string; drop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `backlot-wt-${example}-`));
  cpSync(join(repo, 'examples', example), dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return { dir, drop: () => rmSync(dir, { recursive: true, force: true }) };
}

const fetchJson = async (url: string) => (await fetch(url)).json();

// ---------------------------------------------------------------------------

describe('the local loop (hello-web)', () => {
  const ctx = makeContext();
  const wt = makeWorktree('hello-web');
  afterAll(async () => {
    await ctx.cleanup();
    wt.drop();
  });

  let url = '';

  it('up: leases, seeds, starts, serves — and the ctx blob is complete', async () => {
    const res = await ctx.cli(['up', '--json'], wt.dir);
    expect(res.exitCode).toBe(0);
    const c = res.json!;
    expect(c.state).toBe('hot');
    url = (c.urls as Record<string, string>).web!;
    expect(url).toMatch(/^http:\/\/localhost:\d+$/);
    expect((c.datastores as Record<string, { url: string }>).main.url).toContain('main.db');
    const greetings = (await fetchJson(`${url}/api/greetings`)) as unknown[];
    expect(greetings.length).toBe(3);
  });

  it('bind-by-sync: edit the worktree, sync, same URL serves the new code', async () => {
    const src = readFileSync(join(wt.dir, 'server.mjs'), 'utf8').replace('<h1>hello-web</h1>', '<h1>hello-web EDITED</h1>');
    writeFileSync(join(wt.dir, 'server.mjs'), src);
    const res = await ctx.cli(['sync', '--json'], wt.dir);
    expect(res.exitCode).toBe(0);
    const page = await (await fetch(url)).text(); // SAME url — the watcher never moved
    expect(page).toContain('hello-web EDITED');
  });

  it('untracked files ride along with a binding', async () => {
    writeFileSync(join(wt.dir, 'scratch-note.txt'), 'dirty state travels');
    await ctx.cli(['sync'], wt.dir);
    const res = await ctx.cli(['exec', 'cat scratch-note.txt'], wt.dir);
    expect(res.stdout).toContain('dirty state travels');
  });

  it('reset-data restores the template; the URL stays stable', async () => {
    await ctx.cli(
      ['exec', `node -e 'const{DatabaseSync}=require("node:sqlite");new DatabaseSync(process.env.BACKLOT_DS_MAIN).prepare("INSERT INTO greetings (message) VALUES (?)").run("mutation")'`],
      wt.dir,
    );
    expect(((await fetchJson(`${url}/api/greetings`)) as unknown[]).length).toBe(4);
    const res = await ctx.cli(['reset-data', '--json'], wt.dir);
    expect(res.exitCode).toBe(0);
    expect((res.json!.urls as Record<string, string>).web).toBe(url);
    expect(((await fetchJson(`${url}/api/greetings`)) as unknown[]).length).toBe(3);
  });

  it('run smoke: second env from the pool, green verdict, lease auto-released', async () => {
    const res = await ctx.cli(['run', 'smoke', '--json'], wt.dir);
    expect(res.exitCode).toBe(0);
    const v = res.json!;
    expect(v.ok).toBe(true);
    expect(v.envId).not.toBe(''); // ran somewhere real
    const status = (await ctx.cli(['status', '--json'], wt.dir)).json!;
    const envs = status.envs as Array<{ id: string; lease: unknown }>;
    expect(envs.filter((e) => e.lease === null).length).toBeGreaterThan(0); // run lease released
  });

  it('crash recovery: kill -9 the daemon; next verb respawns, envs recover, port survives', async () => {
    const pid = Number(readFileSync(join(ctx.stateDir, 'daemon.pid'), 'utf8'));
    process.kill(pid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    const status = (await ctx.cli(['status', '--json'], wt.dir)).json!;
    const envs = status.envs as Array<{ state: string }>;
    expect(envs.every((e) => e.state === 'warm')).toBe(true); // hot -> warm on recovery
    const res = await ctx.cli(['up', '--json'], wt.dir);
    expect((res.json!.urls as Record<string, string>).web).toBe(url); // ports are the env's, not the daemon's
  });

  it('release returns the env to the pool without tearing it down', async () => {
    const res = await ctx.cli(['release', '--json'], wt.dir);
    expect(res.json!.released).toBe(true);
    const status = (await ctx.cli(['status', '--json'], wt.dir)).json!;
    expect((status.envs as unknown[]).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('verdicts, outputs, and the error taxonomy', () => {
  const ctx = makeContext();
  const wt = makeWorktree('hello-web');
  afterAll(async () => {
    await ctx.cleanup();
    wt.drop();
  });

  it('a failing check is a work-error verdict with the check exit code', async () => {
    appendFileSync(
      join(wt.dir, 'stack.yaml'),
      `  fail:\n    run: node -e 'console.error("boom"); process.exit(3)'\n`,
    );
    const res = await ctx.cli(['run', 'fail', '--json'], wt.dir);
    expect(res.exitCode).toBe(1); // CLI contract: failed run exits 1
    const v = res.json!;
    expect(v.ok).toBe(false);
    expect(v.exitCode).toBe(3);
    expect((v.failure as { class: string }).class).toBe('work-error');
  });

  it('an unknown check is a work-error naming the available checks', async () => {
    const res = await ctx.cli(['run', 'nope', '--json'], wt.dir);
    expect(res.exitCode).toBe(1);
    expect((res.json!.error as { message: string }).message).toContain('smoke');
  });

  it('outputs contract: env-produced files are reported, pulled only explicitly', async () => {
    appendFileSync(join(wt.dir, 'stack.yaml'), `outputs: [generated.txt]\n`);
    await ctx.cli(['up'], wt.dir);
    await ctx.cli(['exec', 'echo produced-in-env > generated.txt'], wt.dir);
    expect(existsSync(join(wt.dir, 'generated.txt'))).toBe(false); // never written silently
    const pull = await ctx.cli(['pull', '--json'], wt.dir);
    expect(pull.json!.pulled).toEqual(['generated.txt']);
    expect(readFileSync(join(wt.dir, 'generated.txt'), 'utf8')).toContain('produced-in-env');
  });

  it('ctx without a lease is an env-error telling you the fix', async () => {
    const bare = makeWorktree('hello-web');
    const res = await ctx.cli(['ctx', '--json'], bare.dir);
    expect(res.exitCode).toBe(2);
    expect((res.json!.error as { message: string }).message).toContain("backlot up");
    bare.drop();
  });
});

// ---------------------------------------------------------------------------

describe('lease expiry (disposable leases, durable environments)', () => {
  const ctx = makeContext({ BACKLOT_LEASE_TTL_MS: '1200', BACKLOT_SWEEP_MS: '300' });
  const wt = makeWorktree('hello-web');
  afterAll(async () => {
    await ctx.cleanup();
    wt.drop();
  });

  it('an abandoned lease lapses; the environment survives warm-hot in the pool', async () => {
    const up = await ctx.cli(['up', '--json'], wt.dir);
    const envId = up.json!.envId;
    await new Promise((r) => setTimeout(r, 2500)); // agent disappears
    const status = (await ctx.cli(['status', '--json'], wt.dir)).json!;
    const env = (status.envs as Array<{ id: string; lease: unknown; state: string }>).find((e) => e.id === envId)!;
    expect(env.lease).toBeNull(); // lease gone
    expect(env.state).toBe('hot'); // environment untouched
    const again = await ctx.cli(['up', '--json'], wt.dir); // agent returns
    expect(again.json!.envId).toBe(envId); // same env, cheap rebind
  });
});

// ---------------------------------------------------------------------------

describe('the multi-service topology (hello-multi)', () => {
  const ctx = makeContext();
  const wt = makeWorktree('hello-multi');
  afterAll(async () => {
    await ctx.cleanup();
    wt.drop();
  });

  it('up brings api + web + portless worker to ready, in dependency order', async () => {
    const res = await ctx.cli(['up', '--json'], wt.dir);
    expect(res.exitCode).toBe(0);
    const urls = res.json!.urls as Record<string, string>;
    expect(urls.api).toBeDefined();
    expect(urls.web).toBeDefined();
    const page = await (await fetch(urls.web!)).text();
    expect(page).toContain('showpiece'); // session preset is `demo` (default_preset.session)
    const logs = await ctx.cli(['logs', 'worker', '--lines', '5'], wt.dir);
    expect(logs.stdout).toContain('worker ready');
  });

  it('run smoke uses the run preset (dev), collects the artifact, verdict green', async () => {
    const res = await ctx.cli(['run', 'smoke', '--json'], wt.dir);
    expect(res.exitCode).toBe(0);
    const v = res.json!;
    expect(v.ok).toBe(true);
    expect(v.artifactsDir).toBeTruthy();
    const files = readdirSync(v.artifactsDir as string);
    expect(files).toContain('smoke-report.json');
  });

  it('pool recycle clears unleased environments', async () => {
    await ctx.cli(['release'], wt.dir);
    const res = await ctx.cli(['pool', 'recycle', '--json'], wt.dir);
    expect((res.json!.recycled as string[]).length).toBeGreaterThan(0);
  });
});

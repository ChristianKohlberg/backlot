/**
 * Integration: the REAL product loop through the REAL CLI — daemon auto-spawn,
 * lease/bind/run/ctx/sync/exec/reset-data/release, crash recovery, lease
 * expiry, and the multi-service topology. Each block gets an isolated state
 * dir (its own daemon), exactly how a consumer machine would look.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
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
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
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
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
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
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    expect((res.json!.urls as Record<string, string>).web).toBe(url);
    expect(((await fetchJson(`${url}/api/greetings`)) as unknown[]).length).toBe(3);
  });

  it('run smoke: second env from the pool, green verdict, lease auto-released', async () => {
    const res = await ctx.cli(['run', 'smoke', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
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

describe('bind --ref preserves the lease clock (hello-web)', () => {
  const ctx = makeContext();
  const wt = makeWorktree('hello-web');
  beforeAll(() => {
    // bind --ref resolves a COMMIT, so the fixture needs one.
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: wt.dir });
  });
  afterAll(async () => {
    await ctx.cleanup();
    wt.drop();
  });

  it('re-pointing a ref keeps the existing TTL; --ttl overrides it', async () => {
    const remainingMin = (r: CliResult) => ((r.json!.lease as { expiresAt: number }).expiresAt - Date.now()) / 60_000;

    let res = await ctx.cli(['up', '--ttl', '480', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
    expect(remainingMin(res)).toBeGreaterThan(470); // ~480
    expect(remainingMin(res)).toBeLessThan(481);

    // The bug: bind --ref used to reset the lease to the ~30-min default. Bounds
    // are pinned both sides so a wrong impl that extends (not just shortens) fails.
    res = await ctx.cli(['bind', '--ref', 'HEAD', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
    expect(remainingMin(res)).toBeGreaterThan(470); // still ~480, not shortened
    expect(remainingMin(res)).toBeLessThan(481);

    // Explicit --ttl on bind sets the clock in one operation.
    res = await ctx.cli(['bind', '--ref', 'HEAD', '--ttl', '600', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
    expect(remainingMin(res)).toBeGreaterThan(590); // ~600
    expect(remainingMin(res)).toBeLessThan(601);
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
      join(wt.dir, 'backlot.yml'),
      `  fail:\n    run: node -e 'console.error("boom"); process.exit(3)'\n`,
    );
    const res = await ctx.cli(['run', 'fail', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(1); // CLI contract: failed run exits 1
    const v = res.json!;
    expect(v.ok).toBe(false);
    expect(v.exitCode, `stdout: ${v.stdout ?? ''}\nstderr: ${v.stderr ?? ''}`).toBe(3);
    expect((v.failure as { class: string }).class).toBe('work-error');
  });

  it('an unknown check is a work-error naming the available checks', async () => {
    const res = await ctx.cli(['run', 'nope', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(1);
    expect((res.json!.error as { message: string }).message).toContain('smoke');
  });

  it('outputs contract: env-produced files are reported, pulled only explicitly', async () => {
    appendFileSync(join(wt.dir, 'backlot.yml'), `outputs: [generated.txt]\n`);
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
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(2);
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
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    const urls = res.json!.urls as Record<string, string>;
    expect(urls.api).toBeDefined();
    expect(urls.web).toBeDefined();
    const page = await (await fetch(urls.web!)).text();
    expect(page).toContain('showpiece'); // session preset is `demo` (default_preset.session)
    const logs = await ctx.cli(['logs', 'worker', '--lines', '5'], wt.dir);
    expect(logs.stdout).toContain('worker ready');
  });

  it('up <service> starts only its slice and genuinely stops what it excludes', async () => {
    // Full app first: capture web's URL and confirm it actually serves.
    let res = await ctx.cli(['up', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    const webUrl = (res.json!.urls as Record<string, string>).web!;
    expect((await fetch(webUrl)).ok).toBe(true);

    // `up api` — api's closure excludes web, so web must genuinely STOP (its
    // stable port stops answering), not merely vanish from the ctx blob.
    res = await ctx.cli(['up', 'api', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    let urls = res.json!.urls as Record<string, string>;
    expect(urls.api).toBeDefined();
    expect(urls.web).toBeUndefined(); // filtered from ctx
    await expect(fetch(webUrl)).rejects.toThrow(); // AND the process is down

    // A rebind preserves the slice: reset-data must not resurrect web.
    res = await ctx.cli(['reset-data', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    await expect(fetch(webUrl)).rejects.toThrow();

    // `up web` — web depends_on api, so the closure pulls api back in and serves.
    res = await ctx.cli(['up', 'web', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    urls = res.json!.urls as Record<string, string>;
    expect(urls.api).toBeDefined();
    expect((await fetch(urls.web!)).ok).toBe(true);

    // Plain `up` on this SAME live lease re-expands to the whole app: the []
    // request overrides the preserved slice, so the excluded worker restarts.
    // (Guards the []-vs-undefined RPC distinction the design hinges on.)
    res = await ctx.cli(['up', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    const workerLogs = await ctx.cli(['logs', 'worker', '--lines', '5'], wt.dir);
    expect(workerLogs.stdout).toContain('worker ready');

    // An unknown service is a work-error naming the declared ones, not a crash.
    const bad = await ctx.cli(['up', 'nope', '--json'], wt.dir);
    expect(bad.exitCode).toBe(1);
    expect((bad.json!.error as { message: string }).message).toContain("no service 'nope'");
  });

  it('run smoke uses the run preset (dev), collects the artifact, verdict green', async () => {
    const res = await ctx.cli(['run', 'smoke', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
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

// ---------------------------------------------------------------------------

describe('a slice does not leak across a pool handoff (hello-multi)', () => {
  const ctx = makeContext();
  const wt = makeWorktree('hello-multi');
  afterAll(async () => {
    await ctx.cleanup();
    wt.drop();
  });

  it('a released subset env hands the next holder the whole app, not the leftover slice', async () => {
    // Holder A takes an api-only slice, then releases the env back to the pool.
    let res = await ctx.cli(['up', 'api', '--holder', 'agentA', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    expect((res.json!.urls as Record<string, string>).web).toBeUndefined();
    res = await ctx.cli(['release', '--holder', 'agentA', '--json'], wt.dir);
    expect(res.exitCode).toBe(0);

    // Holder B arrives via sync as first contact — never asked for a slice, so it
    // must get the FULL app, not agentA's leftover api-only shape. (Regression:
    // tryClaim used to hand the fresh claim the previous owner's activeServices.)
    res = await ctx.cli(['sync', '--holder', 'agentB', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    const urls = res.json!.urls as Record<string, string>;
    expect(urls.api).toBeDefined();
    expect(urls.web).toBeDefined();
  });

  it('re-claiming a released slice via the fast path reports only the slice, not the whole app', async () => {
    // sliceA runs api only, then releases — the env stays hot with just api up.
    await ctx.cli(['up', 'api', '--holder', 'sliceA', '--json'], wt.dir);
    await ctx.cli(['release', '--holder', 'sliceA', '--json'], wt.dir);
    // sliceB re-claims with the SAME slice: the fast path reuses the hot env
    // (running {api} == requested {api}). ctx must report only api — regression:
    // the fast path skipped writing activeServices, so a fresh-claim-cleared env
    // was journaled as "whole app" while only api ran, and ctx advertised a dead
    // web URL.
    const res = await ctx.cli(['up', 'api', '--holder', 'sliceB', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    const urls = res.json!.urls as Record<string, string>;
    expect(urls.api).toBeDefined();
    expect(urls.web).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('a failed first bind on a re-claimed env keeps ctx truthful (hello-multi)', () => {
  const ctx = makeContext();
  const wt = makeWorktree('hello-multi');
  afterAll(async () => {
    await ctx.cleanup();
    wt.drop();
  });

  it('advertises only the services actually running, even when the bind fails early', async () => {
    // Holder A runs api only, then releases — the env stays hot with just api up.
    await ctx.cli(['up', 'api', '--holder', 'fbA', '--json'], wt.dir);
    await ctx.cli(['release', '--holder', 'fbA', '--json'], wt.dir);

    // Break the worktree so holder B's first (full) bind fails BEFORE it stops or
    // starts anything: a failing upkeep rule that fires on the manifest itself.
    const mf = join(wt.dir, 'backlot.yml');
    writeFileSync(
      mf,
      readFileSync(mf, 'utf8').replace(
        '- { when: seed.mjs, run: "@rebake-template main" }',
        '- { when: backlot.yml, run: "false" }',
      ),
    );
    const failed = await ctx.cli(['up', '--holder', 'fbB', '--json'], wt.dir);
    expect(failed.exitCode).not.toBe(0); // bind failed on the upkeep rule, before any teardown

    // The env still has only api running (A's slice, never torn down). ctx must
    // advertise api and NOT web — regression: a claim-time shape clear used to
    // journal this env as "whole app" and advertise a dead web URL after the
    // early failure. The shape is only ever written once the bind reconciles.
    const res = await ctx.cli(['ctx', '--holder', 'fbB', '--json'], wt.dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    const urls = res.json!.urls as Record<string, string>;
    expect(urls.api).toBeDefined();
    expect(urls.web).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

describe('a slice builds per service, not gated by the whole-source stamp', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-bf-'));
  const cliEnv = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '400' };
  const wt = mkdtempSync(join(tmpdir(), 'backlot-bfwt-'));
  const cli = (args: string[]): Promise<CliResult> =>
    new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env: cliEnv, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json verb */
        }
        resolve({ exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr), json });
      });
    });

  beforeAll(() => {
    // `built` produces its run artifact in a build step; if the build is skipped
    // the run command has nothing to launch. `keep` is a plain always-up service.
    writeFileSync(
      join(wt, 'backlot.yml'),
      [
        'name: buildfp',
        'services:',
        '  keep:',
        '    run: node keep.js',
        '    port: keep',
        '    env: { PORT: "{{ports.keep}}" }',
        '    ready: { http: / }',
        '  built:',
        '    build: node build.js',
        '    run: node out/server.js',
        '    port: built',
        '    env: { PORT: "{{ports.built}}" }',
        '    ready: { http: / }',
        '',
      ].join('\n'),
    );
    writeFileSync(join(wt, 'keep.js'), 'require("http").createServer((q,s)=>s.end("keep")).listen(process.env.PORT)\n');
    writeFileSync(
      join(wt, 'build.js'),
      'const fs=require("fs");fs.mkdirSync("out",{recursive:true});fs.writeFileSync("out/server.js",\'require("http").createServer((q,s)=>s.end("built")).listen(process.env.PORT)\')\n',
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
    execFileSync('git', ['add', '-A'], { cwd: wt });
  });

  afterAll(() => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')));
    } catch {
      /* daemon already gone */
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });

  it('up <sliceA> then up <sliceB-with-a-build> builds sliceB rather than running it unbuilt', async () => {
    // Bring up only `keep`; `built` is excluded, so its build never runs.
    let res = await cli(['up', 'keep', '--json']);
    expect(res.exitCode, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
    expect((res.json!.urls as Record<string, string>).built).toBeUndefined();

    // Now bring up `built`. Its build MUST run (creating out/server.js) so it can
    // serve — regression: the keep-only bind used to stamp the whole-source
    // '@source' fingerprint as "built", so this bind skipped built's build and
    // its run failed on the missing artifact (or served stale code).
    res = await cli(['up', 'built', '--json']);
    expect(res.exitCode, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(0);
    const builtUrl = (res.json!.urls as Record<string, string>).built;
    expect(builtUrl).toBeDefined();
    expect(await (await fetch(builtUrl!)).text()).toBe('built');
  });
});

// ---------------------------------------------------------------------------

describe('logs for a silent service (BACKLOG P3, 2026-07-03)', () => {
  const ctx = makeContext();
  // A service that boots (cmd readiness) but never writes a byte — so no
  // .log file ever exists for it.
  const dir = mkdtempSync(join(tmpdir(), 'backlot-wt-silent-'));
  writeFileSync(
    join(dir, 'stack.yaml'),
    `name: silent\nservices:\n  quiet:\n    run: sleep 300\n    ready: { cmd: "true", timeout: 20 }\n`,
  );
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  afterAll(async () => {
    await ctx.cleanup();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a service that has produced no output has an empty log — not a false env-error', async () => {
    const up = await ctx.cli(['up', '--json'], dir);
    expect(up.exitCode, `stdout: ${up.stdout ?? ''}\nstderr: ${up.stderr ?? ''}`).toBe(0);
    const res = await ctx.cli(['logs', 'quiet', '--json'], dir);
    expect(res.exitCode, `stdout: ${res.stdout ?? ''}\nstderr: ${res.stderr ?? ''}`).toBe(0);
    expect((res.json as { lines: string }).lines).toBe('');
  });

  it('a service the manifest never declared is still an error, naming the real ones', async () => {
    const res = await ctx.cli(['logs', 'nope', '--json'], dir);
    expect(res.exitCode).not.toBe(0);
    expect(String((res.json!.error as { message: string }).message)).toContain('quiet');
  });
});

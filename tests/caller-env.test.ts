import { afterAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redactStream, validateCallerEnv } from '../src/core/caller-env.js';

const CLI = join(import.meta.dirname, '../dist/cli/index.js');
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups) await cleanup(); });

function fixture(mode: 'required' | 'optional' = 'optional', logReady = false) {
  // realpath: macOS's tmpdir is a symlink (/var -> /private/var), and a stack's
  // identity hashes its root path. A CLI child's process.cwd() reports the
  // resolved path, so an MCP tool cwd given as the symlink would name a
  // different stack than the CLI verbs that follow it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bl-inputs-')));
  const state = join(root, 'state');
  const tree = join(root, 'tree');
  execFileSync('mkdir', ['-p', tree]);
  execFileSync('git', ['init', '-q'], { cwd: tree });
  writeFileSync(join(tree, 'server.mjs'), `import {createServer} from 'node:http';
const secret = process.env.TEST_CALLER_KEY;
if (secret) { process.stdout.write(secret.slice(0, 3)); setTimeout(() => console.log(secret.slice(3)), 30); }
createServer((q,s) => s.end(JSON.stringify({value:secret ?? null,pid:process.pid,extra:process.env.TEST_UNDECLARED ?? null}))).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('ready'));
`);
  writeFileSync(join(tree, 'backlot.yml'), `name: inputs
services:
  web:
    run: node server.mjs
    port: web
    hot_reload: true
    env: { PORT: '{{ports.web}}' }
    env_from: { TEST_CALLER_KEY: ${mode} }
    ready: { ${logReady ? 'log: ready' : 'http: /'}, timeout: 10 }
checks:
  ok: { run: 'true' }
`);
  const base: NodeJS.ProcessEnv = { ...process.env, BACKLOT_STATE_DIR: state, BACKLOT_POOL_MAX: '2', BACKLOT_POOL_MAX_TOTAL: '2' };
  delete base.TEST_CALLER_KEY;
  delete base.TEST_UNDECLARED;
  const cli = (args: string[], vars: NodeJS.ProcessEnv = {}, cwd = tree) => new Promise<{ code: number; json: any; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [CLI, ...args, ...(args.includes('--json') ? [] : ['--json'])], { cwd, env: { ...base, ...vars }, timeout: 25_000 }, (error, stdout, stderr) => {
      let json: unknown;
      try { json = JSON.parse(stdout); } catch { json = null; }
      resolve({ code: error ? Number(error.code ?? 1) : 0, json, stdout, stderr });
    });
  });
  cleanups.push(async () => {
    await cli(['pool', 'recycle', '--force']);
    await cli(['daemon', 'stop']);
    rmSync(root, { recursive: true, force: true });
  });
  const response = async (context: any) => {
    const url = context.urls.web.replace('localhost', '127.0.0.1');
    return await (await fetch(url)).json() as { value: string | null; pid: number; extra: string | null };
  };
  // `daemon stop` now blocks until the old pid is gone; the poll below is a
  // belt-and-braces guard so a fixture failure surfaces here, not as a verb
  // that reached a half-closed socket.
  const restartDaemon = async () => {
    const pid = Number(readFileSync(join(state, 'daemon.pid'), 'utf8'));
    expect((await cli(['daemon', 'stop'])).code).toBe(0);
    for (let i = 0; i < 200; i++) {
      try { process.kill(pid, 0); } catch { return; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`daemon ${pid} did not exit after stop`);
  };
  return { root, state, tree, cli, response, restartDaemon };
}

describe('caller environment inputs', () => {
  it('refreshes explicitly, retains through sync/reset, isolates holders, and never persists values', async () => {
    const f = fixture();
    const secret = 'caller-sensitive-value-123';
    const nextSecret = 'caller-sensitive-value-456';
    // Boot the daemon with a stale same-named value: omission must mask it.
    expect((await f.cli(['status'], { TEST_CALLER_KEY: 'stale-daemon-value' }, f.root)).code).toBe(0);
    const first = await f.cli(['up', '--holder', 'a'], { TEST_CALLER_KEY: secret, TEST_UNDECLARED: 'must-not-forward' });
    expect(first.code, first.stderr + first.stdout).toBe(0);
    const original = await f.response(first.json);
    expect(original).toMatchObject({ value: secret, extra: null });
    const same = await f.cli(['up', '--holder', 'a'], { TEST_CALLER_KEY: secret });
    expect((await f.response(same.json)).pid).toBe(original.pid);
    const synced = await f.cli(['sync', '--holder', 'a']);
    expect((await f.response(synced.json)).value).toBe(secret);
    const reset = await f.cli(['reset-data', '--holder', 'a']);
    expect(reset.code, reset.stderr + reset.stdout).toBe(0);
    expect((await f.response(reset.json)).value).toBe(secret);
    const changed = await f.cli(['up', '--holder', 'a'], { TEST_CALLER_KEY: nextSecret });
    expect((await f.response(changed.json)).value).toBe(nextSecret);
    expect(changed.json.bindDiagnostics.reasons).toContain('environment-inputs-changed');
    const second = await f.cli(['up', '--holder', 'b']);
    expect((await f.response(second.json)).value).toBeNull();
    expect((await f.response(changed.json)).value).toBe(nextSecret);
    const cleared = await f.cli(['up', '--holder', 'a']);
    expect((await f.response(cleared.json)).value).toBeNull();
    const views = await Promise.all([f.cli(['status']), f.cli(['ctx', '--holder', 'a']), f.cli(['logs', 'web', '--holder', 'a'])]);
    for (const value of [secret, nextSecret]) {
      expect(JSON.stringify([first, same, synced, reset, changed, ...views])).not.toContain(value);
      const checkFiles = (dir: string) => {
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, item.name);
          if (item.isDirectory()) checkFiles(path);
          else if (item.isFile()) expect(readFileSync(path).includes(Buffer.from(value)), path).toBe(false);
        }
      };
      checkFiles(f.state);
    }
  }, 30_000);

  it('does not transfer input values with a released warm environment', async () => {
    const f = fixture();
    const first = await f.cli(['up', '--holder', 'old'], { TEST_CALLER_KEY: 'old-holder-secret' });
    const original = await f.response(first.json);
    expect((await f.cli(['release', '--holder', 'old'])).code).toBe(0);
    const next = await f.cli(['up', '--holder', 'new']);
    expect(next.json.envId).toBe(first.json.envId);
    const current = await f.response(next.json);
    expect(current.value).toBeNull();
    expect(current.pid).not.toBe(original.pid);
  });

  it('rejects required inputs before claiming and requires resupply after daemon restart', async () => {
    const f = fixture('required');
    const missing = await f.cli(['up']);
    expect(missing.code).toBe(1);
    expect(missing.json.error.message).toContain('TEST_CALLER_KEY');
    expect((await f.cli(['status'])).json.envs).toHaveLength(0);
    const first = await f.cli(['up'], { TEST_CALLER_KEY: 'restart-sensitive-key' });
    expect(first.code).toBe(0);
    await f.restartDaemon();
    const sync = await f.cli(['sync']);
    expect(sync.code).toBe(1);
    expect(sync.json.error.message).toContain('daemon restarts');
    const restored = await f.cli(['up'], { TEST_CALLER_KEY: 'fresh-key' });
    expect(restored.json.lease.id).toBe(first.json.lease.id);
    expect((await f.response(restored.json)).value).toBe('fresh-key');
  });

  it('passes fresh inputs to isolated synchronous and detached check leases', async () => {
    const f = fixture('required');
    expect((await f.cli(['run', 'ok'], { TEST_CALLER_KEY: 'run-private-key' })).json.ok).toBe(true);
    const submitted = await f.cli(['run', 'ok', '--detach'], { TEST_CALLER_KEY: 'detached-private-key' });
    expect(submitted.code).toBe(0);
    let job;
    for (let i = 0; i < 50; i++) {
      job = await f.cli(['job', submitted.json.jobId]);
      if (job.json.state === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(job?.json.verdict.ok).toBe(true);
  });

  it('clears optional inputs across restart and declaration removal/readdition on sync', async () => {
    const f = fixture();
    // Removal restores ordinary daemon inheritance, so boot without this name.
    expect((await f.cli(['status'])).code).toBe(0);
    const first = await f.cli(['up'], { TEST_CALLER_KEY: 'optional-secret' });
    expect(first.code).toBe(0);
    const manifest = readFileSync(join(f.tree, 'backlot.yml'), 'utf8');
    writeFileSync(join(f.tree, 'backlot.yml'), manifest.replace('    env_from: { TEST_CALLER_KEY: optional }\n', ''));
    const removed = await f.cli(['sync']);
    expect(removed.code, removed.stderr + removed.stdout).toBe(0);
    expect((await f.response(removed.json)).value).toBeNull();
    writeFileSync(join(f.tree, 'backlot.yml'), manifest);
    const restored = await f.cli(['sync']);
    expect((await f.response(restored.json)).value).toBeNull();
    expect((await f.cli(['up'], { TEST_CALLER_KEY: 'optional-secret' })).code).toBe(0);
    await f.restartDaemon();
    const restarted = await f.cli(['sync']);
    expect((await f.response(restarted.json)).value).toBeNull();
  });

  it('keeps a templated manifest default for an omitted optional input and masks the daemon without one', async () => {
    const f = fixture();
    writeFileSync(join(f.tree, 'backlot.yml'), readFileSync(join(f.tree, 'backlot.yml'), 'utf8')
      .replace("env: { PORT: '{{ports.web}}' }", "env: { PORT: '{{ports.web}}', TEST_CALLER_KEY: 'default-{{ports.web}}' }"));
    // Boot the daemon with a same-named value: the manifest default must win over it.
    expect((await f.cli(['status'], { TEST_CALLER_KEY: 'stale-daemon-value' }, f.root)).code).toBe(0);
    const defaulted = await f.cli(['up']);
    expect(defaulted.code, defaulted.stderr + defaulted.stdout).toBe(0);
    const port = new URL(defaulted.json.urls.web).port;
    expect((await f.response(defaulted.json)).value).toBe(`default-${port}`);
    const logs = await f.cli(['logs', 'web']);
    expect(logs.stdout).toContain(`default-${port}`.slice(0, 3));
    expect(logs.stdout).not.toContain('[redacted]');
    const supplied = await f.cli(['up'], { TEST_CALLER_KEY: 'caller-wins' });
    expect((await f.response(supplied.json)).value).toBe('caller-wins');
    expect(supplied.json.bindDiagnostics.reasons).toContain('environment-inputs-changed');
    const returned = await f.cli(['up']);
    expect((await f.response(returned.json)).value).toBe(`default-${port}`);
    // Drop the default again: omission now masks the daemon's own value.
    writeFileSync(join(f.tree, 'backlot.yml'), readFileSync(join(f.tree, 'backlot.yml'), 'utf8')
      .replace(", TEST_CALLER_KEY: 'default-{{ports.web}}'", ''));
    const masked = await f.cli(['up']);
    expect(masked.code, masked.stderr + masked.stdout).toBe(0);
    expect((await f.response(masked.json)).value).toBeNull();
  }, 30_000);

  it('binds a preserved slice whose service left the manifest instead of refusing before the claim', async () => {
    const f = fixture();
    // No hot_reload: sync must take the full bind, which is where the pre-claim check runs.
    const manifest = readFileSync(join(f.tree, 'backlot.yml'), 'utf8').replace('    hot_reload: true\n', '').replace('checks:\n', [
      '  worker:',
      '    run: node server.mjs',
      '    port: worker',
      "    env: { PORT: '{{ports.worker}}' }",
      '    ready: { http: /, timeout: 10 }',
      'checks:',
      '',
    ].join('\n'));
    writeFileSync(join(f.tree, 'backlot.yml'), manifest);
    const slice = await f.cli(['up', 'worker']);
    expect(slice.code, slice.stderr + slice.stdout).toBe(0);
    expect(Object.keys(slice.json.urls)).toEqual(['worker']);
    writeFileSync(join(f.tree, 'backlot.yml'), manifest.replace(/  worker:\n(    .*\n)+/, ''));
    const synced = await f.cli(['sync']);
    expect(synced.code, synced.stderr + synced.stdout).toBe(0);
    expect(Object.keys(synced.json.urls)).toEqual(['web']);
    const explicit = await f.cli(['up', 'worker']);
    expect(explicit.code).toBe(1);
    expect(explicit.json.error.message).toContain("no service 'worker'");
  }, 30_000);

  it('validates required inputs before converting a data-only lease to an application', async () => {
    const f = fixture('required');
    writeFileSync(join(f.tree, 'seed.mjs'), `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[2]); db.exec('CREATE TABLE IF NOT EXISTS t(x)');db.close();`);
    writeFileSync(join(f.tree, 'backlot.yml'), readFileSync(join(f.tree, 'backlot.yml'), 'utf8') + `datastores:\n  main: { driver: sqlite, create: 'node seed.mjs {{ns}}' }\n`);
    const data = await f.cli(['up', '--data-only']);
    expect(data.code, data.stdout + data.stderr).toBe(0);
    const missing = await f.cli(['up']);
    expect(missing.code).toBe(1);
    expect((await f.cli(['ctx'])).json.dataOnly).toBe(true);
    const app = await f.cli(['up'], { TEST_CALLER_KEY: 'application-key' });
    expect(app.json.envId).toBe(data.json.envId);
    expect((await f.response(app.json)).value).toBe('application-key');
  });

  it('matches readiness against raw in-memory output while keeping logs redacted', async () => {
    const f = fixture('required', true);
    const result = await f.cli(['up'], { TEST_CALLER_KEY: 'ready' });
    expect(result.code, result.stdout + result.stderr).toBe(0);
    const logs = await f.cli(['logs', 'web']);
    expect(logs.stdout).not.toContain('ready');
    expect(logs.stdout).toContain('[redacted]');
  });

  it('keeps cold-start caller inputs out of shared daemon, exec, checks and unconfigured services', async () => {
    const f = fixture();
    const plainService = [
      '  plain:',
      '    run: node server.mjs',
      '    port: plain',
      "    env: { PORT: '{{ports.plain}}' }",
      '    ready: { http: /, timeout: 10 }',
      '',
    ].join('\n');
    const manifest = readFileSync(join(f.tree, 'backlot.yml'), 'utf8')
      .replace('checks:\n', plainService + 'checks:\n')
      .replace("ok: { run: 'true' }", "ok: { run: 'node assert-clean.mjs' }");
    writeFileSync(join(f.tree, 'backlot.yml'), manifest);
    writeFileSync(join(f.tree, 'assert-clean.mjs'), "if(process.env.TEST_CALLER_KEY !== undefined) process.exit(12);console.log('clean');\n");
    // No status/prewarm: this command must create the actual shared daemon.
    const cold = await f.cli(['up'], { TEST_CALLER_KEY: 'first-caller-secret' });
    expect(cold.code, cold.stderr + cold.stdout).toBe(0);
    expect((await f.response(cold.json)).value).toBe('first-caller-secret');
    expect((await f.response({ urls: { web: cold.json.urls.plain } })).value).toBeNull();
    const exec = await f.cli(['exec', '--json', 'node assert-clean.mjs']);
    expect(exec.json.exitCode, exec.stdout + exec.stderr).toBe(0);
    expect(exec.json.stdout.trim()).toBe('clean');
    const run = await f.cli(['run', 'ok'], { TEST_CALLER_KEY: 'second-caller-secret' });
    expect(run.json.ok, run.stdout + run.stderr).toBe(true);
    expect(run.json.output).toContain('clean');
    expect((await f.cli(['status'], {}, f.root)).code).toBe(0);
    expect((await f.cli(['doctor'], {}, f.root)).code).toBe(0);
  });

  it('sanitizes cold MCP autospawn using tool cwd, not the adapter working directory', async () => {
    const f = fixture('required');
    writeFileSync(join(f.tree, 'assert-clean.mjs'), "if(process.env.TEST_CALLER_KEY !== undefined) process.exit(12);console.log('clean');\n");
    const adapter = spawn(process.execPath, [join(import.meta.dirname, '../dist/mcp/index.js')], {
      cwd: f.root,
      env: { ...process.env, BACKLOT_STATE_DIR: f.state, TEST_CALLER_KEY: 'mcp-caller-secret' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    cleanups.push(async () => { adapter.kill(); });
    const context = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MCP up did not return')), 20_000);
      let output = '';
      adapter.on('error', (error) => { clearTimeout(timeout); reject(error); });
      adapter.stdout.on('data', (chunk) => {
        output += String(chunk);
        const newline = output.indexOf('\n');
        if (newline < 0) return;
        clearTimeout(timeout);
        try { resolve(JSON.parse(JSON.parse(output.slice(0, newline)).result.content[0].text)); } catch (error) { reject(error); }
      });
      adapter.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'backlot_up', arguments: { cwd: f.tree, holder: 'mcp-cold' },
      } }) + '\n');
    });
    expect((await f.response(context)).value).toBe('mcp-caller-secret');
    const exec = await f.cli(['exec', '--json', '--holder', 'mcp-cold', 'node assert-clean.mjs']);
    expect(exec.json.exitCode, exec.stdout + exec.stderr).toBe(0);
    expect(exec.json.stdout.trim()).toBe('clean');
  });

  it('refuses broker control names in env_from before autospawn', async () => {
    const f = fixture();
    writeFileSync(join(f.tree, 'backlot.yml'), readFileSync(join(f.tree, 'backlot.yml'), 'utf8')
      .replace('TEST_CALLER_KEY: optional', 'BACKLOT_STATE_DIR: required'));
    const result = await f.cli(['up']);
    expect(result.code).toBe(1);
    expect(result.json.error.message).toContain('manifest is invalid');
    expect(result.json.error.message).toContain('BACKLOT_STATE_DIR');
  });

  it('redacts split, overlapping and unicode values and rejects unlisted RPC values without echo', () => {
    const redact = redactStream(['abc', 'abcdef', 'π-key']);
    expect(redact('log ab')).toBe('log ');
    expect(redact('cde')).toBe('');
    expect(redact('f π-')).toBe('[redacted] ');
    expect(redact('key done', true)).toBe('[redacted] done');
    expect(() => validateCallerEnv({ name: 'x', services: {} }, { SECRET: 'do-not-print' })).toThrow('undeclared');
    try { validateCallerEnv({ name: 'x', services: {} }, { SECRET: 'do-not-print' }); } catch (error) {
      expect(String(error)).not.toContain('do-not-print');
    }
  });
});

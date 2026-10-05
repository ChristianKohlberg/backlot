import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disposeStateSync } from './support/leaks.js';

const CLI = join(import.meta.dirname, '../dist/cli/index.js');
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function fixture() {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'backlot-config-test-')));
  const state = realpathSync(mkdtempSync(join(tmpdir(), 'backlot-config-state-')));
  const env = { ...process.env, BACKLOT_STATE_DIR: state, BACKLOT_SWEEP_MS: '600000' };
  const cli = (args: string[]) => {
    try { return JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--json'], { cwd, env, encoding: 'utf8', timeout: 45000 })); }
    catch (error) { const e = error as { stdout?: string; stderr?: string }; throw new Error(`${args.join(' ')}: ${e.stdout ?? ''} ${e.stderr ?? ''}`); }
  };
  execFileSync('git', ['init', '-q'], { cwd });
  cleanups.push(() => {
    try { cli(['release']); } catch { /* cleanup even if the assertion failed */ }
    try { cli(['pool', 'recycle']); } catch { /* daemon stop still reaps */ }
    try { cli(['daemon', 'stop']); } catch { /* already gone */ }
    rmSync(cwd, { recursive: true, force: true });
    disposeStateSync(state);
  });
  return { cwd, cli, write: (name: string, value: string) => writeFileSync(join(cwd, name), value) };
}

it('applies changed startup env and run commands without poisoning later reuse, while source edits keep a service with no build', async () => {
  const f = fixture();
  const server = (version: string) => `import {createServer} from 'node:http';import {readFileSync} from 'node:fs';createServer((q,s)=>s.end(JSON.stringify({pid:process.pid,value:process.env.VALUE,version:'${version}',message:readFileSync('message.txt','utf8')}))).listen(Number(process.env.PORT),'127.0.0.1');`;
  f.write('a.mjs', server('a')); f.write('b.mjs', server('b')); f.write('message.txt', 'one');
  const manifest = (value: string, file = 'a.mjs') => f.write('backlot.yml', `name: startup-config\nservices:\n  web:\n    run: node ${file}\n    port: web\n    env: { PORT: "{{ports.web}}", VALUE: "${value}" }\n    ready: { http: /, timeout: 10 }\n`);
  manifest('before');
  const first = f.cli(['up', '--ttl', '480m']);
  const body = async () => (await fetch(first.urls.web, { headers: { connection: 'close' }, signal: AbortSignal.timeout(5000) })).json();
  const initial = await body();
  f.write('message.txt', 'two');
  const refresh = f.cli(['up']);
  expect(refresh.bindDiagnostics.reuse).toBe('reused');
  expect(await body()).toMatchObject({ pid: initial.pid, message: 'two', value: 'before' });
  manifest('after');
  const changed = f.cli(['up']);
  expect(changed.bindDiagnostics.reuse).toBe('rebound');
  const after = await body();
  expect(after.value).toBe('after');
  expect(after.pid).not.toBe(initial.pid);
  expect(changed.lease.id).toBe(first.lease.id);
  const reused = f.cli(['up']);
  expect(reused.bindDiagnostics.reuse).toBe('reused');
  expect((await body()).pid).toBe(after.pid);
  manifest('after', 'b.mjs');
  f.cli(['up']);
  const next = await body();
  expect(next.version).toBe('b');
  expect(next.pid).not.toBe(after.pid);
}, 60000);

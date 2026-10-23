import { it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeCtx } from './support/context.js';

it('the README example starts, serves an edit after up, and preserves source on destroy', async () => {
  const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
  const server = /```js\n([\s\S]*?)```/.exec(readme)![1]!;
  const manifest = /```yaml\n([\s\S]*?)```/.exec(readme)![1]!;
  const c = makeCtx();
  const wt = c.worktree({ 'server.mjs': server, 'runly.yaml': manifest });
  // Match git init in the quickstart: no commit and no tracked files yet.
  execFileSync('git', ['update-ref', '-d', 'HEAD'], { cwd: wt });
  execFileSync('git', ['rm', '--cached', 'server.mjs', 'runly.yaml'], { cwd: wt });
  const request = (url: string): Promise<string> => new Promise((resolve, reject) => {
    const req = get(url, { agent: false }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.setTimeout(10_000, () => req.destroy(new Error('quickstart request timed out')));
    req.on('error', reject);
  });
  try {
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stdout + up.stderr).toBe(0);
    expect(await request(up.json.urls.web)).toBe('Hello from Runly!\n');
    const env = await c.cli(['ctx', '--env'], wt);
    expect(env.code, env.stderr).toBe(0);
    expect(env.stdout).toContain('export RUNLY_URL_WEB=');
    const edited = server.replace('Hello from Runly!', 'Edited example');
    writeFileSync(join(wt, 'server.mjs'), edited);
    const again = await c.cli(['up', '--json'], wt);
    expect(again.code, again.stdout + again.stderr).toBe(0);
    expect(again.json.urls.web).toBe(up.json.urls.web);
    expect(await request(again.json.urls.web)).toBe('Edited example\n');
    expect((await c.cli(['logs', 'web'], wt)).code).toBe(0);
    expect((await c.cli(['down'], wt)).code).toBe(0);
    expect((await c.cli(['destroy'], wt)).code).toBe(0);
    expect(readFileSync(join(wt, 'server.mjs'), 'utf8')).toBe(edited);
  } finally {
    c.dispose();
  }
});

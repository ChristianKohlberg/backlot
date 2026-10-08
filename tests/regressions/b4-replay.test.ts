/**
 * Regression from the 0.18 bug hunt (B4), fixed in 0.18.1. Failed against
 * 0.18.0 (2345a24): the proxy replayed a request the service had already
 * acted on (it crashed after its side effect, before replying) to every
 * relaunch — the POST ran 4 times and the one request crash-looped the
 * service into `failed`. The FIXED behaviour: a delivered non-idempotent
 * request is never replayed; the client sees the close, as without a proxy.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeCtx, sleep, type Ctx } from '../support/context.js';

const ctxs: Ctx[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
});

const SVC = `import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
createServer((q, s) => {
  if (q.method === 'POST' && q.url === '/charge') {
    let body = '';
    q.on('data', (d) => (body += d));
    q.on('end', () => {
      // The side effect is done ...
      appendFileSync('charges.log', 'charged ' + body + ' by ' + process.pid + '\\n');
      // ... and the process dies before it answers (a crash in serialization, OOM, ...).
      process.exit(1);
    });
    return;
  }
  s.end('ok ' + process.pid);
}).listen(Number(process.env.PORT), '127.0.0.1');
`;

describe('B4 replay of a request the service already acted on (0.18.1)', () => {
  it('a POST whose handler crashes after its side effect is executed exactly once', async () => {
    const c = makeCtx({ BACKLOT_SWEEP_MS: '200' });
    ctxs.push(c);
    const wt = c.worktree({
      'runly.yml': `name: pay
services:
  api: { run: node svc.mjs, port: api, env: { PORT: "{{ports.api}}" }, ready: { http: /, timeout: 20 } }
`,
      'svc.mjs': SVC,
      '.gitignore': 'charges.log\n',
    });
    const up = await c.cli(['up', '--json'], wt);
    expect(up.code, up.stderr + up.stdout).toBe(0);
    const res = await fetch(`${up.json.urls.api}/charge`, { method: 'POST', body: 'order-42' }).then(
      async (r) => `${r.status} ${await r.text()}`,
      (e) => `error ${String(e)}`,
    );
    // The client sees the crash, as it would without the proxy.
    expect(res).toMatch(/^error/);
    await sleep(3000);
    const charges = existsSync(join(wt, 'charges.log')) ? readFileSync(join(wt, 'charges.log'), 'utf8').trim().split('\n') : [];
    expect(charges, 'one POST was executed more than once by the proxy replay').toHaveLength(1);
    const ps = await c.cli(['ps', '--json'], wt);
    const api = ps.json.services.find((s: { service: string }) => s.service === 'api');
    expect(api.state, 'one bad request crash-looped the service into failed').not.toBe('failed');
  }, 90_000);
});

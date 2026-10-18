import { afterAll, expect, it } from 'vitest';
import { makeCtx, SERVER } from './support/context.js';
const c = makeCtx({ BACKLOT_LEASE_TTL_MS: '1' });
afterAll(() => c.dispose());
it('using verbs and daemon recovery keep a lease without a deadline', async () => {
  const wt = c.worktree({ 'runly.yml': `name: forever
services:
  web: {run: node server.mjs, port: web, env: {PORT: "{{ports.web}}"}, ready: {http: /}}
`, 'server.mjs': SERVER });
  const first = await c.cli(['up', '--json'], wt);
  expect(first.code, first.stderr).toBe(0);
  for (const verb of ['ctx', 'reset-data', 'up']) {
    const result = await c.cli([verb, '--json'], wt);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json.lease).toMatchObject({ id: first.json.lease.id, expiresAt: null });
  }
  await c.stopDaemon();
  const after = await c.cli(['ctx', '--json'], wt);
  expect(after.json.lease).toMatchObject({id: first.json.lease.id, expiresAt: null});
});

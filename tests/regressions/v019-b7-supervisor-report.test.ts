/**
 * rv018 bug hunt — (fixed in 0.19, failed on 0.18.1) B7: `runly status` reports `supervisor: systemd` for any
 * daemon whose environment carries INVOCATION_ID — which an AUTOSPAWNED
 * daemon inherits from a CLI run anywhere under a systemd service (a CI
 * runner, a service-launched terminal multiplexer, a Claude Code instance
 * started by a unit).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { makeCtx, type Ctx } from '../support/context.js';

const ctxs: Ctx[] = [];
afterAll(() => {
  for (const c of ctxs) c.dispose();
});

describe('B7 status.supervisor', () => {
  it('an autospawned daemon is not reported as supervised by systemd', async () => {
    const c = makeCtx();
    ctxs.push(c);
    const wt = c.worktree({ 'runly.yml': 'name: sup\nservices:\n  web: { run: "true" }\n' });
    const st = await c.cli(['status', '--json'], wt, { INVOCATION_ID: '0123456789abcdef0123456789abcdef' });
    expect(st.code, st.stderr).toBe(0);
    expect(st.json.supervisor, 'autospawned from a shell under a systemd service').toBe('autospawn');
  }, 60_000);
});

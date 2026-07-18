/**
 * Fleet review, MCP adapter cluster. The adapter is the surface agents actually
 * drive, so a silent wrong default here is worse than an error.
 */
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const MCP = join(import.meta.dirname, '..', 'dist', 'mcp', 'index.js');

/** Drive the adapter over stdio the way a real MCP client does. */
function talk(messages: unknown[], timeoutMs = 4000): Promise<Record<string, unknown>[]> {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-mcp-'));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [MCP], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, BACKLOT_STATE_DIR: stateDir },
    });
    let buf = '';
    p.stdout.on('data', (d) => (buf += String(d)));
    for (const m of messages) p.stdin.write(JSON.stringify(m) + '\n');
    setTimeout(() => {
      p.kill('SIGKILL');
      rmSync(stateDir, { recursive: true, force: true });
      resolve(
        buf
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as Record<string, unknown>),
      );
    }, timeoutMs);
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

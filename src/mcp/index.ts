#!/usr/bin/env node
/**
 * Minimal MCP (Model Context Protocol) server over stdio — a THIN adapter on
 * the same daemon RPC the CLI uses (decision 0014: never a second
 * implementation). Newline-delimited JSON-RPC 2.0; implements initialize,
 * tools/list, tools/call. Start with:  backlot-mcp  (or node dist/mcp/index.js)
 *
 * Every tool result is the same JSON the CLI's --json emits, as text content.
 */
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { ensureDaemon, rpc } from '../cli/client.js';

const PROTOCOL = '2025-06-18';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  verb: string;
}

/**
 * Read from package.json rather than a literal: the hardcoded value had already
 * drifted (0.4.0 while the package shipped 0.5.0), so clients were told the
 * wrong version of the tool they were driving.
 */
const VERSION: string = (() => {
  try {
    const require = createRequire(import.meta.url);
    return (require('../../package.json') as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const cwdProp = {
  cwd: { type: 'string', description: 'Worktree directory (a stack.yaml is found upward from here). REQUIRED — the MCP server has no meaningful cwd of its own.' },
  // Without this, every agent working in one worktree resolves to the same
  // holder (the path) and silently shares — and clobbers — a single lease.
  holder: {
    type: 'string',
    description: 'Optional lease identity. Agents sharing a worktree MUST pass distinct holders, or they share one environment and overwrite each other.',
  },
};

const TOOLS: Tool[] = [
  {
    name: 'backlot_up',
    description: 'Lease a warm environment for this worktree: sync, upkeep, seed, start services. Returns the context blob (URLs, logins, connection strings).',
    inputSchema: { type: 'object', properties: { ...cwdProp, hygiene: { type: 'string', enum: ['reuse', 'reset-data', 'pristine'] } }, required: ['cwd'] },
    verb: 'up',
  },
  {
    name: 'backlot_run',
    description: 'Run a named check from stack.yaml against a fresh binding: verdict with ok/exitCode/failure taxonomy (work-error = your code, env-error = environment, infra-error = external), artifacts dir, outputs_changed.',
    inputSchema: { type: 'object', properties: { ...cwdProp, check: { type: 'string' }, hygiene: { type: 'string', enum: ['reuse', 'reset-data', 'pristine'] } }, required: ['cwd', 'check'] },
    verb: 'run',
  },
  {
    name: 'backlot_ctx',
    description: 'The current lease context: service URLs, logins, token command, datastore connection strings, artifacts dir, recent service events.',
    inputSchema: { type: 'object', properties: { ...cwdProp }, required: ['cwd'] },
    verb: 'ctx',
  },
  {
    name: 'backlot_sync',
    description: 'Project the worktree state (including dirty/untracked files) into the leased environment; services restart only if the source changed.',
    inputSchema: { type: 'object', properties: { ...cwdProp }, required: ['cwd'] },
    verb: 'sync',
  },
  {
    name: 'backlot_exec',
    description: 'Run a shell command inside the leased environment tree (BACKLOT_URL_*/BACKLOT_DS_* env injected).',
    inputSchema: { type: 'object', properties: { ...cwdProp, cmd: { type: 'string' } }, required: ['cwd', 'cmd'] },
    verb: 'exec',
  },
  {
    name: 'backlot_logs',
    description: 'Tail a supervised service log from the leased environment.',
    inputSchema: { type: 'object', properties: { ...cwdProp, service: { type: 'string' }, lines: { type: 'number' } }, required: ['cwd', 'service'] },
    verb: 'logs',
  },
  {
    name: 'backlot_reset_data',
    description: 'Restore the data template on the current lease (replay a repro against pristine data). URLs stay stable.',
    inputSchema: { type: 'object', properties: { ...cwdProp }, required: ['cwd'] },
    verb: 'reset-data',
  },
  {
    name: 'backlot_pull',
    description: 'Copy the environment\'s changed declared outputs (regenerated lockfiles, generated clients) back into the worktree — the only sanctioned write-back.',
    inputSchema: { type: 'object', properties: { ...cwdProp }, required: ['cwd'] },
    verb: 'pull',
  },
  {
    name: 'backlot_token',
    description: 'Mint an auth token via the stack\'s auth.token hook (resolves {{role}}). Returns {token, role}.',
    inputSchema: { type: 'object', properties: { ...cwdProp, role: { type: 'string', description: 'Role to mint for (default admin).' } }, required: ['cwd'] },
    verb: 'token',
  },
  {
    name: 'backlot_release',
    description: 'Release the current lease; the environment returns to the pool warm.',
    inputSchema: { type: 'object', properties: { ...cwdProp }, required: ['cwd'] },
    verb: 'release',
  },
  {
    name: 'backlot_status',
    description: 'Pool overview: environments, states, leases, recent daemon events.',
    inputSchema: { type: 'object', properties: {} },
    verb: 'status',
  },
  {
    name: 'backlot_doctor',
    description: 'Active health check of the pool: pid divergence, stuck-recycling envs, plus recent events.',
    inputSchema: { type: 'object', properties: {} },
    verb: 'doctor',
  },
];

function respond(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function respondError(id: unknown, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  void (async () => {
    if (!line.trim()) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return respondError(null, -32700, 'parse error');
    }
    const { id, method, params } = msg;
    try {
      switch (method) {
        case 'initialize':
          return respond(id, {
            protocolVersion: PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: 'backlot', version: VERSION },
          });
        case 'notifications/initialized':
          return; // notification — no response
        case 'ping':
          return respond(id, {});
        case 'tools/list':
          return respond(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
          const toolName = String(params?.name);
          const tool = TOOLS.find((t) => t.name === toolName);
          if (!tool) return respondError(id, -32602, `unknown tool '${toolName}'`);
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          // The schema marks these required, but nothing enforced it — and the
          // daemon falls back to ITS OWN cwd, which is meaningless here. A
          // missing cwd silently operated on whatever stack happened to sit
          // above the daemon's working directory.
          const required = (tool.inputSchema as { required?: string[] }).required ?? [];
          const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
          if (missing.length > 0) {
            return respondError(id, -32602, `tool '${toolName}' requires: ${missing.join(', ')}`);
          }
          await ensureDaemon();
          // This adapter process outlives its tool calls and dies with the
          // agent, which makes it exactly the liveness signal a lease needs —
          // so supply it automatically unless the caller named its own.
          const withIdentity = tool.verb === 'up' && args.holderPid === undefined
            ? { ...args, holderPid: process.pid }
            : args;
          const res = await rpc(tool.verb, withIdentity);
          const text = JSON.stringify(res.ok ? res.data : { error: res.error });
          return respond(id, { content: [{ type: 'text', text }], isError: !res.ok });
        }
        default:
          if (id !== undefined) return respondError(id, -32601, `method '${method}' not found`);
      }
    } catch (err) {
      return respondError(id, -32603, String((err as Error).message ?? err));
    }
  })();
});

#!/usr/bin/env node
/**
 * Minimal MCP (Model Context Protocol) server over stdio — a THIN adapter on
 * the same daemon RPC the CLI uses (decision 0014: never a second
 * implementation). Newline-delimited JSON-RPC 2.0; implements initialize,
 * tools/list, tools/call. Start with:  infront-mcp  (or node dist/mcp/index.js)
 *
 * Every tool result is the same JSON the CLI's --json emits, as text content.
 */
import { createInterface } from 'node:readline';
import { ensureDaemon, rpc } from '../cli/client.js';

const PROTOCOL = '2025-06-18';

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  verb: string;
  map?: (args: Record<string, unknown>) => Record<string, unknown>;
}

const cwdProp = {
  cwd: { type: 'string', description: 'Worktree directory (a stack.yaml is found upward from here). REQUIRED — the MCP server has no meaningful cwd of its own.' },
};

const TOOLS: Tool[] = [
  {
    name: 'infront_up',
    description: 'Lease a warm environment for this worktree: sync, upkeep, seed, start services. Returns the context blob (URLs, logins, connection strings).',
    inputSchema: { type: 'object', properties: { ...cwdProp, hygiene: { type: 'string', enum: ['reuse', 'reset-data', 'pristine'] } }, required: ['cwd'] },
    verb: 'up',
  },
  {
    name: 'infront_run',
    description: 'Run a named check from stack.yaml against a fresh binding: verdict with ok/exitCode/failure taxonomy (work-error = your code, env-error = environment, infra-error = external), artifacts dir, outputs_changed.',
    inputSchema: { type: 'object', properties: { ...cwdProp, check: { type: 'string' }, hygiene: { type: 'string', enum: ['reuse', 'reset-data', 'pristine'] } }, required: ['cwd', 'check'] },
    verb: 'run',
  },
  {
    name: 'infront_ctx',
    description: 'The current lease context: service URLs, logins, token command, datastore connection strings, artifacts dir, recent service events.',
    inputSchema: { type: 'object', properties: { ...cwdProp }, required: ['cwd'] },
    verb: 'ctx',
  },
  {
    name: 'infront_sync',
    description: 'Project the worktree state (including dirty/untracked files) into the leased environment; services restart only if the source changed.',
    inputSchema: { type: 'object', properties: { ...cwdProp }, required: ['cwd'] },
    verb: 'sync',
  },
  {
    name: 'infront_exec',
    description: 'Run a shell command inside the leased environment tree (INFRONT_URL_*/INFRONT_DS_* env injected).',
    inputSchema: { type: 'object', properties: { ...cwdProp, cmd: { type: 'string' } }, required: ['cwd', 'cmd'] },
    verb: 'exec',
  },
  {
    name: 'infront_logs',
    description: 'Tail a supervised service log from the leased environment.',
    inputSchema: { type: 'object', properties: { ...cwdProp, service: { type: 'string' }, lines: { type: 'number' } }, required: ['cwd', 'service'] },
    verb: 'logs',
  },
  {
    name: 'infront_reset_data',
    description: 'Restore the data template on the current lease (replay a repro against pristine data). URLs stay stable.',
    inputSchema: { type: 'object', properties: { ...cwdProp }, required: ['cwd'] },
    verb: 'reset-data',
  },
  {
    name: 'infront_release',
    description: 'Release the current lease; the environment returns to the pool warm.',
    inputSchema: { type: 'object', properties: { ...cwdProp }, required: ['cwd'] },
    verb: 'release',
  },
  {
    name: 'infront_status',
    description: 'Pool overview: environments, states, leases.',
    inputSchema: { type: 'object', properties: {} },
    verb: 'status',
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
            serverInfo: { name: 'infront', version: '0.4.0' },
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
          await ensureDaemon();
          const res = await rpc(tool.verb, args);
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

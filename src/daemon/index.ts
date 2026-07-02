#!/usr/bin/env node
/**
 * The infront daemon: HTTP over a unix socket, auto-spawned by the CLI
 * (decision 0009). One RPC endpoint; the CLI is a thin client. Serializes
 * requests through a simple queue — policy code stays race-free.
 */
import { createServer } from 'node:http';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { socketPath, pidPath } from '../core/paths.js';
import { BrokerError } from '../core/util.js';
import { Engine } from './engine.js';

const engine = new Engine();
engine.recover();

// One request at a time: correctness first; concurrency belongs to environments,
// not to the policy code mutating the journal.
let chain: Promise<unknown> = Promise.resolve();
const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
};

async function dispatch(verb: string, args: Record<string, unknown>): Promise<unknown> {
  const cwd = String(args.cwd ?? process.cwd());
  const holder = args.holder ? String(args.holder) : undefined;
  switch (verb) {
    case 'ping':
      return { pid: process.pid };
    case 'up':
      return engine.up({
        cwd, holder,
        hygiene: (args.hygiene as never) ?? undefined,
        watch: Boolean(args.watch),
        ttlMs: args.ttlMs ? Number(args.ttlMs) : undefined,
      });
    case 'run':
      return engine.run({ cwd, holder, check: String(args.check), hygiene: (args.hygiene as never) ?? undefined });
    case 'run-detach': {
      const jobId = engine.createJob(cwd, String(args.check));
      // Chain the execution onto the serialized queue and return NOW — the
      // verdict outlives the client (decision 0015).
      enqueue(() => engine.executeJob(jobId, { cwd, holder, check: String(args.check), hygiene: (args.hygiene as never) ?? undefined }));
      return { jobId, poll: `infront job ${jobId}` };
    }
    case 'job':
      return engine.jobStatus(String(args.jobId));
    case 'ctx':
      return engine.ctx(cwd, holder);
    case 'sync':
      return engine.syncLease(cwd, holder);
    case 'reset-data':
      return engine.resetData(cwd, holder);
    case 'exec':
      return engine.exec(cwd, String(args.cmd), holder);
    case 'logs':
      return engine.logs(cwd, String(args.service), Number(args.lines ?? 40), holder);
    case 'pull':
      return engine.pull(cwd, holder);
    case 'release':
      return engine.release(cwd, holder);
    case 'status':
      return engine.status();
    case 'pool-recycle':
      return engine.poolRecycle(Boolean(args.all));
    case 'shutdown':
      setTimeout(async () => {
        await engine.shutdown();
        process.exit(0);
      }, 50);
      return { stopping: true };
    default:
      throw new BrokerError('env-error', `daemon does not know verb '${verb}'`, 'rpc');
  }
}

const sock = socketPath();
if (existsSync(sock)) rmSync(sock, { force: true }); // stale socket from a dead daemon

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    void (async () => {
      try {
        const { verb, args } = JSON.parse(body || '{}');
        const data = await enqueue(() => dispatch(verb, args ?? {}));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, data }));
      } catch (err) {
        const e = err instanceof BrokerError ? err.toJSON() : { class: 'env-error', message: String((err as Error).message ?? err) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e }));
      }
    })();
  });
});

server.listen(sock, () => {
  writeFileSync(pidPath(), String(process.pid));
  // Detach from the spawning CLI's lifetime.
  if (process.send) process.send('ready');
});

const sweepMs = Number(process.env.INFRONT_SWEEP_MS ?? 15_000);
setInterval(() => void engine.sweep(), sweepMs).unref();
// The server keeps the loop alive; the sweeper must not.

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void engine.shutdown().then(() => {
      rmSync(sock, { force: true });
      process.exit(0);
    });
  });
}

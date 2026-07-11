#!/usr/bin/env node
/**
 * The backlot daemon: HTTP over a unix socket, auto-spawned by the CLI
 * (decision 0009). One RPC endpoint; the CLI is a thin client. Serializes
 * requests through a simple queue — policy code stays race-free.
 */
import { createServer, request } from 'node:http';
import { existsSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { socketPath, pidPath } from '../core/paths.js';
import { BrokerError } from '../core/util.js';
import { Engine } from './engine.js';

// Singleton guard: recover() and listen happen only AFTER we win the socket,
// so a losing daemon never reaps the winner's children or mutates the journal.
const engine = new Engine();
// Concurrency lives in the engine: a short pool lock for claim bookkeeping and
// one lock per environment. Requests for different environments overlap; two
// operations on one environment never do.

async function dispatch(verb: string, args: Record<string, unknown>, emit: (phase: string) => void): Promise<unknown> {
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
        onProgress: emit,
      });
    case 'run':
      return engine.run({ cwd, holder, check: String(args.check), hygiene: (args.hygiene as never) ?? undefined, onProgress: emit });
    case 'run-detach': {
      const jobId = engine.createJob(cwd, String(args.check));
      // Fire-and-forget — env/pool locks make it safe; the journaled verdict
      // outlives the client (decision 0015).
      void engine.executeJob(jobId, { cwd, holder, check: String(args.check), hygiene: (args.hygiene as never) ?? undefined });
      return { jobId, poll: `backlot job ${jobId}` };
    }
    case 'job':
      return engine.jobStatus(String(args.jobId));
    case 'job-ls':
      return engine.jobList();
    case 'bind-ref':
      return engine.bindRef(cwd, String(args.ref), holder);
    case 'ctx':
      return engine.ctx(cwd, holder);
    case 'sync':
      return engine.syncLease(cwd, holder, emit);
    case 'reset-data':
      return engine.resetData(cwd, holder, emit);
    case 'exec':
      return engine.exec(cwd, String(args.cmd), holder);
    case 'logs':
      return engine.logs(cwd, String(args.service), Number(args.lines ?? 40), holder);
    case 'token':
      return engine.token(cwd, String(args.role ?? 'admin'), holder);
    case 'pull':
      return engine.pull(cwd, holder);
    case 'release':
      return engine.release(cwd, holder);
    case 'appliance-ls':
      return engine.applianceLs(cwd);
    case 'appliance-start':
      return engine.applianceStart(cwd, args.name ? String(args.name) : undefined);
    case 'appliance-stop':
      return engine.applianceStop(cwd, String(args.name));
    case 'status':
      return engine.status();
    case 'doctor':
      return engine.doctor();
    case 'pool-recycle':
      return engine.poolRecycle(Boolean(args.all));
    case 'pool-reconcile':
      // Local substrate: reconcile = doctor + reap anything degraded/stuck.
      return engine.poolReconcile();
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
let ownsSocket = false;

/** Is a LIVE daemon already answering on the socket? (vs. a stale socket file) */
function pingExisting(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(sock)) return resolve(false);
    const req = request({ socketPath: sock, path: '/', method: 'POST', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false)); // ECONNREFUSED = stale socket
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end(JSON.stringify({ verb: 'ping', args: {} }));
  });
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    void (async () => {
      // Response is newline-delimited JSON: zero or more {type:'progress'}
      // frames, then exactly one {type:'result'} frame. The CLI renders
      // progress to stderr (TTY only) and the result to stdout.
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const emit = (phase: string) => {
        try {
          res.write(JSON.stringify({ type: 'progress', phase }) + '\n');
        } catch {
          /* client hung up mid-stream */
        }
      };
      try {
        const { verb, args } = JSON.parse(body || '{}');
        const data = await dispatch(verb, args ?? {}, emit);
        res.end(JSON.stringify({ type: 'result', ok: true, data }) + '\n');
      } catch (err) {
        const e = err instanceof BrokerError ? err.toJSON() : { class: 'env-error', message: String((err as Error).message ?? err) };
        res.end(JSON.stringify({ type: 'result', ok: false, error: e }) + '\n');
      }
    })();
  });
});

// EADDRINUSE means another daemon won the listen race between our ping and our
// bind — concede cleanly rather than clobber it.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    if (process.send) process.send('ready'); // a live daemon exists; the client can proceed
    process.exit(0);
  }
  throw err;
});

async function start(): Promise<void> {
  if (await pingExisting()) {
    // A healthy daemon already owns the socket — do NOT recover() or listen.
    if (process.send) process.send('ready');
    process.exit(0);
  }
  if (existsSync(sock)) rmSync(sock, { force: true }); // stale socket from a dead daemon

  server.listen(sock, () => {
    ownsSocket = true;
    // The socket has no RPC auth and exposes arbitrary-shell verbs (exec/token),
    // so it must be owner-only. On macOS the socket-file mode is what actually
    // gates connect() (the dir traversal isn't enough), so this chmod is the
    // real boundary, not just belt-and-suspenders.
    try {
      chmodSync(sock, 0o600);
    } catch {
      /* best-effort; the 0700 state dir is the backstop */
    }
    writeFileSync(pidPath(), String(process.pid));
    // Only NOW, as the sole owner, reconcile prior daemon state.
    engine.recover();
    const sweepMs = Number(process.env.BACKLOT_SWEEP_MS ?? 15_000);
    setInterval(() => void engine.sweep(), sweepMs).unref();
    // Detach from the spawning CLI's lifetime.
    if (process.send) process.send('ready');
  });
}

void start();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void engine.shutdown().then(() => {
      // Only remove the socket if WE own it — a losing/duplicate daemon must
      // never delete the healthy daemon's socket.
      if (ownsSocket) rmSync(sock, { force: true });
      process.exit(0);
    });
  });
}

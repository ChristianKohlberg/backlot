#!/usr/bin/env node
/**
 * The backlot daemon: HTTP over a unix socket, auto-spawned by the CLI
 * (decision 0009). One RPC endpoint; the CLI is a thin client. Serializes
 * requests through a simple queue — policy code stays race-free.
 */
import { createServer, request } from 'node:http';
import { existsSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { socketPath, pidPath, stateRoot } from '../core/paths.js';
import { electSelf, releaseSelf } from './election.js';
import { BrokerError } from '../core/util.js';
import { Engine } from './engine.js';
import { logEvent } from '../core/events.js';

// Singleton guard: recover() and listen happen only AFTER we win the socket,
// so a losing daemon never reaps the winner's children or mutates the journal.
const engine = new Engine();
// Concurrency lives in the engine: a short pool lock for claim bookkeeping and
// one lock per environment. Requests for different environments overlap; two
// operations on one environment never do.

async function dispatch(verb: string, args: Record<string, unknown>, emit: (phase: string) => void): Promise<unknown> {
  const cwd = String(args.cwd ?? process.cwd());
  const holder = args.holder ? String(args.holder) : undefined;
  const holderPid = args.holderPid !== undefined ? Number(args.holderPid) : undefined;
  switch (verb) {
    case 'ping':
      return { pid: process.pid };
    case 'up':
      return engine.up({
        cwd, holder, holderPid,
        hygiene: (args.hygiene as never) ?? undefined,
        watch: Boolean(args.watch),
        ttlMs: args.ttlMs ? Number(args.ttlMs) : undefined,
        // [] (not undefined) so the `up` verb always means the whole app unless
        // a slice is named — undefined is reserved for internal shape-preserving
        // rebinds (reset-data/watch/bind), which never come through this RPC.
        services: Array.isArray(args.services) ? (args.services as unknown[]).map(String) : [],
        onProgress: emit,
      });
    case 'run':
      return engine.run({ cwd, holder, check: String(args.check), hygiene: (args.hygiene as never) ?? undefined, pull: Boolean(args.pull), onProgress: emit });
    case 'run-detach': {
      const jobId = engine.createJob(cwd, String(args.check));
      // Fire-and-forget — env/pool locks make it safe; the journaled verdict
      // outlives the client (decision 0015).
      // Fire-and-forget by design (the verdict is journaled and outlives the
      // client) — but a REJECTION here is process-fatal without a catch, and
      // the job would be lost with no record of why.
      void engine
        .executeJob(jobId, { cwd, holder, check: String(args.check), hygiene: (args.hygiene as never) ?? undefined })
        .catch((err) => logEvent({ level: 'error', kind: 'job', detail: `job ${jobId} failed outside the verdict path: ${String((err as Error).message ?? err)}` }));
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
    case 'pool-gc':
      return engine.poolGc();
    case 'shutdown':
      setTimeout(async () => {
        await engine.shutdown();
        // Clean up what we own, exactly as the signal path does — a stale lock
        // is recoverable (the next daemon sees a dead holder) but leaving one
        // behind makes every restart pay a lock-break round.
        if (ownsSocket) rmSync(sock, { force: true });
        if (ownsLock) releaseSelf();
        process.exit(0);
      }, 50);
      return { stopping: true };
    default:
      throw new BrokerError('env-error', `daemon does not know verb '${verb}'`, 'rpc');
  }
}

const sock = socketPath();
let ownsSocket = false;
let ownsLock = false;

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

/**
 * Recovery reconciles prior daemon state, and now genuinely waits on kills
 * (verified reaps, orphan sweep) instead of firing signals blind. Requests are
 * therefore held until it completes: serving `status` mid-reconcile would show
 * a caller envs that are about to change state, which is the old synchronous
 * contract silently broken.
 *
 * `ping` is exempt — the singleton election must be answerable immediately, or
 * a second daemon would conclude the socket is stale and take over.
 */
let recovered: Promise<void> = Promise.resolve();

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
      let verbForLog = '?';
      try {
        const { verb, args } = JSON.parse(body || '{}');
        verbForLog = String(verb ?? '?');
        if (verb !== 'ping') await recovered;
        const data = await dispatch(verb, args ?? {}, emit);
        res.end(JSON.stringify({ type: 'result', ok: true, data }) + '\n');
      } catch (err) {
        // An unclassified throw is a DAEMON bug, not a bad environment.
        // Labelling it env-error told the agent to recycle an environment,
        // which cannot fix a TypeError in the broker — and buried the defect.
        const e = err instanceof BrokerError
          ? err.toJSON()
          : { class: 'infra-error', message: `internal daemon error: ${String((err as Error).message ?? err)}` };
        if (!(err instanceof BrokerError)) {
          logEvent({ level: 'error', kind: 'internal', detail: `${verbForLog}: ${String((err as Error).stack ?? err)}`.slice(0, 1000) });
        }
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
  // Win the lock BEFORE touching the socket. Without this, two daemons that
  // both saw no answer to their ping would each unlink the socket — the second
  // deleting the first's LIVE one — and both would then bind successfully,
  // sweeping the same journal and reaping each other's processes.
  if (!electSelf()) {
    if (process.send) process.send('ready'); // someone else owns it; the client can proceed
    process.exit(0);
  }
  ownsLock = true;
  // The daemon inherited its cwd from whichever CLI spawned it — usually a
  // WORKTREE, which the consumer may delete while the daemon lives on. A
  // deleted cwd makes anything that reads it (worker_threads spawn calls
  // uv_cwd) fail with ENOENT. Pin cwd to the state root, which the daemon
  // owns for exactly its own lifetime; nothing daemon-side resolves against
  // cwd (every RPC carries the client's cwd explicitly).
  process.chdir(stateRoot());
  // Only the election winner may remove a socket, so this can no longer be a
  // live one: any daemon that could have been listening lost the lock.
  if (existsSync(sock)) rmSync(sock, { force: true }); // stale socket from a dead daemon

  // Create the socket ALREADY private. The chmod below runs inside the listen
  // callback, by which point the socket exists and can accept connections, so
  // a permissive umask left a window where it was world-reachable. The socket
  // has no RPC auth and exposes arbitrary-shell verbs, so the window matters.
  process.umask(0o077);
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
    // Only NOW, as the sole owner, reconcile prior daemon state. Recovery
    // verifies each reap and sweeps for orphans, so it awaits real work; every
    // non-ping request queues behind it.
    recovered = engine.recover().catch((err) => {
      // A failed reconcile must not wedge the daemon forever — surface it and
      // let requests through rather than hanging every client.
      logEvent({ level: 'error', kind: 'recover', detail: `recovery failed: ${String((err as Error).message ?? err)}` });
    });
    const sweepMs = Number(process.env.BACKLOT_SWEEP_MS ?? 15_000);
    // The sweeper must not run DURING recovery: it would act on rows recovery
    // is still reconciling, and a stale-snapshot save could resurrect an env
    // recovery had just deleted. Each tick also swallows its own rejection —
    // a fire-and-forget async call whose promise rejects is an unhandled
    // rejection, which takes the daemon down on any transient journal or FS
    // write failure.
    void recovered.then(() => {
      setInterval(() => {
        void engine.sweep().catch((err) => {
          logEvent({ level: 'error', kind: 'sweep', detail: `sweep failed: ${String((err as Error).message ?? err)}` });
        });
      }, sweepMs).unref();
    }).catch((err) => logEvent({ level: 'error', kind: 'recover', detail: `sweeper never armed: ${String((err as Error).message ?? err)}` }));
    // Detach from the spawning CLI's lifetime.
    if (process.send) process.send('ready');
  });
}

void start().catch((err) => {
  // Nothing has been established yet, so there is no graceful path — but dying
  // silently left the client waiting on a daemon that would never answer.
  console.error(`backlot daemon failed to start: ${String((err as Error).stack ?? err)}`);
  process.exit(1);
});

/**
 * Runtime-level guards.
 *
 * Node's default for an unhandled rejection or an uncaught exception is to kill
 * the process — which for this daemon means every environment loses its
 * supervisor over one missed `.catch`. Four confirmed defects in the 2026-07-18
 * review were exactly that shape (a socket 'error', an fs.watch 'error', a
 * spawn 'error' with no 'exit', a fire-and-forget sweep).
 *
 * The two are handled ASYMMETRICALLY on purpose:
 *
 * - An unhandled REJECTION is almost always a missing `.catch` on an otherwise
 *   contained operation. Logging and staying alive is right: the daemon keeps
 *   supervising, and the event log names the gap.
 * - An uncaught EXCEPTION leaves the process in an undefined state, and this
 *   daemon owns a journal that is the machine's source of truth. Continuing
 *   risks corrupting it. Exiting is safe BECAUSE of the crash-recovery contract
 *   (decision 0009): services survive, and the next daemon reconciles them. So
 *   log loudly, then die deliberately rather than limp.
 */
process.on('unhandledRejection', (reason) => {
  logEvent({
    level: 'error',
    kind: 'internal',
    detail: `unhandled rejection (daemon continuing): ${String((reason as Error)?.stack ?? reason)}`.slice(0, 2000),
  });
});

process.on('uncaughtException', (err) => {
  logEvent({
    level: 'error',
    kind: 'internal',
    detail: `uncaught exception — exiting so a clean daemon can reconcile: ${String(err?.stack ?? err)}`.slice(0, 2000),
  });
  try {
    if (ownsSocket) rmSync(sock, { force: true });
    if (ownsLock) releaseSelf();
  } catch {
    /* best-effort */
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    // A daemon that LOST the election must exit without touching shared state:
    // engine.shutdown() stops services and rewrites env rows, which would let a
    // conceding process tear down the winner's environments.
    if (!ownsLock && !ownsSocket) process.exit(0);
    void engine.shutdown().then(() => {
      // Only remove the socket if WE own it — a losing/duplicate daemon must
      // never delete the healthy daemon's socket.
      if (ownsSocket) rmSync(sock, { force: true });
      if (ownsLock) releaseSelf();
      process.exit(0);
    });
  });
}

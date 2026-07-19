# 0020. A rewrite in Go was considered and declined

- Status: Accepted
- Date: 2026-07
- Context: [0013](0013-typescript-node-npm-apache2.md) chose TypeScript on Node; this
  revisits that choice against evidence rather than preference.

## Decision

backlot stays on TypeScript/Node. A partial extraction of the supervision core into Go
is also declined. The question was evaluated against the 96-finding review recorded in
[../reviews/2026-07-18-fleet-review.md](../reviews/2026-07-18-fleet-review.md) — the
best evidence available about where this codebase actually breaks.

## Rationale

**Most defects were not the language's fault, so a rewrite re-earns them from zero.**
Attributing every fixed defect to a root cause gives roughly 68% DESIGN (a wrong or
missing invariant), 17% POSIX/PLATFORM (process groups, pid reuse, dual-stack
`localhost`, case-insensitive filesystems), and 10-15% LANGUAGE/RUNTIME. The two
largest fix commits by defect count are pure design and pure POSIX respectively. Go
faces both identically.

**Go makes the largest defect family harder, not easier.** The biggest single cluster
was seven lost updates: a full-row `saveEnv` written from a snapshot taken before an
await. The real bug is that supervisor callbacks (`onDegraded`, `onPidsChanged`) are
concurrent writers that never take `envLocked` — language-neutral. But Node confines
the read-modify-write window to `await` points, which are enumerable and greppable.
Under preemptive scheduling with shared memory the window is every instruction.

**Two thirds of the test suite would not survive the port**, and the loss concentrates
exactly where it is most dangerous: `tests/orphan-reclaim.test.ts` calls
`killGroupVerified`, `scanTagged`, `sameProcess` and `groupAlive` directly, and is the
proof that the pid-reuse and process-group races are fixed.

**Goroutines buy nothing at this scale.** `poolMaxHeuristic` is clamped to [2,8]. The
workload is IO-bound supervision of a few dozen child processes. The pain is one long
synchronous operation blocking the loop — a fixable defect, not a scheduling ceiling.

**Go retains most of the POSIX cost anyway**: no stdlib process-start-time API, still
reading `/proc` by hand for pgid and tags, still polling for non-child group death,
still unable to `waitpid` processes that deliberately outlive the daemon.

## The honest case for moving, and why it loses

The strongest genuine argument is that **four "the whole daemon dies" defects shared one
Node mechanism** — an unhandled `'error'` event or rejected promise is process-fatal by
default. In Go, `cmd.Start()` returns spawn failure synchronously and that class cannot
be written. That is real, and it was not theoretical.

It loses because the class closes in about five lines: a process-level
`unhandledRejection`/`uncaughtException` pair plus a `.catch` on each floating promise
(landed with this decision). The remaining language item — synchronous hashing and
copying blocking the event loop — has a stable in-language fix (`worker_threads`,
around one self-contained module). Months of rewrite, plus a fresh defect population,
to buy what an afternoon buys is not a trade.

`node:sqlite` being experimental is contained rather than architectural: `DatabaseSync`
appears only inside the `Journal` class, so the backend stays swappable.

Single-binary distribution is the one durable advantage, and it is a preference until
an install actually fails. Nobody has installed backlot yet.

## Consequences

- The wire contracts (CLI `--json`, exit codes, unix-socket RPC, MCP stdio JSON-RPC) are
  language-neutral, so no consumer is demanding this — and the same neutrality keeps a
  future rewrite possible if the evidence changes.
- `Journal` remains the sole `DatabaseSync` boundary. Do not let sqlite calls spread.
- This decision is falsifiable. Reopen it if any of these are observed:
  - The unhandled-rejection class recurs *after* the process-level guards and a lint
    rule against floating promises are both in place.
  - Moving `syncIntoEnv` to a worker thread fails to restore RPC responsiveness during a
    large bind.
  - Real installs fail on the Node pin — telemetry, not speculation.
  - `node:sqlite` ships a breaking change, or the journal needs concurrent writers that
    `DatabaseSync` cannot serve.
  - The remote substrate driver lands and its profile is genuinely CPU-bound or
    high-fan-out (hundreds of concurrent supervised remotes) rather than 2-8 local
    environments.
  - A sustained defect log — not one audit — shows the language-attributable share
    climbing well above ~15%. One review is a snapshot; a trend is evidence.

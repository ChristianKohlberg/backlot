# 0049 — Bounded local statistics and monitoring

Expose measurements through one read-only stats RPC, runly stats, and runly
monitor. Scope to the caller's worktree by default; --all reads the whole daemon.
Monitoring must never touch the activity clock, wake services, or enter load
admission. A journaled worktree remains queryable while its manifest is broken.
The CLI may start a stopped daemon to query it, following other read-only verbs.

Keep bounded local aggregates in metrics.json: up to 24 hours of minute buckets,
12,000 bucket/series entries and 16 MiB serialized data, plus the latest 200
correlated observations. Eviction and persistence failures are reported, not
hidden. retainedSince is the earliest stored minute in the scope, not a promise
of gap-free coverage. Window starts round down to a minute; histogram quantiles
are upper-bound estimates. Counts, sums and extrema are exact for retained samples.

Record monotonic operation durations, success/error outcomes and stable scope
labels. Never record commands, request paths, payloads, output or credential
values. Long labels retain a hash suffix to avoid collisions. Operation IDs are
not series dimensions. Storage is best-effort and cannot fail a service operation.

Batch proxy traffic in memory, flushing at five-second intervals, connection
closure and snapshots. Persistence is atomic and batched every five seconds;
shutdown flushes too. A crash can lose the latest unflushed observations, including
pending proxy byte deltas (two five-second stages can lose roughly ten seconds
of byte history). This is diagnostic telemetry, not billing/audit data.
The bounded JSON persistence still serializes and writes on the daemon thread;
near-cap writes measured around 20 ms for 3 MB on the development machine.
Do not treat monitor itself as a zero-overhead latency benchmark.

Proxy first_byte_ms is TCP accept to first bytes received from the upstream,
once per connection across safe retries. It does not measure individual requests,
client receipt, HTTP response completion or WebSocket message latency. hold_ms
covers explicit held segments, excluding retry backoff. Generated 503 responses
do not count as upstream success. The connection that triggers a cold wake shares
an operation ID with that wake and its startup stages; other connections waiting
for the same startup are not individually correlated to it. Proxy listeners
must clear inherited bind contexts to avoid attributing later traffic to an old up.

Live proxy counters reset with the daemon (or begin when a listener is created);
live daemonStartedAt identifies the restart boundary. History survives restart.
Machine budget figures are declared costs, not sampled CPU/RSS. Phase timings
can overlap, particularly data and builds; summing them is not wall-clock time.

Monitor uses sequential snapshots and cancellation-aware RPC. Ctrl-C, SIGTERM
and --timeout close an outstanding request as well as pending timers. JSON mode
is NDJSON, one object per snapshot; stats --json remains one object.

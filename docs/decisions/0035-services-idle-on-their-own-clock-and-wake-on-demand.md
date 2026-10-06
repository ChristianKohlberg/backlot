# 0035. Each service stops on its own idle clock and starts on demand; an environment goes with its agent or its worktree

- Status: Accepted — amended by [0039](0039-teardown-keeps-templates-a-leased-environment-survives-a-crash-loop.md): only verbs that use an environment are activity (`ctx`, `ps`, `plan`, `logs` are not); `destroy` keeps the worktree's upkeep and build records
- Date: 2026-10
- Amends: [0021](0021-quiesce-is-not-a-teardown.md) — the leased-idle quiesce of a
  whole environment (`leasedIdleTtlMs`) is replaced by a per-service idle stop
  (still under the environment lock, never published as `recycling`);
  [0033](0033-the-daemon-holds-public-ports-behind-an-l4-proxy.md) — the wake hook
  it left for "step 6" is installed; [0034](0034-additive-up-database-copies-and-ps.md)
  — a holder is believed dead only after a grace, and its death now tears the
  environment down instead of releasing the lease
- Context: since 0033 the daemon holds every public port and counts client
  bytes, so it can tell an environment nobody is using from one a browser or a
  test suite is driving. Until 0.16 the lifecycle ignored that: a leased
  environment kept every service running until `leasedIdleTtlMs` (an hour)
  went by without a runly verb, and then stopped all of them at once; a lease
  whose holder died was released but the environment, its data and its ports
  stayed; and nothing at all happened when a worktree was deleted while still
  leased. On a box shared by ten agents that meant gigabytes of dev servers for
  agents that had moved on or no longer existed.

## Decision

**Idle is per service, and it means nobody used it.** A running service is
idle when, for `BACKLOT_SERVICE_IDLE_MS` (default 10 minutes, `serviceIdleMs`
in config.json, `idle:` per service in the manifest — a duration, or
`never`/`off`):

- no runly verb touched its environment (any verb: `up`, `ctx`, `exec`,
  `logs`, `ps`, `plan`, …), and
- no client byte went through its own public port (a portless service follows
  any port of its environment), and
- it did not (re)start in that time.

An agent being alive is **not** activity: an agent that leased an environment
and went on to other work does not keep it running. runly's own readiness
probes go to the internal port and never count (0033); `status`, which is
server-wide, does not touch any environment.

**An idle service is stopped; everything else stays.** The sweeper stops just
that service, under the environment lock (0021: never through `recycling`).
The lease, the data, the public port and every other service stay; `ps` shows
the service as `idle`, and the environment reads `warm` once none runs.

**A connection starts it again.** A connection to the public port of a
stopped service that the lease still wants (not one `runly down` stopped) is
held — with the existing hold, `BACKLOT_PROXY_HOLD_MS`, 90 s — while the
service's start path runs: appliances ensured, datastores kept as they are,
the load budget asked (0036), its build only when needed (a `when:` build whose
inputs changed, or one that never succeeded in this worktree; 0038), its
`depends_on` closure started first. Then the held connection goes through. An
unleased environment is never woken by a connection.

**Wakes chain through the proxy.** Services reach each other through public
ports (0033), so an SPA dev server that forwards `/api` to the API wakes the
API with that request, just as a browser woke the SPA. One caveat: a service
whose readiness check itself needs another stopped service must declare it in
`depends_on`, or its wake waits for a wake that its own readiness blocks.

**The self-restart gap is held too.** When a service crashes, the supervisor
marks its port `starting` before it relaunches it, and `up` once the new
process accepts again; a connection the proxy cannot forward because the
process just died is retried and held instead of refused. A connection the
dying process had already accepted is lost with it, as with any proxy.

**Activity survives a daemon restart.** The last client byte per port is
written to the environment row (`envs.activity`), at most every 5 s per
environment, at every sweep and at shutdown; a restarted daemon seeds the
proxy's clocks from it.

**The tether.** A lease or database copy can be tied to a holder process
(`--holder-pid`, `BACKLOT_HOLDER_PID`). When that process has been gone for
`BACKLOT_TETHER_GRACE_MS` (default 60 s) — first seen dead, still dead a minute
later — everything goes: services, data, preview tunnel, public ports, lease
(and for a copy, the copy). A daemon restart restarts the grace. While the
holder lives, the sweeper renews the lease's TTL, so a tethered lease never
lapses under a living agent; its services still idle-stop.

**Claude Code tethers automatically.** Claude Code exports `CLAUDE_PID`, the
pid of the `claude` process that every Bash tool call descends from. When
neither `--holder-pid` nor `BACKLOT_HOLDER_PID` is given, `up` and `db new` use
it — only if it is alive **and** an ancestor of the CLI, so a stale value
inherited into an unrelated process tree is never trusted. What keeps the
tether alive is that `claude` process: the session itself. Background shells,
subagents and tool calls all run under it; ending or killing the session
starts the grace. `BACKLOT_TETHER=off` opts out (the lease then lives by its
TTL). Other harnesses pass `--holder-pid` explicitly.

**A worktree that is gone takes its environment with it.** When the
environment's worktree no longer exists (or now holds a different stack), the
sweeper tears the environment down even when it is leased — after a daemon
restart too. "Returned to a pool" cannot be detected in general, so it has a
verb: `runly destroy` tears down this worktree's environment, drops its
database copies and removes its worktree records, now.

## Consequences

- An agent that stops using its environment costs nothing after ten minutes
  but its ports and data; one that ends costs nothing after a minute.
- The first request after an idle stop pays a start (seconds, with a held
  connection, not a refusal). `idle: never` opts a service out.
- `BACKLOT_LEASED_IDLE_TTL_MS` / `leasedIdleTtlMs` are read and ignored.
  `BACKLOT_IDLE_TTL_MS` still decides which unleased environment is cold
  enough to evict for capacity.
- Known gap: which services were idle-stopped is daemon memory; after a
  daemon restart `ps` shows them as `stopped` (they still wake on demand).

## Alternatives considered

- **Keep the whole-environment quiesce, just sooner.** Rejected: a test suite
  hammering the API would not keep the worker it never talks to alive, nor
  should it; and a whole-environment stop makes every service pay the restart.
- **Treat a live agent as activity.** Rejected by the owner: agents live for
  hours doing other work.
- **Release the lease when the holder dies (the 0.15 behaviour).** Rejected:
  the environment, its data and its ports outlived the only one who could use
  them.

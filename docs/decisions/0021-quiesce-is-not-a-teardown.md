# 0021. A quiesce runs under the environment lock, not as a borrowed teardown

- Status: Accepted
- Date: 2026-07
- Context: the lease-liveness work (leased-but-idle environments quiesce to warm,
  keeping their lease) implemented the stop by claiming the environment through
  `claimForTeardown`, which publishes `state: 'recycling'` to the journal for the
  duration of the service stop.

## Decision

The idle quiesce — leased or not — executes inside the environment's ordinary
operation lock (`envLocked`), with the journal state left untouched (`hot`) until the
services are stopped and the row is written `warm`. No new state is introduced, and
`recycling` is reserved for what it says: an environment being destroyed.

## Rationale

**Disk is truth, so a borrowed state is a borrowed crash contract.** Whatever the
journal says at any instant is exactly what a daemon crash at that instant hands to
recovery — and recovery's contract for `recycling` is *finish the teardown*: delete the
environment and its lease. A heat reclaim that publishes itself as a teardown therefore
escalates, on crash, into the destruction of a live agent's environment and lease.
Safe by the never-the-only-copy invariant, but a violation of both "a restart is a
non-event" (§5) and the lease-liveness promise ("the lease survives, only the services
stop").

**The borrowed state was doing jobs other machinery already does better.** Excluding
concurrent binds during the stop is what the environment lock *is*: a bind queued
behind the quiesce finds a `warm` row and takes the full restart path (the fast path
requires `hot` plus healthy pids), so it cannot return dead URLs. Excluding concurrent
teardowns is the `busy` flag, which `claimForTeardown` already refuses.

**Crash-mid-quiesce becomes a case that already has tests.** Under the lock, the
mid-stop journal state is plain `hot` with recorded pids that are dead or dying —
byte-for-byte the daemon-crash shape recovery has always handled: reap the recorded
pids, mark `warm`, keep the lease.

**The quiesce/acquire race guard becomes real.** The pre-stop idle re-check previously
read `lastUsedAt` from a snapshot nothing serialized against binds, so it could never
observe a concurrent acquire (the 2026-07-19 review's one held-back finding). Inside
the environment lock the re-check is ordered against the bind epilogues that write
`lastUsedAt`: a bind that ran first aborts the quiesce; a bind that queues behind it
rebinds a warm environment. Neither path throws, and neither charges `failStreak`.

## The alternative considered

A first-class `quiescing` state, taught to recovery ("finish the quiesce: reap, warm,
keep the lease"). Honest, but it grows the state machine for every reader of
`env.state` — sweeper skip rules, acquisition filters, `status` output, the docs — to
solve a problem the existing lock and the existing recovery path solve with less.
Rejected as surface without corresponding capability.

## Enforcement

`tests/lease-liveness.test.ts` ("a quiesce is never published as a teardown") stretches
the stop window with a TERM-ignoring service and polls the journal through a live
quiesce: observing `recycling` at any instant fails the test, and the lease must
survive to the `warm` end state. Against the borrowed-state implementation it observes
`hot → recycling → warm` and fails; under this decision it observes `hot → warm`.

# 0036. A server-wide load budget admits every start and build; `runly plan` says whether one would wait

- Status: Accepted
- Date: 2026-10
- Amends: [0032](0032-environments-run-in-the-callers-worktree.md) — the
  machine-wide pool cap (`BACKLOT_POOL_MAX_TOTAL`) no longer bounds load, only
  how many environments may be held
- Context: the only thing that bounded load was the number of environment
  rows, `min(cores/2, memGB/4)` clamped to [2, 8]. That is the wrong unit both
  ways: eight environments of a three-service app are a different load from
  eight of a twelve-service one, and since 0035 most held environments run
  nothing. Meanwhile ten agents starting builds at once on one box took it into
  swap with nothing to stop them, and nobody could ask "will my `up` start now?".

## Decision

**Declared resources.** A service or appliance may declare
`resources: { memory: 600M, cpu: 1, build: { memory: 2G, cpu: 4 } }`. What is
not declared costs a conservative default — run 512M / 0.5 cpu, build 1G / 1
cpu — and `runly plan` says which costs were assumed.

**One budget for every stack the daemon serves.** Every `up` and every
start on demand states its need before it builds or starts anything: the run
resources of each service and appliance it will start, plus the largest build
it will run (builds of one bind run one after another; a skipped `when:` build
costs nothing). It is admitted when

- runly's committed resources — running services and in-flight
  reservations, across every environment — plus the need fit under the
  budget: memory 70 % of RAM (`BACKLOT_BUDGET_MEMORY`), cpu 1.5 × cores
  (`BACKLOT_BUDGET_CPU`);
- on Linux, MemAvailable minus the need stays above the reserve,
  max(2 GiB, 10 % of RAM) (`BACKLOT_BUDGET_RESERVE`) — the headroom for work
  that is not runly's;
- the 1-minute load average is at most 2 × cores
  (`BACKLOT_BUDGET_LOAD_PER_CORE`).

Otherwise it queues, **first come first served** (a small request never
overtakes a big one), reporting its position, an estimate and what it waits
for, for at most `BACKLOT_BUDGET_WAIT_MS` (10 min) — then it fails with
env-error naming what is committed and the knobs. A need larger than the whole
budget fails at once; a request past `BACKLOT_BUDGET_MAX_QUEUE` (64) waiters is
refused at once. A start on demand waits at most as long as the proxy holds
its connection.

**Builds hold their share only while they build.** The build part of a
reservation is returned when the bind's build phase ends; the run part when
the operation ends, after which the running services themselves are the
commitment. A service that idle-stops (0035) stops counting.

**`runly plan [service…] [--rebuild] [--json]`** prints what an `up` would
build and start, each item's cost (declared or default), the total, the
budget, what is committed and the box's state, and the verdict: `starts now`,
or `would wait for …`, or `can never start: …`. It changes nothing.

**`BACKLOT_BUDGET=off`** (or `budget.enabled: false` in config.json) admits
everything. Every knob also reads from config.json's `budget` object
(`memory`, `cpu`, `reserve`, `loadPerCore`, `waitMs`, `maxQueue`).

**The pool cap stays, as a cap on what is held.** `BACKLOT_POOL_MAX_TOTAL`
still bounds environment rows — ports, data directories, database namespaces —
and eviction of cold environments still makes room. With the budget on, its
default is 2 × cores clamped to [4, 64] (32 on a 16-core box); with the budget
off, the old load-bounding heuristic applies again. Copies (`runly db`) stay
outside both (0034).

## Consequences

- On a 16-core / 62 GB box: a 43 GB / 24-cpu budget, a 6.2 GB reserve, a
  load gate of 32 — about 80 undeclared services running at once.
- Accounting is declared, not measured: a manifest that under-declares gets
  more admitted than fits; the MemAvailable and load gates are the backstop.
  RSS is shown by `ps` for whoever tunes `resources:`.
- A failed admission is env-error (exit 2): retrying later can succeed.

## Alternatives considered

- **Measure instead of declare** (admit by current RSS). Rejected as the only
  rule: a starting build has no RSS yet, and the peak is what matters.
- **Raise the row cap and nothing else.** Rejected: rows say nothing about load.
- **Priority instead of FIFO.** Rejected for now: fairness is easier to explain
  and to trust; nothing asked for priorities.

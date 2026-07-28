# 0025. A data-only environment answers to its own ceiling — and changing an environment's shape is a capacity event

- Status: Accepted
- Date: 2026-07
- Context: `up --data-only` ([0023](0023-data-only-leases.md)) removed the *weight*
  of an application environment but kept the *slot competition*: it was charged
  against `poolMax`/`poolMaxTotal`, which are derived from `min(cores/2, memGB/4)`
  because they bound **running services**. A data-only environment starts none,
  opens no port and builds nothing; where the datastore is an appliance its
  marginal cost is a database catalog plus a synced tree. A fresh worktree asking
  for `--data-only` was refused because six *application* environments — all cold
  and unleased — held the machine-wide budget (issue #48, alongside #46).
- Relates to: [0023](0023-data-only-leases.md) (the shape itself),
  [0003](0003-durable-environments-disposable-leases.md) (durable environments),
  [0002](0002-core-nouns.md) (the Environment noun)

## Decision

1. **Data-only environments are counted against `poolMaxDataOnly`**
   (`BACKLOT_POOL_MAX_DATA_ONLY`, default `max(4, 2 × poolMaxHeuristic())`) and
   against **neither** application cap. That ceiling is deliberately disk-shaped
   rather than CPU-shaped, and there is no per-stack variant: one lane per agent
   on one stack is the normal case.

2. **The shape lives on the environment row**, and **changing it is a capacity
   event.** A claim may still convert an environment between shapes — including a
   holder switching its own lease, which 0023 supports in both directions — but
   only when the destination ceiling has room. The conversion is written at claim
   time and logged as `pool-shape`.

3. A free environment of the **matching** shape is always preferred over
   converting one, so capacity is never spent when it need not be.

## Rationale

**Separately priced, not free.** The trees are still on disk, so an unbounded
data-only population is its own failure. What the separate ceiling fixes is the
*unit*: a lane spending a stack-sized allowance on a catalog-sized need is what
reintroduced the contention 0023 set out to remove — a test lane invoked by every
agent on every integration run competing with the interactive leases people use to
look at the app.

**Why the conversion has to be metered.** Both caps gate `createEnv` only —
rebinding an existing environment is never capacity-checked (see
[0024](0024-updating-the-running-daemon.md)'s neighbour, #46, for the other
consequence of that). With the two shapes answering to different ceilings, a claim
that changes an environment's shape moves it between them. If that move is free,
the cheap ceiling *is* application capacity: take N catalog-priced environments,
convert each to a full stack, and a host that allows one application environment
runs as many as you like. Metering the move is what makes the split sound.

**Why not pin the shape for the environment's lifetime.** That was tried first and
is simpler — no conversion, no metering, the leak impossible by construction. It
was rejected because it silently deletes a capability 0023 deliberately built and
tested: a holder switching its own lease between a database and the whole
application, which is how someone moves from "run the suite" to "look at what
broke" without giving up their seeded data. The regression showed up as two failing
tests in `tests/data-only-lease.test.ts`, which is the right way round.

**Why write the shape at claim time rather than after the bind.** The accounting
has to be exact against a concurrent claim, which must already see the environment
in its new bucket. It records intent rather than reality, and that is safe: the
field says what shape the environment *is*, and a bind that then fails leaves it
warm with nothing running — indistinguishable from any other failed bind.

## Consequences

- `poolMax`/`poolMaxTotal` now mean "application environments", and the refusal
  text says so. A host can hold `poolMaxTotal` applications *plus*
  `poolMaxDataOnly` lanes.
- Eviction (#46) is bucketed: a data-only request can only evict a cold data-only
  environment, since giving up an application one would not free the ceiling that
  refused it.
- A conversion refused for capacity reports the destination ceiling, naming the
  lease that would have to change shape.
- `dataOnly` is no longer derived per bind. `bindAndStart` reads the row and
  asserts against any explicit request, since a mismatch would mean the claim let
  something through that it should have refused.

## Alternatives considered

- **Exempt data-only entirely.** Rejected: the trees are on disk, and an unbounded
  population is a different bug rather than a fix.
- **Count a data-only environment fractionally against the application caps.**
  Rejected: a fraction of a cores-and-memory budget still prices a catalog in CPU,
  and the arithmetic is unexplainable in a refusal message.
- **A per-stack data-only cap as well.** Rejected for v1: the reported shape is
  many lanes on ONE stack (a lane per agent), which such a cap would refuse.
- **A second pool, or a second lease kind.** Rejected, as in 0023: this is one
  pool, one lease kind, one `envs` table — only the accounting differs.

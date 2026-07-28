# 0023. A lease may cover the datastores alone — the environment is unbundled downward, not split

- Status: Accepted
- Date: 2026-07
- Context: a consumer repo whose application environments backlot already brokers
  well ran its integration suites *outside* backlot, on Testcontainers, because
  the unit its test lane needed was not available on its own. Measured: 4m18s +
  3m16s of actual assertions became ~2 hours of wall clock with three agents
  active; an idle box improved only ~20%, so the cost was structural — container
  start plus a full backup restore, repeated per agent per test collection
  (issue #39).
- Relates to: [0002](0002-core-nouns.md) (the Environment noun),
  [0022](0022-data-state-mechanisms-deferred.md) (forcing conditions)

## Decision

`backlot up --data-only` takes an ordinary pooled environment and binds **only its
datastores**: sync and upkeep run, the namespace is created or restored at its
preset, and no service is started and no build is run. The environment is published
`warm`, because that is what warm already means — nothing running, everything else
intact.

No new pooled resource type, no second pool, no new lease kind. A data-only
environment is claimed, leased, quiesced, retained, recycled and torn down by
exactly the machinery every other environment uses.

"No services" is recorded durably on the environment row (`data_only`), because
`activeServices: []` cannot express it: an empty **selection** has always meant "the
whole app" (`resolveServiceClosure`), and a shape-preserving rebind reads that field.
Its inheritance rule is the slice's rule — an explicit request wins, a fresh claim
never inherits the previous holder's shape, a continuing lease preserves it.

## Rationale

**The pieces already existed; only the entry point was missing.** A bind creates and
template-restores the datastore namespace *before* it starts anything, `ctx` already
publishes `datastores.<name>.url`, and teardown already drops the namespace. What
0002 bundled into one noun — tree, caches, services, ports, namespace — a test lane
wanted a strict subset of. Unbundling downward costs a flag; the alternatives cost a
subsystem.

**Leasing a whole application environment was the wrong shape, not merely a heavy
one.** It boots services a test lane never calls, and it competes for pool slots with
the interactive leases people use to *look* at the app. Faced with those two, every
consumer built its own — which is the outcome this project exists to prevent.

**A second pool was considered and declined.** Splitting capacity accounting would
touch the FIFO queue, the per-stack and machine-wide ceilings, and the structural
capacity diagnosis — the most concurrency-sensitive code in the engine — to buy
isolation that `POOL_MAX` already buys, on environments that run no services and are
therefore cheap. If slot contention becomes the real complaint, a separate ceiling
can be added later without changing this decision.

**`warm` was chosen over `hot` or a new state.** A data-only environment has no
services by construction, so `hot` would be a lie to every reader of the journal and
would invite the idle sweeper to reclaim heat that was never taken. 0021 argues
against borrowing a state; inventing one here would need a reason, and there is none:
warm already describes this exactly. The one consequence is that `assertUsable` must
stop treating warm as proof that services went missing — for a data-only environment
it is proof of nothing.

**This is a forced mechanism, per 0022.** The forcing condition was a consumer
already using backlot for environments and measurably paying for the absence of the
smaller unit.

## Consequences

- `up --data-only` refuses what it cannot mean: a named service alongside it,
  `--watch` (nothing would reload), and a manifest declaring no datastore.
- `ctx` reports `dataOnly`, so a fixture can distinguish "no services by design"
  from "a service failed to come up" — `urls: {}` alone is ambiguous.
- `status` reports `dataOnly` per environment and names it in the summary line.
- A data-only environment occupies a pool slot. On a busy box the answer is a
  higher `POOL_MAX`, not a second pool.
- The journal gains a `data_only` column, defaulting to 0 — correct for every row
  that already existed.
- Not addressed: whether `run <check>` should accept `--data-only` for checks that
  need no services. It is the same mechanism and can be added when a consumer asks.
- Unverified downstream: whether a given repo's restore hook can restore from a
  *baked template* rather than its raw backup. Backlot removes the container start
  outright, but the restore cost is the repo's own script, and a lane that re-restores
  a full backup per lease still pays for it.

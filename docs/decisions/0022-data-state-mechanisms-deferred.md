# 0022. Data-state mechanisms are deferred until a consumer forces them

- Status: Accepted
- Date: 2026-07
- Amends: [0016](0016-data-states-not-seeds-three-baselines-scenarios-in-tests.md) —
  its doctrine stands; its unbuilt mechanisms lose their "sequenced" standing.

## Decision

0016's **doctrine is affirmed and remains binding**: a seed is a named data state
whose lifecycle backlot owns and whose content it never reads; a stack keeps ~three
stable baselines (`empty` / `dev` / `scaled`); scenario-specific data lives in the
tests that assert on it, never in new presets; `dev` and the e2e fixture state are
the same state.

0016's **mechanisms are deferred, not sequenced**. Per-check `state:` and
`backlot up --state` (S1), `states:` with `inputs`-hash template keying (S2), and
`snapshot`/`restore` (S3/S3b) will be built when — and only when — their forcing
condition occurs:

| Mechanism | Forcing condition |
| --- | --- |
| S1 selection | a repo needs different baselines per check and `default_preset` (per-kind selection, which already exists) cannot express it |
| S2 inputs-hash keying | the `@rebake-template` rule demonstrably fails a consumer (a missed input class, or the manual declaration becomes a recurring source of stale templates) |
| S3 snapshot/restore | someone repeatedly loses hand-built repro state mid-debug and says so |
| S4 layered/golden states | the remote substrate ships (already parked with it) |

## Rationale

The pressure to build these was consistency, not demand: this repo holds that an
Accepted-but-unimplemented decision is worse than no decision. This amendment
resolves that debt in the other direction — by making the record honest about what
is deliberately unbuilt — because the demand evidence is thin:

- The one selection mechanism consumers demonstrably use, different data per verb
  kind, **already exists** (`default_preset: {run, session}`).
- S2's original sin (silent template staleness) has been substantially closed by
  `@rebake-template` and content bake keys; what remains is ergonomics.
- No consumer has requested S3; the founding monorepo's preset sprawl was stopped
  by the *doctrine*, which costs nothing to keep.
- Each mechanism can be built later at the same cost as today — against a real
  consumer, with a real red test, and the right requirements instead of guessed
  ones. Built now, they are review surface and regression risk (S2 rewires
  template identity hardened on 2026-07-19) carried for zero present users.

## Consequences

- The backlog's S1–S4 entries move from active work to a when-forced section
  naming these conditions.
- Nothing in `docs/architecture.md`, the README, or the schema promises the
  deferred mechanisms; 0016 carries an amendment pointer so a reader of its
  follow-ups does not mistake them for pending work.
- If a forcing condition fires, the corresponding mechanism is implemented per
  0016's design — this amendment defers, it does not redesign.

# 0042. The migrations from before 0.16 are removed; an older journal is refused

- Status: Accepted
- Date: 2026-10
- Amends: [0030](0030-rename-backlot-to-runly.md) and
  [0034](0034-additive-up-database-copies-and-ps.md) — their migrations
- Context: 0.16–0.18 carried code that adopted legacy stack identities (alias
  spellings of a project path), moved retired template directories aside and
  dropped them in bounded batches, converted `data_only` environment rows,
  and pruned an `artifacts/` directory. Every journal those versions opened was
  migrated at their first start. The code ran in every recovery and every
  sweep, was a large share of the engine, and had its own fixtures and tests.

## Decision

The migrations are removed (about 1,200 lines). The journal refuses a file
stamped below schema 4 with an infra-error that says to start runly 0.18 on
it once first. Tables are created with all their columns; the remaining
`ALTER` loop only adds columns schema-4 journals may lack.

## Consequences

- Upgrading from 0.15 or older goes through 0.18.
- Leftover `retired-templates/` or `artifacts/` directories are not touched;
  `runly pool doctor` does not list them.

# 0011. Environments hold nothing precious; outputs write back only explicitly

- Status: Accepted

## Decision

Invariant: **an environment never holds the only copy of anything.** The consumer's
worktree is the sole source of truth; the environment's tree is a disposable
projection; templates are rebuildable by definition. Every reclaim decision is
therefore safe by construction.

The one sanctioned reverse flow: manifest-declared `outputs:` (regenerated lockfiles,
generated API clients — artifacts produced env-side but owned worktree-side) are
reported in the verdict (`outputs_changed`) and copied to the worktree **only** by an
explicit `infront pull` (or `--pull`). infront never silently writes to a worktree.

`infront exec` may produce anything inside the environment (dependency updates run
there when the consumer lacks the toolchain); the bind-time reset bounds the blast
radius, and `outputs:` is how its useful products come home.

## Rationale

Harnesses that let environments hold unlanded work inherit permanent teardown anxiety.
Keeping environments worthless-by-invariant is what makes leases, recycling, TTLs, and
crash recovery all trivially safe.

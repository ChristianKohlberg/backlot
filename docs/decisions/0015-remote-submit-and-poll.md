# 0015. Remote runs are submit-and-poll; remote environments carry provider TTLs

- Status: Local half superseded by [0032](0032-environments-run-in-the-callers-worktree.md) — `runly run`, `--detach`, `runly job`, the job journal and verdict artifacts are removed; the provider-TTL and tagging half stands for a future remote substrate

## Decision

On remote substrates:

- A run executes **detached on the box** (journaled), never as a held SSH pipe; the
  local CLI submits, then polls/reattaches. A closed laptop lid mid-run means the run
  completes remotely and the verdict/artifacts await reconnection.
- Every remote environment carries a **provider-side TTL** (e.g. Morph `ttl_action`)
  as the backstop a sleeping local daemon cannot provide.
- Drivers tag instances with stack/pool metadata so `pool reconcile` can adopt or reap
  what the local journal forgot.

## Rationale

Local and remote fail oppositely: locally, sleep pauses everything coherently and
orphans cost RAM; remotely, the world keeps running (and billing) while the brain is
asleep. The asymmetry — local orphans cost memory, remote orphans cost money — drives
both the TTL requirement and detached execution.

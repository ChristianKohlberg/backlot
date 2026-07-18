# 0019. Service ownership is proven by tag and group, not by a recorded pid

- Status: Accepted
- Supersedes the pid-based half of [0009](0009-journal-is-truth-daemon-is-cache.md) recovery

## Decision

A recorded pid is a **hint**, never proof of ownership. Locally:

- Every supervised service is spawned carrying `BACKLOT_ENV_ID`, `BACKLOT_SERVICE`, and
  `BACKLOT_STATE_ROOT` in its environment. The tag is inherited by every descendant, so
  the real server stays attributable after the wrapper that spawned it is gone.
- Every recorded pid is stored with the kernel's **start time** for that pid, pinning it
  to one process *life*. A pid whose start time no longer matches is somebody else's and
  is never signalled.
- Killing is verified against the **process group**, not the leader. Success means "no
  process remains in the group", and SIGTERM escalates to SIGKILL before the caller may
  drop the record.
- What the journal cannot name is found by scanning tags (`pool gc`), which runs on
  daemon recovery, on a periodic sweep, and as an explicit verb. A process is reclaimed
  only when no live environment accounts for it.
- The tag is scoped to the state root, so parallel installs — and concurrent test
  daemons — can never reap each other.

## Rationale

The crash-recovery contract (0009) deliberately lets services survive a daemon crash,
which means something must reclaim them later. Doing that from recorded pids alone fails
in three independent ways, all observed:

1. **`sh -c` forks.** The recorded pid is often only the wrapper. It dies obediently on
   SIGTERM while the real server ignores the signal and keeps its port and its ~1 GB, so
   "the leader exited" reads as success while the leak continues.
2. **A single unverified SIGTERM does not kill anything that handles SIGTERM** — a .NET
   host, a trapping shell. Dropping the pid afterwards made the survivor permanently
   unreachable, because a restarted daemon vends an empty supervisor for that env and
   every later teardown became a silent no-op.
3. **Pids are reused.** Signalling a pid recorded by a long-dead daemon can hit an
   unrelated process, which is worse than leaking.

Observed in the field (0.5.0, 31 GB host, no swap): 11 `ng serve` processes running
against 1 tracked environment — roughly 10 GB — with `pool recycle --all` reclaiming
nothing, because nothing tied those processes to backlot. On a memory-constrained host
this cascades: the leak drives the box toward OOM, the OOM killer takes more consumers,
and each one strands more orphans.

Identity has to come from something the process itself carries. The environment tag
survives the parent, survives the daemon, and survives the journal row.

## Consequences

- The tag scan is Linux-only (`/proc`). Elsewhere `pool gc` reports `supported: false`
  and cleanup degrades to the verified group kill. Skipping a sweep is the right failure
  mode; guessing at identity and signalling a stranger is not.
- Reclaim is scoped to a state root, so deleting a state root while its services run
  strands them beyond backlot's reach — acceptable, since that root's journal is gone too.
- Recovery now performs real work (verified kills, a scan), so the daemon holds requests
  behind it rather than serving a view of state it is about to change. `ping` is exempt
  so the singleton election stays answerable.
- `release` still leaves services running: the warm pool is the product, and a released
  environment is meant to stay hot. The leak it used to widen is closed by reclaim, not
  by tearing down on release.

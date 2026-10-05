# 0032. Environments run in the caller's worktree — one per worktree — and runly caches no builds

- Status: Accepted
- Date: 2026-10
- Supersedes: [0004](0004-watchers-never-move-bindings-move.md) (environments own a
  tree), [0005](0005-git-sync-immutable-bindings.md) (sync transport, immutable
  bindings, bind-time reset)
- Amends: [0002](0002-core-nouns.md) (Environment, Binding),
  [0007](0007-hygiene-levels.md) (what `reset-data` and `pristine` touch),
  [0008](0008-lazy-upkeep-fingerprint-ledger.md) (what a rule fingerprints, and
  whose ledger it is), [0011](0011-nothing-precious-outputs-writeback.md) (the
  write-back), [0023](0023-data-only-leases.md) and
  [0025](0025-data-only-environments-are-priced-separately.md) (the per-stack
  ceiling is gone)
- Context: every bind projected the caller's worktree into a separate tree under
  `envs/<env>/tree` — a `git ls-files` file set, stat-gated and hash-verified
  copies — and the services built and ran there, with their caches in that
  copy. Measured on the founding consumer (the revamp monorepo, 2026-10-05):

  | | |
  | --- | --- |
  | tracked files | 34,816 (1.07 GB) |
  | live environment trees on the box | 5, at 2.0–2.6 GB each |
  | of which source copy | ~1.07 GB per environment |
  | of which caches | `node_modules` 555 MB, `obj`/`bin` 911 MB, `.angular` 27 MB |
  | filesystem | ext4 — no reflink, so `COPYFILE_FICLONE` falls back to a real copy |

  A new environment paid a full source copy and then a second, cold set of
  caches. Those caches could never be shared with the worktree's own, because
  they record the path they were made at: .NET's `obj/project.assets.json`,
  `*.dgspec.json` and the CoreCompileInputs hash embed absolute paths, and pnpm
  records its install path in `node_modules/.pnpm-workspace-state-v1.json`.
  Meanwhile the agent's own worktree — a persistent treehouse pool slot at a
  fixed path — already held warm caches from its earlier tasks.

## Decision

The owner's calls, recorded as given: *"Run it in the slot, the copy is gone."*
On review of the first cut: **one environment per worktree**, with `run` reusing
it after a fresh data reset and no flag to keep the session's data; and **runly
is not responsible for builds or build caches** — MSBuild, pnpm and the Angular
CLI decide incrementality themselves.

**An environment runs in the caller's worktree.** Its services' `cwd`, their
builds, upkeep rules, checks, `exec` and the `auth.token` hook all run in the
stack root the caller bound from. There is no projection. What stays under the
environment's own directory is the state that is not source and is private to
it: ports, datastore namespaces, the data dir, logs, pids, leases.

**A worktree has exactly one environment.** A stack is one physical worktree
(its id is derived from the canonical root), and a bind for that worktree always
lands on its one environment; a second is never created. A second holder of the
same worktree waits for the environment like any other claimant — and is
refused at once, naming the holder, when that lease outlasts the wait. The
per-stack ceiling (`BACKLOT_POOL_MAX`) has nothing left to bound; the
machine-wide and data-only ceilings are unchanged. A journal from an older runly
can still hold several environments for one worktree: the sweep recycles the
unleased surplus, and a leased one is left to its holder until it is released.

**`run` reuses that environment, with a fresh data reset first.** When a session
holds it, the check binds *through* the session's lease: reset-data hygiene (a
fresh clone from the template), the whole app started, the check run, the lease
and its deadline kept. With no session it takes a run lease and ends it after
the verdict; the environment stays for the next bind. A run never binds through
another run's lease — it queues for the environment instead. There is
deliberately no escape hatch (no `--keep-session-data`): a check's verdict is
only worth something against data in a known state.

**runly caches no builds.** There is no whole-worktree source identity, no
`@source`, no build stamps. A service's `build:` runs on every bind that starts
it, and on every `runly warm`; the build tool decides what is already current,
and a no-op build of theirs is cheap.

What each mechanism became:

- **Upkeep rules stay, and fingerprint only their triggers.** A rule's
  fingerprint is the content of exactly the files its `when:` glob matches
  (`git ls-files` filtered by the globs before anything is stat'ed, plus
  checked-out submodules and `sync.include`, minus declared `caches:`).
  `@rebake-template` and the content-derived template identity work as before
  over the same files. The trigger files' hashes are cached — stat-gated, with
  git's racily-clean rule — in `worktrees/<stack>/triggers.json` in the state
  root, never in the worktree, and that cache holds the trigger files and
  nothing else. (A consumer's trigger globs match 160 MB of database backups,
  named by several rules; re-reading them per rule per bind on the daemon's
  thread is what the cache avoids.)
- **The upkeep ledger is the worktree's.** Command rules are recorded in
  `worktrees/<stack>/ledger.json`, shared by the worktree's environment and by
  `warm`; the `@`-built-in rules (which act on an environment's data) stay on the
  environment row. A rule drops its entry before it runs, so one that fails
  half-way is never vouched for.
- **A worktree lock** serializes everything runly writes into the worktree
  (upkeep, builds, a pristine bind clearing the ledger) between the environment
  and `warm`, which can run with no environment at all. An environment lock is
  always taken before it.
- **`up` and `sync`.** runly cannot tell whether the worktree's code changed
  since the services started, so the verb says it. `up` on a running, healthy
  environment in the requested shape, with nothing else changed (manifest,
  inputs, presets, due upkeep, hygiene), is a reuse: no build, no restart. `sync`
  applies the worktree as it is now: with every service `hot_reload`, no due
  upkeep rule and an unchanged manifest it keeps the services (they read the
  worktree themselves); otherwise it rebuilds and restarts. `--watch` watches the
  worktree for exactly the case its dev servers cannot handle (a save that trips
  an upkeep rule takes the full bind) and to record activity; writes under
  `caches:` are ignored.
- **Hygiene.** `reuse` is unchanged. `reset-data` restores data and nothing else
  — the clean-slate sweep of untracked files is gone, because in the worktree
  those files are the caller's work. `pristine` recreates the environment's
  private state and **clears the worktree's upkeep ledger**, so every upkeep rule
  runs again in place; it never deletes a file in the worktree.
  Auto-escalation (two failures → pristine) keeps that meaning.
- **`run`** reports `outputsChanged` by hashing the declared `outputs:` around the
  check, and collects artifacts only from files written since the check started.
- **Teardown and recovery** delete only the environment's private directory, and
  check before the `rm -rf` that it lies under the state root's `envs/` and does
  not contain the worktree. The cwd-based reap of tag-scrubbing escapees is
  limited to that private directory: in a worktree, cwd is not ownership (the
  agent's shells and builds sit there). Recovery deletes an older daemon's
  projected `tree/` once its processes are confirmed gone.
- **`runly warm`** (new) runs the stack's due command upkeep rules and its
  services' `build:` steps in the current worktree, with no lease and no
  services. It holds the worktree's environment lock (if it has one), then the
  worktree lock, writes the same upkeep ledger a bind reads, and prints each step
  with its duration (`--json` for the structured form; commands are never
  printed). A build line that templates an environment's ports or datastores,
  and an `@` built-in, is reported as skipped. The intended use is an idle pool
  slot moved to a new commit: `git checkout <sha> && runly warm`, so the next
  bind finds the installs done and the build tools' own incremental state
  current. Scheduling it in the background is deliberately deferred.

### What was deleted, and why

- `src/core/sync.ts` (`syncIntoEnv`, the clean-slate sweep, the deletion mirror,
  the case-insensitive-rename handling, `changedOutputs`, `pullOutputs`) and the
  `sync-thread`/`sync-worker` pair.
- The whole-worktree fingerprint, its worker thread and its `hashes.json` stat
  cache, `@source`, and the per-service build stamps (`@built:<service>`): runly
  does not decide whether a build is needed.
- `runly pull` and `run --pull` — there is no environment copy to pull from; the
  check wrote its outputs where they belong. Both are now usage errors (exit 64)
  that name this decision.
- `runly bind --ref <sha>` — it extracted a commit into a temp dir and projected
  that. With no second tree, binding a ref means checking it out in a worktree
  (`git checkout`, or a separate worktree) and binding that; the flag is a usage
  error naming this decision. Plain `bind` remains `sync`'s older spelling.
- The ephemeral second environment of `run`, and with it the per-stack ceiling's
  only remaining purpose.
- The submodule refusal — it existed only because a submodule's contents were
  never projected; in place they are simply there.
- `sync.keep` has nothing left to protect. It still validates (consumer
  manifests carry it) and is ignored.

## Consequences

- A new environment costs no source copy and no second set of caches, and a
  worktree never holds two environments' build output: there is only one
  environment to build into it.
- **A check sees the live worktree.** Under the projection a run executed
  against the revision synced at its start, and an edit made mid-run could not
  touch the verdict. Now it can: the binding is no longer an immutable snapshot.
  A caller that needs a stable verdict does not edit while its check runs, or
  runs it from a separate worktree.
- **A run wipes the session's data.** It resets the environment's datastores
  before the check and leaves the reset state behind; the session's services are
  restarted as the whole app. That is the owner's call, with no flag around it.
- **A second holder of a worktree waits.** Two agents (or two lanes) working
  from one worktree share one environment, one at a time; parallel lanes need
  separate worktrees. A database per consumer (0023) is now a database per
  worktree.
- **`up` no longer notices code changes.** It reuses a running environment as
  is; `sync` (or `--watch` for upkeep triggers) is how a change is applied. A
  consumer whose instructions say "edit, then `up`" must say "edit, then `sync`".
- **Every bind that starts services runs their builds**, and so does every
  `warm`. On a worktree whose build tool is incremental this costs a no-op build
  per bind; on one that is not, it costs a full build. That trade is the owner's.
- **runly now writes into the worktree** — that is the point — through the
  repo's own commands: upkeep, builds, services, checks. Output git does not
  ignore and `caches:` does not declare can match an upkeep trigger; consumers
  should ignore their outputs.
- The ledger cannot see what happens to the worktree outside runly. If the
  caller deletes `node_modules` by hand, bind with `--pristine` (or let two
  failures escalate to it) to re-run what the ledger vouched for. `pristine`
  does not delete caches; a corrupted cache the repo's own commands do not
  repair survives it.
- **Known limitation (accepted):** only tags and recorded process groups
  identify a service process now. One that scrubs its tag and leaves its group
  is no longer found by cwd at teardown, because cwd in a worktree is not
  ownership.
- The safety invariant of 0011 narrows to what runly owns: an environment's
  private directory never holds the only copy of anything, and runly never
  deletes the worktree. Teardown stays safe by construction because it deletes
  only the former and checks that it is not the latter.
- Ports stay stable for an environment's lifetime (0004's other half), so URLs
  and the lease-scoped preview (0027) are unaffected.
- The remote-substrate sync of 0005 (git as the local/remote boundary) is not
  replaced here; a remote substrate will need its own answer to "where does the
  worktree live", and that is its decision to make.

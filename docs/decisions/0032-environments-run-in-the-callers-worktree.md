# 0032. Environments run in the caller's worktree; the projection copy is gone

- Status: Accepted
- Date: 2026-10
- Supersedes: [0004](0004-watchers-never-move-bindings-move.md) (environments own a
  tree), [0005](0005-git-sync-immutable-bindings.md) (sync transport, immutable
  bindings, bind-time reset)
- Amends: [0002](0002-core-nouns.md) (Environment, Binding),
  [0007](0007-hygiene-levels.md) (what `reset-data` and `pristine` touch),
  [0008](0008-lazy-upkeep-fingerprint-ledger.md) (whose ledger it is),
  [0011](0011-nothing-precious-outputs-writeback.md) (the write-back)
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

**An environment runs in the caller's worktree.** Its services' `cwd`, their
builds, upkeep rules, checks, `exec` and the `auth.token` hook all run in the
stack root the caller bound from. There is no projection. What stays under the
environment's own directory is the state that is not source and is private to
it: ports, datastore namespaces, the data dir, logs, pids, leases.

The owner's call, recorded as given: *"Run it in the slot, the copy is gone."*

What each mechanism became:

- **Source identity.** A bind still needs to know whether the running services
  and the build output are from this state, so `src/core/worktree.ts`
  fingerprints the live worktree: the same `git ls-files` set (plus
  `sync.include`, plus checked-out submodules, minus declared `caches:`), the
  same stat-gated, racily-clean hashing, no copy. Its stat cache lives in the
  state root (`worktrees/<stack>/hashes.json`), never in the worktree.
- **The ledger splits by what it describes.** Command upkeep rules and per-service
  build stamps (`@built:<service>`, keyed by source hash *and* the resolved build
  command) are facts about the worktree, shared by every environment of the stack
  and by `warm`: they live in `worktrees/<stack>/ledger.json`. `@source` (what
  the running services were started from) and the `@`-built-in rules (which act
  on an environment's data) stay on the environment row. A rule or build drops
  its entry before it runs, so one that fails half-way is never vouched for.
- **A worktree lock** serializes everything that writes into the worktree
  (upkeep, builds, a pristine bind clearing the ledger) across the stack's
  environments. Environment locks are always taken before it.
- **`sync` and `--watch`** keep their contracts without copying. With every
  service `hot_reload`, no pending upkeep rule and an unchanged manifest, `sync`
  records the new source and keeps the services — they read the worktree
  themselves. Otherwise it is the full bind (rebuild, restart). `--watch` watches
  the worktree for exactly the cases its dev servers cannot handle (a save that
  trips an upkeep rule takes the full bind) and to record activity; writes under
  `caches:` are ignored.
- **Hygiene.** `reuse` is unchanged. `reset-data` restores data and nothing else
  — the clean-slate sweep of untracked files is gone, because in the worktree
  those files are the caller's work. `pristine` recreates the environment's
  private state and **clears the worktree ledger**, so every upkeep rule and
  build runs again in place; it never deletes a file in the worktree.
  Auto-escalation (two failures → pristine) keeps that meaning.
- **`run`** binds its own environment exactly as before and runs the check in
  the worktree. Declared `outputs:` are hashed around the check and reported as
  `outputsChanged`; artifacts are collected only from files written since the
  check started.
- **Env reuse across holders** is unchanged: a stack is one physical worktree,
  so every environment of a stack already served the same worktree.
- **Teardown and recovery** delete only the environment's private directory, and
  check before the `rm -rf` that it lies under the state root's `envs/` and does
  not contain the worktree. The cwd-based reap of tag-scrubbing escapees is
  limited to that private directory: in a worktree, cwd is not ownership (the
  agent's shells and builds sit there). Recovery deletes an older daemon's
  projected `tree/` once its processes are confirmed gone.
- **`runly warm`** (new) runs the stack's command upkeep rules and its services'
  `build:` steps in the current worktree, with no lease and no services. It holds
  every environment lock of the stack, then the worktree lock, writes the same
  ledger a bind reads, and prints each step with its duration (`--json` for the
  structured form; commands are never printed). A build line that templates an
  environment's ports or datastores, and an `@` built-in, is reported as skipped.
  The intended use is an idle pool slot moved to a new commit:
  `git checkout <sha> && runly warm`. Scheduling it in the background is
  deliberately deferred.

### What was deleted, and why

- `src/core/sync.ts` (`syncIntoEnv`, the clean-slate sweep, the deletion mirror,
  the case-insensitive-rename handling, `changedOutputs`, `pullOutputs`) and the
  `sync-thread`/`sync-worker` pair — replaced by the copy-free fingerprint and
  its own worker.
- `runly pull` and `run --pull` — there is no environment copy to pull from; the
  check wrote its outputs where they belong. Both are now usage errors (exit 64)
  that name this decision.
- `runly bind --ref <sha>` — it extracted a commit into a temp dir and projected
  that. With no second tree, binding a ref means checking it out in a worktree
  (`git checkout`, or a separate worktree) and binding that; the flag is a usage
  error naming this decision. Plain `bind` remains `sync`'s older spelling.
- The submodule refusal — it existed only because a submodule's contents were
  never projected; in place they are simply there, and are fingerprinted.
- `sync.keep` has nothing left to protect. It still validates (consumer
  manifests carry it) and is ignored.

## Consequences

- A new environment costs no source copy and no second set of caches; the first
  bind in a worktree that already built is a build-stamp hit if `warm` (or an
  earlier bind) built the same source with the same command.
- **A check sees the live worktree.** Under the projection a run executed
  against the revision synced at its start, and an edit made mid-run could not
  touch the verdict. Now it can: the binding is no longer an immutable snapshot.
  A caller that needs a stable verdict does not edit while its check runs, or
  runs it from a separate worktree.
- **Environments of one worktree share its build output.** Two environments of
  the same stack (a session `up` and a `run`) run from the same `bin/` and
  `node_modules`; a rebuild by one is visible to the other's running services,
  and two dev servers of one project share one cache directory. The worktree
  lock serializes the writes, not their effect on running processes.
- **runly now writes into the worktree** — that is the point — through the
  repo's own commands: upkeep, builds, services, checks. A service command that
  generates a file (a runtime config, a log) writes it there. Output git does
  not ignore and `caches:` does not declare becomes part of the source identity,
  so every bind would see it as a change and restart; consumers should ignore
  their outputs.
- The ledger cannot see what happens to the worktree outside runly. If the
  caller deletes `node_modules` or `obj/` by hand, bind with `--pristine` (or let
  two failures escalate to it) to re-run what the ledger vouched for.
- Only tags and recorded process groups identify a service process now; one that
  scrubs its tag and leaves its group is no longer found by cwd at teardown.
- The safety invariant of 0011 narrows to what runly owns: an environment's
  private directory never holds the only copy of anything, and runly never
  deletes the worktree. Teardown stays safe by construction because it deletes
  only the former and checks that it is not the latter.
- Ports stay stable for an environment's lifetime (0004's other half), so URLs
  and the lease-scoped preview (0027) are unaffected.
- The remote-substrate sync of 0005 (git as the local/remote boundary) is not
  replaced here; a remote substrate will need its own answer to "where does the
  worktree live", and that is its decision to make.

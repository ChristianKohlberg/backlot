# 0032. Environments run in the caller's worktree — one per worktree — `up` is the only bind verb, and runly runs no checks

- Status: Accepted
- Date: 2026-10
- Supersedes: [0004](0004-watchers-never-move-bindings-move.md) (environments own a
  tree), [0005](0005-git-sync-immutable-bindings.md) (sync transport, immutable
  bindings, bind-time reset, the `sync` verb and `--watch`), the local half of
  [0015](0015-remote-submit-and-poll.md) (detached runs, `job`, the job journal)
- Amends: [0002](0002-core-nouns.md) (Environment, Binding; the Run noun is
  removed), [0007](0007-hygiene-levels.md) (what `reset-data` and `pristine` touch),
  [0008](0008-lazy-upkeep-fingerprint-ledger.md) (what a rule fingerprints, and
  whose ledger it is), [0011](0011-nothing-precious-outputs-writeback.md) (the
  write-back), [0023](0023-data-only-leases.md) and
  [0025](0025-data-only-environments-are-priced-separately.md) (the per-stack
  ceiling is gone), [0012](0012-commands-first-services.md) (`watch_run`,
  `hot_reload`, service `outputs:`), [0016](0016-data-states-not-seeds-three-baselines-scenarios-in-tests.md)
  (§4, a check declaring its state)
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
On review of the first cut: **one environment per worktree**, and **runly is not
responsible for builds or build caches** — MSBuild, pnpm and the Angular CLI
decide incrementality themselves. On review of the second: **`up` is the only
bind verb** (no `sync`), it restarts only what a build changed, and **runly runs
no checks** — `runly run`, its jobs and the manifest's `checks:` are removed,
and so is the per-stack ceiling.

**An environment runs in the caller's worktree.** Its services' `cwd`, their
builds, upkeep rules, `exec` and the `auth.token` hook all run in the
stack root the caller bound from. There is no projection. What stays under the
environment's own directory is the state that is not source and is private to
it: ports, datastore namespaces, the data dir, logs, pids, leases.

**A worktree has exactly one environment.** A stack is one physical worktree
(its id is derived from the canonical root), and a bind for that worktree always
lands on its one environment; a second is never created. A second holder of the
same worktree waits for the environment like any other claimant — and is
refused at once, naming the holder, when that lease outlasts the wait. The
per-stack ceiling (`BACKLOT_POOL_MAX`, `poolMax` in `config.json`) is removed —
it had nothing left to bound, and a leftover setting is ignored; the
machine-wide (`BACKLOT_POOL_MAX_TOTAL`) and data-only ceilings are unchanged. A journal from an older runly
can still hold several environments for one worktree: the sweep recycles the
unleased surplus, and a leased one is left to its holder until it is released.

**`up` is the only bind verb, and it restarts what a build changed.** Every `up`
applies the worktree as it is now: it runs the due upkeep rules and then the
`build:` of every service it starts. runly still does not decide whether a build
is needed; it decides only whether a *service* must restart:

- A service may declare `outputs:` — globs, relative to the stack root, of what
  its build produces (`backend/host/Fid.Host/bin/**`, a SPA's `dist/` directory).
  runly snapshots the matched files (path, size, mtime) before the build and
  again after it, and restarts the service only when they differ.
- A service with a `build:` and no `outputs:` is restarted after every build —
  the safe default.
- A service with no `build:` keeps running: no build ran, so nothing of it can
  have changed (a dev server that reads the worktree itself). A service of that
  kind that must restart on every `up` declares a build that does nothing it
  measures, e.g. `build: "true"`.
- A service that is not running is started, whatever its outputs say.
- The rest of the environment is untouched: ports and data stay, and the
  services that depend on a restarted one are not restarted (their URLs did
  not move).

The full stop/data/build/start path remains for what a restart of single
services cannot carry: a changed manifest, changed caller inputs or presets, an
upkeep rule that ran, a data hygiene (`--reset-data`, `--pristine`), an
environment that is not running healthy, or a different service shape.

**runly runs no checks.** `runly run`, `--detach`, `runly job`, the job journal
and verdict artifacts are removed, and so is the manifest's `checks:` section. A
repository runs its own tests against the environment, which `runly ctx --env`
describes as shell-exportable lines with stable names:

| Variable | Value |
| --- | --- |
| `RUNLY_ENV_ID` | the environment's id |
| `RUNLY_PORT_<PORT>` | each allocated port, by its manifest key |
| `RUNLY_URL_<SERVICE>` | each running service's URL |
| `RUNLY_DATASTORE_<NAME>_URL` | each datastore's connection string |
| `RUNLY_LOGIN_USER`, `RUNLY_LOGIN_PASSWORD` | the primary login, when the stack declares one |

Names are upper-cased with every other character as `_` (`web-audit` →
`RUNLY_URL_WEB_AUDIT`); a value is single-quoted only when the shell needs it.
`eval "$(runly ctx --env)" && pnpm test` is the whole interface; `ctx --json`
stays for programs. A manifest that still declares `checks:` loads, with a
one-line warning on stderr naming this decision.

**runly caches no builds.** There is no whole-worktree source identity, no
`@source`, no build stamps. A service's `build:` runs on every `up` that starts
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
- **`sync`, `bind` and `--watch` are removed.** `up` does what `sync` did
  (apply the worktree, upkeep and builds), and restarts less. `--watch` existed
  to re-sync on save and to notice a save that trips an upkeep rule; a repeated
  `up` covers both. `watch_run` and `hot_reload` are accepted and ignored.
- **Hygiene.** `reuse` is unchanged. `reset-data` restores data and nothing else
  — the clean-slate sweep of untracked files is gone, because in the worktree
  those files are the caller's work. `pristine` recreates the environment's
  private state and **clears the worktree's upkeep ledger**, so every upkeep rule
  runs again in place; it never deletes a file in the worktree.
  Auto-escalation (two failures → pristine) keeps that meaning.
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
- `runly pull` and `--pull` — there is no environment copy to pull from.
- `runly bind --ref <sha>` — it extracted a commit into a temp dir and projected
  that. With no second tree, binding a ref means checking it out in a worktree
  (`git checkout`, or a separate worktree) and running `up` there.
- `runly sync` and its older spelling `bind`, the `sync` RPC, `--watch` and its
  watchers (the in-place refresh that kept `hot_reload` services running).
- `runly run`, `--detach`, `runly job` (`job ls`), the `jobs` journal table (an
  older journal keeps it, unread) and its recovery sweep, the verdict artifacts directory and its retention, the
  check timeout and process-group kill, and the manifest's `checks:` (with
  `outputs:` at the top level, which only `run` read).
- `BACKLOT_POOL_MAX` / `poolMax`: the per-stack ceiling, and its line in
  `status`.
- Each removed verb and flag is a usage error (exit 64) that names this decision
  and what replaced it, answered before the daemon is contacted.
- The submodule refusal — it existed only because a submodule's contents were
  never projected; in place they are simply there.
- `sync.keep` has nothing left to protect. It still validates (consumer
  manifests carry it) and is ignored.

## Consequences

- A new environment costs no source copy and no second set of caches, and a
  worktree never holds two environments' build output: there is only one
  environment to build into it.
- **Tests see the live worktree.** Under the projection a run executed
  against the revision synced at its start, and an edit made mid-run could not
  touch the verdict. Now the services run from the worktree itself: a caller that
  needs a stable result does not edit while its tests run, or runs them from a
  separate worktree.
- **runly gives no verdicts any more.** A repository's tests decide pass or fail
  themselves, and choose their data state with `up --reset-data` /
  `--preset`; the error taxonomy (0010) still classifies runly's own failures.
- **A service whose output did not change keeps running** across `up` —
  including through a change the build did not notice. A wrong `outputs:` glob
  (one that misses what the build writes) means a stale service; the remedy is
  the glob, or `up --reset-data` for a full restart. Dependents of a restarted
  service keep running and keep their connections to its stable port; a
  dependent that caches what it read at startup must be restarted by its own
  build or by a full bind.
- **A second holder of a worktree waits.** Two agents (or two lanes) working
  from one worktree share one environment, one at a time; parallel lanes need
  separate worktrees. A database per consumer (0023) is now a database per
  worktree.
- **Every `up` runs the builds of the services it starts**, and so does every
  `warm`. On a worktree whose build tool is incremental this costs a no-op build
  per bind; on one that is not, it costs a full build. That trade is the owner's.
- **runly now writes into the worktree** — that is the point — through the
  repo's own commands: upkeep, builds, services. Output git does not
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

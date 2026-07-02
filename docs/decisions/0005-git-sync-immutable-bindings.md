# 0005. Git is the sync transport; bindings are immutable; verbs sync, watch streams

- Status: Accepted

## Decision

- Sync = `git fetch` from the consumer's worktree path + the dirty/untracked state
  applied as a patch. Git handles deletes, renames, and modes; the object store makes
  it incremental; the same mechanism works over SSH to remote substrates — **the sync
  boundary is the local/remote abstraction**.
- Nothing observes the consumer's worktree by default. Every action verb (`run`, `up`,
  `sync`, `bind`) captures the worktree at invocation. `--watch` sessions opt into a
  debounced auto-sync watcher.
- A **binding is an immutable snapshot**: a run executes against the revision synced at
  start; consumer edits mid-run cannot contaminate the verdict.
- Bind-time reset: tracked files restored hard, untracked cleaned, **except** declared
  `caches:` and `sync.keep`. `sync.include` declares git-ignored-but-needed files.
  Oversized diffs fall back to file copy.

## Rationale

Explicit sync matches how agents act (discrete steps, a verb was coming anyway) and
makes verdicts deterministic. Git-as-transport avoids reimplementing rsync semantics
and dogfoods the "orchestrate, don't reimplement" doctrine.

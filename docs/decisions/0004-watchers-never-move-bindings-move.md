# 0004. Watchers never move; bindings move

- Status: Accepted

## Decision

An environment owns its own copy of the source tree, in its own directory. Its
processes (dev servers, watchers) watch **that tree, forever**. Pointing an environment
at different work means syncing different work into its tree — never relocating
processes to a consumer's worktree. Consumer worktrees visit environments; environments
never visit worktrees.

## Rationale

Watcher identity is path-bound: incremental caches, pid files, proxies, generated
artifacts. "Moving" a watcher is really killing it and starting cold elsewhere —
nothing warm carries over. Inverting ownership makes rebinds incremental (caches
survive), keeps ports and URLs stable for an environment's lifetime, and guarantees the
consumer's worktree is never touched by infront.

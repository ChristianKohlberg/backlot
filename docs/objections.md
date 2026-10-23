# Choosing Runly

## Why not copy source into each environment?

Services and builds run in your existing worktree, so they reuse its installed
dependencies and compiler caches. Runly keeps only private data, logs and ports
outside it. This avoids duplicate source trees and caches tied to the wrong path.

The trade-off is that edits are immediately visible to running processes. Use
separate worktrees for independent tasks or tests that need fixed source. Each
worktree gets one environment.

Private data is not disposable by assumption: database mutations may exist only
there. Idle preserves it; explicit destruction or worktree removal deletes it.
Runly never deletes the source worktree.

## Why not run the commands directly?

For a small app, running its commands directly may be sufficient. Runly adds
stable proxy URLs, readiness checks, isolated database copies, repeatable seed
restores, idle/wake and local diagnostics. Your own commands still perform the
builds and run the services.

Environment lifetime follows the worktree, not the agent process. An agent exit
does not delete data; inactivity stops managed services. This matters when a
human or a resumed session needs to inspect the same state later.

## Where do containers fit?

Use containers when the app or its backing servers need them. Runly can start
shared backing servers through appliances and run container commands as services.
The manifest must still make process ownership, readiness and cleanup explicit.
An appliance is shared infrastructure: idle and environment destruction do not
stop it.

Runly is useful when you want its worktree lifecycle, seed templates, disposable
copies and traffic-triggered wake around those commands. If your existing setup
already provides the behavior you need, adding another manager may not help.

See [the guide](overview.md), [manifest reference](manifest.md) and
[operations](operations.md) for the actual contracts. Earlier comparisons are
recorded in the [dated landscape review](reviews/2026-07-20-landscape.md).

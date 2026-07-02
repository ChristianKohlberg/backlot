# 0003. Environments are durable; leases are disposable

- Status: Accepted

## Decision

Environments belong to a fixed-size pool and survive their consumers. Ownership is a
lease with a TTL refreshed by any CLI interaction; expiry **releases** the environment
back to the pool warm — it never tears anything down. Idle environments quiesce
(`hot → warm`: services stopped, caches kept) on a second timer.

There are no consumer heartbeats: losing a lease is designed to be worthless, because
rebinding is cheap and the source of truth never leaves the consumer's worktree.

## Rationale

Abandoned half-dead environments are the rational response to expensive provisioning —
people hoard what is costly to recreate. Making the lease (not the environment) the
disposable unit fixes abandonment structurally: an agent that crashes or vanishes costs
nothing, and there is never anything running "for nobody."

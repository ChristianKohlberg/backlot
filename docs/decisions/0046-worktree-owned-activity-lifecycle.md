# 0046 — Worktree-owned environments, activity-based idle

Environments belong to worktrees, independently of agent processes. After **5 minutes**
without activity, managed services stop; data, configuration and public ports stay.
Activity means bytes in either direction through any environment proxy port, or a
verb that uses the environment (`up`, `exec`, `token`, `preview`, `reset-data`, `down`).
Read-only commands and internal readiness probes do not count. The clock is shared
across the environment, with per-service `idle:` overrides.

New connections wake wanted services and their dependencies even after `release`,
subject to the load budget. Explicitly downed or failed services require `up`.
WebSocket messages, protocol heartbeats and server-sent events count as traffic;
a silent open connection does not. Consequently an idle stop closes silent sockets:
clients must reconnect. Run silent background work with `runly exec` (heartbeats
while its child runs), or set `idle: never`. Shared appliances remain running.

Agent death, disconnection, idle age and pool pressure never delete an environment.
A confirmed missing worktree does; inaccessible paths and filesystem errors are not
proof of deletion. Renaming a worktree removes its old path and therefore also
triggers cleanup. Explicit `destroy` and `pool recycle` remain destructive.
Environment leases never expire; `--ttl` is rejected outside `preview`. Public
previews always expire (30 minutes by default, `preview --ttl <minutes>` to change
it). Expiry closes public access, including open streams, but retains the lease
and environment. A successful `up` renews an active preview for its configured TTL. Failed `up`
calls and daemon restarts do not extend it. A successful `up` also reopens a
previously enabled preview after automatic expiry, using its saved TTL. Explicit
`preview stop`, `release`, or a forbidden-preview configuration clears that intent. `--holder-pid` on `up` is diagnostic metadata only; there is no
agent-specific automatic tether. Required caller inputs lost on release or daemon
restart must be supplied by a fresh `up` before services using them can wake.

A full machine-wide environment cap refuses creation and names `BACKLOT_POOL_MAX_TOTAL`;
raise the cap or explicitly destroy an unwanted environment. Load admission still
bounds running services and builds. Failed starts retain data; retrying never
implicitly runs `--pristine`.

Standalone database copies retain their separate lifecycle: `db with` owns a copy
for its command; `db new` can use an explicit process holder or the Claude ancestor
tether. This does not control the application environment.

Schema 5 prevents older daemons from reopening these environments and applying destructive legacy lifecycle rules. Legacy environment deadlines are retired on recovery. Legacy public previews without a recorded deadline are revoked rather than restored. This supersedes the environment lifetime rules in 0035, 0039 and 0041 and automatic capacity eviction.

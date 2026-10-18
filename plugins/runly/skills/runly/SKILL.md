---
name: runly
description: Use the runly CLI to start an existing stack, run tests, inspect logs, manage data and previews, or troubleshoot its environment. For creating or changing the manifest, use runly-setup.
---

# runly

runly runs the repo's app **in your worktree**, one environment per worktree,
from `runly.yml` or `runly.yaml` at the repo root. A per-machine daemon supervises the
services and holds a stable public port per service. You get URLs, logins and
connection strings; you run your own tests against them.

Every verb takes `--json` (one object; monitor emits one per snapshot). Exit codes: `0` ok,
`1` work-error (your code: fix it), `2` env-error (the environment: run `up`
again), `3` infra-error (something external, or version skew: act on the
message), `64` usage. Branch on the class, not just the code.

## Tasks

**Start the app, or the part you need.**

```bash
runly up                 # every service; prints a short summary (--json: the full context)
runly up web             # web and its depends_on; up only ever adds, never stops a service
runly down web           # stop one service (no name = all); lease, data and port stay
```

**After an edit, run `runly up` again.** It runs the due upkeep and the builds
and restarts only the services whose build output changed; a dev server without
a `build:` keeps running and reloads itself. With named services, other running
services are not built or restarted. Plain builds run each time; `build: {run, when}`
can skip unchanged inputs only while its outputs remain intact. `--rebuild`
bypasses that skip. Without declared outputs a built service always restarts;
dependents do not restart merely because a dependency did.

**Run your tests against it.** `ctx --env` (or `up --env`) prints
`export KEY=value` lines:

```bash
eval "$(runly ctx --env)" && npm test   # reads RUNLY_URL_<SVC>, RUNLY_PORT_<PORT>, RUNLY_DATASTORE_<DS>_URL,
                         # RUNLY_DATASTORE_<DS>_PRESET, RUNLY_LOGIN_USER, RUNLY_LOGIN_PASSWORD
```

Names are upper-cased, other characters become `_` (`web-audit` →
`RUNLY_URL_WEB_AUDIT`). Want known data first: `runly up --preset main=dev`
(reloads that datastore; its users restart) or `runly up --reset-data` (all).
Without them data is kept.

**Need only a database?** `runly db with main -- npm test` gives the command a
fresh seeded copy (`RUNLY_DB_URL`; `RUNLY_DB_DATABASE` is the database's own
name), drops it afterwards and exits with the command's code; runly's own
failures say `runly db with:` on stderr (`--runly-exit 125` gives them a code of
their own). Copies need no lease and run in parallel; don't
start your own database container. `runly db new main` keeps one until
`runly db drop <name>`, worktree removal, or its configured holder's death.
A datastore marked `copies_only` exists only this way:
environments never get one and `ctx` does not list it.

**See what runs.** `runly ps` (this worktree; `--all` for the box): each service's
state (`running`, `starting`, `idle`, `failed`, `stopped`, `down`), ports, pid, idle
time, memory, and the database copies. `runly ctx --json` has the full context,
including `allLogins`.

**A service crash-loops.** It is stopped and shown `failed` with its last exit
code; the environment, its data, the other services and the logs stay. Read
`runly logs <svc>`, fix the cause, then `runly up` starts it again. An `up` that
failed (a build, upkeep, data) is named by `ctx` and `ps` with its error; only
`up` redoes it.

**Will an `up` start now?** `runly plan [svc...]` says "starts now" or what it
would wait for in the box's load budget. A waiting `up` queues and fails with
env-error after 10 minutes; check `runly ps --all` instead of retrying.

**Wait for a log line instead of polling.**

```bash
runly logs api -f --until 'listening' --timeout 120   # 0 on match, 124 on timeout
runly logs --since 10m --grep 'ERROR|WARN'                         # all services, interleaved
runly logs --build                                                 # upkeep and each last build, a section each
```

`--grep` that matches nothing exits 1.

`--until` only matches lines of the current process, never one from before the
last start.

**Authenticate.** Read `allLogins` in `ctx --json` and pick the login whose
`description` fits the test (the admin login cannot expose a permission bug).
`runly token --role <r> --raw` prints a bare token for an `Authorization` header.

**Hand back.** `runly release` ends the lease and leaves the environment for the
next `up`. `runly destroy` tears down everything this worktree holds (services,
data, copies, ports); run it before handing a worktree back to a pool. The baked
templates stay, so the next `up` is not a cold rebake; upkeep rules without
`outputs:` run again. Templates keyed by an `@rebake-template` rule are shared
by every worktree of the stack: a fresh worktree with the same seeds restores
instead of baking. `--pristine` bakes one private to your worktree and leaves
the shared one to the others.

## How long it lives

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

## Don't

- Poll `ps`, `status` or `logs` in a loop; use `logs -f --until … --timeout`.
- Use the removed verbs and flags (`sync`, `run`, `job`, `pull`, `bind`,
  `--watch`, `--detach`, `--data-only`, `--ref`); they exit 64 naming the
  replacement.
- `runly pool recycle` without an env id, or `--force`: the pool is shared.
- `runly update --force`: on a shared box it interrupts someone else's bind. If
  a verb fails with infra-error naming two versions, run `runly update`.
- Preview without being asked: `runly preview <svc>` publishes an
  unauthenticated URL (Tailscale is tailnet-only). Public access has its own
  deadline; a restart restores it only if unexpired. End publication and disable
  reopening with `runly preview stop`. Check `previewExpiresAt` and
  `previewRestore` in `ctx --json`, and any `previewNotice` from `up`.

## Measure before tuning

Use runly stats --since 30m --json for this worktree's bounded history, or --all
for the daemon. runly monitor --interval 2s --timeout 60 --json captures a bounded
NDJSON observation window. Monitoring never keeps services active. Compare build
skips/restarts, datastore bake/restore time, budget wait and wake duration before
changing settings. Check sample counts and collection truncation/storage errors.
Proxy first-byte timing is per TCP connection, not per HTTP request or WebSocket
message. Budget figures are declared costs, not measured resource use.

## Inputs, recovery and installation

Supply a service's `env_from` variables in the shell running `up`; required
ones must be present. Explicit `up` refreshes them, while `reset-data` preserves
them. Values are memory-only and lost on release or daemon restart; run `up`
with them again. Do not put secrets in the manifest or install them into the
daemon unit.

After a daemon restart, traffic, `exec` or `token` resumes wanted services
without redoing builds; `up` reapplies the worktree. Read-only `ctx` and `ps`
do not resume services. The proxy holds a request while starting; a startup
failure before an HTTP response returns 503 with Retry-After. Inspect `runly ps`,
`runly ctx --json`, `runly logs <svc>` and `runly logs --build`; local proxy
diagnostics include `lastError` and `readyAt`. Established streams can disconnect;
do not assume mutating requests are safe to retry.

Install or upgrade with `npm i -g @theford/runly`, then `runly update` to load
the installed build into the daemon. `update` does not download packages.
For a checkout follow its install hint instead. Optional `runly daemon install`
supervises the daemon with systemd/launchd. Its environment is captured at install
time: reinstall after changing PATH or required daemon variables; use
`--env NAME` for an additional variable. Caller `env_from` inputs stay excluded.

## Other verbs

`runly warm` (due upkeep and builds, no lease), `runly exec <cmd>` (a command in
the worktree, on your terminal, with your environment plus the `ctx --env`
variables; stopped services start first; its own exit code), `runly reset-data`, `runly status`, `runly doctor`,
`runly appliance ls|start|stop`, `runly pool doctor [--fix]`,
`runly update [--check]`. The README lists every verb and manifest field.

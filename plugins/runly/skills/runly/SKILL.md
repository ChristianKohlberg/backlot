---
name: runly
description: Use runly to put a running, seeded, authenticated instance of the web app in front of you before inspecting behaviour, proving a change with the repo's own tests, or reproducing a bug. Use when the repo has a runly.yml at its root and the `runly` CLI is installed. Covers up/down, ctx --env for your tests, database copies (db with), ps, plan, logs, idle and wake, the session tether, and destroy.
---

# runly

runly runs the repo's app **in your worktree**, one environment per worktree,
from the `runly.yml` at the repo root. A per-machine daemon supervises the
services and holds a stable public port per service. You get URLs, logins and
connection strings; you run your own tests against them.

Every verb takes `--json` (stdout is one JSON object). Exit codes: `0` ok,
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
a `build:` keeps running and reloads itself. `--rebuild` forces every build.

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
fresh seeded copy (`RUNLY_DB_URL`, `RUNLY_DB_NAME`), drops it afterwards and
exits with the command's code. Copies need no lease and run in parallel; don't
start your own database container. `runly db new main` keeps one until
`runly db drop <name>`.

**See what runs.** `runly ps` (this worktree; `--all` for the box): each service's
state (`running`, `starting`, `idle`, `stopped`, `down`), ports, pid, idle time,
memory, and the database copies. `runly ctx --json` has the full context,
including `allLogins`.

**Will an `up` start now?** `runly plan [svc...]` says "starts now" or what it
would wait for in the box's load budget. A waiting `up` queues and fails with
env-error after 10 minutes; check `runly ps --all` instead of retrying.

**Wait for a log line instead of polling.**

```bash
runly logs api -f --until 'listening' --timeout 120   # 0 on match, 124 on timeout
runly logs --since 10m --grep 'ERROR|WARN'                         # all services, interleaved
runly logs --build                                                 # last build and upkeep output
```

`--until` only matches lines of the current process, never one from before the
last start.

**Authenticate.** Read `allLogins` in `ctx --json` and pick the login whose
`description` fits the test (the admin login cannot expose a permission bug).
`runly token --role <r> --raw` prints a bare token for an `Authorization` header.

**Hand back.** `runly release` ends the lease and leaves the environment for the
next `up`. `runly destroy` tears down everything this worktree holds (services,
data, copies, ports); run it before handing a worktree back to a pool.

## How long it lives

- **Under Claude Code you are tethered.** `up` and `db new` tie the environment
  to your session (`CLAUDE_PID`). It lives as long as the session and is torn
  down 60 s after the session ends. Nothing to renew. `BACKLOT_TETHER=off` opts
  out.
- **Elsewhere, use `--ttl <minutes>`** (default 30). Never
  `BACKLOT_HOLDER_PID=$$ runly up`: each command runs in a fresh shell, so `$$`
  is already dead and runly refuses it (exit 64).
- **Idle services stop and wake.** A service with no runly verb and no client
  byte for 10 minutes is stopped (`ps` says `idle`); its URL, data and lease
  stay, and the next request starts it and waits until it is ready. Don't keep
  it warm with polling.
- **A deleted worktree takes its environment with it.**

## Don't

- Poll `ps`, `status` or `logs` in a loop; use `logs -f --until … --timeout`.
- Use the removed verbs and flags (`sync`, `run`, `job`, `pull`, `bind`,
  `--watch`, `--detach`, `--data-only`, `--ref`); they exit 64 naming the
  replacement.
- `runly pool recycle` without an env id, or `--force`: the pool is shared.
- `runly update --force`: on a shared box it interrupts someone else's bind. If
  a verb fails with infra-error naming two versions, run `runly update`.
- Preview without being asked: `runly preview <svc>` publishes an
  unauthenticated URL. End it with `runly preview stop`.

## Other verbs

`runly warm` (due upkeep and builds, no lease), `runly exec <cmd>` (a command in
the worktree with the `ctx --env` variables set; exits 0 or 1, `--json`
has `exitCode`), `runly reset-data`, `runly status`, `runly doctor`,
`runly appliance ls|start|stop`, `runly pool doctor [--fix]`,
`runly update [--check]`. The README lists every verb and manifest field.

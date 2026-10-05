---
name: runly
description: Use runly to put a running, seeded, authenticated instance of the web app in front of you before inspecting behaviour, proving a change, or reproducing a bug. Use when the consuming repo has a runly.yml at its root and the `runly` CLI is installed; covers leasing a warm env that runs in your worktree, additive per-service up/down, re-running up after edits, throwaway database copies (runly db), runly ps, running your own tests against `ctx --env`, warming an idle worktree, and reading context.
---

# runly

runly brokers **environments**: it puts a working instance of the repo's web
app — running, seeded, authenticated, provable — in front of you as a cheap,
repeatable act. It reads one declarative file, **`runly.yml`** at the consuming
repo's root (services, datastores, upkeep rules), and exposes a small set
of verbs over a per-machine daemon.

Reach for runly whenever you need the *actual app up* for uncommitted worktree
state — to inspect it, to prove a change with your own tests, or to iterate —
not just to read or edit code.

## The lease model

- **Warm pool.** Environments are pooled, durable, and kept warm; work *visits*
  them. You never create or destroy an environment — you lease one.
- **It runs in your worktree.** An environment's services build and run in the
  worktree you call from — its caches (node_modules, obj/, …) are your caches.
  What the environment keeps privately is its ports, its datastore namespace and
  its logs. **One environment per worktree.** Binding replays only the upkeep
  rules whose trigger files changed, then runs your build commands (the build
  tool decides what is current; runly caches no builds) — **seconds, not
  minutes**. Your tests see the live worktree, edits made while they run included.
- **URLs are stable and survive restarts.** The daemon holds each public port
  (20000–29999) and proxies it to the service, so a request that arrives while
  an `up` restarts a service waits until it is ready instead of failing. Always
  take ports and URLs from `ctx`; the port a service process listens on is an
  internal one that changes at every start.
- **One lease kind: `up`.** You hold the env, its services stay running, you
  `up` again after edits, `exec`/`ctx`/`logs` against it, and `release` when done.
- **runly runs no checks.** Run the repo's own tests yourself against the
  environment: `eval "$(runly ctx --env)" && <test command>`. Want known data
  first? `runly up --reset-data` (all datastores) or `runly up --preset <ds>=<preset>`
  (that one datastore) before it. Without `--preset`, data is kept as it is.
- **Releasing is a non-event.** `release` (or just letting the lease's TTL lapse)
  returns the env to the pool with its heat intact.
- **Need just a database? `runly db with <datastore> -- <cmd>`.** It makes a
  fresh seeded copy from the same template, runs your command with
  `RUNLY_DB_URL`/`RUNLY_DB_NAME`, and drops the copy when it exits — as many in
  parallel as you like, no lease, your running app untouched. Don't stand up your
  own container for that. (`up --data-only` was removed in 0.15: exit 64.)
- **Idle services stop; your next request starts them.** A service with no runly
  verb and no client byte for 10 minutes is stopped (`ps` says `idle`); its URL,
  data and lease stay. The next request to its URL is held while it starts —
  slower, never refused. Nothing to do on your side; don't "keep it warm" with
  polling.
- **Under Claude Code your environment is tied to your session.** `up` and
  `db new` tether to the `claude` process (`CLAUDE_PID`) automatically; a minute
  after the session ends everything goes (services, data, ports, lease). While
  the session lives, the lease does not lapse. A deleted worktree takes its
  environment with it; `runly destroy` does it now.
- **The box has a load budget.** An `up` that does not fit waits in a queue
  (its position and reason are on stderr with `--progress`) and fails with
  env-error after 10 minutes. `runly plan` tells you beforehand whether it would
  start now or wait, and for what. Don't retry in a loop — `runly ps --all`
  shows what is running.
- **How long you hold it: use `--ttl <minutes>`** (outside Claude Code). That is the form for you.
  There is a second form, `--holder-pid <pid>` / `BACKLOT_HOLDER_PID`, which ties
  the lease to a process so it frees the instant that process exits — it is for
  interactive shells and long-lived supervisors only. **Do not write
  `BACKLOT_HOLDER_PID=$$ runly up`:** each of your commands runs in a fresh
  shell, so `$$` names a shell that has already exited, and runly refuses the
  bind (exit 64) rather than give you a lease that is reclaimable on arrival.
  If you pass a pid, it must be a process you know outlives the command.

## Verbs

Every verb accepts **`--json`**: stdout is one clean data object (for you),
stderr is human progress. Exit codes are contractual: `0` ok · `1` work-error ·
`2` env-error · `3` infra-error · `64` usage.

| Verb | What it does |
| --- | --- |
| `up [service...]` | Session lease: upkeep, build and start services in this worktree, print context. A `build: {run, when}` is skipped while its inputs are unchanged (`build <svc>: skipped (when: unchanged)`); `--rebuild` forces every build. **Additive: named services (plus their `depends_on` closure) start next to what already runs; nothing running is stopped. No service = add every service.** **Every `up` applies your edits:** it runs the due upkeep and the builds, then restarts only the services whose build output changed (see below). Flags: `--preset <ds>=<preset>` (reload that one datastore, restart the services that use it), `--reset-data`\|`--pristine`, `--ttl <minutes>` (**the lease form for agents**), `--holder-pid <pid>` (interactive shells only — see above). |
| `down [service...]` | Stop just the named services (no name = all). The lease, the data and the public ports stay; `up` brings them back. Dependents keep running and are named in the answer. |
| `db new\|with\|ls\|drop` | Database copies outside any environment, from the same templates: `db new <ds> [--preset p]` prints `name`/`url`/`preset`; `db with <ds> [--preset p] -- <cmd>` runs the command with `RUNLY_DB_URL`/`RUNLY_DB_NAME`, drops the copy on exit and returns the command's exit code; `db ls [--all]`; `db drop <name>`. A copy is reaped when its holder exits or its worktree goes. No TTL. |
| `ps [--all]` | What runs for this worktree (`--all`: the whole box): services (state — `running`, `starting`, `idle` (stopped for idleness, wakes on a request), `stopped`, `down` — public/internal port, pid, idle, stops-in, rss) and database copies (name, datastore, preset, holder, created). |
| `plan [service...]` | Would an `up` start now, or wait for the load budget — and for what (memory, cpu, free memory, load)? Itemises what it would build and start and what each costs (declared `resources:` or an assumed default). Changes nothing. |
| `destroy` | Tear down everything runly holds for this worktree now: environment, data, copies, ports, lease. |
| `ctx` | Re-read the consumer **context blob** (service URLs, login creds, connection strings, recent events) for the env your lease holds — read-only, no re-bind. `up` already returned this once. **A stack may advertise several logins: `logins` is the primary one, `allLogins` is the whole set** — see below. |
| `ctx --env` | The same environment as shell-exportable `KEY=value` lines for your own tests: `RUNLY_ENV_ID`, `RUNLY_PORT_<PORT>`, `RUNLY_URL_<SERVICE>`, `RUNLY_DATASTORE_<NAME>_URL`, `RUNLY_DATASTORE_<NAME>_PRESET` (the preset it holds), `RUNLY_LOGIN_USER`, `RUNLY_LOGIN_PASSWORD` (names upper-cased, other characters as `_`: `web-audit` → `RUNLY_URL_WEB_AUDIT`). Use `eval "$(runly ctx --env)" && <tests>`. |
| `release` | Release the current lease; the environment stays warm in the pool. On `{"released": false}` read the `reason` — a lease is keyed by the directory that bound it, so releasing from elsewhere matches nothing. |
| `warm` | Run this worktree's due upkeep rules and its service builds **now, with no lease and no services**, and print each step with its duration. For an idle worktree just moved to a new commit (`git checkout <sha> && runly warm`), so the next bind finds the installs done and the build tools' caches current. |
| `exec <cmd...>` | Run an arbitrary command in your worktree with the lease's ports, URLs and connection strings in its environment (`BACKLOT_URL_*`, `BACKLOT_DS_*`); hands back raw stdout + exit code. Needs an `up` first. |
| `logs [service...]` | Service logs, interleaved with `svc \| ` prefixes (none named = all). `--lines N` (40), `--since up` (current process only) or `--since 10m`, `--grep <re>`, `--build` (last build/upkeep output). **Wait for a line instead of polling:** `runly logs web -f --until 'Compiled successfully' --timeout 300` exits 0 on the match and 124 on timeout. |
| `reset-data` | Restore the data template on the current lease (fresh seeded state; builds and caches untouched). |
| `token --role <r>` | Mint an auth token via the stack's `auth.token` hook — for authenticating as a given role. Prints JSON (`{token, role}`); **add `--raw` for the bare token**, which is what an `Authorization` header wants. Piping the JSON into a header gets you a 401 that looks like a permissions problem. |
| `preview <service>` | Publish **one** service from your lease on a public quick tunnel (needs `cloudflared`) so a human on another machine can look at it. The URL is **unauthenticated — anyone with the link reaches the app**, so only run it when you were asked to share, and end it with `preview stop` (releasing the lease also does). Opt-in per invocation; a stack may forbid it in `runly.yml` (work-error). It is scoped to the **lease**, not the services: a repeated `up` or a rebind leaves it up, and a bind that invalidated it says so in `previewNotice`. |
| `status` | Daemon, pool, and lease overview. Per environment, `available` answers "will the next bind take this one?" — `heat: "cold"` just means quiesced, which is a **healthy free** pool entry, not a stuck one. |

Adjacent: `appliance ls|start|stop`
(shared backing servers), `pool ls|recycle|reconcile|gc|doctor [--fix]` (doctor: what runly left behind; dry run unless `--fix`, only ever runly's own), `daemon stop`,
`update` (see below), `--version`.

**If a verb fails with `infra-error` naming two versions, that is version skew.**
Installing a new runly does not replace the daemon already running, so the CLI
you invoke and the daemon serving it can be different builds; runly refuses the
verb rather than let the old code answer it silently. The fix is one command:

```bash
runly update            # restart the daemon onto the installed build
runly update --check    # report versions and who would rebind, change nothing
```

Leases survive the restart — services stop and your next verb rebinds. `update`
refuses if an operation is in flight, and refuses a downgrade. Do **not** reach for
`--force`: on a shared box it interrupts somebody else's bind mid-way. If
`update` refuses, wait and retry, or tell the human. runly never installs itself,
so if `--check` shows no skew but you expected a newer version, the package has not
been upgraded yet — that is a human's step, and `--check` prints the command.

**The pool is shared.** On a box running several agents, `pool recycle` with no
argument targets **every** environment, not just yours. Name the one you mean —
`pool recycle <env-id>` — and never reach for `--force`, which is the only thing
that takes an environment somebody else still holds a lease on. A pool whose
entries show `heat: "cold"` is not stuck; it is idle and ready.

### What `up` restarts

`sync`, `run`, `job`, `--watch` and `--detach` are gone (decision 0032) — they
exit 64 naming their replacement. After an edit, run `up` again. It runs the due
upkeep rules and every `build:` of the services it starts, then:

- a service whose build changed its declared `outputs:` is restarted;
- a service with a `build:` and no `outputs:` is restarted after every build;
- a service with **no** `build:` keeps running (a dev server that reloads itself);
- `--preset <ds>=<p>` reloads that datastore and restarts only the running
  services whose templates reference it (all of them if none does);
- a changed manifest, an upkeep rule that ran or `--reset-data`/`--pristine`
  restart everything.

`bindDiagnostics.reuse` says which happened (`reused`, `restarted` with the
`restarted` list, or `rebound`), and `builds[].reason` says why per service.

### Additive `up` and `down`

`up` only ever adds. **Name one or more services and runly starts them plus
their transitive `depends_on` closure, next to whatever already runs.** On a
fresh worktree that is exactly the slice you named; `runly up` with no argument
adds the rest. `down` takes services away again without giving up the lease.

```bash
runly up web            # start `web` + its depends_on closure; nothing else boots
runly up api            # add `api` next to `web`; `web` keeps its pid
runly down web          # stop `web` only; lease, data, ports stay
runly up                # add everything
runly ps                # what runs here, with ports, pids, idle time and memory
```

Datastores always exist with the environment; only services are named. An
unknown service name is a manifest work-error.

### Logins: read `allLogins`, don't default to the admin

`ctx` reports `logins` — the **primary** login, a single object — and `allLogins`,
**every** login the stack declares, in manifest order (`logins` is entry 0, so a
one-login stack reports the same object in both and you never branch on the shape).
Each entry may carry a `role` (the value `token --role <r>` wants) and a
`description` saying what that login is *for*.

**Read the roster before you pick.** Driving everything as the admin account is the
one choice that can never surface a permission or scoping bug — if you are proving
that a restricted user is denied something, or that a scoped user sees only their own
data, you need the login whose `description` says so. If `allLogins` has one entry,
that is the stack's answer and there is nothing to choose.

```bash
runly ctx --json | jq '.allLogins'      # who exists, and what each one is for
runly token --role auditor --raw        # a token for one of them, if the stack declares the hook
```

runly does not create or verify these logins — the stack's seed does. An absent or
empty `allLogins` means the manifest declares none, not that the seed failed.

## Your tests vs `exec`

- **Your own tests to prove a change.** `eval "$(runly ctx --env)" && <tests>`
  in your worktree, after `up` (and `up --reset-data` when they need known data).
  If a test fails, check `runly status`/`logs` before blaming the code: a dead
  service is the environment, not your change.
- **`exec <cmd>` to poke at the live environment** your `up` lease is holding.
  Raw exit code and stdout, no classification.

## Rules

1. Run your tests against `ctx --env`; don't hand-roll port or URL discovery.
   `up --reset-data` first when they need the seeded state.
2. `up` just the services you're working on; don't boot the whole app to
   iterate on one frontend. For a database-only test lane use `runly db with`.
3. `release` when you stop, and size `--ttl` to the work — holding a lease keeps a
   pooled env out of circulation. Never `--holder-pid $$`; see the lease model above.
4. Branch on the **class** of a failure, not just the exit code: `work-error` is
   yours to fix, `env-error` is the environment (runly recycles it), and
   `infra-error` is something external — don't "fix" healthy code because a DB
   was down.
5. Add `--json` whenever you'll parse the output.

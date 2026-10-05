---
name: runly
description: Use runly to put a running, seeded, authenticated instance of the web app in front of you before inspecting behaviour, proving a change, or reproducing a bug. Use when the consuming repo has a runly.yml at its root and the `runly` CLI is installed; covers leasing a warm env that runs in your worktree, partial/per-service up, re-running up after edits, running your own tests against `ctx --env`, warming an idle worktree, and reading context.
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
  first? `runly up --reset-data` (or `reset-data --preset NAME`) before it.
- **Releasing is a non-event.** `release` (or just letting the lease's TTL lapse)
  returns the env to the pool with its heat intact.
- **You can lease just a database.** `up --data-only` gives you a seeded, isolated
  datastore with no services and no builds — the right unit for an integration
  test lane. Don't stand up your own container for that.
- **How long you hold it: use `--ttl <minutes>`.** That is the form for you.
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
| `up [service...]` | Session lease: upkeep, build and start services in this worktree, print context. **No service = the whole app. Named services start only that slice plus its transitive `depends_on` closure** (see below). **Every `up` applies your edits:** it runs the due upkeep and the builds, then restarts only the services whose build output changed (see below). Flags: `--reset-data`\|`--pristine`, `--ttl <minutes>` (**the lease form for agents**), `--holder-pid <pid>` (interactive shells only — see above), `--data-only` (see below). |
| `up --data-only` | Lease the **datastores alone** — a seeded database, no services, no builds. For a test lane that needs a database per run rather than a whole application: read `.datastores.<name>.url` from `ctx` and point your fixture at it, `reset-data` between runs. `ctx` reports `dataOnly: true`, and the env sits at `warm` because nothing is meant to run. Cannot be combined with a service name. Counted against its own machine-wide ceiling, not the application pool caps — a test lane does not compete with interactive leases. |
| `ctx` | Re-read the consumer **context blob** (service URLs, login creds, connection strings, recent events) for the env your lease holds — read-only, no re-bind. `up` already returned this once. **A stack may advertise several logins: `logins` is the primary one, `allLogins` is the whole set** — see below. |
| `ctx --env` | The same environment as shell-exportable `KEY=value` lines for your own tests: `RUNLY_ENV_ID`, `RUNLY_PORT_<PORT>`, `RUNLY_URL_<SERVICE>`, `RUNLY_DATASTORE_<NAME>_URL`, `RUNLY_LOGIN_USER`, `RUNLY_LOGIN_PASSWORD` (names upper-cased, other characters as `_`: `web-audit` → `RUNLY_URL_WEB_AUDIT`). Use `eval "$(runly ctx --env)" && <tests>`. |
| `release` | Release the current lease; the environment stays warm in the pool. On `{"released": false}` read the `reason` — a lease is keyed by the directory that bound it, so releasing from elsewhere matches nothing. |
| `warm` | Run this worktree's due upkeep rules and its service builds **now, with no lease and no services**, and print each step with its duration. For an idle worktree just moved to a new commit (`git checkout <sha> && runly warm`), so the next bind finds the installs done and the build tools' caches current. |
| `exec <cmd...>` | Run an arbitrary command in your worktree with the lease's ports, URLs and connection strings in its environment (`BACKLOT_URL_*`, `BACKLOT_DS_*`); hands back raw stdout + exit code. Needs an `up` first. |
| `logs <service> [--lines N]` | Tail a service's logs from the leased env. |
| `reset-data` | Restore the data template on the current lease (fresh seeded state; builds and caches untouched). |
| `token --role <r>` | Mint an auth token via the stack's `auth.token` hook — for authenticating as a given role. Prints JSON (`{token, role}`); **add `--raw` for the bare token**, which is what an `Authorization` header wants. Piping the JSON into a header gets you a 401 that looks like a permissions problem. |
| `preview <service>` | Publish **one** service from your lease on a public quick tunnel (needs `cloudflared`) so a human on another machine can look at it. The URL is **unauthenticated — anyone with the link reaches the app**, so only run it when you were asked to share, and end it with `preview stop` (releasing the lease also does). Opt-in per invocation; a stack may forbid it in `runly.yml` (work-error). It is scoped to the **lease**, not the services: a repeated `up` or a rebind leaves it up, and a bind that invalidated it says so in `previewNotice`. |
| `status` | Daemon, pool, and lease overview. Per environment, `available` answers "will the next bind take this one?" — `heat: "cold"` just means quiesced, which is a **healthy free** pool entry, not a stuck one. |

Adjacent: `appliance ls|start|stop`
(shared backing servers), `pool ls|recycle|reconcile|gc|doctor`, `daemon stop`,
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
- a changed manifest, an upkeep rule that ran or `--reset-data`/`--pristine`
  restart everything.

`bindDiagnostics.reuse` says which happened (`reused`, `restarted` with the
`restarted` list, or `rebound`), and `builds[].reason` says why per service.

### Partial / per-service `up`

`runly up` with no argument brings up the whole app. **Name one or more
services and runly starts only that slice plus its transitive `depends_on`
closure** — nothing else boots. This is the way to lease a single vertical or a
lone SPA without booting the rest of the stack.

```bash
runly up web            # start `web` + everything in its depends_on closure; leave the rest down
runly up api worker     # start these two slices (and their closures) only
runly up                # whole app
```

Naming a leaf service transitively pulls in exactly what it needs and nothing it
doesn't. An unknown service name is a manifest work-error. All the usual `up`
flags apply to the partial form.

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
2. Use partial `up` to lease just the slice you're working on; don't boot the
   whole app to iterate on one frontend.
3. `release` when you stop, and size `--ttl` to the work — holding a lease keeps a
   pooled env out of circulation. Never `--holder-pid $$`; see the lease model above.
4. Branch on the **class** of a failure, not just the exit code: `work-error` is
   yours to fix, `env-error` is the environment (runly recycles it), and
   `infra-error` is something external — don't "fix" healthy code because a DB
   was down.
5. Add `--json` whenever you'll parse the output.

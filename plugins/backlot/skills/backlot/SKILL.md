---
name: backlot
description: Use backlot to put a running, seeded, authenticated instance of the web app in front of you before inspecting behaviour, proving a change, or reproducing a bug. Use when the consuming repo has a backlot.yml at its root and the `backlot` CLI is installed; covers leasing a warm env, bind-by-sync, partial/per-service up, running classified checks, and reading context.
---

# backlot

backlot brokers **environments**: it puts a working instance of the repo's web
app — running, seeded, authenticated, provable — in front of you as a cheap,
repeatable act. It reads one declarative file, **`backlot.yml`** at the consuming
repo's root (services, datastores, upkeep rules, checks), and exposes a small set
of verbs over a per-machine daemon.

Reach for backlot whenever you need the *actual app up* for uncommitted worktree
state — to inspect it, to prove a change with a machine verdict, or to iterate —
not just to read or edit code.

## The lease model

- **Warm pool.** Environments are pooled, durable, and kept warm; work *visits*
  them. You never create or destroy an environment — you lease one.
- **Bind-by-sync.** Binding your worktree to a warm env is a git sync +
  fingerprint-gated upkeep (replay only the upkeep rules whose triggers changed) —
  **seconds, not minutes**. No checkpointing, no image rebuild.
- **Two kinds of lease:**
  - a **session lease** (`up`) — you hold the env, its services stay running, you
    `sync`/`exec`/`ctx`/`logs` against it, and you `release` when done;
  - a **run lease** (`run <check>`) — self-contained: it takes its *own* env from
    the pool, binds, executes one declared check, returns a classified verdict,
    and releases automatically. No prior `up` needed.
- **Releasing is a non-event.** `release` (or just letting the lease's TTL lapse)
  returns the env to the pool with its heat intact.
- **You can lease just a database.** `up --data-only` gives you a seeded, isolated
  datastore with no services and no builds — the right unit for an integration
  test lane. Don't stand up your own container for that.
- **How long you hold it: use `--ttl <minutes>`.** That is the form for you.
  There is a second form, `--holder-pid <pid>` / `BACKLOT_HOLDER_PID`, which ties
  the lease to a process so it frees the instant that process exits — it is for
  interactive shells and long-lived supervisors only. **Do not write
  `BACKLOT_HOLDER_PID=$$ backlot up`:** each of your commands runs in a fresh
  shell, so `$$` names a shell that has already exited, and backlot refuses the
  bind (exit 64) rather than give you a lease that is reclaimable on arrival.
  If you pass a pid, it must be a process you know outlives the command.

## Verbs

Every verb accepts **`--json`**: stdout is one clean data object (for you),
stderr is human progress. Exit codes are contractual: `0` ok · `1` work-error ·
`2` env-error · `3` infra-error · `64` usage.

| Verb | What it does |
| --- | --- |
| `up [service...]` | Session lease: sync, upkeep, start services, print context. **No service = the whole app. Named services start only that slice plus its transitive `depends_on` closure** (see below). Flags: `--watch`, `--reset-data`\|`--pristine`, `--ttl <minutes>` (**the lease form for agents**), `--holder-pid <pid>` (interactive shells only — see above), `--data-only` (see below). |
| `up --data-only` | Lease the **datastores alone** — a seeded database, no services, no builds. For a test lane that needs a database per run rather than a whole application: read `.datastores.<name>.url` from `ctx` and point your fixture at it, `reset-data` between runs. `ctx` reports `dataOnly: true`, and the env sits at `warm` because nothing is meant to run. Cannot be combined with a service name or `--watch`. Counted against its own machine-wide ceiling, not the application pool caps — a test lane does not compete with interactive leases. |
| `run <check>` | Run lease: bind → execute the check declared in `backlot.yml` → classified verdict → release. `--pristine` rebuilds from scratch; `--pull` copies declared outputs back; `--detach` returns a `jobId` immediately (poll with `job <jobId>`). |
| `ctx` | Re-read the consumer **context blob** (service URLs, login creds, connection strings, recent events) for the env your lease holds — read-only, no re-bind. `up` already returned this once. |
| `release` | Release the current lease; the environment stays warm in the pool. On `{"released": false}` read the `reason` — a lease is keyed by the directory that bound it, so releasing from elsewhere matches nothing. |
| `sync` | Project the current worktree state into the leased env — seconds; `hot_reload` services keep running, others restart as needed. |
| `exec <cmd...>` | Run an arbitrary command inside the env your lease holds; hands back raw stdout + exit code (not a verdict). Needs an `up` first. |
| `logs <service> [--lines N]` | Tail a service's logs from the leased env. |
| `reset-data` | Restore the data template on the current lease (fresh seeded state, declared caches kept). |
| `token --role <r>` | Mint an auth token via the stack's `auth.token` hook — for authenticating as a given role. Prints JSON (`{token, role}`); **add `--raw` for the bare token**, which is what an `Authorization` header wants. Piping the JSON into a header gets you a 401 that looks like a permissions problem. |
| `status` | Daemon, pool, and lease overview. Per environment, `available` answers "will the next bind take this one?" — `heat: "cold"` just means quiesced, which is a **healthy free** pool entry, not a stuck one. |

Adjacent: `pull` (copy declared outputs into the worktree), `appliance ls|start|stop`
(shared backing servers), `pool ls|recycle|reconcile|gc|doctor`, `daemon stop`,
`update` (see below), `--version`.

**If a verb fails with `infra-error` naming two versions, that is version skew.**
Installing a new backlot does not replace the daemon already running, so the CLI
you invoke and the daemon serving it can be different builds; backlot refuses the
verb rather than let the old code answer it silently. The fix is one command:

```bash
backlot update            # restart the daemon onto the installed build
backlot update --check    # report versions and who would rebind, change nothing
```

Leases survive the restart — services stop and your next verb rebinds. `update`
refuses if an operation is in flight, and refuses a downgrade. Do **not** reach for
`--force`: on a shared box it interrupts somebody else's `run` mid-verdict. If
`update` refuses, wait and retry, or tell the human. backlot never installs itself,
so if `--check` shows no skew but you expected a newer version, the package has not
been upgraded yet — that is a human's step, and `--check` prints the command.

**The pool is shared.** On a box running several agents, `pool recycle` with no
argument targets **every** environment, not just yours. Name the one you mean —
`pool recycle <env-id>` — and never reach for `--force`, which is the only thing
that takes an environment somebody else still holds a lease on. A pool whose
entries show `heat: "cold"` is not stuck; it is idle and ready.

### Partial / per-service `up`

`backlot up` with no argument brings up the whole app. **Name one or more
services and backlot starts only that slice plus its transitive `depends_on`
closure** — nothing else boots. This is the way to lease a single vertical or a
lone SPA without booting the rest of the stack.

```bash
backlot up web            # start `web` + everything in its depends_on closure; leave the rest down
backlot up api worker     # start these two slices (and their closures) only
backlot up                # whole app
```

Naming a leaf service transitively pulls in exactly what it needs and nothing it
doesn't. An unknown service name is a manifest work-error. All the usual `up`
flags apply to the partial form.

## `run` vs `exec`

- **`run <check>` to prove a change.** Self-contained, takes its own env, returns
  a verdict classified `work` / `env` / `infra` — a dead dev-server is never
  reported as your test failing — with artifacts, then releases.
- **`exec <cmd>` to poke at the live environment** your `up` lease is holding.
  Raw exit code and stdout, no classification.

## Rules

1. Prefer `run <check>` for anything you need a pass/fail on — it manages its own
   lease and gives you a classified verdict; don't hand-roll `up` + `exec` for
   that.
2. Use partial `up` to lease just the slice you're working on; don't boot the
   whole app to iterate on one frontend.
3. `release` when you stop, and size `--ttl` to the work — holding a lease keeps a
   pooled env out of circulation. Never `--holder-pid $$`; see the lease model above.
4. Branch on the **class** of a failure, not just the exit code: `work-error` is
   yours to fix, `env-error` is the environment (backlot recycles it), and
   `infra-error` is something external — don't "fix" healthy code because a DB
   was down.
5. Add `--json` whenever you'll parse the output.

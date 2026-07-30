# backlot

[![npm](https://img.shields.io/npm/v/backlot)](https://www.npmjs.com/package/backlot) [![ci](https://github.com/ChristianKohlberg/backlot/actions/workflows/ci.yml/badge.svg)](https://github.com/ChristianKohlberg/backlot/actions/workflows/ci.yml) [![release](https://img.shields.io/github/v/release/ChristianKohlberg/backlot)](https://github.com/ChristianKohlberg/backlot/releases)

**backlot puts a working instance of your web application in front of a coding agent
(or a human) — running, seeded, authenticated, provable — as a cheap, repeatable act.**

It brokers environments; it never provides them. Local processes today, your own cloud
sandboxes (Morph, Sprites, SSH) tomorrow — same verbs, same model.

> **Status: 0.10.** The local loop — pool, leases, bind-by-sync, data states,
> verdicts — is complete, hardened by two full review cycles, and proven end to
> end against a real .NET + Angular + MSSQL monorepo (its Playwright e2e suite
> runs as a backlot check, and each release is verified by driving a real session
> before publish). The one unbuilt milestone is the remote substrate driver
> (Morph/SSH). Details live in the
> [release notes](https://github.com/ChristianKohlberg/backlot/releases).

## Why

Coding agents need three things from an app under development, constantly: a running
seeded instance to **inspect**, a deterministic environment to **prove** changes in
(e2e, with a machine-readable verdict), and a seconds-fast **iterate** loop — all for
*uncommitted worktree state*, which CI can never serve. Hand-rolled harnesses converge
on the same machinery in every repo (port allocation, DB namespacing, capacity gating,
zombie reaping) and stay welded to that repo. backlot is that machinery, extracted,
with the repo-specific knowledge moved into one declarative file.

The core trick: **environments are pooled, durable, and warm; work visits them.**
Binding your worktree to a warm environment is a git sync + fingerprint-gated upkeep —
seconds, not minutes. Abandoning an environment is a non-event: your lease lapses and
the environment returns to the pool with its heat intact. ([Why not checkpointing?](docs/decisions/0006-convergence-over-checkpointing.md))

## Quickstart

The one prerequisite: a `backlot.yml` at the repo root (the manifest — see the
example below). Every runnable fixture in [`examples/`](examples/) ships one, so
the fastest first contact is a checkout:

```bash
git clone https://github.com/ChristianKohlberg/backlot && cd backlot
npm install && npm run build && npm link   # (or, for your own repos: npm i -g backlot)
cd examples/hello-web
backlot up --json          # lease a warm env: sync, seed, start — returns the full context blob (URLs + creds)
backlot run smoke --json   # bind -> run the check -> JSON verdict -> release
backlot ctx --json         # re-read that same blob later, read-only — no re-bind (up already returned it)
backlot sync               # edit locally, project it in — seconds; hot_reload services keep running
backlot exec <cmd>         # run an arbitrary command in the env your lease holds (raw exit, not a verdict)
backlot release            # environment returns to the pool, warm
```

**`run` vs `exec`.** `run <check>` is self-contained: it takes its *own*
environment, executes a check declared in `backlot.yml`, returns a classified
verdict (`work` / `env` / `infra` — a dead dev-server is never reported as your
test failing) with artifacts, then releases — **no prior `up` needed**. `exec
<cmd>` runs an arbitrary command inside the environment your `up` lease is
already holding and hands back its raw stdout and exit code, so it **needs an
`up` first**. Rule of thumb: **`run` to prove a change, `exec` to poke at the
live environment.**

### Upgrading: `backlot update` after you install

Installing a new backlot replaces the files on disk. It does **not** replace the
daemon already running — that process keeps serving the old code for as long as
it lives, and the socket carries no version. So an upgrade is two steps:

```bash
npm i -g backlot@latest    # or whatever installed it — backlot never installs itself
backlot update             # restart the daemon onto the build you just installed
```

Skip the second step and backlot tells you, rather than quietly serving you the
old behaviour: every verb except `update`, `doctor` and `daemon stop` fails with
`infra-error` (exit 3) naming both versions. That refusal is deliberate — an old
daemon does not reject a flag it has never heard of, it *ignores* it, so
`up --data-only` against a pre-0.9.0 daemon would boot the whole application into
what you asked to be a database-only lease and report success.

```bash
backlot --version          # this CLI
backlot update --check     # cli vs daemon, who would have to rebind, and the upgrade command for your install
backlot update             # restart; no-op when the daemon is already the installed build
```

**What a restart costs.** Leases **survive** it. Services stop, environments drop
to `warm`, and each holder's next verb rebinds — seconds, the same transition the
idle sweeper already performs on a leased environment. `update` names every holder
before acting. It refuses only two things: an **in-flight operation** (a `run`
whose caller is waiting on a verdict) and a **downgrade** (an older CLI restarting
a newer daemon). `--force` overrides either.

### Partial `up`: lease one slice, not the whole app

`backlot up` with **no service** brings up the whole app. Name one or more
services and backlot starts **only that slice plus its transitive `depends_on`
closure** — nothing else boots. This is how you lease a single vertical or a lone
SPA without paying for the rest of the stack.

Take [`examples/hello-multi`](examples/hello-multi/backlot.yml): `web`
`depends_on: [api]`, and `worker` stands alone.

```bash
cd examples/hello-multi
backlot up web       # starts web + api (its depends_on closure) — worker stays down
backlot up worker    # starts worker alone — no api, no web
backlot up           # the whole app: api + web + worker
```

Because the closure is transitive, naming a leaf pulls in everything it needs to
run and nothing it doesn't — ideal for iterating on one frontend while its single
backing service comes along for the ride. An unknown service name is a manifest
work-error. All the usual flags (`--watch`, `--reset-data`/`--pristine`,
`--ttl`, `--json`) apply to the partial form too.

### `--data-only`: lease a database, not an application

A test lane usually needs one thing from an environment — a warm, seeded database
of its own — and paying for services it never calls is what pushes people back to
Testcontainers, where every lane starts its own container and restores a full
backup per test collection.

```bash
backlot up --data-only --ttl 30      # seeded store, leased; no services, no builds
backlot ctx --json                   # .datastores.main.url — point your fixture at it
backlot reset-data                   # back to the baseline between runs
backlot release
```

Everything else about the lease is unchanged: it is pooled, isolated per holder,
restored from the same template, and dropped on recycle. Two lanes get two
namespaces, so neither sees the other's writes. `ctx` reports `dataOnly: true` so a
fixture can tell "no services by design" from "a service failed to start", and the
environment sits at `warm` because nothing is meant to be running.

It refuses what it cannot mean: naming a service alongside it, `--watch` (nothing
would reload), and a manifest that declares no datastore.

**It is priced like a catalog, not like a stack.** `POOL_MAX` and
`POOL_MAX_TOTAL` come from `min(cores/2, memGB/4)` because they bound *running
services* — so data-only environments are counted against their own machine-wide
ceiling, `BACKLOT_POOL_MAX_DATA_ONLY` (default `max(4, 2 × the heuristic)`,
disk-shaped), and against neither application cap. A test lane on every
integration run therefore no longer competes with the interactive leases people
use to look at the app, which was the whole point of the feature.

Two consequences worth knowing. A host can hold `POOL_MAX_TOTAL` applications
*plus* `POOL_MAX_DATA_ONLY` lanes. And switching your own lease between the two
shapes still works in both directions, but now needs room in the shape you are
switching *into* — otherwise the cheap ceiling would just be application capacity
by another name ([decision 0025](docs/decisions/0025-data-only-environments-are-priced-separately.md)).

### How long you hold it: `--ttl` for agents, `--holder-pid` for shells

A lease has a TTL, and there are two ways to say when you are done with an
environment:

```bash
backlot up --ttl 45                       # agents, scripts, CI: hold it for 45 minutes
BACKLOT_HOLDER_PID=$$ backlot up          # an interactive shell: hold it until THIS shell exits
```

**`--ttl` is the form for anything automated.** `--holder-pid <pid>` (or
`BACKLOT_HOLDER_PID`) pins the lease to a process so the environment returns to
the pool the instant that process exits instead of waiting out the TTL — which is
only useful if the process genuinely outlives the command.

It does **not** work from an agent harness, because those run each command in a
fresh shell: by the time `backlot up` returns, the `$$` it was given is a shell
that has already exited. Backlot refuses such a bind (exit `64`) rather than
create a lease that is reclaimable the moment it exists — otherwise the sweeper
frees the environment while you are still using it, the next bind takes it, and
you are quietly looking at somebody else's database through the same URL.

`backlot release` hands the environment back early. If it answers
`{"released": false}`, read the `reason`: a lease is keyed by the directory that
bound it, so releasing from a different worktree matches nothing.

For your own repo: `npm i -g backlot`, write the `backlot.yml`, then the same
verbs. Requires Node ≥ 22.13 and git. The daemon auto-spawns on first use (unix
socket, per-machine state under `~/.local/state/backlot`; isolate with
`BACKLOT_STATE_DIR`).

The manifest, by example ([schema](schema/backlot.schema.json)):

```yaml
name: myapp
services:
  api:
    run: dotnet run --no-build --project backend/Host
    port: api
    env: { ConnectionStrings__Main: "{{datastores.main.url}}" }
    ready: { http: /health }
  web:
    run: pnpm exec ng serve --port {{ports.web}}
    port: web
    ready: { http: / }
    hot_reload: true      # ng serve reloads itself -> `sync` never restarts it
datastores:
  main:
    driver: postgres
    create: bin/seed {{ns}} {{preset}}
    presets: [dev, empty]
    template: true
upkeep:
  - { when: pnpm-lock.yaml, run: pnpm install --frozen-lockfile }
auth:
  logins:                 # one object, or a list — the first entry is the primary
    - { user: qa-admin,    password: Demo!1234, role: admin, description: "all rights, all branches" }
    - { user: qa-readonly, password: Demo!1234, description: "read-only, proves a denied write" }
  token: scripts/mint-token --role {{role}} --json
checks:
  e2e: { run: pnpm e2e, artifacts: [test-results/**] }
```

Services are commands, not containers. Backing infrastructure (your DB server) stays
externally run — backlot probes it and classifies its absence honestly
(`infra-error`, never blaming your code). If the repo has one blessed way to start
that infrastructure, declare it as an **appliance** and backlot ensures it without
ever owning it ([decision 0018](docs/decisions/0018-appliances-ensured-not-owned.md)).

### Several logins, each with a purpose

Most seeded stacks have more than one account, and the difference matters: an admin
login is the one account that can never expose a scoping bug. `auth.logins` therefore
takes **either a single login (unchanged) or a list**, and each login may carry a
`role` — the `{{role}}` your `auth.token` hook takes — and a `description` saying what
it is *for*, so a consumer picks the right one without reading your seed script.

`ctx` reports both, and the redundancy is the point — nothing has to ask which form
the manifest used:

```jsonc
{
  "logins":    { "user": "qa-admin", "password": "Demo!1234", "role": "admin", "description": "all rights, all branches" },
  "allLogins": [ /* every declared login, in manifest order — `logins` is entry 0 */ ]
}
```

`logins` stays **the primary login**, always a single object, always the manifest's
first entry, so anything reading `ctx.logins.user` is untouched when a stack grows a
list. A single-login stack reports the same object in both places. An empty list is
rejected — omitting the key remains how a stack says it has no logins
([decision 0026](docs/decisions/0026-a-stack-may-advertise-several-logins.md)).

Backlot does not create these logins, verify them, or know what a role means: the seed
makes them, the manifest declares what exists, `ctx` reports it.

## What it is / is not

| backlot is | backlot is not |
| --- | --- |
| a warm pool of leased, isolated environments | a compute provider (bring your own, local or cloud) |
| bind-by-sync: your dirty worktree, in front, in seconds | a build system (it invokes your commands, never understands them) |
| seeded, template-restored data states | CI (CI may call backlot; never the reverse) |
| machine verdicts with a work/env/infra error taxonomy | an agent (no LLM calls, no browser driving) |

## Learn more

- [docs/overview.md](docs/overview.md) — the two-page tour, with diagrams. Start here.
- [docs/objections.md](docs/objections.md) — "why the copy?", "my agent can just run the dev servers", "compose does this" — taken seriously, with receipts.
- [docs/architecture.md](docs/architecture.md) — the full design; it *is* the product.
- [docs/decisions/](docs/decisions/) — why it is the way it is.

## Security model

Be clear-eyed about what running backlot means:

- **`backlot.yml` commands execute with your privileges.** Services, seeds, upkeep
  rules, and checks are shell commands from the repo — exactly like `make`, npm
  scripts, or a Justfile. Cloning an untrusted repo and running `backlot up` runs
  that repo's commands as you. Review manifests you didn't write.
- **The daemon has no network surface.** It listens on a unix socket in your
  per-user state dir (filesystem permissions are the auth) — no TCP, no remote
  callers. Future remote substrates run the same model *on the remote box*, reached
  over your own SSH/provider credentials.
- **Environments are projections, not sandboxes.** Isolation between environments
  is namespacing (ports, directories, database namespaces), not a security
  boundary — code in an environment runs as you, on your machine. For untrusted
  code, put the *substrate* in a sandbox (a VM, a cloud box), not your laptop.

## Claude Code

backlot ships an official [Claude Code](https://claude.com/claude-code) plugin —
a stack-agnostic skill that teaches an agent the lease model and the verb table so
it drives backlot correctly against any repo's `backlot.yml`. This repository
doubles as its own plugin marketplace. From inside Claude Code:

```
/plugin marketplace add ChristianKohlberg/backlot
/plugin install backlot
```

CLI-only, no MCP server — see [`plugins/backlot`](plugins/backlot/).

## License

Apache-2.0.

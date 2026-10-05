# runly

Previously **Backlot**. Install with `npm install -g runly`; use `runly up` and `runly ctx`.

The `backlot` command and `backlot.yml` manifests remain accepted. `runly.yml` takes precedence. State stays in `~/.local/state/backlot`; `.backlot` files, process tags and `BACKLOT_*` environment variables retain their names so existing leases and services remain discoverable. After upgrading, run `runly update` to update the running daemon. The GitHub repository remains `ChristianKohlberg/backlot`.

[![npm](https://img.shields.io/npm/v/runly)](https://www.npmjs.com/package/runly) [![ci](https://github.com/ChristianKohlberg/backlot/actions/workflows/ci.yml/badge.svg)](https://github.com/ChristianKohlberg/backlot/actions/workflows/ci.yml) [![release](https://img.shields.io/github/v/release/ChristianKohlberg/backlot)](https://github.com/ChristianKohlberg/backlot/releases)

**runly puts a working instance of your web application in front of a coding agent
(or a human) — running, seeded, authenticated, provable — as a cheap, repeatable act.**

It brokers environments; it never provides them. Local processes today, your own cloud
sandboxes (Morph, Sprites, SSH) tomorrow — same verbs, same model.

> **Status: 0.13.** The local loop — pool, leases, in-place binds, data states —
> is complete, hardened by two full review cycles, and proven end to end against
> a real .NET + Angular + MSSQL monorepo (its Playwright e2e suite runs against a
> runly environment, and each release is verified by driving a real session
> before publish). The one unbuilt milestone is the remote substrate driver
> (Morph/SSH). Details live in the
> [release notes](https://github.com/ChristianKohlberg/backlot/releases).

## Why

Coding agents need three things from an app under development, constantly: a running
seeded instance to **inspect**, a deterministic environment to **prove** changes in
(their e2e suite, against known data), and a seconds-fast **iterate** loop — all for
*uncommitted worktree state*, which CI can never serve. Hand-rolled harnesses converge
on the same machinery in every repo (port allocation, DB namespacing, capacity gating,
zombie reaping) and stay welded to that repo. runly is that machinery, extracted,
with the repo-specific knowledge moved into one declarative file.

The core trick: **environments are pooled, durable, and warm, and they run in your
worktree — one per worktree.** Binding runs the upkeep rules whose trigger files
changed, then your own build commands, in the worktree you call from, whose caches are
already warm — seconds, not minutes; no copy of your source is made, and runly keeps no
build cache of its own: your build tools decide what is current
([decision 0032](docs/decisions/0032-environments-run-in-the-callers-worktree.md)).
What an environment keeps to itself is its ports, its datastore namespace and its logs. Abandoning an environment is a non-event: your lease lapses and
the environment returns to the pool with its heat intact. ([Why not checkpointing?](docs/decisions/0006-convergence-over-checkpointing.md))

## Quickstart

The one prerequisite: a `runly.yml` at the repo root (the manifest — see the
example below). Every runnable fixture in [`examples/`](examples/) ships one, so
the fastest first contact is a checkout:

```bash
git clone https://github.com/ChristianKohlberg/runly runly && cd runly
npm install && npm run build && npm link   # (or, for your own repos: npm i -g runly)
cd examples/hello-web
runly up --json          # lease an env: upkeep, seed, build and start in THIS worktree — returns the full context blob (URLs + creds)
runly ctx --json         # re-read that same blob later, read-only — no re-bind (up already returned it)
eval "$(runly ctx --env)" && node smoke.test.mjs   # your own tests, fed RUNLY_URL_WEB etc.
runly up                 # after editing: due upkeep + builds, restarts what the builds changed
runly warm               # due upkeep + builds in this worktree, no lease, no services (prepare an idle worktree)
runly exec <cmd>         # run a command in the worktree with your lease's URLs/ports/conn strings (raw exit, not a verdict)
runly preview <service>  # publish one service (public tunnel via cloudflared, or the tailnet via tailscale)
runly preview stop       # stop the preview tunnel on your lease
runly release            # environment returns to the pool, warm
```

**Your tests, runly's environment.** runly does not run checks (decision 0032).
`runly ctx --env` prints the environment as shell-exportable lines with stable
names, and your own test command reads them:

| Variable | Value |
| --- | --- |
| `RUNLY_ENV_ID` | the environment's id |
| `RUNLY_PORT_<PORT>` | each allocated port, by its manifest key |
| `RUNLY_URL_<SERVICE>` | each running service's URL |
| `RUNLY_DATASTORE_<NAME>_URL` | each datastore's connection string |
| `RUNLY_LOGIN_USER`, `RUNLY_LOGIN_PASSWORD` | the primary login, when the stack declares one |

Names are upper-cased, every other character becomes `_` (`web-audit` →
`RUNLY_URL_WEB_AUDIT`), and a value is single-quoted only when a shell needs it.
`ctx --json` carries the same and more for programs. Want known data first?
`runly up --reset-data` (or `reset-data --preset NAME`) before the tests.
`exec <cmd>` is the other way in: it runs a command in your worktree with the
lease's environment in its variables (`BACKLOT_URL_*`, `BACKLOT_DS_*`,
`BACKLOT_PORT_*`) and hands back its raw stdout and exit code.

The `backlot-mcp` executable and MCP adapter have been removed. Remove existing
MCP launch entries from your agent configuration and invoke CLI commands through
your shell tools, for example `runly up --json` and `runly ctx --env`.
The CLI, daemon RPC and Claude Code skill remain supported.

**Every `up` applies the worktree as it is — and restarts only what changed.** It
runs the due upkeep rules and the `build:` of every service it starts (your build
tool decides what is current; runly keeps no build cache). Then:

- a running service whose build **output** changed is restarted. A service says
  what its build produces with `outputs:` globs (`bin/**`, `dist/web`); runly
  compares path, size and mtime before and after the build;
- a service with a `build:` and no `outputs:` is restarted after every build;
- a service with **no** `build:` keeps running (a dev server reads the worktree
  itself). To restart one on every `up`, give it `build: "true"`;
- a service that is not running is started; dependents of a restarted service
  are not restarted (its port did not move).

A changed manifest, changed caller inputs or presets, an upkeep rule that ran,
`--reset-data`/`--pristine`, or an unhealthy environment take the full bind
instead: everything stops, data is prepared, everything is built and started.
Comments and whitespace alone do not change the parsed manifest. See
[the in-place rules](docs/architecture.md#6-in-place--verbs-converge-watch-observes) and
[preview reconciliation](docs/decisions/0027-lease-scoped-public-preview.md).

Your services run in your **live** worktree: an edit you make while tests run is
visible to them. `runly pull`, `--pull`, `bind --ref`, `sync`, `run`, `job`,
`--watch` and `--detach` were removed (decision 0032); each is a usage error that
names its replacement.

### Warming an idle worktree

`runly warm` runs the stack's due upkeep rules and services' `build:` steps in the
current worktree **without a lease and without starting services**, printing each
step and how long it took (`--json` for the structured form). Upkeep it ran is
recorded, so the next `up` skips it; builds are not recorded — the next `up`
runs them again, your build tool finds its output current, and the services keep
running when their `outputs:` did not change. The intended
use is a pooled worktree moved to a new commit between tasks:

```bash
git checkout <sha> && runly warm
```

It waits for any operation in flight on the worktree's environment. Build lines
that template an environment's ports or datastores, and `@` built-ins (they act
on an environment's data), are reported as skipped — the next bind does them.

### What runs in your worktree

Since environments run in place, the repo's own commands write into the worktree:
upkeep installs, builds, service-generated files, your tests' results. Worth
knowing:

- **Ignore your output.** Anything a build or service writes that git does not
  ignore — and `caches:` does not declare — can match an upkeep trigger glob.
  Declare build output under `caches:` (it is then never a trigger) or
  git-ignore it.
- **Wiped `node_modules` by hand? Bind `--pristine`.** runly records which upkeep
  rules it ran; it cannot see you deleting what they installed. A pristine bind
  forgets that record and re-runs every upkeep rule — it never deletes anything in
  the worktree. Two consecutive bind failures escalate to it automatically.
- **One environment per worktree.** A second holder (`--holder`) of the same
  worktree waits for its environment — and is refused at once, naming the holder,
  when that lease outlasts the wait. Parallel lanes need separate worktrees.

### Upgrading to 0.13 — breaking ([decision 0032](docs/decisions/0032-environments-run-in-the-callers-worktree.md))

- **Environments run in your worktree, one per worktree.** No source copy is made.
  A second holder of the same worktree waits for its environment (refused at once,
  naming the holder, when that lease outlasts the wait); parallel lanes need
  separate worktrees.
- **`up` is the only bind verb.** Every `up` runs the due upkeep and the builds of
  the services it starts, then restarts only the services whose build output
  changed — declare it per service with `outputs:` (none declared = restart after
  every build; no `build:` = keep running). **`sync` and `bind` are removed** —
  where you ran `sync`, run `up`. `--watch` is removed with them; `watch_run` and
  `hot_reload` are accepted and ignored.
- **runly runs no checks.** `runly run`, `--detach`, `runly job` and verdict
  artifacts are removed. Run your tests yourself against
  `eval "$(runly ctx --env)"` (variables above). A manifest that still declares
  `checks:` loads with a one-line warning; delete the section and move its
  commands into your own scripts. A top-level `outputs:` is silently ignored.
- **`BACKLOT_POOL_MAX` is removed** — the per-stack ceiling, its `config.json`
  `poolMax` and its `status` field. A leftover setting is ignored.
  `BACKLOT_POOL_MAX_TOTAL` and `BACKLOT_POOL_MAX_DATA_ONLY` are unchanged.
- **runly caches no builds**, so `build:` runs on every `up` that starts its
  service; a no-op build of an incremental tool is cheap.
- Removed verbs and flags — `pull`, `sync`, `bind`, `run`, `job`, `--pull`,
  `--ref`, `--watch`, `--detach` — are usage errors (exit 64) naming decision 0032.
- `bindDiagnostics`: `reuse` is `reused` (services kept), `restarted` (with the
  `restarted` list) or `rebound`; `builds` lists every build with its duration,
  whether it restarted its service and why. `source`, the `fingerprint` phase and
  `refreshed`/`projected` are gone.
- `reset-data` restores data only (no sweep of untracked files); `--pristine`
  re-runs every upkeep rule and never deletes worktree files.
- New: `runly warm`, `runly ctx --env`.

### Moving from Backlot to Runly

For an existing global npm install, remove the old package first: both packages
provide the compatibility command `backlot`, so installing
Runly alongside Backlot otherwise fails with `EEXIST`.

```bash
npm uninstall -g backlot
npm install -g runly
runly update
```

Uninstalling the npm package leaves the state directory and databases intact.
For a source checkout already linked as Backlot, rebuild and use
`npm link --force` to replace the old links, then run `runly update`.
The update command refuses while operations are busy; retry once they finish.
Existing `backlot.yml` files need no rename. New manifests use `runly.yml`.

### Upgrading: `runly update` after you install

Installing a new runly replaces the files on disk. It does **not** replace the
daemon already running — that process keeps serving the old code for as long as
it lives. So an upgrade is two steps:

```bash
npm i -g runly@latest    # or whatever installed it — runly never installs itself
runly update             # restart the daemon onto the build you just installed
```

Skip the second step and runly tells you, rather than quietly serving you the
old behaviour: every verb except `update`, `doctor` and `daemon stop` fails with
`infra-error` (exit 3) naming both versions. That refusal is deliberate — an old
daemon does not reject a flag it has never heard of, it *ignores* it, so
`up --data-only` against a pre-0.9.0 daemon would boot the whole application into
what you asked to be a database-only lease and report success.

```bash
runly --version          # this CLI
runly update --check     # cli vs daemon, who would have to rebind, and the upgrade command for your install
runly update             # restart; no-op when the daemon is already the installed build
```

`runly daemon stop` waits up to 60 seconds after the shutdown acknowledgement
for the old daemon and its service teardown to finish. Success includes
`stopped: true` (and retains `stopping: true` for compatibility); if no daemon is
running, it succeeds without starting one. A shutdown still in progress at the
deadline returns `infra-error` (exit 3) saying so — the daemon is still shutting
down, so wait for it to exit rather than issuing another stop.

**What a restart costs.** Leases **survive** it. Services stop, environments drop
to `warm`, and each holder's next verb rebinds — seconds, the same transition the
idle sweeper already performs on a leased environment. `update` names every holder
before acting. It refuses only two things: an **in-flight operation** (a bind
or `exec` whose caller is waiting on it) and a **downgrade** (an older CLI restarting
a newer daemon). `--force` overrides either.

### Partial `up`: lease one slice, not the whole app

`runly up` with **no service** brings up the whole app. Name one or more
services and runly starts **only that slice plus its transitive `depends_on`
closure** — nothing else boots. This is how you lease a single vertical or a lone
SPA without paying for the rest of the stack.

Take [`examples/hello-multi`](examples/hello-multi/runly.yml): `web`
`depends_on: [api]`, and `worker` stands alone.

```bash
cd examples/hello-multi
runly up web       # starts web + api (its depends_on closure) — worker stays down
runly up worker    # starts worker alone — no api, no web
runly up           # the whole app: api + web + worker
```

Because the closure is transitive, naming a leaf pulls in everything it needs to
run and nothing it doesn't — ideal for iterating on one frontend while its single
backing service comes along for the ride. An unknown service name is a manifest
work-error. All the usual flags (`--reset-data`/`--pristine`,
`--ttl`, `--json`) apply to the partial form too.

### `--data-only`: lease a database, not an application

A test lane usually needs one thing from an environment — a warm, seeded database
of its own — and paying for services it never calls is what pushes people back to
Testcontainers, where every lane starts its own container and restores a full
backup per test collection.

```bash
runly up --data-only --ttl 30      # seeded store, leased; no services, no builds
runly ctx --json                   # .datastores.main.url — point your fixture at it
runly reset-data                   # back to the baseline between runs
runly release
```

Everything else about the lease is unchanged: it is pooled, restored from the same
template, and dropped on recycle. A worktree has one environment, so two lanes in
two worktrees get two namespaces and neither sees the other's writes; two lanes in
one worktree take turns. `ctx` reports `dataOnly: true` so a
fixture can tell "no services by design" from "a service failed to start", and the
environment sits at `warm` because nothing is meant to be running.

It refuses what it cannot mean: naming a service alongside it, and a manifest
that declares no datastore.

**It is priced like a catalog, not like a stack.** `POOL_MAX_TOTAL` comes from `min(cores/2, memGB/4)` because they bound *running
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

During conversion to data-only, the old application slot stays reserved until
its services have stopped. If preparation fails before teardown, the running
application still counts against the application caps; retrying the conversion
or returning to the application shape remains supported. A shape change waits
for an operation already using the environment. For failed teardown and recycle
retries, see [survivor ownership](docs/architecture.md#journal-upgrade-barrier).

### Choosing datastore presets

`up` and `reset-data` accept `--preset NAME` when
the stack has one datastore. For multiple stores, name each target explicitly:

```bash
runly up --preset main=dev --preset audit=empty
runly reset-data --preset main=empty
```

Names must appear in that datastore's `presets` catalog, and so must the names a
`default_preset` declares: a declared default outside the catalog fails every
bind, with or without `--preset`. Without a catalog (omitted or empty), the
implicit `default` and any manifest-declared `default_preset` names remain valid.
Unknown stores, unknown presets, duplicate targets and ambiguous bare names are
refused before acquiring an environment or changing data. Changing a preset
restores that store even with ordinary reuse hygiene. Under reuse, unmentioned
stores keep their data unless their inherited preset was removed or upkeep
requires a template rebake. `reset-data` and `--pristine` restore every store.

A continuing lease keeps its selections across `up`, `reset-data`,
`--pristine`, failed-bind retries and daemon restart unless explicitly overridden.
If a manifest removes the selected preset, the next bind selects the
current default: `default_preset.session` (`default_preset.run` is ignored since
`runly run` was removed), then
the first catalog entry, then `default`. A new lease uses the manifest
defaults and never inherits the previous holder's choices. In `ctx --json`,
`.datastores.<name>.preset` reports the last completed restore, including earlier
stores that succeeded when a later store failed; it is absent after a pristine
wipe until that store is restored. A selection that differs from the one the
environment last recorded appears as `datastore-preset-changed` in bind
diagnostics (a first bind or a newly added store has none to differ from).
RPC accepts the same choices as a `presets` object mapping datastore names
to preset names. Other CLI verbs reject `--preset` with exit 64 and a message
on stderr.

### How long you hold it: `--ttl` for agents, `--holder-pid` for shells

A lease has a TTL, and there are two ways to say when you are done with an
environment:

```bash
runly up --ttl 45                       # agents, scripts, CI: hold it for 45 minutes
BACKLOT_HOLDER_PID=$$ runly up          # an interactive shell: hold it until THIS shell exits
```

Every `up` renews the lease (to `--ttl`, or the default). `reset-data` preserves
a continuing lease's absolute deadline. Use `up --ttl <minutes>` to extend it;
`preview <service> --ttl <minutes>` also renews explicitly. Read-only polling does not extend ownership. A fresh or
expired acquisition takes a normal new deadline; `reset-data` requires a live
lease and refuses an expired one before changing data.

**`--ttl` is the form for anything automated.** `--holder-pid <pid>` (or
`BACKLOT_HOLDER_PID`) pins the lease to a process so the environment returns to
the pool the instant that process exits instead of waiting out the TTL — which is
only useful if the process genuinely outlives the command.

It does **not** work from an agent harness, because those run each command in a
fresh shell: by the time `runly up` returns, the `$$` it was given is a shell
that has already exited. Runly refuses such a bind (exit `64`) rather than
create a lease that is reclaimable the moment it exists — otherwise the sweeper
frees the environment while you are still using it, the next bind takes it, and
you are quietly looking at somebody else's database through the same URL.

`runly release` hands the environment back early. If it answers
`{"released": false}`, read the `reason`: use the same holder that bound it
(`--holder` if supplied, otherwise the caller directory). See
[physical stack identity and legacy holder recovery](docs/architecture.md#physical-stack-identity)
for symlink aliases and upgrade recovery.

For your own repo: `npm i -g runly`, write the `runly.yml`, then the same
verbs. Requires Node ≥ 22.13 and git. The daemon auto-spawns on first use (unix
socket, per-machine state under `~/.local/state/backlot`; isolate with
`BACKLOT_STATE_DIR`).

The manifest, by example ([schema](schema/runly.schema.json)):

```yaml
name: myapp
services:
  api:
    build: dotnet build backend/Host
    outputs: [backend/Host/bin/**]   # restarted on `up` only when the build changed these
    run: dotnet run --no-build --project backend/Host
    port: api
    env: { ConnectionStrings__Main: "{{datastores.main.url}}" }
    ready: { http: /health }
  web:
    run: pnpm exec ng serve --port {{ports.web}}
    port: web
    ready: { http: / }    # no build: — ng serve reloads itself, `up` keeps it running
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
```

Your tests are yours: `eval "$(runly ctx --env)" && pnpm e2e`.

An upkeep rule may set `timeout` in seconds, for example
`{ when: Cargo.lock, run: cargo build --release, timeout: 1200 }`.
Rules without it keep the 300-second default; `BACKLOT_CMD_TIMEOUT_S` overrides
both. The deadline kills the command's process group. With `--progress`, each
command reports its rule number before starting, elapsed time every five seconds,
and completion on stderr; command text and output are not streamed, and `--json`
stdout stays machine-readable. Successful unchanged rules remain skipped.

Services are commands, not containers. Backing infrastructure (your DB server) stays
externally run — runly probes it and classifies its absence honestly
(`infra-error`, never blaming your code). If the repo has one blessed way to start
that infrastructure, declare it as an **appliance** and runly ensures it without
ever owning it ([decision 0018](docs/decisions/0018-appliances-ensured-not-owned.md)).

### Caller environment inputs

Services may explicitly request variables from the process invoking `up`:

```yaml
services:
  api:
    run: node server.mjs
    env_from:
      API_KEY: optional
      API_ENDPOINT: required
```

Export those names in your shell, then run `runly up`. The CLI sends only
declared names over the local socket; the shared daemon does not need a restart.
When autospawning, it removes those names from the new daemon's environment so
the first caller's inputs cannot become ambient configuration for other leases.
`required` refuses a missing value before claiming an environment. An empty string
is a supplied value. A supplied input overrides a same-named `env` entry. An omitted
`optional` input keeps the service's explicit `env` default (templated as usual);
without such a default it is unset and masks a same-named daemon variable. They are
service and readiness-probe inputs, not build, upkeep or `exec` inputs.
`BACKLOT_*` names are reserved for broker controls and cannot be declared here.

Each explicit `up` refreshes the lease's inputs, including clearing omitted optional
values, and changed inputs restart services even when source files are unchanged.
`reset-data` keeps that lease's inputs. A new
holder never inherits them: reusing its warm environment restarts input-configured
services with the new holder's values.

Values remain in daemon/process memory, never in the journal or context/status
responses. Broker service logs redact exact input values, including values split
across output chunks. Repo commands can still write their own files or transform
values; applications own that output. Release forgets the input record; existing
warm services retain their startup environment until stopped or rebound. After a
daemon restart, run `up` again with the values: required inputs refuse a rebind
without them, and optional inputs stay off until supplied again.

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

Runly does not create these logins, verify them, or know what a role means: the seed
makes them, the manifest declares what exists, `ctx` reports it.

### A preview URL that is still valid tomorrow

`runly preview` publishes through a **publisher**. The default,
`cloudflare-quick`, takes whatever `*.trycloudflare.com` name Cloudflare hands
it — right for "look at this for ten minutes", wrong for a bookmark, a ticket, a
device you type an address into by hand, or an app pinned to a dev server. Every
restart invalidates all of them.

Preview launchers may fork children within their process group: Backlot preserves
that leased group through a repeated `up` and idle cleanup, and stops it when the lease ends.
The launcher must remain alive and keep its tunnel children in that group;
detached children that call `setsid` are outside this ownership guarantee. Orphan
tag scanning is Linux-only; macOS uses recorded identity and group teardown.

`cloudflare-named` publishes under a zone you own instead:

```yaml
preview:
  publisher: cloudflare-named
  domain: example.dev     # the zone; required by this publisher
  prefix: myapp           # optional — see below
```

`web` then appears at `https://web-myapp.example.dev`, and it is the same
address next week. Backlot creates the named tunnel and its DNS record on first
use and reuses them; `preview stop` ends the process, not the name.

**It needs a login, once:** `cloudflared tunnel login` for the zone, which leaves
the origin certificate the publisher checks for. No API token, and runly holds
no new secret.

**Leave `prefix` unset unless you mean it.** It defaults to the environment id,
which is unique by construction. A pooled stack has several environments and one
manifest, so a prefix written there is shared — and the second publish of `web`
takes the hostname from the first. Set it only to pin a name a human has to
remember, and only where one environment of the stack runs at a time.

**A named URL is durable, and so is the exposure.** Put a Cloudflare Access
policy over the zone; it matches on hostname, so one policy covers every preview
you will ever publish there ([decision 0028](docs/decisions/0028-named-preview-hostnames.md)).

### A preview only your tailnet can reach

`tailscale` publishes on this machine's own tailnet name instead of the internet:

```yaml
preview:
  publisher: tailscale
  https_port: 20601       # optional — see below
```

`web` then appears at `https://<machine>.<tailnet>.ts.net:20601` for every device
on your tailnet, and for nobody else. runly runs `tailscale serve` in the
**foreground** as a child of your lease, so the mapping exists exactly as long as
that process: `preview stop`, `release`, a moved port or a reaped environment
takes the URL down with it, and nothing is left in tailscale's persistent config
([decision 0031](docs/decisions/0031-tailscale-preview-publisher.md)).

**It needs the operator, once:** `sudo tailscale set --operator=$USER`, plus
MagicDNS and HTTPS Certificates enabled for the tailnet. runly never calls sudo —
sudo would move `tailscale serve` out of the process group and environment it
reaps by.

**Leave `https_port` unset unless you mean it.** Unset, the port is derived from
the environment id and service (in 21000–21999, past anything this machine
already serves), so the same environment gets the same address every time it
publishes. Pin it only for an address a human has to remember, and only where
one environment of the stack publishes at a time; a pinned port that is already
served is refused, not taken over.

For one long-lived environment that should keep a remembered address — a demo box,
say — pin the port on the command instead of in the shared manifest:
`runly preview web --https-port 20601`. It applies to that publish only.

### Understanding a slow bind

`up --json` and `reset-data --json` return
`bindDiagnostics` for that operation. `ctx` does not replay timings from earlier calls. The report
includes:

- `durationMs`: elapsed daemon-side operation time, excluding CLI startup.
- `phasesMs`: time spent acquiring/waiting (`queue`), preparing, ensuring
  appliances, upkeep, stopping services, data preparation, builds, readiness, and
  finalization. Skipped phases are zero.
- `reuse`: `reused` when every service kept running (the builds ran and changed
  no declared output), `restarted` when only the services in `restarted` were
  restarted, or `rebound` for the full stop/data/build/start path. `reasons`
  explains why the full path was taken (`manifest-changed`, `upkeep-required`,
  `hygiene-reset-data`, `environment-not-running`, …).
- `upkeep`: numbers of rules run and skipped; `builds`: each build that ran in this
  operation, how long it took, whether its service was restarted and why
  (`outputs-changed`, `outputs-unchanged`, `no-outputs-declared`, `full-rebind`).
  runly keeps no build cache — every `up` that starts a service runs its
  `build:`, and the build tool decides what is current.

Timings are request-local and appear on successful results. They contain no
command output or caller environment values. For progress while a command is
still running, use `--progress`, including alongside `--json`.

## What it is / is not

| runly is | runly is not |
| --- | --- |
| a warm pool of leased, isolated environments | a compute provider (bring your own, local or cloud) |
| in-place binds: your dirty worktree, running, in seconds | a build system (it invokes your commands, never understands them) |
| seeded, template-restored data states | CI (CI may call runly; never the reverse) |
| machine-readable context and a work/env/infra error taxonomy | an agent (no LLM calls, no browser driving), or a test runner |

## Learn more

- [docs/overview.md](docs/overview.md) — the two-page tour, with diagrams. Start here.
- [docs/objections.md](docs/objections.md) — "my agent can just run the dev servers", "compose does this" — taken seriously, with receipts. (Its "why the copy?" answer predates [decision 0032](docs/decisions/0032-environments-run-in-the-callers-worktree.md), which removed the copy.)
- [docs/architecture.md](docs/architecture.md) — the full design; it *is* the product.
- [docs/decisions/](docs/decisions/) — why it is the way it is.

## Security model

Be clear-eyed about what running runly means:

- **`runly.yml` commands execute with your privileges.** Services, seeds, upkeep
  rules and builds are shell commands from the repo — exactly like `make`, npm
  scripts, or a Justfile. Cloning an untrusted repo and running `runly up` runs
  that repo's commands as you. Review manifests you didn't write.
- **The daemon has no network surface.** It listens on a unix socket in your
  per-user state dir (filesystem permissions are the auth) — no TCP, no remote
  callers. Future remote substrates run the same model *on the remote box*, reached
  over your own SSH/provider credentials.
- **Environments are not sandboxes.** They run in your worktree, and isolation
  between them is namespacing (ports, database namespaces, private log/data
  directories), not a security boundary — code in an environment runs as you, on
  your machine, and writes into your worktree. For untrusted
  code, put the *substrate* in a sandbox (a VM, a cloud box), not your laptop.
- **Public preview URLs are world-readable.** `runly preview` publishes the
  chosen service through a quick tunnel (Cloudflare by default; the `tailscale`
  publisher reaches only your tailnet instead). The URL is
  **unauthenticated** — anyone with the link reaches the service, and under
  `cloudflare-named` (below) that link still works tomorrow, so put an access
  policy in front of the zone if what you publish is not meant for everyone.
  Stacks that must never be published set `preview.forbidden: true` in
  `runly.yml`. The
  tunnel lives as long as your **lease**, not as long as a service process: a
  repeated `up`, a rebind or an idle quiesce leaves it up. A bind tears it down if the
  manifest starts forbidding preview, if the previewed service drops out of the
  running set, or if its port moves — and if `--reset-data` leaves the *same* URL
  serving *new* data, it says so in the bind's `previewNotice`. `runly preview
  stop` and `runly release` both end it.

## Claude Code

runly ships an official [Claude Code](https://claude.com/claude-code) plugin —
a stack-agnostic skill that teaches an agent the lease model and the verb table so
it drives runly correctly against any repo's `runly.yml`. This repository
doubles as its own plugin marketplace. From inside Claude Code:

```
/plugin marketplace add ChristianKohlberg/backlot
/plugin install runly
```

CLI-only, no MCP server — see [`plugins/runly`](plugins/runly/).
Already using `backlot@backlot`? Follow the [plugin migration instructions](plugins/runly/README.md#existing-backlot-installations); updating the CLI does not rename an installed plugin.

## License

Apache-2.0.

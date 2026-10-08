# runly

[![npm](https://img.shields.io/npm/v/runly)](https://www.npmjs.com/package/runly) [![ci](https://github.com/ChristianKohlberg/backlot/actions/workflows/ci.yml/badge.svg)](https://github.com/ChristianKohlberg/backlot/actions/workflows/ci.yml) [![release](https://img.shields.io/github/v/release/ChristianKohlberg/backlot)](https://github.com/ChristianKohlberg/backlot/releases)

runly puts a running, seeded, authenticated instance of your web application in
front of a coding agent or a human. It runs your repo's own commands in the
worktree you call it from, one environment per worktree, described by one
`runly.yml`.

## Install

```bash
npm i -g runly        # requires Node ≥ 22.13 and git
runly update          # after every upgrade: restarts the running daemon onto the installed build
```

The daemon starts on first use (a unix socket in `~/.local/state/backlot`;
`BACKLOT_STATE_DIR` moves it). The `backlot` command and `backlot.yml` are
accepted aliases, and every setting is a `BACKLOT_*` environment variable
([list](docs/architecture.md#configuration)).

For Claude Code, install the bundled skill:

```
/plugin marketplace add ChristianKohlberg/backlot
/plugin install runly
```

## Quickstart

```bash
git clone https://github.com/ChristianKohlberg/backlot && cd backlot
npm ci && npm run build && npm link
cd examples/hello-multi

runly up web                 # upkeep, builds, data; start web and its depends_on (api); prints the context
runly up                     # add every other service; up never stops one
runly ps                     # services and database copies of this worktree
eval "$(runly ctx --env)" && node smoke.test.mjs   # your tests, fed exported RUNLY_* variables
runly up --preset main=empty # reload one datastore; the others keep their data
runly db with main -- sh -c 'echo "$RUNLY_DB_URL"'   # a fresh database copy for one command, dropped after
runly logs api -f --until 'listening' --timeout 60   # wait for the current process's line (124 on timeout)
runly down web               # stop one service; lease, data and port stay
runly destroy                # tear down everything this worktree holds
```

After an edit, run `runly up` again: it runs the due upkeep and the builds and
restarts only the services whose build output changed. Idle services stop after
10 minutes and start again on the next request. How an environment lives and
ends is in [the guide](docs/overview.md#an-environments-life).

## Manifest reference

`runly.yml` at the repo root ([JSON Schema](schema/runly.schema.json)). Commands
run under `sh` in the worktree; write POSIX sh.

| Field | Meaning |
| --- | --- |
| `name` | Stack name (`a-z0-9-`). Required. |
| `services.<svc>.run` | The supervised command. Required. |
| `services.<svc>.build` | Command run before the service starts, on every `up`. `{ run, when: [globs], serial }`: `when` skips it while the matched files are unchanged since the last successful build and its `outputs:` are still what that build left; `serial: true` runs it alone. |
| `services.<svc>.outputs` | Globs the build produces; a running service restarts only when they changed. `{ paths, compare: stat \| content }`. None declared = restart after every build. |
| `services.<svc>.port` | Symbolic port name. Omit for a portless worker. |
| `services.<svc>.env` | Environment variables; values may use templates (below). |
| `services.<svc>.env_from` | Caller variables to pass in: `NAME: required \| optional`. Not `BACKLOT_*`. |
| `services.<svc>.cwd` | Working directory, relative to the repo root. |
| `services.<svc>.ready` | Readiness: `http` (path answering 200), `log` (regex), or `cmd` (exit 0); `timeout` seconds (120). |
| `services.<svc>.fatal_logs` | Regex that fails the start at once when it appears in the log. |
| `services.<svc>.depends_on` | Services that must be ready first. |
| `services.<svc>.idle` | Idle time before the service is stopped (`90s`, `30m`, `2h`, seconds, or `never`). Default 10 minutes. |
| `services.<svc>.resources` | Cost for the load budget: `{ memory, cpu, build: { memory, cpu } }`. Default 512M / 0.5 cpu running, 1G / 1 cpu building. |
| `datastores.<ds>.driver` | `sqlite`, `postgres`, `mssql`, `mysql` or `redis`. Required. |
| `datastores.<ds>.create` | Creates and seeds a namespace; `{{ns}}`, `{{preset}}`. |
| `datastores.<ds>.drop` | Drops a namespace; `{{ns}}`. Needed for `runly db` copies of a server datastore. |
| `datastores.<ds>.template_restore` | Restores a baked template into a namespace; `{{template}}`, `{{ns}}`. Server drivers. |
| `datastores.<ds>.template` | `true`: bake a template file and restore by copy. sqlite only. |
| `datastores.<ds>.url` | Connection string handed to services; `{{ns}}`. Required for server drivers. |
| `datastores.<ds>.probe` | `host:port` checked before anything starts (unreachable = infra-error). |
| `datastores.<ds>.server` | `external` (the only value): runly never runs a database server. |
| `datastores.<ds>.presets` | Named seed states. |
| `datastores.<ds>.default_preset` | The preset a new datastore is created with (else the first preset). A name, or `{ session, run }` read as one value. |
| `datastores.<ds>.ephemeral` | `true`: no presets or templates; a reset runs `drop:` as a flush (Redis-class). |
| `datastores.<ds>.share_templates` | `false`: keep this datastore's templates per worktree. Default: a template keyed by an `@rebake-template` rule is baked once and shared by every worktree of the same stack name on this machine; `--pristine` bakes a private one for its worktree. |
| `datastores.<ds>.copies_only` | `true`: never provisioned for an environment; only the source of `runly db new\|with` copies (template baked on the first copy). No service may template it; `ctx` does not list it. |
| `datastores.<ds>.list` | Command printing the namespaces on the server, one per line; read only by `runly pool doctor`. |
| `appliances.<name>` | A shared backing server: `probe` (required), `start` (run once when the probe fails), `stop` (only for `runly appliance stop`), `ready`, `timeout` (60), `resources`. |
| `upkeep[]` | `{ when: <path or glob>, run: <cmd>, timeout: <s>, outputs: <path or list> }`: runs when the matched files' content changed since it last ran in this worktree, or when a declared `outputs` path is missing (a `git clean` removed it). `runly destroy` forgets the rules that declare no `outputs`, so they run again on the next `up`. `run: "@rebake-template <ds>"` makes the matched files part of that datastore's template key: changed content gets a new template (baked once, then reused) and reloads the store; `--pristine` rebakes. Timeout 300 s. |
| `builds` | `parallel` (default): builds run in `depends_on` waves, each wave at once. `serial`: one at a time, in manifest order. |
| `caches` | Build and install output in the worktree (`node_modules`, `**/obj`); never an upkeep trigger. |
| `sync.include` | Git-ignored files an upkeep `when:` may still match (`.env.local`). |
| `auth.logins` | One `{ user, password, role, description }` or a list; the first is the primary login. |
| `auth.token` | Command printing a token on stdout; `{{role}}`. |
| `preview.publisher` | `cloudflare-quick` (default), `cloudflare-named` or `tailscale`. |
| `preview.domain`, `preview.prefix` | `cloudflare-named`: the zone, and the hostname suffix (default: the environment id). |
| `preview.https_port` | `tailscale`: the tailnet HTTPS port (default: derived per environment and service). |
| `preview.forbidden` | `true`: `runly preview` is refused. |

Templates: `{{ports.<port>}}`, `{{public_ports.<port>}}`, `{{services.<svc>.url}}`,
`{{datastores.<ds>.url}}`, `{{datastores.<ds>.ns}}`. In a service's own `run:` and
`env:`, its own `{{ports.<port>}}` is the internal port it must listen on;
everywhere else ports and URLs are the stable public ones. Top-level `outputs`,
`checks` (with a warning), `sync.keep`, `watch_run` and `hot_reload` are accepted
and ignored.

## Command reference

Every verb takes `--json` (stdout is one JSON object). Exit codes: `0` ok, `1`
work-error (your code), `2` env-error (the environment), `3` infra-error
(something external), `64` usage.

| Command | What it does |
| --- | --- |
| `runly up [svc...]` | Lease this worktree's environment, run due upkeep and builds, start the named services and their `depends_on` (none named = all). Never stops a running service; with services named, the other running ones are not rebuilt or restarted. Prints a short summary (what started or restarted, and why a full rebind happened); `--json` the full context. |
| `  --preset [ds=]NAME` | Reload that datastore from its template (repeatable); the services that use it restart. Without it, data is kept. |
| `  --reset-data` / `--pristine` | Restore every datastore / that, plus re-run every upkeep rule and build (never deletes worktree files). |
| `  --rebuild` | Run every build, ignoring `when:`. |
| `  --ttl <minutes>` | Lease length (default 30), for an untethered lease: it skips the automatic tether, and is refused next to `--holder-pid`. |
| `  --env` | Print the `ctx --env` export lines instead of the summary. |
| `  --holder-pid <pid>` | Tie the environment to a process that outlives the command; torn down a minute after it exits. The summary then says `held by agent <pid>` instead of a deadline. |
| `runly down [svc...]` | Stop these services (none = all); lease, data and ports stay. |
| `runly ctx [--env]` | A short summary (service URLs and states, datastores, login, a failed last `up`); `--json` the full context; `--env` prints `export RUNLY_*=…` lines for `eval`. |
| `runly ps [--all]` | Services (state, ports, pid, idle, memory) and database copies of this worktree, or of the whole box (with a worktree column). A service that crash-looped, or failed its boot during an `up`, shows `failed` with its last exit; an `up` that failed (a build, upkeep, data) is named with its error. The next `up` retries both. |
| `runly plan [svc...] [--rebuild]` | What an `up` would build and start, what it costs, and whether it starts now or waits for the load budget. |
| `runly logs [svc...]` | Service logs, interleaved (last 40 lines). `--lines N`, `--since up\|10m`, `--grep <re>` (exit 1 when nothing matches), `--build` (the upkeep output and each service's last build, a section each with its own last N lines; the header says what was cut). |
| `  -f [--until <re>] [--timeout <s>]` | Follow; `--until` exits 0 on the first matching line of the current process (never an earlier one), `--timeout` exits 124. |
| `runly db with <ds> [--preset NAME] [--runly-exit N] -- <cmd>` | Run a command against a fresh copy (`RUNLY_DB_URL`; `RUNLY_DB_DATABASE`, the database's name on its server; `RUNLY_DB_COPY`, the handle), drop it after, exit with its code. The command dies with the CLI however the CLI dies. runly's own failures are marked on stderr (`runly db with:`, and a `{"runlyDbWith":…}` line with `--json`) and exit 1/2/3, or `N` with `--runly-exit N`. |
| `runly db new <ds> [--preset NAME]` | Make a copy and print `name=`, `url=`, `database=`, `preset=`. |
| `runly db ls [--all]` / `db drop <name>` | List copies / drop one now. |
| `runly exec <cmd...>` | Run a command in the worktree with your environment plus the `ctx --env` variables (and `BACKLOT_URL_*`, `BACKLOT_PORT_*`, `BACKLOT_DS_*`). Stopped services start first. Your terminal, its exit code; `--json` collects `stdout`, `stderr`, `exitCode`. No deadline unless `BACKLOT_CMD_TIMEOUT_S` is set. |
| `runly warm` | Run due upkeep and builds now, with no lease and no services. |
| `runly reset-data [--preset ds=NAME]` | Restore the data of the current lease. |
| `runly token [--role <r>] [--raw]` | Run `auth.token` (role default `admin`, also in `RUNLY_ROLE`); `--raw` prints the bare token. Stopped services start first. |
| `runly release` | End the lease; the environment stays for the next `up`. |
| `runly destroy` | Tear down everything runly holds for this worktree: services, data, copies, ports, lease. Its build records, templates and the upkeep rules that declare `outputs` stay. |
| `runly preview <svc> [--ttl <minutes>] [--https-port N]` | Publish one service through the preview publisher. Unauthenticated. Lasts as long as the lease; a daemon restart publishes it again (same address where the publisher can pin one). |
| `runly preview stop` | End the preview (also one a restart could not publish again). |
| `runly status` / `runly doctor` | Daemon, environments, budget and recent warnings (`--json` everything) / health and drift report. |
| `runly appliance ls\|start\|stop [name]` | Probe, start or stop shared backing servers. |
| `runly pool ls\|recycle [<env-id>] [--force]\|reconcile\|gc` | Environments; recycle one (or all); reap degraded ones; reclaim orphaned processes. |
| `runly pool doctor [--fix]` | List (and with `--fix` remove) what runly left behind. Only runly's own. |
| `runly update [--check] [--force]` | Restart the daemon onto the installed build. Leases survive. |
| `runly daemon stop` / `runly --version` | Stop the daemon, waiting up to 60 s (`BACKLOT_DAEMON_STOP_TIMEOUT_MS`) / print the CLI version. |
| `runly daemon install [--print] [--env NAME]` / `daemon uninstall` | Supervise the daemon with a systemd user unit (Linux) or launchd agent (macOS) that restarts it when it crashes; `--print` shows the unit. The unit carries `PATH`, an allowlist (`DOTNET_*`, `NODE_*`, `JAVA_HOME`, `DOCKER_*`, `LANG`/`LC_*`, proxies, `SSL_CERT_*`), `BACKLOT_*`, the variables the manifest's commands reference and each `--env NAME`, never an `env_from` input; install prints what it captured and left out. |

The verbs that act on a lease or copy take `--holder <name>` to act for a holder
other than the caller's worktree (the default; any subdirectory of it counts). `up`, `warm` and `reset-data` show progress on a terminal;
`--progress` forces it, `--quiet` silences it.

## More

- [docs/overview.md](docs/overview.md) — the guide: environment life, ports,
  testing, data, builds, the load budget, previews, security.
- [docs/architecture.md](docs/architecture.md) — the design and every setting.
- [docs/decisions/](docs/decisions/) — why it is the way it is.

## License

Apache-2.0.

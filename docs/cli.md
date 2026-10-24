# CLI reference

Every verb takes `--json` (one JSON object; `monitor` emits one per snapshot). Exit codes: `0` ok, `1`
work-error (your code), `2` env-error (the environment), `3` infra-error
(something external), `64` usage.

| Command | What it does |
| --- | --- |
| `runly up [svc...]` | Lease this worktree's environment, run due upkeep and builds, start the named services and their `depends_on` (none named = all). Keeps unrelated services wanted; restarts services when their configuration or build requires it; with services named, the other running ones are not rebuilt or restarted. Prints a short summary (what started or restarted, and why a full rebind happened); `--json` the full context. |
| `  --preset [ds=]NAME` | Reload that datastore from its template (repeatable); the services that use it restart. Without it, data is kept. |
| `  --reset-data` / `--pristine` | Restore every datastore / that, plus re-run every upkeep rule and build (never deletes worktree files). |
| `  --rebuild` | Run every build, ignoring `when:`. |
| `  --env` | Print the `ctx --env` export lines instead of the summary. |
| `  --holder-pid <pid>` | Optional process metadata; process death never destroys the environment. |
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
| `runly preview <svc> [--ttl <minutes>] [--https-port N]` | Publish one service through the preview publisher. Unauthenticated. Always expires: 30 minutes by default. `--ttl` changes public access only. Successful `up` renews active previews or reopens automatically expired ones for that TTL. Explicit `preview stop` keeps it private; restart alone never reopens expired access. |
| `runly preview stop` | End the preview (also one a restart could not publish again). |
| `runly stats [--all] [--since 30m]` | Local timings and counters, scoped to this worktree by default. Up to 24h bounded history; JSON includes correlated observations and coverage metadata. |
| `runly monitor [--all] [--since 30m] [--interval 2s] [--timeout 60]` | Live statistics without waking services. Ctrl-C stops; JSON is NDJSON, one object per snapshot. |
| `runly status` / `runly doctor` | Daemon, environments, budget and recent warnings (`--json` everything) / health and drift report. |
| `runly appliance ls\|start\|stop [name]` | Probe, start or stop shared backing servers. |
| `runly pool ls\|recycle [<env-id>] [--force]\|reconcile\|gc` | List environments; destructively recycle one (or all); destructively remove degraded rows; reclaim orphaned processes. Use `pool doctor` to inspect first. |
| `runly pool doctor [--fix]` | List (and with `--fix` remove) what runly left behind. Only runly's own. |
| `runly update [--check] [--force]` | Restart the daemon onto the installed build. Leases survive. |
| `runly daemon stop` / `runly --version` | Stop the daemon, waiting up to 60 s (`BACKLOT_DAEMON_STOP_TIMEOUT_MS`) / print the CLI version. |
| `runly daemon install [--print] [--env NAME]` / `daemon uninstall` | Supervise the daemon with a systemd user unit (Linux) or launchd agent (macOS) that restarts it when it crashes; `--print` shows the unit. The unit carries `PATH`, an allowlist (`DOTNET_*`, `NODE_*`, `JAVA_HOME`, `DOCKER_*`, `LANG`/`LC_*`, proxies, `SSL_CERT_*`), `BACKLOT_*`, the variables the manifest's commands reference and each `--env NAME`, never an `env_from` input; install prints what it captured and left out. |

The verbs that act on a lease or copy take `--holder <name>` to act for a holder
other than the caller's worktree (the default; any subdirectory of it counts). `up`, `warm` and `reset-data` show progress on a terminal;
`--progress` forces it, `--quiet` silences it.

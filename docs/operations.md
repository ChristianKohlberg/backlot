# Operations and tuning

For the everyday workflow, start with [the guide](overview.md). Full syntax is in the [CLI reference](cli.md).

## The daemon

The CLI starts the daemon on first use. If it crashes, the next CLI command
starts a new one, which takes the ports back and reaps what the old one left; until
then the ports refuse connections. To have it restarted at once instead, install
a supervisor:

```bash
runly daemon install --print   # show the unit (systemd user unit on Linux, launchd agent on macOS)
runly daemon install           # write and enable it; start the daemon through it if none runs
runly update                   # if a daemon was already running: restart it under the unit (leases survive)
runly daemon uninstall         # disable and remove it
```

The unit restarts a crashed daemon. A normal daemon shutdown stops managed services; recovery reclaims survivors after a crash. It runs with what `daemon install` captured from the shell
that ran it, and prints that list (and how many variables it left out): `PATH`,
an allowlist (`DOTNET_*`, `NODE_*`, `NVM_*`, `JAVA_HOME`, `DOCKER_HOST`,
`DOCKER_CONTEXT`, `LANG`, `LC_*`, the proxy variables, `SSL_CERT_*`), every
`BACKLOT_*` setting, the variables the manifest's commands reference (`$NAME`)
when installed from a stack, and each `--env NAME`. An `env_from` input is never
stored in the unit: each `up` brings it. Reinstall after changing them. A repo
command that fails because a tool or runtime is missing (`command not found`, no
.NET SDK) is reported as an env-error that says so and how to give the unit the
variable. Once it is installed, a
CLI that finds no daemon starts the unit rather than a daemon of its own, and
`runly status` reports `supervisor: systemd` (or `launchd`). There is one unit
per state root. runly never installs it by itself.

## The load budget

One daemon admits every start and build on the box against one budget: 70 % of
RAM and 1.5 × cores of **declared** resources, and on Linux free memory above
max(2 GiB, 10 % of RAM). The CPU must not be saturated: with Linux PSI, runnable
work may not have waited for a CPU 70 % of the time over both the last 10 s and
the last minute (`BACKLOT_BUDGET_CPU_PRESSURE`; 100 or more turns this off);
without PSI (macOS), the 1-minute load must be at most 4 × cores. Waking a
service that ran within the last hour skips the CPU check (memory still
applies), and an `up` with nothing to build or start never waits. A build
holds its share only while it builds, and a wave of parallel builds holds their
sum; an idle-stopped service holds none. Undeclared costs are 512M / 0.5 cpu
running and 1G / 1 cpu building.

An `up` (or a wake) that does not fit waits in a first-come queue, shows its
position with `--progress`, and fails with env-error (exit 2) after 10 minutes,
naming what is committed. `runly plan` answers beforehand: "starts now" or what
it would wait for. `BACKLOT_BUDGET=off` disables it; the other knobs are in
[architecture §11](architecture.md#configuration).

## Logs

```bash
runly logs                          # all services, interleaved: "api | …" (last 40 lines)
runly logs api --since up           # only the current api process
runly logs --since 10m --grep 'ERROR|WARN'
runly logs web -f --until 'Compiled successfully' --timeout 300
runly logs --build                  # the last build output of each service, and of upkeep
```

`--until` matches only lines after each service's last start, so a line from
an earlier process never ends the wait. It exits 0 on a match; `--timeout` exits
124. Every
line carries its arrival time; logs survive idle stops and daemon restarts, are
capped at 20 MB per file with one rotation (`BACKLOT_LOG_CAP_BYTES`), and go with
the environment.

## Cleanup

Each environment records how to drop its databases when it creates them, so a
deleted worktree's databases are dropped with the command they were made with.
Templates are kept per datastore and preset (the newest, plus every one an
environment, copy or existing worktree of the stack last restored from), the
rest after an hour. `runly pool doctor` lists what runly left behind
(unreferenced directories and templates, records of deleted worktrees, processes
and listeners of gone environments, and, with a datastore `list:` command,
orphaned server databases in runly's naming); `--fix` removes eligible leftovers. Review the report before applying it. It only
touches runly's own: files under its state root, processes carrying its tag, and
databases of stacks it knows. Other databases show as `foreign-namespace` and
stay.

## Logins and tokens

`auth.logins` takes one login or a list; each may carry a `role` and a
`description` saying what it is for. `ctx` reports `logins` (the primary, the
first entry, always one object) and `allLogins` (every entry). runly does not
create or verify logins; the seed does. `runly token --role <r>` runs
`auth.token` with `{{role}}` and prints `{token, role}`; `--raw` prints the bare
token for an `Authorization` header.

## Caller inputs

`env_from` lists variables a service takes from the shell that runs `up`:

```yaml
services:
  api:
    run: node server.mjs
    env_from: { API_KEY: optional, API_ENDPOINT: required }
```

Only the declared names are sent to the daemon. A missing `required` input is
refused before anything starts; a supplied value overrides a same-named `env:`
entry; an omitted `optional` one keeps the `env:` default or stays unset. Every
`up` refreshes them, and a change restarts the services that use them. Values
live in daemon memory only, are redacted from service logs, and are never
inherited by another holder. After a daemon restart, run `up` with them again.
They reach services and readiness probes, not builds, upkeep or `exec`.

## Previews

Cloudflare URLs are unauthenticated unless you add access controls; Tailscale access follows your tailnet policy. A stable hostname does not extend its access deadline.

`runly preview <service>` publishes one service of your lease; `preview stop`
ends it and clears reopening intent. Public access expires after 30 minutes
(or `preview --ttl <minutes>`), including open streams. Idle stops and service
restarts preserve the tunnel within its deadline. Successful `up` renews it,
or republishes an automatically expired preview for its saved duration;
`release` and teardown end publication. A daemon restart (a crash,
`daemon stop`, an update) restores only unexpired access once the daemon holds
the ports, without extending its deadline, with the same
publisher and, where the publisher can pin it, the same address
(`cloudflare-quick` gets a new name); the service wakes on the first request.
`ctx` shows `previewRestore` while that runs, or with the error when it failed;
`preview stop` ends it either way. A bind ends it when the manifest sets `preview.forbidden`,
the service is taken `down`, or its port moves; `--reset-data` keeps it and says
in `previewNotice` that the same URL now serves new data.

| Publisher | Address | Needs |
| --- | --- | --- |
| `cloudflare-quick` (default) | a new `*.trycloudflare.com` name each time | `cloudflared` on `PATH` (or `BACKLOT_CLOUDFLARED`) |
| `cloudflare-named` | `https://<service>-<prefix>.<domain>`, the same next week | `preview.domain`; `cloudflared tunnel login` once for the zone |
| `tailscale` | `https://<machine>.<tailnet>.ts.net:<port>`, tailnet only | `sudo tailscale set --operator=$USER` once; MagicDNS and HTTPS certificates |

Leave `preview.prefix` and `preview.https_port` unset unless one environment of
the stack publishes at a time: the defaults derive from the environment id, so
they are unique. To pin a tailnet port for one publish, use `runly preview web
--https-port 20601`. `tailscale serve` runs in the foreground as a child of the
lease, so nothing remains in tailscale's config when it ends.

## Measure and tune a setup

Use recorded statistics during the first development sessions:

~~~sh
runly stats --since 30m
runly stats --all --since 2h --json
runly monitor --interval 2s
runly monitor --since 30m --timeout 60 --json
~~~

Stats defaults to this worktree and the last 30 minutes; --all includes all
worktrees on the daemon. Monitor refreshes sequentially until Ctrl-C or its
timeout (seconds). Its JSON output is one object per line, suitable for capture.
Neither command counts as environment activity or wakes services. Like other
CLI reads, they can autostart a stopped daemon.

Compare unchanged up, a source edit, a seed edit and idle/wake cycles.
Measurements include bind/build phases, skipped builds/upkeep, budget waits,
service readiness and idle stops, datastore bake/create/restore/drop, template
reuse/retries, and proxy traffic, holds, retries and first upstream bytes.
JSON recentOperations links a cold wake's triggering connection to its startup
stages. It contains the latest 200 correlated observations, not a complete trace.

A high datastore.restore_ms points to copying cost; repeated template_bake_ms
suggests seed invalidation or cache reuse needs investigation. Slow
wake.total_ms with high budget.wait_ms means load admission is a contributor.
build.skipped, build.run_ms and service.restarts help distinguish avoided work
from a fast build that still restarts services. These measurements describe what
happened; they do not prove a cache's input set is correct.

**First-byte timing is connection-level.** proxy.first_byte_ms starts at TCP
accept and ends when the first upstream bytes reach the proxy. It includes
startup delay for a cold connection, but cannot separate individual HTTP
keep-alive requests or WebSocket messages, and does not prove client receipt.
proxy.hold_ms measures explicit startup holds, excluding retry backoff.
Quantiles apply to those observations, not all application requests.

History uses minute buckets for up to 24 hours, bounded by entry and byte caps;
heavy use can shorten it. Window starts round down to a minute. p50/p95 are
histogram estimates; sample counts accompany them. Check collection for
retainedSince, truncation, dropped observations and storage errors before drawing
conclusions. retainedSince does not promise continuous coverage. Historical
aggregates survive daemon restarts; live proxy totals do not. Machine budget
figures are declared costs, not actual CPU/memory samples—use ps and bounded
OS/container measurements for those. Data/build phases may overlap.

Recording is local and stores no request contents, URLs, commands or credentials.
Batched persistence can lose recent measurements on a crash. Monitoring has
bounded overhead; it is not a replacement for application request tracing or
an external latency benchmark.

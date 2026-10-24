# Everyday guide

Runly builds and runs your commands in the caller's worktree. Each worktree has
one environment with its own ports, datastore namespaces and logs. Source files
and build output stay in the worktree; Runly is not a sandbox or a test runner.
Start with the [npm quickstart](../README.md#quickstart).

## A session

```sh
runly up                  # start all services; preserve existing data
runly ps                  # inspect services
runly logs                # inspect their output
# edit code
runly up                  # apply configuration, upkeep and builds
runly exec npm test       # run your own tests with Runly's connection variables
runly down                # stop services; keep data and ports
```

`up web` adds `web` and its dependencies without removing other wanted services.
A second holder of the same worktree must wait or release the existing lease;
use separate worktrees for parallel environments. `release` ends ownership and
public previews, but keeps the environment and permits traffic-triggered wake.

## An environment's life

- **Idle:** after five minutes without activity, managed services stop. Data and
  proxy ports remain. A service's `idle:` can override the duration.
- **Activity:** proxy bytes in either direction and using commands such as `up`,
  `exec`, `token`, `preview`, `reset-data` and `down`. The clock is shared across
  the environment. Read-only commands and readiness probes do not count.
- **Streams:** WebSocket/SSE traffic counts; silent open sockets do not. An idle
  stop closes silent connections, so clients must reconnect. Use `runly exec`
  for heartbeating background work, or `idle: never` where appropriate.
- **Wake:** traffic starts wanted services and dependencies through the load
  budget, even after release. Explicitly downed or failed services need `up`.
- **Retention:** agent death, lease release, inactivity, crash loops and pool
  pressure do not delete environment data. Environment leases have no TTL.
- **Destruction:** `destroy`, explicit pool cleanup, or confirmed worktree removal
  deletes environment resources. Moving/renaming a worktree makes its old path
  missing too. Back up any data you need before these actions.

A full pool refuses creation rather than evicting another worktree. A failed
start retains data; retry with `up`. Runly never automatically selects pristine.
Shared appliances are not stopped by service idle or environment teardown.

A daemon restart preserves data, leases and public port assignments. The next
using command or proxy connection resumes eligible services. Required caller
inputs must be supplied again with `up`; failed binds also need a fresh `up`.
See [daemon setup](operations.md#the-daemon) for automatic crash recovery.

## What `up` does

Runly runs due upkeep, prepares datastores, builds selected services and waits
for readiness. A changed manifest, caller input, upkeep result or unhealthy
runtime can require a full restart.

On the incremental path, running services with a build restart when their
`outputs:` change; without declared outputs they restart after every build.
Services without a build keep running and must reload their own source edits.
`build: { run, when }` skips unchanged inputs while recorded outputs remain valid;
`--rebuild` forces builds. Runly does not replace your build tool's cache.

`warm` runs upkeep and builds without starting services. `pristine` explicitly
resets data and reruns upkeep/builds; it never deletes worktree files. Use
`up --json` to inspect `bindDiagnostics` when reuse or restart is unexpected.

## Data

Datastores are isolated per environment. `create:` seeds a namespace; configured
templates speed up later restores. Existing data is preserved on an ordinary `up`.

| Action | Effect |
| --- | --- |
| `up --preset main=empty` | Reload only `main`; restart services that use it. |
| `reset-data` | Restore all environment datastores from their seed/template state. |
| `up --pristine` | Reset data and rerun upkeep/builds; shared templates stay intact for other worktrees. |
| `db with main -- npm test` | Create a separate copy for this command and drop it afterward. |
| `destroy` | Delete the environment and its databases; retain reusable templates and build records. |

**Reset and destruction discard mutations.** Private databases may hold changes
that exist nowhere else. A changed `@rebake-template` trigger also reloads its
store on the next `up`; choose seed triggers narrowly.

Content-keyed templates can be shared across worktrees of the same manifest
name. Use `share_templates: false` when seed results depend on worktree-specific
state not represented in the key. Seed commands must finish and close database
connections before exiting. See the [manifest reference](manifest.md) for setup.

Standalone copies have a separate lifetime: `db with` owns a copy for its
command; `db new` copies end on explicit drop, holder death when configured, or
worktree removal. `db new` does not run upkeep; use `warm` if seeding needs it.

## Running your own tests

```sh
runly exec npm test
# Or export the context into your shell:
eval "$(runly ctx --env)" && npm test
```

Exports include `RUNLY_ENV_ID`, `RUNLY_URL_<SERVICE>`, `RUNLY_PORT_<PORT>` and
`RUNLY_DATASTORE_<NAME>_URL`. Names become uppercase with punctuation replaced by
underscores. `db with` instead supplies `RUNLY_DB_URL`, `RUNLY_DB_DATABASE` and
`RUNLY_DB_COPY`. Runly returns the test command's exit code.

`ctx` is read-only; `exec` resumes eligible services and heartbeats while its
command runs. Source edits are visible immediately to processes in the worktree;
use another worktree when tests require a frozen input.

## Ports

Services listen on their internal `{{ports.<key>}}`; other consumers use the
stable public proxy URL. `{{public_ports.<key>}}` is always public. A public port
can change if another process took it while the daemon was down.

New connections wait during startup, subject to a deadline. Safe replay after
a reset is limited to one complete, bodyless GET/HEAD/OPTIONS request before any
response. Mutations, pipelined requests, upgrades and answered streams are not
replayed. Recognizable HTTP startup failures receive a generic 503; detailed
errors remain in local logs. WebSocket clients must handle disconnects.

## When something fails

| Exit | Meaning | Next step |
| --- | --- | --- |
| 1 | Work or manifest error | Inspect logs, fix the cause, retry `up`. |
| 2 | Environment/resource problem | Follow the diagnostic; inspect `ps`, `logs`, `doctor` or `plan`. No automatic data reset. |
| 3 | Infrastructure problem | Restore the dependency, or use `runly update` for daemon version skew. |
| 64 | Invalid usage | Check `runly --help` or the [CLI reference](cli.md). |

A failed service is reported in `ps`; its data and environment remain. Retry it
with `up`. Inspect `pool doctor` before considering `--fix`; `pool recycle` and
`pool reconcile` are destructive operations, not routine retry commands.

`--json` returns structured output; `monitor --json` emits one object per
snapshot. [Monitoring](operations.md#measure-and-tune-a-setup) is read-only and
does not prevent idle. Observe the first few development sessions before tuning
build triggers, seed templates, resource declarations or idle durations.

## Security model

Manifest commands run with your user's privileges. Review untrusted manifests.
Runly isolates names and ports, not filesystem or operating-system access.
The control socket is protected by local file permissions; service proxies
listen on loopback.

[Public previews](operations.md#previews) expire after 30 minutes by default.
Successful `up` renews active access or reopens automatically expired access;
`preview stop` clears that intent. Cloudflare URLs have no application login
added by Runly. Keep sensitive stacks private with `preview.forbidden: true`.
A stable hostname is not a promise of continuous access.

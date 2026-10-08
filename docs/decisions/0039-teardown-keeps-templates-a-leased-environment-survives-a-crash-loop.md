# 0039. A teardown keeps the worktree's templates and records; a leased environment survives a crash loop; only verbs that use an environment are activity; the daemon may be supervised; a datastore may exist only as copies

- Status: Accepted; corrected in 0.18.1 (the proxy replay rule and a service
  that fails during a bind — see the two paragraphs marked 0.18.1)
- Date: 2026-10
- Amends: [0007](0007-hygiene-levels.md) — a crash loop degrades only an
  unleased environment; [0032](0032-environments-run-in-the-callers-worktree.md)
  and §7 of the architecture — `@rebake-template` no longer rebakes a template
  whose key matches; [0034](0034-additive-up-database-copies-and-ps.md) — `db
  with` stops its command with the copy, and `copies_only` datastores;
  [0035](0035-services-idle-on-their-own-clock-and-wake-on-demand.md) — what
  counts as activity, `destroy` keeps the worktree's records;
  [0009](0009-local-daemon-no-central-service.md) — the daemon may run under
  systemd or launchd
- Context: the step-10 benchmark on the founding .NET + Angular + MSSQL
  monorepo (runly 0.17.0, 29–32 upkeep rules, three MSSQL datastores) found:
  - B1. Every `up` after a teardown spent 90–113 s in the data phase rebaking
    templates that still existed on the server: `destroy` deleted the
    worktree's upkeep ledger, the `@rebake-template` fingerprints lived on the
    deleted environment row, so every rule fired again — and a fired rule
    dropped the template. A reset with warm templates takes 5 s. The cold path
    also ran data (110 s) and builds (99 s) one after the other.
  - B2. A restore that failed was followed by a silent rebake. Restores ran
    outside the bake lock, so a sibling's rebake, a prune, or another
    restore's failure fallback dropped the template mid-copy; that restore
    failed and rebaked in turn — under parallel `--reset-data` one transient
    error cascaded into rebakes.
  - B3. Four crashes in ~70 s marked a LEASED environment degraded, and 12 s
    later the sweeper deleted it with its data and its logs — the evidence of
    why it crashed.
  - B4. A request in the first ~50 ms after a crash got an empty reply: the
    kernel had accepted the connection, the process was gone, and the proxy
    passed the close on.
  - B5. `runly db with` killed by SIGKILL left its command running against a
    database that was dropped 73 s later.
  - B6. `ps`, `ctx`, `plan` and `logs` touched the environment, so an agent
    polling them kept idle services awake. `ps` computed IDLE and STOPS IN
    from two different clocks.
  - B7. A crashed daemon left the public ports dead and the orphaned services
    holding memory until the next CLI command happened to respawn it.
  - B8. A datastore used only for `runly db` copies (an integration lane) was
    still provisioned, with its template, for every environment.

## Decision

**Templates and the worktree's records outlive an environment.** A template is
keyed by its `create:` command and the content of its `@rebake-template` rules'
trigger files (vetbill-1i49): a marker whose key matches was baked from exactly
these inputs and is reused; a missing one is baked by the restore that needs
it. A fired `@rebake-template` rule therefore only means "this environment's
data may be from another template": the datastore is reloaded when the template
it was restored from (`env.templates`) is not the current one. Only
`--pristine` (nothing is trusted) drops the current templates — of the named
datastore only, every preset — so they are baked again. `runly destroy` keeps
the worktree's upkeep ledger, trigger cache and build ledger: they describe the
worktree, which destroy never touches. They go with the worktree (the sweeper)
or with `--pristine`.

**Data and builds overlap.** On a full bind the datastores are restored (or
baked) while the services build; services start once both are done, a failure
of either is reported after both settle (data first). `bindDiagnostics.phasesMs`
gives each its own wall time, so `data + build` may exceed `durationMs`. A
datastore's `create:` must therefore not depend on a service's `build:` (upkeep
runs before both).

**Restores share the template lock.** The per-stack template lock is a
readers-writer lock: bakes, rebakes, retention and doctor are writers; restores
are readers and run side by side. A failed restore is logged (`kind:
template`, with the error) and retried as it is; only a second failure rebakes
— and only if the marker it restored from is still the current one (another
restore may have rebaked meanwhile). Markers name their datastore (`ds`).

**A leased environment survives a crash loop.** A service that exhausts its
restart budget in a leased environment is stopped and reported `failed`: `ps`
and `ctx` show it with its last exit and the hint `runly logs <svc>`, an event
says the same, a connection does not wake it and `exec`/`token` do not resume
it. The environment, its data, its other services and its logs stay; the next
`up` starts it again. A bind during which a started service fails — it crash-loops,
or (0.18.1) it never becomes ready because it exits, hits a `fatal_logs` marker
or daemonizes during its boot — reports it (work-error, `up` exits non-zero
naming it), stops only that service, does not start what `depends_on` it, and
leaves the rest running, wakeable and usable by `exec`/`token`. One failed
service is not a failed bind: it does not count toward `failStreak` (0007).
And a LEASED environment is never escalated to `pristine` automatically, how
many binds ever failed — pristine reloads its data, and its data is someone's
work; they can ask for `--pristine`. An UNLEASED environment is still marked
`degraded` and recycled. Logs go only with the environment.

**The proxy retries a connection its service dropped unanswered — when no
process can have acted on it** (corrected in 0.18.1). Until a service sends its
first byte back, the proxy keeps what the client sent (up to 1 MB). A reset or
close in that window is handled like a refused connect — held while the port is
`starting`, woken when `down`, retried while still `up` (at most five times,
then the close is passed on: that is the service's answer) — only when:

- nothing the client sent reached the process: the connect was refused, or the
  connection was lost before the proxy wrote a byte upstream; or
- the bytes reached it, the connection's first bytes are an HTTP request with
  a method that is safe to repeat (`GET`, `HEAD`, `OPTIONS`), and they have not
  been carried to a relaunch before — one connection's bytes reach at most two
  processes, so a request that kills every process it reaches cannot burn the
  restart budget.

Anything else — `POST`, `PUT`, `PATCH`, `DELETE`, a database or TLS wire
protocol — that reached a process is never replayed: the client sees the reset
or close, as without a proxy. 0.18.0 said "replaying is safe only before the
service answered"; that is wrong for a non-idempotent request — a handler that
did its side effect and then crashed before replying ran it once per relaunch
(four times), and the one request crash-looped the service into `failed`.
After the service's first byte nothing is retried.

**`runly db with` takes its command down with its copy.** The command carries
the copy's tag (`BACKLOT_DB_COPY`, inherited by its descendants), its pid,
start time and — without a terminal, where it runs in its own process group —
its group are recorded on the copy row. Every drop of a copy first stops what
runs against it: the recorded group through its verified leader, else the
verified pid, and on Linux every tagged process. A `db with` copy whose CLI
died is dropped at the next sweep, not after the tether grace (the CLI never
comes back). At a terminal the command stays in the CLI's group, so job
control behaves as before; on macOS, without the tag scan, a command whose
shell wrapper already exited may outlive the drop.

**Only verbs that use an environment are activity.** `up`, `reset-data`,
`exec`, `token`, `preview` and `down` move its clock; `ctx`, `ps`, `plan`,
`logs`, `status`, `db ls` and `doctor` do not, and neither does any server-wide
verb. `ps` shows IDLE and STOPS IN from the one clock the sweeper stops by.

**The daemon may be supervised.** `runly daemon install` writes and enables a
systemd user unit (Linux) or launchd agent (macOS) per state root that runs the
daemon with restart-on-failure (`RestartSec=1`, `KillMode=process` so services
survive the daemon as before), PATH and `BACKLOT_*` captured at install time;
`--print` shows it, `runly daemon uninstall` removes it. A CLI that finds no
daemon starts the unit (when it runs this build's daemon) instead of spawning
one; the socket election still decides, so there is never a second daemon.
`runly status` reports `supervisor`. A crashed daemon is back within seconds
and `recover()` re-holds the ports and reaps the orphans. runly never installs
the unit on its own.

**A datastore may exist only as copies.** `copies_only: true` on a datastore:
never provisioned for an environment, only the source of `runly db new|with`
copies (its template baked on the first copy and reused). No service may
template it (refused at load), `ctx` and `ctx --env` do not list it, and `up
--preset` / `reset-data --preset` cannot name it. An environment made before
the flag gives its namespace back at its next full bind.

## Consequences

- An `up` after `destroy` with unchanged seeds costs a restore, not a bake; the
  benchmark's cold path drops by the shorter of data and build.
- A crash-looping service no longer costs its holder the environment or the
  logs that explain it; recycling for a crash loop remains for environments
  nobody holds.
- An agent that polls `ps`/`ctx` no longer keeps services awake — and no longer
  keeps them from being stopped while it only watches.
- A supervised daemon is an opt-in; the default is still the autospawn.
- A copy restore that fails for a reason that is not transient costs one extra
  restore before the rebake.

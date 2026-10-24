# runly — architecture

> **Thesis:** runly puts a working instance of a web application *in front of* a coding
> agent (or a human) — running, seeded, authenticated, provable — as a cheap, repeatable
> act. It brokers environments; it never provides them.

This document is the design. It was produced by working a real system (a .NET +
Angular + MSSQL monorepo with a home-grown verify harness) through every failure
mode we could think of, then generalizing. Individual decisions are recorded in
[`decisions/`](decisions/); this document is the connected whole. How it behaves
for a user is in [`overview.md`](overview.md).

---

## 1. The problem

Coding agents (and the humans supervising them) need three things from a web
application under development, constantly:

1. **Inspect** — a running, seeded, logged-in instance to look at and drive.
2. **Prove** — system-level tests (e2e) against a deterministic environment — the
   repo's own tests, fed the environment by `runly ctx --env`.
3. **Iterate** — the fix-rebind-retest loop, in seconds, against real running services —
   *before* committing and long before CI.

CI cannot serve this: CI proves *committed* state to *the team*; agents need to prove
*arbitrary dirty state* to *one consumer*, immediately. Hand-rolled harnesses converge
on the same machinery in every repo — port allocation, DB namespacing, capacity gating,
zombie reaping — welded to one codebase and permanently half-finished.

The result of *expensive* environments is a predictable pathology: everyone keeps theirs
alive "just in case," and the machine fills with abandoned half-dead stacks. Abandonment
is not a discipline failure; it is the rational response to expensive provisioning.

## 2. Non-goals (hard boundaries)

These are where tools like this die of scope creep. runly:

- **Never owns compute.** Local processes and BYO cloud sandboxes (Morph, Sprites, E2B,
  plain SSH) via drivers. No fleet, no billing, no scheduler.
- **Is never a build system.** It *invokes* the repo's commands; it never understands
  them. There is no plugin that knows what Angular is.
- **Is never CI.** CI may call runly; never the reverse.
- **Is never the agent, nor the test runner.** No LLM calls, no browser driving, no
  test authoring, no verdicts (decision 0032). runly guarantees URLs, credentials and
  data states; what the consumer does with
  them is its business.

**Scope (v1):** web applications — N HTTP-ish services + M datastores, with a browser
as the primary consumer. Portless workers and multi-datastore stacks are in scope;
Kubernetes, Windows, secrets management, and dashboards are not.

## 3. The model — the nouns

| Noun | What it is |
| --- | --- |
| **Stack** | What a repo declares in `runly.yml`: services, datastores, seed presets, upkeep rules. The only repo-specific artifact. |
| **Substrate** | Where environments physically live, behind a driver: `local` (supervised processes in a directory), later `docker`, `morph`, `sprites`, `ssh`. |
| **Environment** | The one environment of a worktree, on a substrate: running services, allocated ports, a datastore namespace, its logs — running **in the caller's worktree**, whose caches it shares ([decision 0032](decisions/0032-environments-run-in-the-callers-worktree.md)). Durable; belongs to the worktree, never to a person or task. Its lease says which services it wants up — `up` adds, `down` takes away — and every datastore exists for its whole life ([decision 0034](decisions/0034-additive-up-database-copies-and-ps.md)). |
| **Database copy** | A fresh copy of one datastore, restored from the environments' template, outside any environment: no lease, no ports, no services (`runly db new|with`, decision 0034). Journalled with its holder and its drop command; reaped like an environment when the holder or the worktree is gone. |
| **Binding** | A source state (the caller's worktree, as it is) plus a data state (preset, at a hygiene level) attached to the worktree's one environment. Since decision 0032 it is not a frozen snapshot: the services read the live worktree, and runly records no identity of it. |
| **Lease** | Worktree ownership until explicit release or destruction ([its life](overview.md#an-environments-life)). No TTL or process liveness governs it. |

There is no Run noun: runly executes no checks and gives no verdicts (decision
0032). A repo runs its own tests against `runly ctx --env`.

### The two inversions everything follows from

**Environments belong to worktrees.** Leases never expire, and agent death does
not destroy data. Explicit release relinquishes ownership; inactivity stops
managed services while preserving their data and ports (decision 0046).

**Environments run in the worktree; proxy ports survive service restarts.** The services build and run
in the caller's worktree, whose caches are already warm (.NET and pnpm caches embed
absolute paths, so a copy elsewhere would start cold;
[decision 0032](decisions/0032-environments-run-in-the-callers-worktree.md)). What
stays the environment's own is its ports (and therefore URLs, stable for its
lifetime), its datastore namespaces and its logs.

Stable ports are held, not just recorded ([decision 0033](decisions/0033-the-daemon-holds-public-ports-behind-an-l4-proxy.md)):
the daemon listens on each environment's **public** ports (20000–29999) for the
environment's life and pipes TCP to the **internal** port (30000–31999) the service
was started on, fresh at each start. New connections wait within one startup
deadline. After delivered bytes, replay is limited to one complete, bodyless
GET/HEAD/OPTIONS request before the first response; pipelines, upgrades and
ambiguous framing are rejected. Already-answered streams are never replayed.
Activity counts both directions; readiness probes bypass the
proxy. Derived tailnet ports use a third block (32000–32767); all three sit below
the OS ephemeral range. `src/daemon/proxy.ts` owns the proxy, `ensureProxies` in
the engine owns holding and (only when a port cannot be held) moving them.

### Physical stack identity

Stack identity uses the physical project directory: symlink spellings refer to the
same stack, while separate Git worktree directories remain distinct. CLI calls
resolve paths in the caller process before RPC. Explicit holder strings stay
opaque; new implicit holders use the physical caller directory.

A verb run from a subdirectory of a worktree acts on the worktree's
environment: the implicit holder is the stack root, unless the caller's own
directory holds a live lease of its own (`callerHolder`).

A journal stamped below schema 4 is refused with an infra-error that says to
start runly 0.18 on it once first, which migrates it (decision 0042).

### The safety invariant

**runly never deletes the worktree.** Environment data may contain work that has
not been saved elsewhere. Idle stop retains it. Destruction requires confirmed
worktree removal or an explicit destructive command. Teardown removes only the
private environment directory and recorded datastore resources; it verifies the
directory lies under the state root and does not contain the worktree before removal.

## 4. Convergence, not checkpointing

runly gets the checkpointing dividend **by convergence rather than restoration**. A
checkpoint (Morph, Sprites, CRIU) freezes opaque bytes and gives back *that exact
moment*. runly keeps live environments plus layered, individually-keyed caches — the
upkeep ledger, machine-global package stores, baked DB templates, the compiler's
own incremental state — and on each bind *converges* what's there to what was asked for.

A checkpoint is a photograph; a warm environment is a kitchen already mise-en-place.

This buys three things checkpointing cannot:

1. **Arbitrary targets.** The primary request is "put my current dirty worktree in
   front of me" — a state that has never existed, so no snapshot of it can exist.
2. **Selective invalidation.** A lockfile hash busts the dependency layer; a seed hash
   busts the DB template; everything else survives. Checkpoint state is opaque.
3. **No hypervisor.** True process checkpointing does not exist on macOS. Convergence
   is the ~90% approximation with zero infrastructure demands.

The two mechanisms compose: remotely, where real checkpointing exists, the substrate
driver uses it — a remote pool is provisioned by *branching a golden snapshot*
(checkpoint-backed base) and converged the last mile by the same upkeep pass.
Local pools are convergence all the way down. Same verbs above the driver line.

## 5. Topology — local-first, nothing to deploy

- **No central service.** One **per-machine state root** (`$XDG_STATE_HOME/backlot`,
  or `BACKLOT_STATE_DIR`): a SQLite journal (environments, leases, ports, copies),
  each environment's private directory (data, logs), templates and the daemon socket.
  A stack is a worktree plus its manifest `name`, so worktrees never share an
  environment, and every holder in one worktree uses the same one.
- **A per-machine daemon, auto-spawned by the CLI on first use** (the tmux/Docker
  pattern), speaking HTTP over a unix socket. The daemon exists because processes need
  a parent: someone must supervise services, watch readiness, expire public previews, and
  quiesce idle environments while no CLI is running. Verbs fired in parallel on a
  cold machine all race to spawn it; the singleton election keeps that safe (one
  wins, losers concede, their clients fall through to the winner), but fleets
  should still warm the daemon with a cheap `runly status` before parallelizing.
  `runly daemon install` (decision 0039) puts it under a systemd user unit or a
  launchd agent instead, one per state root, which restarts it a second after a
  crash (`Restart=on-failure`, `KillMode=process`: its services outlive it as
  they always did); a CLI that finds no daemon then starts the unit rather than
  spawning one, and the election still guarantees a single daemon.
- **Concurrency lives at the environment boundary**: a short pool lock serializes
  claim/release bookkeeping; one lock per environment serializes bind/reset/token on it
  (`exec` takes it only to resume and touch the environment; the command runs in the CLI,
  decision 0040).
  A third, per-worktree lock serializes what writes into a worktree (upkeep, builds)
  between its one environment and `runly warm`, which can run with none;
  environment locks are always taken first. Different stacks bind in parallel; the
  sweeper never tears down or quiesces an environment with an operation in flight.
- **Remote execution is a design target, not an implemented backend.** Current
  services run locally in the caller's worktree.
- **Disk is truth; daemon memory is a cache.** After a daemon crash or reboot, the next
  CLI call (or the supervising unit) respawns the daemon, which reconciles: recorded processes reaped (by pid
  identity and tag), environments marked `warm`, public ports held again, and unfinished
  teardowns/copy drops retried. Leases stay; only unexpired previews are restored.
- **Team mode** (same daemon on a shared host, TCP + auth) is a possible future, not v1.

### Environment states

`hot` means services are up; `warm` means they are stopped while data remains.
Wake returns a warm environment to service. Neither state implies deletion.
`pristine` is an explicit data reset, not an automatic state transition.

**Lifecycle** ([decision 0046](decisions/0046-worktree-owned-activity-lifecycle.md)).

Environments belong to worktrees, independently of agent processes. After **5 minutes**
without activity, managed services stop; data, configuration and public ports stay.
Activity means bytes in either direction through any environment proxy port, or a
verb that uses the environment (`up`, `exec`, `token`, `preview`, `reset-data`, `down`).
Read-only commands and internal readiness probes do not count. The clock is shared
across the environment, with per-service `idle:` overrides.

New connections wake wanted services and their dependencies even after `release`,
subject to the load budget. Explicitly downed or failed services require `up`.
WebSocket messages, protocol heartbeats and server-sent events count as traffic;
a silent open connection does not. Consequently an idle stop closes silent sockets:
clients must reconnect. Run silent background work with `runly exec` (heartbeats
while its child runs), or set `idle: never`. Shared appliances remain running.

Agent death, disconnection, idle age and pool pressure never delete an environment.
A confirmed missing worktree does; inaccessible paths and filesystem errors are not
proof of deletion. Renaming a worktree removes its old path and therefore also
triggers cleanup. Explicit `destroy` and `pool recycle` remain destructive.
Environment leases never expire; `--ttl` is rejected outside `preview`. Public
previews always expire (30 minutes by default, `preview --ttl <minutes>` to change
it). Expiry closes public access, including open streams, but retains the lease
and environment. A successful `up` renews an active preview for its configured TTL. Failed `up`
calls and daemon restarts do not extend it. A successful `up` also reopens a
previously enabled preview after automatic expiry, using its saved TTL. Explicit
`preview stop`, `release`, or a forbidden-preview configuration clears that intent. `--holder-pid` on `up` is diagnostic metadata only; there is no
agent-specific automatic tether. Required caller inputs lost on release or daemon
restart must be supplied by a fresh `up` before services using them can wake.

A full machine-wide environment cap refuses creation and names `BACKLOT_POOL_MAX_TOTAL`;
raise the cap or explicitly destroy an unwanted environment. Load admission still
bounds running services and builds. Failed starts retain data; retrying never
implicitly runs `--pristine`.

Standalone database copies retain their separate lifecycle: `db with` owns a copy
for its command; `db new` can use an explicit process holder or the Claude ancestor
tether. This does not control the application environment.

Activity is journaled every five seconds, at sweeps and shutdown, then restored after restart.

**Load budget** ([decision 0036](decisions/0036-a-server-wide-load-budget.md)).
`src/daemon/budget.ts`: every bind and wake computes its need (run resources of what
it starts, plus the costliest build wave it runs; declared `resources:` or the default)
and asks `LoadBudget.admit`, a FIFO queue checked against committed resources across
every environment, Linux MemAvailable minus a reserve, and CPU saturation: Linux PSI
(`/proc/pressure/cpu` "some" at or above `cpuPressure` over both 10 s and 60 s), or
without PSI the 1-minute load above `loadPerCore` x cores. A zero need never queues; a
wake of services idle-stopped within the last hour skips the CPU gate. The build share
is released after the build phase (`Reservation.releaseBuild`), the rest when the
operation ends. `runly plan` runs the same computation without acting.

**Cleanup** ([decision 0037](decisions/0037-cleanup-by-reference-and-pool-doctor.md)).
Drop recipes are recorded on the environment row before a datastore is created;
templates restored from are recorded on rows (and, per worktree, in
`worktrees/<stack>/templates.json`) and kept, the newest per datastore and preset too,
everything else goes after a grace (a `<name>@shared` dir counts as alive while any
worktree of that name does — decision 0044); `runly pool doctor [--fix]` lists and
removes orphans that are provably runly's own.

**One environment per worktree, a machine-wide cap.** The cap gates creation;
existing environments can be reused. Cold rows still count. Creation refuses at
capacity without eviction; releasing a lease does not free a row. Explicit cleanup
or raising `BACKLOT_POOL_MAX_TOTAL` frees capacity. The load budget bounds what runs.

A database without the application is a `runly db` copy
([decision 0034](decisions/0034-additive-up-database-copies-and-ps.md)), which is not an
environment and answers to no pool cap. Every environment counts against `poolMaxTotal`.

### Journal upgrade barrier

The journal stamps its schema in `PRAGMA user_version`, and a daemon refuses a
journal stamped newer than it understands. The current schema is 5 (decision 0046): older daemons must not apply destructive lifetime policies to retained environments.

Journal schema 3 retains every observed unresolved process group in
`servicePids.*.pgid` and additional `pgids`, including groups a process leaves.
A dead recorded process does not prove these groups are empty. Retries and
recovery check every persisted group for liveness, and signal only through a
process whose identity is verified.
Failed teardown preserves a warm, retryable environment with its ownership and
capacity charge; deletion waits for confirmed reclamation, including the final
cwd scan. `pool recycle`, including `--force`, reports unreaped survivors
separately from a busy or leased environment. Run `runly doctor` to inspect
them, then retry recycling once they can be reclaimed; force does not bypass
unresolved ownership.

Schema 2 readers would discard the group fields and incorrectly release capacity,
so they must refuse a schema 3 journal. Upgrade the running daemon before using
it; do not lower `PRAGMA user_version` to bypass the barrier. Schema 3 retains
schema 2's lease preset intent and the additive physical-path identity migration.

Schema 4 ([decision 0034](decisions/0034-additive-up-database-copies-and-ps.md))
records `activeServices: []` for an environment whose lease wants no services
(a schema 3 reader would boot the whole app) and adds the `db_copies` table (a
schema 3 reader would never reap a copy), so a schema 3 daemon refuses it. Lease
preset intent is no longer read: a datastore keeps what it holds unless a bind
names a preset.

<a id="6-in-place--verbs-converge-watch-observes"></a><a id="6-sync--verbs-sync-watch-streams"></a>

## 6. In place — `up` converges the environment to the worktree

Since [decision 0032](decisions/0032-environments-run-in-the-callers-worktree.md) an
environment runs in the caller's worktree — exactly one environment per worktree — so
nothing is copied. Nothing observes the worktree either, and runly keeps no identity of
its source and no build cache: it reads only the files the upkeep rules' `when:` globs
match (§7), and a service's `build:` runs on every `up` that starts it, leaving
incrementality to the build tool — unless the build opts in to a skip with
`build: { run, when: [globs] }` ([decision 0038](decisions/0038-time-stamped-logs-and-build-skip.md)):
then it is skipped while the matched files (path, size, mtime) and the command are
unchanged since its last successful build in this worktree (`src/core/builds.ts`,
ledger `worktrees/<stack>/builds.json`; `up --rebuild` forces).

- **One environment per worktree.** A bind for a worktree always lands on its
  environment; a second holder waits for it (refused at once, naming the holder, when
  the lease outlasts the wait). The sweep recycles surplus environments an older
  journal left for one worktree.
- **`up` is the only bind verb; it is additive and restarts what a build changed**
  ([decision 0034](decisions/0034-additive-up-database-copies-and-ps.md)). The services
  a bind runs are what runs now, plus (for a continuing lease) what the lease wants —
  `EnvRow.activeServices`, undefined for every service, `[]` for none — plus the
  request's `depends_on` closure. Every `up` runs the due upkeep rules and the
  `build:` of every service it runs. The full stop/data/build/start path is taken
  when the parsed manifest differs from the last successful full bind (the
  memory-only `appliedManifests` ledger in `engine.ts`; missing entries count as
  different), caller inputs changed, an upkeep rule ran, a public port moved, the
  hygiene is `reset-data`/`pristine`, or the environment is not hot and healthy.
  Otherwise each running service's build runs between two snapshots of its declared
  `outputs:` (path, size, mtime — `snapshotOutputs` in `worktree.ts`; or a content hash
  with `outputs: { paths, compare: content }`), and only the
  services whose snapshot differs — or that declare no outputs — are stopped and
  started again (`stopServicesForRestart`, then `startSlice` over just those, with
  the rest counted as already started for `depends_on`); the services the request
  adds are built and started with them. A datastore named with `--preset` is
  reloaded while the running services that template `{{datastores.<name>.…}}` (all
  of them, when none does) are stopped. A service with no `build:` keeps running.
  Dependents of a restarted service are not restarted: its port is stable. `down`
  stops the named services (or all) under the env lock and records the smaller
  wanted set; the proxy keeps their public ports. See `tests/in-place.test.ts`,
  `tests/additive-up-and-db.test.ts`, `tests/bind-diagnostics.test.ts` and
  `tests/startup-config.test.ts`.
- **Tests see the live worktree.** There is no frozen snapshot any more: an edit made
  while the repo's tests run is visible to the services. runly runs no checks; the
  tests read the environment from `runly ctx --env` (`RUNLY_PORT_<PORT>`,
  `RUNLY_URL_<SERVICE>`, `RUNLY_DATASTORE_<NAME>_URL`,
  `RUNLY_DATASTORE_<NAME>_PRESET`, `RUNLY_LOGIN_USER`, `RUNLY_LOGIN_PASSWORD`,
  `RUNLY_ENV_ID`), or take a database copy of their own with `runly db with`.
- Nothing in the worktree is ever deleted by runly. `reset-data` restores data only;
  `pristine` clears the worktree's upkeep ledger so every upkeep rule re-runs in
  place (§8).
- Git-ignored-but-needed files (`.env.local`) declared under `sync.include` can be
  matched by an upkeep `when:` glob; `caches:` are never matched.
- `runly warm` runs an idle worktree's due command upkeep rules and its service
  builds — no lease, no services — writing the same upkeep ledger a bind reads (§7).

### Outputs — in place

Some files are regenerated by the repo's own commands but owned by the worktree (a
lockfile, a generated API client). Those commands run in the worktree, so they write
them where they belong; there is nothing to copy back. A *service's* `outputs:` is
what its build produces, which decides whether `up` restarts it.

## 7. Upkeep — the trigger ledger

Dependencies, generated code, and toolchain drift are handled by a **closed list** of
`(trigger files → action)` rules in the manifest, executed at bind time, before
build/start:

- A rule's trigger hash is the content of exactly the files its `when:` glob matches
  (git's file list filtered by the globs before anything is stat'ed). Those files'
  hashes are cached — stat-gated, racily clean — in `worktrees/<stack>/triggers.json`
  in the state root; the cache holds trigger files and nothing else.
- The ledger records the hash of each trigger *as last applied*. Command rules are
  facts about the **worktree** (`worktrees/<stack>/ledger.json`,
  shared by its environment and by `runly warm`, written under the worktree lock);
  `@` built-ins describe an **environment** and stay on its row. Comparison stays
  **direction-agnostic**, so binding *older* work also converges correctly. A rule
  drops its entry before it runs, so one that fails half-way is never vouched for.
- Builds are not part of the upkeep ledger. A service's `build:` runs on every bind
  that starts it and on every `warm`, in `depends_on` waves (one wave's builds at
  once; `builds: serial` or `build: { serial: true }` opt out); MSBuild, pnpm or the Angular CLI decide what is
  current. A `build: { run, when }` keeps its own ledger (decision 0038).
- Declare upkeep `outputs:` so missing generated/install artifacts trigger a rerun.
  Without outputs, unchanged triggers cannot detect deletion. `--pristine` clears
  the ledger but also resets data; it is not a harmless install-repair command.
- **Pool divergence is normal and harmless.** Idle worktrees are never touched by
  the daemon on its own initiative; staleness is bounded by one upkeep pass at next
  use, or by an explicit `runly warm`. Machine-global package stores
  (pnpm store, NuGet cache) make the Nth environment's install mostly hard-linking.
- **No background mutation of environments** (v1): lazy is predictable, and
  predictability is what agents need. `runly warm` is the manual, explicit form;
  scheduling it is deferred.
- **Data templates are keyed by the `create:` command string**, plus — when an
  `@rebake-template <datastore>` upkeep rule exists — the content of that rule's trigger
  files. Editing a seed script therefore yields a new template only when such a rule
  covers it (see `examples/hello-multi/runly.yml`). A template whose key matches IS
  current and is reused — by a fresh environment after `destroy` too — and a missing
  one is baked by the restore that needs it (decision 0039). A fired rule only says
  the environment's data may come from another template: the datastore is reloaded
  when `env.templates` names a different one. Only `--pristine` drops the current
  templates (of that datastore, every preset) so they are baked again.
  `@rebake-template` is the one upkeep built-in.
- **A content-keyed template is shared per manifest name** (decision 0044): with an
  `@rebake-template` key the identity is (name, datastore, preset, create command,
  trigger content) and holds nothing of the worktree path, so it lives in
  `templates/<name>@shared/`, its database is `backlot_tpl_<name>_shared_…`, and its
  lock is keyed by that dir — every worktree of the name bakes it once and restores
  from it side by side. Without a key (or with `share_templates: false`) templates stay
  in `templates/<stack id>/`. `--pristine` on a shared datastore bakes
  `<ds>-<preset>@<key>.own.baked` in the worktree's own dir, which outranks the shared
  one for that worktree while it exists. A per-worktree template with the shared one's
  file name (pre-0.20) is adopted instead of baking — its marker is copied, naming the
  same database — and is then a duplicate retention collects (the database stays while
  another marker names it; a bake never drops a database another marker names).
- Toolchain installation is the operator or manifest author's responsibility.
  Updating an SDK does not require deleting environment data.

## 8. Data — presets, templates, hygiene

A datastore is the manifest's `create:` / `drop:` / `url:` commands plus an optional
`template_restore:` (sqlite: `template: true`); see [`driver-spec.md`](driver-spec.md).
`create:` bakes a template once per template key and preset (§7); after that, data
states are restored from templates in seconds. Template changes hold a per-stack
readers-writer lock (`withBakeLock` exclusive for bake, rebake, retention and doctor;
`withTemplateRead` shared for every restore), so restores run side by side and nothing
drops a template mid-restore. A failed restore is logged (`kind: template`) and retried;
a second failure rebakes, unless the marker changed meanwhile (decision 0039) (Postgres: native
`CREATE DATABASE … TEMPLATE`; MSSQL: backup/restore; SQLite: file copy; Redis-class
stores: `ephemeral: true` — `drop:` is the flush, run on reset; `create:` runs only on
first bind; no presets or templates).

**Hygiene levels** per bind:

| Level | Meaning | Typical consumer |
| --- | --- | --- |
| `reuse` | keep every datastore's data; a store named with `--preset` is reloaded alone (see [data](overview.md#data)) | human inspect loop |
| `reset-data` | restore every datastore from its template, each with the preset it holds (or the one named), keep all build caches | agent verify loops (`up --reset-data` before the tests) |
| `pristine` | fresh private state and data; every upkeep rule and every build re-run in the worktree (nothing there is deleted) | explicit fresh-data verification |

Failed binds retain their data and require a new `up` to retry. No automatic pristine
reset occurs. A service past its crash budget is stopped and reported failed, with
or without a lease; the environment survives.

`reset-data` is also exposed mid-lease as a verb: replay your repro against pristine
data after twenty minutes of debugging mutation.

## 9. Supervision and the error taxonomy

**The daemon is the parent of every service process.** Crash detection is SIGCHLD —
instant and authoritative; no PID-reparenting guesswork, no port-health inference.
Readiness is probed (`http`, `log`, or command); declared `fatal_logs` markers fail a
boot in seconds instead of polling a dead port to timeout. Session services restart
with bounded backoff; flapping stops the service and reports it `failed`. The
environment and its data remain, with or without a lease (decision 0046).
A crash mid-bind fails the bind explicitly — never a silently wrong answer.

Every failure is classified — the field an agent branches on mechanically:

| Class | Meaning | Who acts |
| --- | --- | --- |
| `work-error` | the worktree's code is at fault (compile error, failing upkeep triggered by your change, a service that will not start) | the consumer fixes and runs `up` again |
| `env-error` | the environment is at fault (stale cache, missing toolchain, flapping service) | the consumer inspects the diagnostic, fixes the cause and retries; data is retained |
| `infra-error` | something external (backing DB down, registry unreachable) | actionable message; nobody's code is blamed |

## 10. Laptop reality

- **Sleep is a coherent pause** locally: daemon, services, and backing containers freeze
  and thaw together. On wake the daemon detects the clock jump and **pardons the gap**
  (idle clocks are adjusted; public-preview deadlines are never extended). There is no separate wake
  grace because degradation is judged only by a service's restart budget, not by a
  post-boot health poll — a slept service simply resumes. Detection is
  platform-specific: on macOS the sweeper reads the **kernel's own record**
  (`kern.sleeptime`/`kern.waketime` via sysctl) because the monotonic clock keeps
  advancing through real sleep on Apple Silicon, so clock divergence never appears
  there; on Linux it detects wall-clock outrunning the monotonic clock (which halts
  through suspend). One sleep is pardoned exactly once, and every pardon is logged
  as a `pardon` event naming the gap and the detector.
- **Leases are worktree-owned and never expire.** TTL belongs only to public previews. A holder PID is diagnostic metadata, never liveness.
- **Activity controls idle stop**, independently of leases. Traffic in either
  direction anywhere in the environment, using verbs, and exec heartbeats count.
  Read-only polling and mere process/socket existence do not.
- **Remote execution remains unimplemented.** Provider billing limits and remote
  orphan reconciliation belong to a future substrate contract, not current CLI behavior.
- **Locally, the same tagging rule applies to service processes.** Every supervised
  service is spawned carrying `BACKLOT_ENV_ID` / `BACKLOT_SERVICE` / `BACKLOT_STATE_ROOT`,
  inherited by every descendant. Pids alone are not ownership: a recorded pid may have
  been recycled by the OS, and `sh -c` frequently forks so the recorded pid is only the
  wrapper. Cleanup therefore (a) pins each pid to one process *life* via its kernel
  start time, (b) verifies the whole process **group** is gone rather than trusting that
  the leader exited, and (c) falls back to `scanTagged` — a /proc sweep by tag — for
  processes no journal row can name. `pool gc` is that sweep as a verb; recovery and the
  sweeper run it automatically. A process is only ever reclaimed when no live env
  accounts for it. The state-root tag scopes all of this, so parallel installs and
  concurrent test daemons can never reap each other.

## 11. The consumer's interface

The [CLI reference](cli.md) lists commands and flags. See [operations](operations.md)
for daemon supervision, database-copy operation, caller inputs, logs, previews and
monitoring. Reads such as `ctx`, `ps` and `stats` never count as activity.

### Configuration

Policy lives in the engine, never the manifest. Precedence per knob: environment
variable > `$STATE_DIR/config.json` > built-in default. A setting runly no longer
reads is ignored.

| Env var | config.json key | Default |
| --- | --- | --- |
| `BACKLOT_STATE_DIR` | — | `$XDG_STATE_HOME/backlot` (the per-machine root; 0700) |
| `BACKLOT_SERVICE_IDLE_MS` | `serviceIdleMs` | 5 min — environment-wide proxy traffic and using verbs; service `idle:` overrides |
| `BACKLOT_TETHER_GRACE_MS` | `tetherGraceMs` | 60 s — database-copy holder death grace only |
| `BACKLOT_TETHER` | — | `off` disables automatic Claude ancestry detection for `db new` only |
| `BACKLOT_PROXY_HOLD_MS` | — | 90 s — how long a connection is held while its service starts or wakes |
| `BACKLOT_POOL_MAX_TOTAL` | `poolMaxTotal` | With budget on: 2 x cores, clamped [4,64]; otherwise [2,8]. Bounds retained environments; never automatically evicts |
| `BACKLOT_BUDGET` | `budget.enabled` | on — `off` admits everything (decision 0036) |
| `BACKLOT_BUDGET_MEMORY` | `budget.memory` | 70 % of RAM — declared memory runly may commit at once |
| `BACKLOT_BUDGET_CPU` | `budget.cpu` | 1.5 x cores |
| `BACKLOT_BUDGET_RESERVE` | `budget.reserve` | max(2 GiB, 10 % of RAM) — Linux MemAvailable kept free after a start |
| `BACKLOT_BUDGET_CPU_PRESSURE` | `budget.cpuPressure` | 70 — Linux PSI: a start waits while runnable work stalled on the CPU at least this percent of both the last 10 s and 60 s; 100 or more turns the gate off |
| `BACKLOT_BUDGET_LOAD_PER_CORE` | `budget.loadPerCore` | 4 — without PSI (macOS): a start waits while load1 is above this x cores |
| `BACKLOT_BUDGET_WAIT_MS` | `budget.waitMs` | 10 min — longest wait in the budget queue |
| `BACKLOT_BUDGET_MAX_QUEUE` | `budget.maxQueue` | 64 waiters |
| `BACKLOT_TEMPLATE_GRACE_MS` | `templateGraceMs` | 1 h — an unreferenced, superseded template is kept this long after it was baked |
| `BACKLOT_LEASE_TTL_MS` | — | Retired and ignored; leases never expire |
| `BACKLOT_IDLE_TTL_MS` | `idleTtlMs` | Legacy heat-reporting threshold only; does not stop or delete environments |
| `BACKLOT_UNLEASED_TTL` | `unleasedTtl` | Retired and ignored; inactivity never destroys environments |
| `BACKLOT_WAIT_MS` | `waitMs` | 60 s — how long a bind waits for an environment held by another holder, or for a slot at the machine-wide cap |
| `BACKLOT_HOLDER_PID` | — | diagnostic process metadata for `up`; process lifetime for `db new` (as `--holder-pid`) |
| `BACKLOT_PORT_RANGE` | — | `20000-29999` — public ports |
| `BACKLOT_INTERNAL_PORT_RANGE` | — | `30000-31999` — the ports services listen on |
| `BACKLOT_TUNNEL_PORT_RANGE` | — | `32000-32767` — derived tailnet preview ports |
| `BACKLOT_CMD_TIMEOUT_S` | — | unset — overrides every repo-command deadline (upkeep and datastore commands 300 s, builds 600 s); also gives `exec`, which otherwise has none, a deadline (decision 0040) |
| `BACKLOT_PROXY_REPLAY_CAP_BYTES` | — | 64 MiB — client bytes all proxied connections together may hold for a replay; past it a connection is not retried (`status --json` `proxyReplayCarriedBytes`) |
| `BACKLOT_LOG_CAP_BYTES` | `logCapBytes` | 20 MB per log file, one rotation (`.log.1`) |
| `BACKLOT_TEMPLATES_KEEP` | `templatesKeep` | 1 per datastore and preset, plus every template a row references (decision 0037) |
| `BACKLOT_SWEEP_MS` | — | 15 s (lease/idle sweep cadence) |
| `BACKLOT_PREVIEW_PUBLISHER` | — | `cloudflare-quick` — the preview publisher adapter. The one knob a stack outranks: the manifest's `preview.publisher` wins over it |
| `BACKLOT_CLOUDFLARED` | — | `cloudflared` off `PATH` — the executable the Cloudflare publishers run. A launcher that forks the real tunnel must stay alive and keep it in its own process group (decision 0027) |
| `BACKLOT_TAILSCALE` | — | `tailscale` off `PATH` — the executable the tailscale publisher runs |
| `BACKLOT_PREVIEW_START_TIMEOUT_MS` | — | 45 s (wait for a quick tunnel to publish its URL) |
| `BACKLOT_RETENTION_MS` | — | 10 min (disk retention cadence) |
| `BACKLOT_RPC_TIMEOUT_MS` | — | 15 min — how long the CLI waits for one daemon answer |
| `BACKLOT_DAEMON_STOP_TIMEOUT_MS` | — | 60 s — how long `daemon stop` waits for the daemon to exit |
| `BACKLOT_SYSTEMCTL`, `BACKLOT_LAUNCHCTL` | — | `systemctl` / `launchctl` off `PATH` — what `runly daemon install` and the CLI's unit start run |

**Advertised host.** Service URLs advertise `http://localhost:…` while port
probing guarantees the IPv4 side (127.0.0.1 + wildcard). On dual-stack machines
`localhost` may resolve to ::1 first; every mainstream client (browsers, curl,
Node fetch, Python urllib) falls back to 127.0.0.1, which is why this is a
documented caveat and not a contract change (owner decision, 2026-07-19): an
IPv4-only service behind a `localhost` URL is reachable in practice, and
consumers with an exotic IPv6-only client should bind their service dual-stack.

The daemon writes a structured event log (`$STATE_DIR/events.jsonl`, size-capped)
surfaced by `status` and `doctor`.

## 12. The manifest

Use `runly.yml` or `runly.yaml`; `.yml` takes precedence when both exist.
The [manifest reference](manifest.md) describes fields and template variables;
[the schema](../schema/runly.schema.json) defines validation. Manifests describe
the app. Machine-wide caps, load gates and state paths belong to configuration.

## 13. Driver seams

Three thin interfaces (see [`driver-spec.md`](driver-spec.md) and
[`../src/drivers/types.ts`](../src/drivers/types.ts)); thinness is what "never own
compute" looks like in code.

**Substrate** (design target, not wired): `provision`, `exec`, `expose(port) → url`,
`destroy`; optional `pause/resume/checkpoint/restore`. Local supervision is built into
the engine today.

**Datastore** (`DsDriver`): `ns`, `url`, `probe`, `ensure(preset)`, `drop`, plus
`dropRecipe` and `templateRef` for cleanup by reference (decision 0037); `ephemeral`
stores implement reset as flush.

**Preview publisher** (3 verbs): `checkPrerequisite`, `start(localUrl) → {url, pid}`,
`stop(pid)` — how a leased service is published to the internet, deliberately *not* the
substrate's `expose` (decision 0027).

## 14. Scope

Runly currently supervises local worktree processes. Remote substrate drivers
remain a design target, not an available CLI feature. Historical comparisons
are in the [dated landscape review](reviews/2026-07-20-landscape.md).
Current releases are listed on [GitHub](https://github.com/ChristianKohlberg/runly/releases).

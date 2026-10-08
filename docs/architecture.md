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
| **Lease** | Temporary ownership of an environment, with a TTL or a holder process ([its life](overview.md#an-environments-life)). TTL expiry leaves the environment **warm** for the worktree's next `up`; a dead holder process tears it down. |

There is no Run noun: runly executes no checks and gives no verdicts (decision
0032). A repo runs its own tests against `runly ctx --env`.

### The two inversions everything follows from

**Environments are durable; leases are disposable.** The abandonment pathology is fixed
structurally, not by reaping harder: when a lease lapses (agent crashed, human forgot),
the environment stays with its worktree, its data and caches intact, and its services
stop on their idle clocks. When the holder is a known process, its death tears the
environment down instead ([decision 0035](decisions/0035-services-idle-on-their-own-clock-and-wake-on-demand.md)),
so nothing keeps running *for nobody*.

**Environments run in the worktree; ports never move.** The services build and run
in the caller's worktree, whose caches are already warm (.NET and pnpm caches embed
absolute paths, so a copy elsewhere would start cold;
[decision 0032](decisions/0032-environments-run-in-the-callers-worktree.md)). What
stays the environment's own is its ports (and therefore URLs, stable for its
lifetime), its datastore namespaces and its logs.

Stable ports are held, not just recorded ([decision 0033](decisions/0033-the-daemon-holds-public-ports-behind-an-l4-proxy.md)):
the daemon listens on each environment's **public** ports (20000–29999) for the
environment's life and pipes TCP to the **internal** port (30000–31999) the service
was started on, fresh at each start. A connection that arrives while its service
restarts is held until it is ready — also one the service accepted and dropped
before its first byte back (a crash the supervisor has not seen yet, a restart
under way): the proxy keeps what the client sent until the service answers and
replays it, like a refused connect — but only when no process can have acted on
it: nothing reached the process, or an idempotent HTTP request (`GET`/`HEAD`/`OPTIONS`)
carried to one relaunch at most; a `POST` or a non-HTTP stream that reached a
process is never replayed (decision 0039, corrected in 0.18.1); client bytes and the last activity time are
counted per port (`proxy` in `ctx`/`status`), and readiness probes bypass the
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

**An environment's private state never holds the only copy of anything, and runly
never deletes the worktree.** The consumer's worktree remains the sole source of truth
and is where the environment runs; the environment's own directory (data, logs) is
disposable; templates are rebuildable by definition. Every reclaim decision — lease
expiry, recycle, teardown, even losing the machine — deletes only that private
directory, and teardown checks that it lies under the state root and does not contain
the worktree before it does (decision 0032).

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
  a parent: someone must supervise services, watch readiness, expire leases, and
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
  sweeper never expires or quiesces an environment with an operation in flight.
- **Local even when compute is remote.** A Morph environment is a pool entry whose
  driver executes over SSH. The consumer's machine is the brain; substrates are muscles.
- **Disk is truth; daemon memory is a cache.** After a daemon crash or reboot, the next
  CLI call (or the supervising unit) respawns the daemon, which reconciles: recorded processes reaped (by pid
  identity and tag), environments marked `warm`, public ports held again, leases past
  their TTL ended, unfinished teardowns and copy drops retried. A restart is a non-event.
- **Team mode** (same daemon on a shared host, TCP + auth) is a possible future, not v1.

### Environment states

`hot` (services up) → `warm` (services stopped, caches intact; reached when every
service has idle-stopped) → recycled (`pristine` rebuild). Rebind from hot ≈ seconds;
from warm ≈ start + ready-wait; pristine ≈ full provision (bounded by templates and
shared caches, below).

**Lifecycle** ([decision 0035](decisions/0035-services-idle-on-their-own-clock-and-wake-on-demand.md)).
Each running service has its own idle clock: the last runly verb that USES its
environment (`up`, `reset-data`, `exec`, `token`, `preview`, `down` — reading with
`ctx`, `ps`, `plan`, `logs` or `status` is not activity, decision 0039), the last
client byte through its own public port, its own start. `ps` shows IDLE and STOPS
IN from that one clock. Past
`BACKLOT_SERVICE_IDLE_MS` (10 min; `idle:` per service) the sweeper stops it under the
environment lock; lease, data, ports and the other services stay, and `ps` says
`idle`. A connection to its public port wakes it (the proxy's wake hook → `wakeService`:
closure, appliances, datastores kept, load budget, build only if needed) and is held
until it is ready; services reach each other through public ports, so wakes chain. A
crash restart marks the port `starting` (supervisor hooks `onCrashed` / `onRelaunched` /
`onGaveUp`), and a refused forward — or one dropped before the first byte back, under
the replay rule above — is retried and held, so the self-restart gap holds connections
too. A service that crash-loops past its restart budget in a LEASED environment — or,
during a bind, fails its boot on its own account (exit, `fatal_logs`, daemonized) — is
stopped and reported `failed` (`ps`, `ctx.failures`, a `service-failed` event: last exit, `runly logs
<svc>`); the environment, its data, its other services and its logs stay, nothing
wakes it, and the next `up` starts it again (decision 0039). Only an unleased
environment is marked `degraded` and recycled for it. Activity clocks are persisted (`envs.activity`, throttled to 5 s, and
at sweep and shutdown). A lease or copy tethered to a holder process is torn down
completely once the holder has been dead for `BACKLOT_TETHER_GRACE_MS` (60 s); a live
holder renews its lease's TTL. Under Claude Code the CLI tethers to `CLAUDE_PID` when it
is a live ancestor. A worktree that is gone (or holds another stack) takes its
environment with it, leased or not; `runly destroy` does it on request.

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

**One environment per worktree, a machine-wide cap, and eviction.** A stack (one
worktree) has exactly one environment (decision 0032). `poolMaxTotal` is machine-wide,
derived from this host's cores. It gates environment **creation** only — rebinding an
existing environment is never capacity-checked — so it bounds how many environments are
*held*; the load budget bounds what runs.

That made a cold environment permanently expensive: idle reclamation quiesces *heat*,
not the environment, so the row survived and the machine-wide budget stayed full
forever. A host with as many worktrees as the heuristic allows locked out every new
stack indefinitely while nothing was running (#46). So when the machine-wide cap is
what binds, runly **evicts the least-recently-used cold environment** — unleased, not
busy, idle past `idleTtlMs` — and takes its slot. Never a leased or busy one, and never
one released recently enough to still be doing the warm pool's job; the victim pays one
cold provision on its next bind, and the eviction is logged as `pool-evict`. "Cold" here
means idle past the TTL whether or not the sweeper has quiesced it yet: the sweep only
looks every `BACKLOT_SWEEP_MS`, so a just-abandoned environment is `hot` while already
condemned, and requiring `warm` refused the caller for that whole window. Excluding cold rows from the count instead (the obvious alternative)
would have left nothing to stop N of them being rebound hot at once.

Waiting can never clear a machine-wide block — the count is of rows, and releasing a
lease leaves the row behind — so if nothing is evictable the refusal is immediate, and
names the cap that actually bound plus `BACKLOT_POOL_MAX_TOTAL` (#47).

A database without the application is a `runly db` copy
([decision 0034](decisions/0034-additive-up-database-copies-and-ps.md)), which is not an
environment and answers to no pool cap. Every environment counts against `poolMaxTotal`.

### Journal upgrade barrier

The journal stamps its schema in `PRAGMA user_version`, and a daemon refuses a
journal stamped newer than it understands. The current schema is 4.

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
- The ledger cannot see what happens to the worktree outside runly: a `node_modules`
  deleted by hand is still "applied". `--pristine` clears the worktree ledger.
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
- Toolchain-level bumps (global.json, .nvmrc) are env-recycle events, not upkeep —
  unless the repo manages toolchains declaratively (mise/asdf) via its own rule.
  runly never installs SDKs on its own initiative.

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
| `pristine` | fresh private state and data; every upkeep rule and every build re-run in the worktree (nothing there is deleted) | merge-grade proofs; auto-escalation |

Two consecutive bind failures on the same warm environment auto-escalate the next bind
to `pristine` (a per-env `failStreak` in the journal, cleared by any successful bind) —
the standard defense against stale-cache heisenbugs. Never for an environment the
caller already leases (0.18.1): pristine reloads its data, which is the holder's work.
One failed service (decision 0039) does not count as a bind failure. A service that flaps past its
restart budget marks an UNLEASED environment `degraded`: skipped by acquisition, recycled
by the sweeper. In a leased environment it is stopped and reported `failed` instead
(decision 0039). **Warm is a cache, not a home**: the pool stays honest only while
discarding any environment is cheap.

`reset-data` is also exposed mid-lease as a verb: replay your repro against pristine
data after twenty minutes of debugging mutation.

## 9. Supervision and the error taxonomy

**The daemon is the parent of every service process.** Crash detection is SIGCHLD —
instant and authoritative; no PID-reparenting guesswork, no port-health inference.
Readiness is probed (`http`, `log`, or command); declared `fatal_logs` markers fail a
boot in seconds instead of polling a dead port to timeout. Session services restart
with bounded backoff; flapping stops the service and reports it `failed` in a leased
environment, and marks an unleased one degraded for the sweeper to recycle (decision 0039).
A crash mid-bind fails the bind explicitly — never a silently wrong answer.

Every failure is classified — the field an agent branches on mechanically:

| Class | Meaning | Who acts |
| --- | --- | --- |
| `work-error` | the worktree's code is at fault (compile error, failing upkeep triggered by your change, a service that will not start) | the consumer fixes and runs `up` again |
| `env-error` | the environment is at fault (stale cache, missing toolchain, flapping service) | runly auto-remediates by recycling |
| `infra-error` | something external (backing DB down, registry unreachable) | actionable message; nobody's code is blamed |

## 10. Laptop reality

- **Sleep is a coherent pause** locally: daemon, services, and backing containers freeze
  and thaw together. On wake the daemon detects the clock jump and **pardons the gap**
  (every lease/idle deadline shifts by the sleep duration). There is no separate wake
  grace because degradation is judged only by a service's restart budget, not by a
  post-boot health poll — a slept service simply resumes. Detection is
  platform-specific: on macOS the sweeper reads the **kernel's own record**
  (`kern.sleeptime`/`kern.waketime` via sysctl) because the monotonic clock keeps
  advancing through real sleep on Apple Silicon, so clock divergence never appears
  there; on Linux it detects wall-clock outrunning the monotonic clock (which halts
  through suspend). One sleep is pardoned exactly once, and every pardon is logged
  as a `pardon` event naming the gap and the detector.
- **A lease can name its holder's process** (`--holder-pid`, `BACKLOT_HOLDER_PID`, or
  Claude Code's `CLAUDE_PID` automatically, when it is a live ancestor of the CLI). The
  default holder is a worktree PATH, and nothing about a path can die. A named process is
  checked against its start time; while it lives the lease does not expire, and once it
  has been dead for `BACKLOT_TETHER_GRACE_MS` (60 s) the environment is torn down
  (decision 0035). **This makes it a form for callers that outlive the command, and
  `--ttl` the form for other agents.** A bind naming an ALREADY-dead pid is refused
  outright (exit 64): the environment would be reclaimed while its caller was still using
  it. The pattern that produces this is `BACKLOT_HOLDER_PID=$$ runly up` from an agent
  harness, where every command gets a fresh shell, so `$$` is already gone.
- **A lease does not exempt a service from its idle clock** (decision 0035). Each service
  stops after `BACKLOT_SERVICE_IDLE_MS` without a runly verb that uses its environment or a
  client byte on its port; the lease, data and ports survive, and the next connection or
  `up` starts it again. A live agent is not activity, and neither is an agent polling
  `ctx`, `ps`, `plan`, `logs` or `status` (decision 0039).
- **Leases need no heartbeat** because losing a lease is designed to be worthless: an
  explicit `up` refreshes the TTL (`reset-data` and read-only verbs deliberately do not,
  so an idle agent that only polls `ctx` does not hold an environment forever); expiry
  leaves the environment warm; the source of truth never left the worktree. A tethered
  lease is renewed by its live holder process instead.
- **Remote is the mirror image**: the world keeps running (and billing) while the lid
  is shut. Therefore remote environments always carry **provider-side TTLs** as the
  backstop, and a long remote operation must be submit-and-poll, never a held SSH
  pipe (decision 0015's remote half). Orphan discovery:
  drivers tag instances so `pool reconcile` can adopt or reap what the journal forgot.
  Local orphans cost RAM; remote orphans cost money — the asymmetry drives the design.
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

The CLI **is** the API: every verb takes `--json`; stdout is data, stderr is human.

```
runly up [service...] [--preset [ds=]p]... [--reset-data|--pristine] [--rebuild]
         [--ttl <minutes>] [--holder-pid <pid>] [--env]   # lease; ADD services; upkeep + builds, restart what changed; --env: export lines
runly plan [service...] [--rebuild]            # what up would build/start, its cost, starts now | would wait for X
runly destroy                                  # tear down everything this worktree holds, now
runly down [service...]                        # stop just these (none = all); lease, data, ports stay
runly ctx [--env]                              # a summary; --json: the context blob (below); --env: export RUNLY_* lines
runly ps [--all]                               # services and database copies (this worktree | server)
runly db new <ds> [--preset p] | db with <ds> [--preset p] [--runly-exit N] -- <cmd...> | db ls [--all] | db drop <name>
                                               # database copies outside any environment (decision 0034)
runly warm                                     # due upkeep + builds in this worktree, no lease
runly exec <cmd...>                            # the CLI runs it in the worktree with your env + the lease's RUNLY_* (decision 0040); its exit code
runly logs [service...] [--lines N] [--since up|<dur>] [--grep re] [-f [--until re] [--timeout s]] [--build]
                                               # interleaved, time-stamped service logs (decision 0038); --until (current process only): 0, --timeout: 124
runly token [--role <r>] [--raw]               # mint a token via auth.token (role default admin)
runly reset-data [--preset [ds=]p]... | release
runly preview <service> [--ttl <minutes>] [--https-port N] | preview stop   # publish one service (below)
runly status | doctor                          # daemon, environments, budget | health and drift
runly appliance ls|start|stop [name]           # shared backing servers
runly pool ls|recycle [<env-id>] [--force]|reconcile|gc|doctor [--fix]   # doctor: orphans, dry run unless --fix
runly daemon stop                              # waits up to 60 s (BACKLOT_DAEMON_STOP_TIMEOUT_MS) until the daemon and its services are gone
runly daemon install [--print] [--env NAME]... | uninstall   # supervise the daemon (systemd user unit / launchd agent), decisions 0039, 0043
runly update [--check] [--force]               # run the INSTALLED build (below)
runly --version
# lease and copy verbs take --holder <name> (default: the caller's worktree, from any subdirectory of it)
```

**Version skew, and `update` (decision 0024).** The CLI spawns the daemon from its
own `dist/`, so installing a new runly does not replace a daemon that is already
running — it serves the old code for the rest of its life. The daemon therefore
reports its version on `ping` (which the CLI already issues on every invocation),
and a mismatch **refuses** every verb except `update`, `doctor` and `daemon stop`
with `infra-error`. It refuses rather than warns because an old daemon ignores
arguments it does not know instead of rejecting them: a new flag sent to an old
daemon is silently dropped and the verb reports success (issue #41) — a wrong result
that names the wrong subsystem.

`runly update` restarts the daemon; the autospawn then brings up the installed
build. **Leases survive**: services stop, environments go `warm`, and each holder's
next verb rebinds — the same transition the idle quiesce already performs (decision
0021), which is why a live lease is reported rather than refused. What *is* refused
is an in-flight operation (`busy` — the caller is waiting on it over this
socket) and a downgrade (an older CLI restarting a newer daemon, the direction that
can strand journal state); `--force` overrides either. runly never installs
itself — it prints the upgrade command for the detected install.

The journal stamps `PRAGMA user_version`, and a daemon **refuses to open a state
root stamped newer than it understands** rather than reading a default where the
newer build stored meaning.

Every verb accepts `--json`. Exit codes: `0` ok · `1` work-error ·
`2` env-error · `3` infra-error · `64` usage. On a failure the `--json` body is
`{ok:false, error:{class,message,…}}`. A removed verb or flag exits 64 before the
daemon is contacted, naming the decision that removed it and its replacement.

**Progress.** The long verbs (`up`, `warm`, `reset-data`) stream bind
phases (acquire → upkeep → datastore → build → start-and-ready, with an elapsed
counter on upkeep rules, builds and readiness waits). The daemon sends these as
newline-delimited `{type:"progress"}` frames ahead of the single `{type:"result"}` frame;
the CLI renders them **to stderr**, so the `--json` stdout stays one clean object. Shown
for an interactive terminal (a TTY) or with `--progress`; silent for a non-TTY/pipe/agent
or with `--quiet`. Agents are unaffected by default. Where the time went is answered
after the fact by the bind's own result: `up --json` and `reset-data --json` carry
`bindDiagnostics` — `durationMs`, `phasesMs` (queue, prepare, appliances, upkeep, stop,
data, build, ready, finalize), `reuse` (`reused` | `restarted` | `rebound`) with
`restarted`, `started`, `reloaded` and the `reasons` for a full bind, upkeep counts, and
per build its duration, whether it restarted its service and why. On a full bind the
data and build phases overlap (decision 0039), each reported with its own wall time. No command output or
caller input values appear in it.

`ctx` returns one blob with everything a consumer needs: service URLs (stable per
environment), public ports and the proxy's per-port counters, login credentials, a token-mint hook, datastore
connection strings with the preset each datastore holds, each service's state
(`running`, `stopped`, `down`), hygiene state, and recent service events. An agent holding this
blob needs nothing else from runly. `ctx --env` prints the part a test command needs as
`KEY=value` lines with stable names: `RUNLY_ENV_ID`, `RUNLY_PORT_<PORT>`,
`RUNLY_URL_<SERVICE>`, `RUNLY_DATASTORE_<NAME>_URL`, `RUNLY_DATASTORE_<NAME>_PRESET`,
`RUNLY_LOGIN_USER`, `RUNLY_LOGIN_PASSWORD` (names upper-cased, other characters as `_`; a value is
single-quoted only when a shell needs it), each as an `export` line, so
`eval "$(runly ctx --env)" && pnpm e2e` hands them to the test command. `up --env` prints
the same lines after the bind, and `exec` sets the same variables. Without `--json` or
`--env`, `up` and `ctx` print a short summary (services, URLs, datastores, login; a
tethered lease as `held by agent <pid>`, else its deadline; after `up`, what started or
restarted and the reasons for a full rebind; a failed last `up` from `lastUpFailed`).
`status` and `destroy` print a summary too; `--json` is unchanged.

**Database copies (decision 0034).** `runly db new <datastore>` restores a fresh
copy from the environments' template (baking it if missing) and prints its name,
url and preset; `runly db with <datastore> -- <cmd>` hands one to a command as
`RUNLY_DB_URL` (and `RUNLY_DB_DATABASE`, the database's name on its server;
`RUNLY_DB_COPY`/`RUNLY_DB_NAME`, the handle) and drops it when the command exits,
with its exit code. The command runs under `watchdog.js`, which holds the read end
of a pipe from the CLI: the kernel closes it however the CLI dies, and the
watchdog then stops the command (SIGTERM, SIGKILL after 3 s) — Node has no
PR_SET_PDEATHSIG. runly's own failures are marked (`runly db with:` on stderr, a
`{"runlyDbWith":…}` line with `--json`) and exit 1/2/3 or `--runly-exit N`. A copy is a `db_copies` row — written as `creating` before the restore — that
carries its holder (worktree; `--holder-pid`, or `db with`'s own CLI process) and
its drop (the templated command and where to run it, or its directory under
`<state>/dbs`). The sweeper (and recovery) drops a copy whose holder process is
gone (the same `holderGone` check a lease gets), whose worktree is gone or now
another stack, or whose creation or drop never finished; a failed drop stays on
record with a backoff. `db with` runs its command with the copy's tag
(`BACKLOT_DB_COPY`) and records its pid, start time and — without a terminal, where
it gets its own process group — its group on the row (`child`); every drop stops
what still runs against the copy first (the verified group or pid, and on Linux
every tagged process), and a `db with` copy whose CLI died goes at the next sweep,
without the tether grace (decision 0039). No TTL, no pool cap. `runly ps` lists services (state,
public and internal port, pid, idle time, when it stops for idleness, RSS from the
tagged processes; states `running`, `starting`, `idle`, `failed`, `stopped`, `down`) and
copies, for the caller's worktree or `--all`. A datastore marked `copies_only` is never
provisioned for an environment and exists only as copies (decision 0039).

**Public preview (decision 0027).** `runly preview <service>` publishes one leased
service through a preview **publisher** adapter (default: a Cloudflare quick tunnel via
`cloudflared`, an env-error when absent) and reports the URL in `ctx.previewUrls`;
`runly preview stop` ends it. It is opt-in per invocation and **scoped to the lease,
not to the service incarnation** — a restarting `up`, a rebind or an idle quiesce leaves the
tunnel up, while `release`, TTL lapse and teardown reap it. `shutdown` and crash
recovery reap the tunnel but not the publication: the lease row keeps what was
published (`preview_restore`: service, URL, public port, publisher, the settings that
pin its address), and `recover()` publishes it again once the proxy holds the ports
(decision 0045); a failure is an event and `ctx.previewRestore`. Exceptions and `previewNotice` reporting are defined by
[preview reconciliation](decisions/0027-lease-scoped-public-preview.md).
The URL is **public and unauthenticated** — see the
[security model](overview.md#security-model).

**Division of labor** (the bug-fix loop): the agent thinks, edits, greps, and commits
in its own worktree with its own harness — runly is where the code *runs*, never
where the agent *works*. Fast unit tests that need no system don't pay the broker tax
at all. Agents use the CLI; there is no MCP server
([decision 0029](decisions/0029-cli-only-agent-interface.md)).

### Configuration

Policy lives in the engine, never the manifest. Precedence per knob: environment
variable > `$STATE_DIR/config.json` > built-in default. A setting runly no longer
reads is ignored.

| Env var | config.json key | Default |
| --- | --- | --- |
| `BACKLOT_STATE_DIR` | — | `$XDG_STATE_HOME/backlot` (the per-machine root; 0700) |
| `BACKLOT_SERVICE_IDLE_MS` | `serviceIdleMs` | 10 min — a running service with no verb on its environment and no client byte on its port is stopped (decision 0035); `idle:` per service overrides |
| `BACKLOT_TETHER_GRACE_MS` | `tetherGraceMs` | 60 s — how long a holder process must stay dead before its environment or copy is torn down |
| `BACKLOT_TETHER` | — | `off` disables the automatic Claude Code tether (`CLAUDE_PID`) |
| `BACKLOT_PROXY_HOLD_MS` | — | 90 s — how long a connection is held while its service starts or wakes |
| `BACKLOT_POOL_MAX_TOTAL` | `poolMaxTotal` | With the load budget on: `2 x cores`, clamped **[4,64]** — a cap on environments HELD, machine-wide. With `BACKLOT_BUDGET=off`: `min(cores/2, memGB/4)`, clamped **[2,8]**. When this is what binds, a cold unleased env is evicted rather than the caller refused |
| `BACKLOT_BUDGET` | `budget.enabled` | on — `off` admits everything (decision 0036) |
| `BACKLOT_BUDGET_MEMORY` | `budget.memory` | 70 % of RAM — declared memory runly may commit at once |
| `BACKLOT_BUDGET_CPU` | `budget.cpu` | 1.5 x cores |
| `BACKLOT_BUDGET_RESERVE` | `budget.reserve` | max(2 GiB, 10 % of RAM) — Linux MemAvailable kept free after a start |
| `BACKLOT_BUDGET_CPU_PRESSURE` | `budget.cpuPressure` | 70 — Linux PSI: a start waits while runnable work stalled on the CPU at least this percent of both the last 10 s and 60 s; 100 or more turns the gate off |
| `BACKLOT_BUDGET_LOAD_PER_CORE` | `budget.loadPerCore` | 4 — without PSI (macOS): a start waits while load1 is above this x cores |
| `BACKLOT_BUDGET_WAIT_MS` | `budget.waitMs` | 10 min — longest wait in the budget queue |
| `BACKLOT_BUDGET_MAX_QUEUE` | `budget.maxQueue` | 64 waiters |
| `BACKLOT_TEMPLATE_GRACE_MS` | `templateGraceMs` | 1 h — an unreferenced, superseded template is kept this long after it was baked |
| `BACKLOT_LEASE_TTL_MS` | `sessionTtlMs` | 30 min — the lease TTL when `up` gives no `--ttl` |
| `BACKLOT_IDLE_TTL_MS` | `idleTtlMs` | 30 min — an unleased environment's services stop after this at the latest, and an unleased environment idle this long may be evicted for a new one |
| `BACKLOT_UNLEASED_TTL` | `unleasedTtl` | 24 h (`24h`, `90m`, seconds, or `off`) — an unleased environment nobody used this long is torn down by the sweep: services, data, ports; templates and the worktree's records stay (decision 0041) |
| `BACKLOT_WAIT_MS` | `waitMs` | 60 s — how long a bind waits for an environment held by another holder, or for a slot at the machine-wide cap |
| `BACKLOT_HOLDER_PID` | — | the holder process for `up` and `db new` (as `--holder-pid`) |
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

One file, `runly.yml`, at the repo root, validated by a published JSON Schema
([`../schema/runly.schema.json`](../schema/runly.schema.json)). Everything `{{…}}` is
injected by the engine — symbolic ports, datastore URLs, service URLs — which is what
makes environments relocatable across substrates. Services are **commands, not
containers**; backing infrastructure (a DB server) is externally run and probed.

Every command in the manifest — service `run:`/`build:`, upkeep,
datastore hooks — executes in the worktree under `sh`, which is **dash on Ubuntu and
bash-running-as-sh on macOS**, the two platforms runly tests. Write POSIX sh
only: a bashism (`[[`, arrays, `set -o pipefail`) can pass on one leg and fail
on the other with the same runly.yml.

```yaml
name: myapp
services:
  api:
    build: dotnet build backend/Host
    outputs: [backend/Host/bin/**]        # `up` restarts api only when its build changed these
    run:   dotnet run --no-build --project backend/Host
    port:  api
    env:
      ASPNETCORE_URLS: http://localhost:{{ports.api}}
      ConnectionStrings__Main: "{{datastores.main.url}}"
    ready:      { http: /health, timeout: 300 }
    fatal_logs: 'Unhandled exception|Build FAILED'
  web:
    build:                                # skipped while these files are unchanged (decision 0038)
      run: pnpm exec ng build myapp
      when: ["src/**", angular.json, pnpm-lock.yaml]
    outputs: { paths: [dist/myapp], compare: content }   # restart only when the bytes changed
    resources: { memory: 1G, cpu: 1, build: { memory: 3G, cpu: 4 } }   # the load budget (0036)
    idle: 30m                             # stop after 30 idle minutes instead of 10 (0035)
    run:   npx serve-dist dist/myapp --proxy /api={{services.api.url}}
    port:  web
    ready: { http: / }
  worker:
    run:   bundle exec sidekiq            # portless; no build:, so `up` keeps it running
    ready: { log: "Booted" }
datastores:
  main:
    driver: postgres
    server: external
    probe:  localhost:5432
    create: bin/rails db:prepare db:seed  # or any repo command; {{preset}} {{ns}} available
    presets: [dev, empty]
    template: true
    list:   psql -Atc "select datname from pg_database"   # only `runly pool doctor` reads it (0037)
  cache:
    driver: redis
    ephemeral: true                       # reset-data = flush
caches: [node_modules, "**/obj", .angular]   # output, not source; never an upkeep trigger
sync:
  include: [.env.local]                   # git-ignored, but an upkeep trigger may name it
upkeep:
  - { when: pnpm-lock.yaml, run: pnpm install --frozen-lockfile }
  - { when: "glob(db/migrate/**)", run: bin/rails db:migrate }
auth:
  logins:                                 # one object, or a list; first = primary
    - { user: qa-admin,    password: Demo!1234, role: admin, description: "all rights, all branches" }
    - { user: qa-readonly, password: Demo!1234, description: "read-only, proves a denied write" }
  token:  scripts/mint-token --role {{role}} --json
preview:
  publisher: cloudflare-quick             # which adapter `runly preview` publishes through
  # forbidden: true                       # ...or refuse public preview outright (work-error)
```

What the manifest deliberately does **not** contain: pool sizes, TTLs, budget
limits, substrate names. Those are engine policy and user config, never repo
knowledge. Every field is listed in the [README](../README.md#manifest-reference).

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

## 14. Landscape position

The 2025–26 agent-sandbox wave (E2B, Daytona, Modal, Fly Sprites, Morph) commoditized
the **substrate** — warm, persistent, checkpointable compute — and validated this
design's premises (persistence over ephemerality, checkpoint/restore as table stakes).
None of them knows what makes a VM a *working instance of your app*: the seeded data,
the auth story, the upkeep rules, the lifecycle. Dev-stack orchestrators (Tilt,
Skaffold, Garden) own hot-deploy-to-Kubernetes, not leases or data states.
By 2026 the wave consolidated: Gitpod rebranded to Ona and was acquired by OpenAI; Daytona pivoted to agent sandboxes; Neon's branch-per-agent Postgres sold to Databricks (~$1B) with most databases agent-created — data states validated as a category; kubernetes-sigs/agent-sandbox even ships literal SandboxWarmPool/SandboxClaim CRDs, cluster-side. A dated scored map lives in [reviews/2026-07-20-landscape.md](reviews/2026-07-20-landscape.md). Dagger's container-use is the nearest OSS neighbor (branch+worktree+container per
agent, git as sync) but is per-task-ephemeral, local-only, and has no data
layer.

runly is the unowned layer between them: **the repo-aware environment broker** —
buy the substrate, declare the stack, broker the environments.

## 15. Status

The local loop is complete: environments in the worktree, additive `up`/`down`, the
port proxy with idle stop and wake, the tether, the load budget, database copies,
cleanup, logs and three preview publishers, proven against the founding .NET +
Angular + MSSQL monorepo, whose Playwright suite runs against a runly environment.
The one unbuilt piece is a remote substrate driver (Morph, SSH): the daemon on the
remote box, the CLI forwarding verbs to it, provider-side TTLs and `pool reconcile`
adopting what the journal forgot. Release notes:
[GitHub releases](https://github.com/ChristianKohlberg/backlot/releases).

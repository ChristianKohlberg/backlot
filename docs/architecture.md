# runly — architecture

> **Thesis:** runly puts a working instance of a web application *in front of* a coding
> agent (or a human) — running, seeded, authenticated, provable — as a cheap, repeatable
> act. It brokers environments; it never provides them.

This document is the founding design. It was produced by working a real system
(a .NET + Angular + MSSQL monorepo with a home-grown verify harness) through every
failure mode we could think of, then generalizing. Individual decisions are recorded
in [`decisions/`](decisions/); this document is the connected whole.

### Journal upgrade barrier

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

## 3. The model — five nouns

| Noun | What it is |
| --- | --- |
| **Stack** | What a repo declares in `runly.yml`: services, datastores, seed presets, upkeep rules. The only repo-specific artifact. |
| **Substrate** | Where environments physically live, behind a driver: `local` (supervised processes in a directory), later `docker`, `morph`, `sprites`, `ssh`. |
| **Environment** | A pooled slot on a substrate: running services, allocated ports, a datastore namespace, its logs — running **in the caller's worktree**, whose caches it shares ([decision 0032](decisions/0032-environments-run-in-the-callers-worktree.md)). Durable; belongs to the pool, never to a person or task. A lease may cover a **subset** of it — a service slice (`up <service>`), or the datastores alone (`up --data-only`, [decision 0023](decisions/0023-data-only-leases.md)) for a test lane that needs a seeded database rather than an application. |
| **Binding** | A source state (the caller's worktree, as it is) plus a data state (preset, at a hygiene level) attached to the worktree's one environment. Since decision 0032 it is not a frozen snapshot: the services read the live worktree, and runly records no identity of it. |
| **Lease** | Temporary ownership of an environment; see [lease deadlines and renewal](../README.md#how-long-you-hold-it---ttl-for-agents---holder-pid-for-shells). Expiry returns the environment to the pool **warm** — nothing is torn down. |

There used to be a sixth, verb-noun: a **Run**, a named check executed against a
binding with a JSON verdict. Decision 0032 removed it: a repo runs its own tests
against `runly ctx --env`.

### The two inversions everything follows from

**Environments are durable; leases are disposable.** The abandonment pathology is fixed
structurally, not by reaping harder: when a lease lapses (agent crashed, human forgot),
the environment returns to the pool with all its heat intact. There is never anything
running *for nobody* — the pool is a fixed, intentional set.

**Environments run in the worktree; ports never move.** This used to read "watchers
never move; bindings move": each environment kept its own projected copy of the
worktree, and its dev servers watched that copy. Measured on the founding monorepo,
the copy cost a full source copy plus a second, cold set of caches per environment
(.NET and pnpm caches embed absolute paths, so they never transfer between
paths) while the agent's persistent worktree already held warm ones. Since
[decision 0032](decisions/0032-environments-run-in-the-callers-worktree.md) the
services build and run in the caller's worktree; what stays the environment's
own is its ports (and therefore URLs, stable for its lifetime), its datastore
namespace and its logs.

Stable ports are held, not just recorded ([decision 0033](decisions/0033-the-daemon-holds-public-ports-behind-an-l4-proxy.md)):
the daemon listens on each environment's **public** ports (20000–29999) for the
environment's life and pipes TCP to the **internal** port (30000–31999) the service
was started on, fresh at each start. A connection that arrives while its service
restarts is held until it is ready; client bytes and the last activity time are
counted per port (`proxy` in `ctx`/`status`), and readiness probes bypass the
proxy. Derived tailnet ports use a third block (32000–32767); all three sit below
the OS ephemeral range. `src/daemon/proxy.ts` owns the proxy, `ensureProxies` in
the engine owns holding and (only when a port cannot be held) moving them.

### Physical stack identity

Stack identity uses the physical project directory: symlink spellings refer to the
same stack, while separate Git worktree directories remain distinct. CLI calls
resolve paths in the caller process before RPC. Explicit holder strings stay
opaque; new implicit holders use the physical caller directory.

On upgrade, verified legacy alias identities migrate without changing environment
IDs, ports, datastore namespaces, data, lease IDs, or holder strings. Reconciliation
runs at recovery, holder verbs, and before ordinary retention and orphan checks.
An unreadable manifest delays migration and protects its template ownership from
ordinary pruning; renamed or unavailable sources do not prove an alias.

Old path-shaped holders are never guessed to be implicit or rewritten. A caller's
own live canonical lease takes precedence. Otherwise, a legacy directory holder
that resolves to the caller (including a symlinked subdirectory on an already
canonical stack), or whose mapping cannot be resolved, blocks the default request
with the exact `--holder` needed to inspect or release it. If aliases converge on
several leases for the same holder, Backlot refuses ambiguity and names the
environments. Recovery requires inspecting `runly status` and explicitly choosing
`runly pool recycle <envId> --force`: this destroys the selected environment and
its data and ends its lease.

Proven obsolete template directories move atomically under the bake lock into
`retired-templates/` in the state root, outside older daemons' ordinary retention.
A `.retired-stack.json` descriptor keeps cleanup discoverable after the last
environment is recycled. Retirement waits until no environment carries the old
identity and no canonical environment is busy. Namespace ownership checks across
both template roots preserve shared or ambiguous server templates, including
truncated-name collisions; ordinary retention respects those owners too.

Recovery performs no external retirement drops. Each sweep or explicit
`runly pool gc` retirement batch attempts at most one external drop, capped at
two seconds or the shorter configured command timeout. Unconfirmed drops retain
their markers and `.retirement.json` records with durable backoff; automatic
attempts stop after three failures. After repairing the appliance, run
`runly pool gc` to retry retained records despite backoff or the attempt limit;
repeat for additional pending markers. This still preserves shared or ambiguous
ownership. Ordinary retention never prunes retirement descriptors or failure
records.

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
fingerprint ledger, machine-global package stores, baked DB templates, the compiler's
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
(checkpoint-backed base) and converged the last mile by the same sync + upkeep pass.
Local pools are convergence all the way down. Same verbs above the driver line.

## 5. Topology — local-first, nothing to deploy

- **No central service.** One **per-machine state root**: a SQLite journal (pool,
  leases, bindings, ports) under the XDG state dir, and environment working
  directories under the cache dir. Pools are keyed per stack, so projects never share
  environments but all consumers of one project do.
- **A per-machine daemon, auto-spawned by the CLI on first use** (the tmux/Docker
  pattern), speaking HTTP over a unix socket. The daemon exists because processes need
  a parent: someone must supervise services, watch readiness, expire leases, and
  quiesce idle environments while no CLI is running. Verbs fired in parallel on a
  cold machine all race to spawn it; the singleton election keeps that safe (one
  wins, losers concede, their clients fall through to the winner), but fleets
  should still warm the daemon with a cheap `runly status` before parallelizing.
- **Concurrency lives at the environment boundary**: a short pool lock serializes
  claim/release bookkeeping; one lock per environment serializes bind/exec/reset on it.
  A third, per-worktree lock serializes what writes into a worktree (upkeep, builds)
  between its one environment and `runly warm`, which can run with none;
  environment locks are always taken first. Different stacks bind in parallel; the
  sweeper never expires or quiesces an environment with an operation in flight.
- **Local even when compute is remote.** A Morph environment is a pool entry whose
  driver executes over SSH. The consumer's machine is the brain; substrates are muscles.
- **Disk is truth; daemon memory is a cache.** After a daemon crash or reboot, the next
  CLI call respawns the daemon, which reconciles: env dirs present, recorded PIDs dead →
  mark envs `warm`; leases past TTL → released; orphaned run namespaces → dropped
  (pattern-guarded). A restart is a non-event.
- **Team mode** (same daemon on a shared host, TCP + auth) is a possible future, not v1.

### Environment states

`hot` (services up) → `warm` (services stopped, caches intact; reached by idle TTL) →
recycled (`pristine` rebuild). Rebind from hot ≈ seconds; from warm ≈ start + ready-wait;
pristine ≈ full provision (bounded by templates and shared caches, below).

**One environment per worktree, a machine-wide cap, and eviction.** A stack (one
worktree) has exactly one environment since decision 0032, so the old per-stack
`poolMax` bounds nothing; `poolMaxTotal` is machine-wide, derived from this host's
cores and memory. It gates environment **creation** only — rebinding an existing environment is never
capacity-checked — so the row count is what bounds worst-case concurrent load.

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

**A third ceiling, for data-only environments.** `poolMax`/`poolMaxTotal` bound
*application* environments, because the heuristic behind them measures cores and
memory — running services. A data-only environment (`up --data-only`) starts none, so
it is counted against `poolMaxDataOnly` instead: disk-shaped, machine-wide, and
charged against neither application cap. Otherwise a test lane invoked on every
integration run competes with the interactive leases people use to look at the app,
which is the contention `--data-only` existed to remove (#48).

The shape therefore lives on the environment row, and **changing it is a capacity
event**: a claim may still convert an environment between shapes — a holder switching
its own lease both ways stays supported — but only when the destination ceiling has
room, and the move is logged as `pool-shape`. Unmetered, the conversion would make the
cheap ceiling into application capacity, since reuse is never capacity-checked
(decision 0025). Eviction is bucketed for the same reason: a data-only request can
only give up a cold data-only environment.

## 6. In place — "verbs converge, watch observes"

(The heading keeps its old anchor; there is no watcher any more.)

Since [decision 0032](decisions/0032-environments-run-in-the-callers-worktree.md) an
environment runs in the caller's worktree — exactly one environment per worktree — so
nothing is copied. Nothing observes the worktree either, and runly keeps no identity of
its source and no build cache: it reads only the files the upkeep rules' `when:` globs
match (§7), and a service's `build:` runs on every `up` that starts it, leaving
incrementality to the build tool.

- **One environment per worktree.** A bind for a worktree always lands on its
  environment; a second holder waits for it (refused at once, naming the holder, when
  the lease outlasts the wait). The sweep recycles surplus environments an older
  journal left for one worktree.
- **`up` is the only bind verb, and restarts what a build changed.** Every `up` runs
  the due upkeep rules and the `build:` of every service it starts. The full
  stop/data/build/start path is taken when the parsed manifest differs from the last
  successful full bind (the memory-only `appliedManifests` ledger in `engine.ts`;
  missing entries count as different), caller inputs or presets changed, an upkeep
  rule ran, the hygiene is `reset-data`/`pristine`, the environment is not hot and
  healthy, or the requested shape differs from what runs. Otherwise each active
  service's build runs between two snapshots of its declared `outputs:` (path, size,
  mtime — `snapshotOutputs` in `worktree.ts`), and only the services whose snapshot
  differs — or that declare no outputs — are stopped and started again
  (`stopServicesForRestart`, then `startSlice` over just those, with the rest counted
  as already started for `depends_on`). A service with no `build:` keeps running.
  Dependents of a restarted service are not restarted: its port is stable. See
  `tests/in-place.test.ts`, `tests/bind-diagnostics.test.ts` and
  `tests/startup-config.test.ts`.
- **Tests see the live worktree.** There is no frozen snapshot any more: an edit made
  while the repo's tests run is visible to the services. runly runs no checks; the
  tests read the environment from `runly ctx --env` (`RUNLY_PORT_<PORT>`,
  `RUNLY_URL_<SERVICE>`, `RUNLY_DATASTORE_<NAME>_URL`, `RUNLY_LOGIN_USER`,
  `RUNLY_LOGIN_PASSWORD`, `RUNLY_ENV_ID`).
- `sync`, `bind`, `--watch`, `run`, `--detach` and `job` are removed; the CLI answers
  each with a usage error naming 0032. `watch_run` and `hot_reload` are accepted and
  ignored.
- Nothing in the worktree is ever deleted by runly. `reset-data` restores data only;
  `pristine` clears the worktree's upkeep ledger so every upkeep rule re-runs in
  place (§8).
- Git-ignored-but-needed files (`.env.local`) declared under `sync.include` can be
  matched by an upkeep `when:` glob.
- `runly warm` runs an idle worktree's due command upkeep rules and its service
  builds — no lease, no services — writing the same upkeep ledger a bind reads (§7).

### Outputs — in place

Some files are regenerated by the repo's own commands but owned by the worktree (a
lockfile, a generated API client). Those commands run in the worktree, so they write
them where they belong. The former explicit write-back (`runly pull`, `--pull`) is gone
with the copy it pulled from, and the manifest's top-level `outputs:` (which `run`
reported on) is ignored. A *service's* `outputs:` is a different thing: what its build
produces, which decides whether `up` restarts it.

## 7. Upkeep — the fingerprint ledger

Dependencies, generated code, and toolchain drift are handled by a **closed list** of
`(fingerprint → action)` rules in the manifest, executed at bind time, before
build/start:

- A rule's fingerprint is the content of exactly the files its `when:` glob matches
  (git's file list filtered by the globs before anything is stat'ed). Those files'
  hashes are cached — stat-gated, racily clean — in `worktrees/<stack>/triggers.json`
  in the state root; the cache holds trigger files and nothing else.
- The ledger records the hash of each trigger *as last applied*. Since decision 0032
  command rules are facts about the **worktree** (`worktrees/<stack>/ledger.json`,
  shared by its environment and by `runly warm`, written under the worktree lock);
  `@` built-ins describe an **environment** and stay on its row. Comparison stays
  **direction-agnostic**, so binding *older* work also converges correctly. A rule
  drops its entry before it runs, so one that fails half-way is never vouched for.
- Builds are not part of the ledger. A service's `build:` runs on every bind that
  starts it and on every `warm`; MSBuild, pnpm or the Angular CLI decide what is
  current.
- The ledger cannot see what happens to the worktree outside runly: a `node_modules`
  deleted by hand is still "applied". `--pristine` clears the worktree ledger.
- **Pool divergence is normal and harmless.** Idle worktrees are never touched by
  the daemon on its own initiative; staleness is bounded by one upkeep pass at next
  use, or by an explicit `runly warm`. Machine-global package stores
  (pnpm store, NuGet cache) make the Nth environment's install mostly hard-linking.
- **No background mutation of environments** (v1): lazy is predictable, and
  predictability is what agents need. `runly warm` is the manual, explicit form;
  scheduling it is deferred.
- **Data templates are keyed by the `create:` command string, not by seed *content***
  (v1's honest limitation): editing a seed script does not auto-invalidate the template.
  Declare an `@rebake-template <datastore>` upkeep rule triggered on the seed files to
  invalidate it (see `examples/hello-multi/runly.yml`). Content-hash keying is planned;
  until then that upkeep rule is the mechanism.
- Toolchain-level bumps (global.json, .nvmrc) are env-recycle events, not upkeep —
  unless the repo manages toolchains declaratively (mise/asdf) via its own rule.
  runly never installs SDKs on its own initiative.

## 8. Data — presets, templates, hygiene

Datastore drivers expose `create(ns, preset)` / `drop(ns)` / `url(ns)` plus optional
`template_bake` / `template_restore`. Re-seeding runs once per seed-content hash; after
that, data states are restored from templates in seconds (Postgres: native
`CREATE DATABASE … TEMPLATE`; MSSQL: backup/restore; SQLite: file copy; Redis-class
stores: `ephemeral: true` — `drop:` is the flush, run on reset; `create:` runs only on
first bind; no presets or templates).

**Hygiene levels** per bind:

| Level | Meaning | Typical consumer |
| --- | --- | --- |
| `reuse` | retain compatible state; see [preset selection](../README.md#choosing-datastore-presets) | human inspect loop |
| `reset-data` | restore data template, keep all build caches | agent verify loops (`up --reset-data` before the tests) |
| `pristine` | fresh private state; every upkeep rule re-runs in the worktree (nothing there is deleted; builds run on every `up` anyway) | merge-grade proofs; auto-escalation |

Two consecutive bind failures on the same warm environment auto-escalate the next bind
to `pristine` (a per-env `failStreak` in the journal, cleared by any successful bind) —
the standard defense against stale-cache heisenbugs. A service that flaps past its
restart budget marks its environment `degraded`: skipped by acquisition, auto-reaped by
the sweeper. **Warm is a cache, not a home**: the pool stays honest only while
discarding any environment is cheap.

`reset-data` is also exposed mid-lease as a verb: replay your repro against pristine
data after twenty minutes of debugging mutation.

## 9. Supervision and the error taxonomy

**The daemon is the parent of every service process.** Crash detection is SIGCHLD —
instant and authoritative; no PID-reparenting guesswork, no port-health inference.
Readiness is probed (`http`, `log`, or command); declared `fatal_logs` markers fail a
boot in seconds instead of polling a dead port to timeout. Session services restart
with bounded backoff; flapping marks the environment degraded → recycled on release.
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
- **A lease can name its holder's process** (`--holder-pid`, `BACKLOT_HOLDER_PID`). The default holder is a worktree PATH, and nothing
  about a path can die — so a crashed agent held its environment for the whole TTL. A named
  process is checked against its start time, and a dead holder's lease is released in seconds.
  **This makes it a form for callers that outlive the command, and `--ttl` the form for
  agents.** A bind naming an ALREADY-dead pid is refused outright (exit 64), because such a
  lease is released by the next sweep: the environment would go back in the pool while its
  caller was still using it, and the next bind — another agent, perhaps on a different
  preset — would hand that caller a different, unseeded store through the same URL.
  The pattern that produced this in the field was `BACKLOT_HOLDER_PID=$$ runly up` from an
  agent harness, where every command gets a fresh shell, so `$$` is already gone. It presented
  as a stale seed template and cost hours in the wrong subsystem; refusing at bind time is
  the whole fix.
- **A lease no longer exempts an environment from reclaiming HEAT.** Holding one used to keep
  services (and their memory) alive for the full TTL even if nothing had touched the
  environment since the bind. Now a leased env that goes untouched past `leasedIdleTtlMs`
  quiesces to warm: the lease survives, only the services stop, and the next verb rebinds.
  "Untouched" counts real use — `exec`, `ctx`, `logs` — not just binds, so an actively
  worked environment is never quiesced underneath its agent.
- **Leases need no heartbeat daemon** because losing a lease is designed to be
  worthless: an explicit `up` refreshes the TTL (`reset-data` and read-only verbs deliberately do not,
  so an idle agent that only polls `ctx` does not hold an environment forever);
  expiry returns the env warm; the source
  of truth never left the worktree. Agents that vanish cost nothing.
- **Remote is the mirror image**: the world keeps running (and billing) while the lid
  is shut. Therefore remote environments always carry **provider-side TTLs** as the
  backstop, and a long remote operation must be submit-and-poll, never a held SSH
  pipe (decision 0015's remote half; its local `run --detach` was removed in 0032). Orphan discovery:
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
runly up [--reset-data|--pristine] [--ttl <minutes>]  # lease; upkeep + builds, restart what changed
runly ctx [--env]                              # the context blob (below); --env: RUNLY_* lines
runly warm                                     # due upkeep + builds in this worktree, no lease
runly exec <cmd...>                            # run anything in the worktree, with the lease's env
runly logs <service> [--lines N]               # supervised service logs
runly token --role <r>                         # mint a token via auth.token
runly reset-data | release
runly preview <service> [--ttl <minutes>] | preview stop   # publish one service publicly (below)
runly status | doctor                          # pool state | active health check
runly pool ls|recycle [--all]|reconcile|gc|doctor
runly daemon stop                              # waits until the daemon and its services are gone (README)
runly update [--check] [--force]               # run the INSTALLED build (below)
runly --version
```

**Version skew, and `update` (decision 0024).** The CLI spawns the daemon from its
own `dist/`, so installing a new runly does not replace a daemon that is already
running — it serves the old code for the rest of its life. The daemon therefore
reports its version on `ping` (which the CLI already issues on every invocation),
and a mismatch **refuses** every verb except `update`, `doctor` and `daemon stop`
with `infra-error`. It refuses rather than warns because an old daemon ignores
arguments it does not know instead of rejecting them: `up --data-only` against a
pre-0.9.0 daemon boots the whole application and reports success, which is issue
#41's shape — a wrong result that names the wrong subsystem.

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
`{ok:false, error:{class,message,…}}`. The verbs and flags decision 0032 removed
(`sync`, `bind`, `pull`, `run`, `job`, `--watch`, `--detach`, `--pull`, `--ref`) exit
64 naming it, before the daemon is contacted.

**Progress.** The long verbs (`up`, `warm`, `reset-data`) stream bind
phases (acquire → upkeep → datastore → build → start-and-ready, with an elapsed
counter on upkeep rules, builds and readiness waits). The daemon sends these as
newline-delimited `{type:"progress"}` frames ahead of the single `{type:"result"}` frame;
the CLI renders them **to stderr**, so the `--json` stdout stays one clean object. Shown
for an interactive terminal (a TTY) or with `--progress`; silent for a non-TTY/pipe/agent
or with `--quiet`. Agents are unaffected by default. Where the time went is answered
after the fact by the bind's own result, not by progress: see "Understanding a slow
bind" in the README for `bindDiagnostics`.

`ctx` returns one blob with everything a consumer needs: service URLs (stable per
environment), public ports and the proxy's per-port counters, login credentials, a token-mint hook, datastore
connection strings, hygiene state, and recent service events. An agent holding this
blob needs nothing else from runly. `ctx --env` prints the part a test command needs as
shell-exportable lines with stable names: `RUNLY_ENV_ID`, `RUNLY_PORT_<PORT>`,
`RUNLY_URL_<SERVICE>`, `RUNLY_DATASTORE_<NAME>_URL`, `RUNLY_LOGIN_USER`,
`RUNLY_LOGIN_PASSWORD` (names upper-cased, other characters as `_`; a value is
single-quoted only when a shell needs it) — `eval "$(runly ctx --env)" && pnpm e2e`.

**Public preview (decision 0027).** `runly preview <service>` publishes one leased
service through a preview **publisher** adapter (default: a Cloudflare quick tunnel via
`cloudflared`, an env-error when absent) and reports the URL in `ctx.previewUrls`;
`runly preview stop` ends it. It is opt-in per invocation and **scoped to the lease,
not to the service incarnation** — a restarting `up`, a rebind or an idle quiesce leaves the
tunnel up, while `release`, TTL lapse, teardown, `shutdown` and crash recovery all reap
it. Exceptions and `previewNotice` reporting are defined by
[preview reconciliation](decisions/0027-lease-scoped-public-preview.md).
The URL is **public and unauthenticated** —
see README §Security model.

**Division of labor** (the bug-fix loop): the agent thinks, edits, greps, and commits
in its own worktree with its own harness — runly is where the code *runs*, never
where the agent *works*. Fast unit tests that need no system don't pay the broker tax
at all. See the [README](../README.md#quickstart) for the agent interface and migration
from the former adapter, and [decision 0029](decisions/0029-cli-only-agent-interface.md)
for the removal decision.

### Configuration

Policy lives in the engine, never the manifest. Precedence per knob: environment
variable > `$STATE_DIR/config.json` > built-in default. The per-stack ceiling
(`BACKLOT_POOL_MAX` / `poolMax`) and the run, artifact and job knobs were removed by
decision 0032; a leftover setting is ignored.

| Env var | config.json key | Default |
| --- | --- | --- |
| `BACKLOT_STATE_DIR` | — | `$XDG_STATE_HOME/backlot` (the per-machine root; 0700) |
| `BACKLOT_LEASED_IDLE_TTL_MS` | `leasedIdleTtlMs` | `2 x idleTtlMs` — a LEASED but untouched env stops its services (keeps the lease) |
| `BACKLOT_POOL_MAX_TOTAL` | `poolMaxTotal` | `min(cores/2, memGB/4)`, clamped **[2,8]**, **machine-wide across every stack**, application envs only. When this is what binds, a cold unleased env is evicted rather than the caller refused |
| `BACKLOT_POOL_MAX_DATA_ONLY` | `poolMaxDataOnly` | `max(4, 2 x heuristic)` — data-only envs, machine-wide, counted against neither application cap (decision 0025) |
| `BACKLOT_LEASE_TTL_MS` | `sessionTtlMs` | 30 min |
| `BACKLOT_IDLE_TTL_MS` | `idleTtlMs` | 30 min |
| `BACKLOT_WAIT_MS` | `waitMs` | 60 s (queue-at-capacity timeout; also bounds a shape change waiting on an operation in flight on the holder's own environment) |
| `BACKLOT_LOG_CAP_BYTES` | `logCapBytes` | 5 MB |
| `BACKLOT_TEMPLATES_KEEP` | `templatesKeep` | 4 per stack |
| `BACKLOT_SWEEP_MS` | — | 15 s (lease/idle sweep cadence) |
| `BACKLOT_PREVIEW_PUBLISHER` | — | `cloudflare-quick` — the preview publisher adapter. The one knob a stack outranks: the manifest's `preview.publisher` wins over it |
| `BACKLOT_CLOUDFLARED` | — | `cloudflared` off `PATH` — the executable that publisher runs. A launcher that forks the real tunnel must stay alive and keep it in its own process group (README, "A preview URL that is still valid tomorrow") |
| `BACKLOT_PREVIEW_START_TIMEOUT_MS` | — | 45 s (wait for a quick tunnel to publish its URL) |
| `BACKLOT_RETENTION_MS` | — | 10 min (disk retention cadence) |

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
datastore hooks — executes under `sh`, which is **dash on Ubuntu and
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
    build: pnpm exec ng build myapp
    outputs: [dist/myapp]                 # a directory: everything under it
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
# no checks: — the repo's tests run themselves: eval "$(runly ctx --env)" && pnpm e2e
preview:
  publisher: cloudflare-quick             # which adapter `runly preview` publishes through
  # forbidden: true                       # ...or refuse public preview outright (work-error)
```

What the manifest deliberately does **not** contain: pool sizes, TTLs, capacity math,
substrate names. Those are engine policy and user config, never repo knowledge.

## 13. Driver seams

Three thin interfaces (see [`driver-spec.md`](driver-spec.md) and
[`../src/drivers/types.ts`](../src/drivers/types.ts)); thinness is what "never own
compute" looks like in code.

**Substrate** (~6 verbs + capabilities): `provision`, `exec`, `gitEndpoint`,
`expose(port) → url`, `destroy`; optional `pause/resume/checkpoint/restore`. The engine
degrades gracefully — local has no checkpoint; Morph/Sprites do.

**Datastore** (~5 verbs + capabilities): `create(ns, preset)`, `drop(ns)`, `url(ns)`;
optional `templateBake/templateRestore`; `ephemeral` stores implement reset as flush.

**Preview publisher** (3 verbs): `checkPrerequisite`, `start(localUrl) → {url, pid}`,
`stop(pid)` — how a leased service is published to the internet, deliberately *not* the
substrate's `expose` (decision 0027).

## 14. Landscape position

The 2025–26 agent-sandbox wave (E2B, Daytona, Modal, Fly Sprites, Morph) commoditized
the **substrate** — warm, persistent, checkpointable compute — and validated this
design's premises (persistence over ephemerality, checkpoint/restore as table stakes).
None of them knows what makes a VM a *working instance of your app*: the seeded data,
the auth story, the upkeep rules, the verdict contract. Dev-stack orchestrators (Tilt,
Skaffold, Garden) own hot-deploy-to-Kubernetes, not leases, data states, or verdicts.
By 2026 the wave consolidated: Gitpod rebranded to Ona and was acquired by OpenAI; Daytona pivoted to agent sandboxes; Neon's branch-per-agent Postgres sold to Databricks (~$1B) with most databases agent-created — data states validated as a category; kubernetes-sigs/agent-sandbox even ships literal SandboxWarmPool/SandboxClaim CRDs, cluster-side. A dated scored map lives in [reviews/2026-07-20-landscape.md](reviews/2026-07-20-landscape.md). Dagger's container-use is the nearest OSS neighbor (branch+worktree+container per
agent, git as sync) but is per-task-ephemeral, local-only, and has no data/verdict
layer.

runly is the unowned layer between them: **the repo-aware environment broker** —
buy the substrate, declare the stack, broker the environments.

## 15. Milestones

1. **0.1 — the local loop. ✅ SHIPPED.** Daemon, CLI, local substrate, sqlite driver
   with template restore, verbs `up/run/sync/ctx/exec/logs/reset-data/pull/release/
   status/pool/daemon`. Both examples green through the real CLI (35 tests), including
   crash recovery and lease expiry. (postgres moved to 0.2 with mssql — shipping an
   untested driver would have violated the honesty bar.)
2. **0.2 — first real consumer. ✅ SHIPPED.** The command-datastore family
   (postgres/mssql/mysql — ALL mechanics repo-declared commands, zero embedded DB
   clients) with template bake + restore, proven against a live dockerized Postgres
   (native `createdb -T` restore) AND against the founding monorepo: a full .NET +
   MSSQL vertical (seeded per-env database on the shared server, built host, real
   login, real seeded domain data over an authenticated API) came up through
   `runly up` in ~50 s; `runly run` provisioned a second full environment in
   ~48 s. The consumer's Playwright system-e2e suite ran as a runly check
   (`runly run e2e`, ~58 s incl. provisioning via PLAYWRIGHT_REUSE against the
   runly-provisioned servers) with verdict parity against the incumbent harness —
   identical pass/fail results on the same suite.
3. **0.3 — remote. ◐ PARTIAL.** Detached submit-and-poll runs shipped (`run
   --detach` → jobId; the verdict outlives the client, journaled — removed again in
   0.13 with `run` itself, decision 0032). Driver spec
   stable. NOT yet: a live remote substrate driver (morph/ssh) — that requires
   threading the fs/exec seam through sync/supervision (the honest remaining work
   package) and is the one unshipped piece of the roadmap.
4. **0.4 — public-ready. ✅ CORE SHIPPED.** The generality gate passed with a
   deliberately-foreign consumer (stdlib-Python + sqlite — different runtime, same
   verbs); the MCP adapter shipped as a thin stdio wrapper over the same daemon RPC
   (`backlot-mcp`), protocol-tested; it was later removed by decision 0029. Remaining before an actual announce: the remote
   substrate (0.3's tail), npm publish, and a docs site.

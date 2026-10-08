# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Build & test

- Build: `npm run build` (cleans `dist/`, then compiles TypeScript; required before running tests)
- Test: `npm test` runs vitest over all files in `tests/`; tests use the compiled `dist/cli/index.js`
- Single file: `npm test -- tests/foo.test.ts`
- The suite runs in one private TMPDIR (`tests/support/global-setup.ts`) and FAILS if any process with a state root under it survives the run. Dispose of a state root only through `disposeState`/`disposeStateSync` (`tests/support/leaks.ts`: daemon SIGTERM and wait → kill what still carries the tag → rm). SIGKILLing the daemon and deleting its state dir is what used to leak services. `tests/support/setup-env.ts` drops `CLAUDE_PID` (no auto-tether in tests) and opens the budget's machine gates. On a shared box set `TMPDIR` to a filesystem with free inodes.

## Architecture notes

See `docs/` for decision log. Key files:
- `src/daemon/engine.ts` — pool + lease + bind orchestration (the core)
- `src/daemon/supervisor.ts` — per-env process supervision, `killGroupVerified`, `reapPids`
- `src/core/procscan.ts` — `scanTagged` (Linux-only /proc scan by BACKLOT_ENV_ID tag)
- `src/core/journal.ts` — SQLite journal (disk is truth)

## Service process lifecycle & teardown sharp edges

Services are spawned detached (`detached: true` in `spawn`) so they outlive the daemon intentionally — this is the crash-recovery contract. The BACKLOT tag (`BACKLOT_ENV_ID`, `BACKLOT_SERVICE`, `BACKLOT_STATE_ROOT`) is injected into every service's environment and inherited by grandchildren; `scanTagged` uses it to find orphans even after the process moved to a new session.

Consequence: a group kill (`killGroupVerified`) is not sufficient teardown — a service that called `setsid()` or spawned a detached grandchild escapes the `-pgid` signal and can keep holding its port. `stopAll()` must therefore always be followed by a reap of journal-recorded pids plus a tag scan before trusting any port-free check. **Every `stopAll()` call site is bound by this** — `bindAndStart`, `teardownClaimed`, the idle stop (`stopIdleServices` → `stopServicesForRestart`), and `shutdown()`. Deferring the reap to "the next bind will handle it" is the bug (#34): a quiesced env can sit cold for hours, and a stopping daemon has no next anything. `reapEnvProcesses` in `src/daemon/engine.ts` owns this invariant (see its doc comment for the failure modes and the survivor-preservation contract); `tests/env-port-survivor.test.ts` and `tests/agent-lease-and-recycle.test.ts` are the regression tests. Crash recovery follows the same rule: `recover()` reaps recorded pids for every journaled env and re-runs `teardownClaimed` for `state='recycling'` rows.

Supervision initially records top-level service pids; reclamation also records discovered survivors. `reapPids` in `src/daemon/supervisor.ts` owns their identity and group-preservation contract. For anything that also scrubbed the tag, `reapEnvTree` reaps by cwd (`scanByCwd`, which matches a `(deleted)` cwd too) — but only inside the env's PRIVATE directory and only at teardown. Services run in the caller's worktree (decision 0032), and cwd there is never ownership: the agent's shells and builds sit in it. Never point a cwd scan at a worktree.

## Environments run in the caller's worktree — one per worktree, `up` only, no build cache, no checks

Decision 0032 removed the projection: services, builds, upkeep, `exec` and `auth.token` all run in the stack root. It also removed `sync`/`bind`, `--watch`, `run`/`--detach`/`job` (with the jobs journal and verdict artifacts), the manifest's `checks:` and the per-stack `BACKLOT_POOL_MAX`; the CLI answers each with exit 64 naming 0032 before the daemon is contacted. Sharp edges:

- **Never delete in the worktree.** Teardown removes only `env.root`, and `isPrivateEnvDir` checks it is under `envs/` and does not contain `env.stackRoot` first. `reset-data` touches data only; `pristine` clears the worktree's upkeep LEDGER (re-run every rule), never files.
- **One environment per worktree.** `tryClaim` creates an environment only when the stack has none; a second holder queues for it, and `worktreeHold` makes the refusal structural (fail fast, naming the holder) when the lease outlasts the wait. Never reintroduce a second environment for a stack; `drainSurplusEnvs` recycles the ones an older journal left.
- **runly caches no builds unless asked, and `up` restarts only what a build changed.** There is no `@source`, no source fingerprint: a plain `build:` runs on every `up` that starts its service (and on every `warm`). The one opt-in exception is `build: {run, when}` (decision 0038, `src/core/builds.ts`): skipped while the `when:` files (path+size+mtime) and the command match the last SUCCESSFUL build, ledger `worktrees/<stack>/builds.json`, entry dropped before the build runs. Always go through `buildService`/`buildDecision`, never `runServiceBuild` directly, or the ledger and the build log are bypassed. When nothing forces the full path (manifest, inputs, upkeep that ran, hygiene, health, a moved port), `bindAndStart` builds each running service between two `snapshotOutputs` calls (`src/core/worktree.ts`: path, size, mtime of the service's `outputs:` globs) and restarts only those whose snapshot differs — or which declare no outputs — via `stopServicesForRestart` + `startSlice(only)`. A service without `build:` is never restarted there, and dependents of a restarted service are not either. `bindDiagnostics.reuse` is `reused` | `restarted` | `rebound`.
- **Upkeep reads only its trigger files.** `triggerSet` (`src/core/upkeep.ts`) lists the files the `when:` globs match and hashes them, stat-gated, with a small cache in `worktrees/<stack>/triggers.json`. Keep it scoped to trigger files — a whole-worktree hash is exactly what was removed.
- **The upkeep ledger is the worktree's.** Command rules live in `worktrees/<stack>/ledger.json` (`src/core/tree-ledger.ts`); `@` built-ins stay on the env row. `warm` writes the same ledger a bind reads.
- **Lock order: env lock first, then the worktree lock (`treeLocked`).** (The template lock is taken inside either, never around them.) Binds take the env lock then the worktree lock around upkeep and builds; `warm` takes the stack's env lock(s) (`envsLocked`) then the worktree lock — it can run before any env exists, which is why the worktree lock is still needed. Taking them the other way round deadlocks against a bind.
- `tests/in-place.test.ts` (no copy, teardown leaves the worktree, warm, one env per worktree, output-based restarts, surplus drain) and `tests/worktree.test.ts` (trigger enumeration and hashing) are the regression tests.

## Public ports are held by the daemon's proxy; services listen on internal ports

Decision 0033: `src/daemon/proxy.ts` (`ProxyHub`) listens on every environment's public ports (127.0.0.1 + ::1) for the environment's life and pipes TCP to the internal port the service was started on (fresh per start, `allocInternalPort`). Sharp edges:

- **Only a service's own `{{ports.<its key>}}` is internal** (`templateCtx(stack, env, own)`). Every other consumer — other services, builds, `exec`, `ctx`, preview — gets the public port; `{{public_ports.x}}` is always public. Readiness probes use the internal URL so they never count as activity.
- **The engine drives the proxy state:** `markStarting` before a stop that a start will follow, `proxy.up` after `waitReady`, the supervisor's `onStopped` → `serviceStopped` (leaves `starting` alone), and `bindAndStart`'s `finally` → `settle` (a failed bind closes held connections). A new stop/start path must keep this, or clients are refused or held until timeout.
- **`ensureProxies` is the only place a public port moves** (outside the public block = a 0.13 journal; or `PortInUse`). It runs in `recover()` after the gc and at every bind; a move forces a full bind. Listeners close only in `teardownClaimed` (after `deleteEnv`) and `shutdown()`.
- **Lifecycle hooks (decision 0035):** the wake hook (`requestWake` → `wakeService`) starts a stopped, wanted service of a leased env on its first connection; the supervisor hooks `onCrashed` (port → `starting`), `onRelaunched` (probe internal port → `up`) and `onGaveUp` (→ `down`) cover the crash gap; a refused forward is retried/held until the hold deadline (`Target.refused`). A wake must never take the pool lock or a second env lock (it runs under `envLocked`), and a service whose readiness needs another idle service must be in its `depends_on` or the two wait on each other.
- Activity (`noteActivity`) is persisted to `envs.activity` throttled (5 s), at every sweep and at `shutdown()`, and seeded back into the proxy by `recover()`. `lifecycle.test.ts` covers idle stop, wake, chained wake, the crash gap, persisted activity and the teardowns.
- Counters are in memory, per daemon life. `tests/proxy.test.ts` covers hold-across-restart, byte counting, WebSockets, block allocation, recovery re-bind, a foreign squatter and the 0.13 migration.

## Publishers own their dialect — the engine must not learn one

`preview.publisher` selects an adapter; `src/drivers/preview.ts` holds the
registry. `start()` receives the manifest's `preview` block verbatim as
`settings`, and the **publisher** turns that into an address. Do not move
hostname derivation into the engine to save an argument: `cloudflare-quick`
cannot accept a hostname at all, and the next adapter will want a port or a
socket. That is what makes it a seam rather than one publisher with extra steps
([decision 0028](docs/decisions/0028-named-preview-hostnames.md)).

`cloudflare-named` creates a tunnel and a DNS record per `<prefix, service>` and
**reuses** them across leases — `stop()` kills only the process. That is
deliberate: the surviving name is the entire reason to use it, and a per-lease
tunnel would churn objects in the operator's account and add a second lifecycle
to reap. Its prerequisite is heavier than the quick publisher's (an origin
certificate from `cloudflared tunnel login`, not just the binary), and
`checkPrerequisite` names that command because "unauthorized" from a tunnel
create is not something an operator can act on.

A wildcard record was considered and **rejected**: it binds the whole zone to
one tunnel, which forces one shared cloudflared process for every previewed
service — and a shared process cannot honour 0027's `stop()` contract, because
the pid another publication still references may not be killed.

## `tailscale` serves in the foreground, as the operator — never `--bg`, never sudo

The `tailscale` publisher runs `tailscale serve --https=<port> <url>` WITHOUT
`--bg`. A foreground serve config dies with the process (SIGTERM and SIGKILL
alike, measured on 1.102), which is what lets the lease-scoped preview machinery
reap the URL by reaping a pid. Do not "fix" it to `--bg`: that writes persistent
config nothing in the journal can name again. Do not wrap it in sudo either —
`use_pty` moves the command out of the process group and `env_reset` strips the
runly tags, so a SIGKILLed sudo leaves an unreapable live serve. The machine's
tailscale operator must be the daemon's user (`tailscale set --operator=…`);
`checkPrerequisite` says so ([decision 0031](docs/decisions/0031-tailscale-preview-publisher.md)).

## `cloudflared tunnel route dns` can succeed for the wrong hostname

**`cloudflared tunnel route dns` reports success for the WRONG hostname.** An
origin certificate authorises exactly one zone; ask for a name outside it and
cloudflared treats the whole thing as a label *inside* the cert's zone, creates
`your.name.the-cert-zone.com`, prints `Added CNAME …` and exits 0. runly then
hands back an address that resolves nowhere. This bit on the first real setup and
was caught only because someone happened to run `dig`. `assertRouted` compares
the name in the output against the one requested — and `cf()` therefore returns
**stderr as well as stdout**, because that is the stream cloudflared says it on.
Do not "simplify" `cf()` back to `execFileSync`: the check would read an empty
string and wave every mismatch through. It passes when the output names no
hostname at all, deliberately — the wording has changed between cloudflared
versions, and refusing an unrecognised success would break publishing for
versions we have not seen.

## The preview tunnel is scoped to the lease, not to the services it publishes

`runly preview` journals its tunnel on the **lease row** (`preview_*`), not in
`env.servicePids` — so none of the service-reap machinery above owns it, and the
lifetime rule is deliberately different ([decision 0027](docs/decisions/0027-lease-scoped-public-preview.md)).
A rebind, a restarting `up` or an idle quiesce restarts or stops services while the lease
continues, and the tunnel **survives all of them**; ports are stable for an
environment's lifetime, so it is aimed at the same place when the services return.
It is reaped only when the lease ends (`release`, TTL lapse, dead holder, the
sweeper's torn-row prune), at `teardownClaimed` (before `deleteEnv` drops the row
that names it), at `shutdown()`, and in `recover()`.

The sharp edge: because the tunnel outlives service restarts, the tag-based
reclaim paths must **skip it** — `reapEnvProcesses`' scan filters out the process
group the env's live lease records, and `poolGc` skips every leased one. Do NOT
"simplify" those filters away: without them Linux shoots the tunnel at a boundary
where macOS keeps it, and that platform split is the whole bug class this feature
had to close, and all three of them (`pool gc`, the scan, doctor's orphan report)
must agree on `leasedPreviewPids(tagged)` or one will act on what another calls
healthy. That classifier exempts the verified leader's whole tagged process group
(a launcher's same-group tunnel child included), never a bare pid or a `preview:`
label, and `setsid` descendants are outside it — the contract is in
[decision 0027](docs/decisions/0027-lease-scoped-public-preview.md) and
`tests/preview-process-group.test.ts` is the regression test.

`reconcilePreviewForBind` owns what a bind **and a reusing `up`**
do to a live tunnel: it tears it
down when `preview.forbidden` appears, when the previewed service leaves the
running set (a `runly down` — nothing brings it back this lease), or when its local port moves (a full bind only — a reuse allocates
nothing, and it judges the slice by the env's durable shape, not by live pids);
the slice and port causes are reconciled at the bind's **epilogue**, once the
shape they judge against is committed, while `forbidden` is enforced up front so
a failed bind cannot leave a stack published; `--reset-data`/`--pristine` keeps it and
warns that the *same* public URL now serves *new* data. It **never throws** — the
bind is legitimate — and the message rides back on the bind's own result as
`previewNotice`, not through shared state a later `ctx` read could drain first.
Both preview verbs re-read the lease *inside* `envLocked`, `clearLeasePreview` is
a compare-and-swap on the pid, and `endLease` re-reads between the stop and the
delete (it cannot take the env lock — `tryClaim` calls it under the pool lock),
so no stale snapshot can forget a tunnel someone else just published. `tests/preview-tunnel.test.ts`
covers all of it.

For the successful-bind configuration ledger and refresh/reuse eligibility, see
[in place](docs/architecture.md#6-in-place--verbs-converge-watch-observes) and
`tests/startup-config.test.ts`.

## Physical stack identity

See [physical stack identity](docs/architecture.md#physical-stack-identity).
`callerHolder` in `src/daemon/engine.ts` resolves the implicit holder: the stack
root, so a verb from a subdirectory finds the worktree's lease (0.19), unless the
caller's own directory holds a live lease. The pre-0.16 migrations (alias
adoption, retired templates, data-only rows, `artifacts/`) were removed in 0.19
(decision 0042); `Journal` refuses a journal stamped below schema 4. Do not add a
migration back for those shapes — point the user at 0.18.

## Leases: `--ttl` is the agent form, `--holder-pid` is not (Claude Code tethers itself)

Since 0.16 (decision 0035) a dead holder destroys the environment (`recycleOne(force)`) once `tetherGone` has seen it dead for `BACKLOT_TETHER_GRACE_MS`; `goneSince` is in memory, so a daemon restart restarts the grace. A live holder renews the lease. The CLI fills `holderPid` from `CLAUDE_PID` (`src/cli/tether.ts`) only when it is a live ANCESTOR — never trust the variable alone, it is inherited into unrelated trees. Tests must set `BACKLOT_TETHER_GRACE_MS=0` where they kill a holder and expect a prompt teardown.

`--holder-pid` / `BACKLOT_HOLDER_PID` ties the environment to the named process, which only helps a caller that outlives the command. `BACKLOT_HOLDER_PID=$$` from an agent harness names an already-exited shell, so the lease is reclaimable on arrival: the sweeper's dead-holder rule frees the env, the next binder takes it, and the first caller is left looking at a different, unseeded store through the same URL. It presents as a stale seed template — the wrong subsystem entirely. Binds naming a dead pid are now refused (exit 64). See the lease bullet in `docs/architecture.md`.

## `up` is additive; a preset reloads one datastore; a database alone is a `runly db` copy

Decision 0034. Sharp edges:

- **`EnvRow.activeServices` is what the lease WANTS**, not what runs: undefined = every service, `[]` = none (`down` with no names). `desiredServices` falls back to every service only when a non-empty list has lost all its members to the manifest. A bind runs `running ∪ wanted ∪ closure(request)` for a continuing lease and `running ∪ closure(request)` for a fresh claim — it never stops a running service. `up`'s RPC sends `[]` for "the default set"; only reset-data passes `undefined` (adds nothing). `startSlice` counts a dependency that is not wanted as satisfied (the lease took it `down`).
- **A preset is a one-off reload, not lease intent.** `validatePresetRequest` returns only the named stores; everything else keeps its data (`env.presets` = what the store holds; `presetToRestore` decides what a reset or a first creation restores). `pristine` keeps `env.presets`. On the incremental path the running services that template `{{datastores.<name>.…}}` are stopped around the reload (`datastoreUsers`; `null` = nobody references it = restart all). `leases.presets` is no longer read.
- **Copies are `db_copies` rows** written `creating` before the restore, with the drop recorded (command + cwd, or a dir under `<state>/dbs` checked by `isPrivateDbDir`). `dbBusy` guards in-flight creates/drops from the reaper; `reapDbCopies` runs in every sweep and (not awaited) at the end of `recover()`. `holderGone` is the one liveness check for lease holders and copy holders — step 6's grace belongs there. A failed drop keeps the row (`dropping`) with a backoff; never delete a row whose drop did not confirm.
- **`--data-only` is gone**: the CLI exits 64 before the daemon and the engine refuses `dataOnly` from any RPC client (`DATA_ONLY_REMOVED`). The row migration went with the other pre-0.16 migrations (decision 0042).
- `tests/additive-up-and-db.test.ts` covers additive up/down, preset reloads, copies and their reaping (holder death, worktree removal, daemon restart), and `ps`; `tests/survivor-ownership.test.ts` drives the survivor-retention cases through `down`.

## The load budget bounds load; the pool cap bounds held rows

Decision 0036: `src/daemon/budget.ts` (`LoadBudget`). Every bind (`bindAndStart` wrapper) and every wake computes a `Need` via `needFor` and `admit`s it before building or starting anything; the reservation's build share is released after the build phase (`releaseBuild`), the rest in `finally`. Running services count through `committedRunning` (declared or default costs of every supervised pid). A new start path that skips `admit` silently overcommits the box. FIFO is deliberate (no overtaking); `check` is pure, `runly plan` uses it. In tests the machine gates (load, MemAvailable) are opened by `setup-env.ts` so a busy box cannot make an unrelated test queue.

## Pool caps, and why the machine-wide one evicts

`poolMaxTotal` (default 2 x cores in [4,64] with the budget on, the old `min(cores/2, memGB/4)` in [2,8] with it off) **gates `createEnv` only** — reuse is never capacity-checked, so it bounds environments held, not load. Idle reclamation takes heat, not the row, so cold environments used to hold machine-wide slots forever and lock out any new stack (#46). `evictForMachineCapacity` now gives up the least-recently-used cold env (unleased, not busy, idle past `idleTtlMs`, `hot` or `warm`) when — and only when — the machine-wide cap is the binding one. Do NOT re-restrict that to `warm`: the sweeper only quiesces every `BACKLOT_SWEEP_MS`, so an abandoned env is `hot` while already condemned, and requiring `warm` refused callers for a whole sweep interval while claiming waiting would not help (caught by driving it, not by a test — there is now one). It must run **outside the pool lock** (`poolLocked` is a non-reentrant promise chain and `recycleOne` takes it), and `claimForTeardown` re-validates, so a candidate leased in the gap is declined rather than stolen.

The consequence worth remembering: **waiting can never clear a machine-wide block**, because a release leaves the row behind. `structuralCapacityBlock` therefore treats it as structural unless something is evictable or transient — the old code explicitly assumed the opposite ("another stack will release") and burned the full window (#47). `tests/pool-machine-capacity.test.ts` covers all of it.

There is no data-only ceiling any more (decision 0034); every environment counts against `poolMaxTotal`.

## Cleanup is by recorded reference, and doctor touches only what is provably runly's

Decision 0037. `prepareDatastores` writes the drop recipe on the env row BEFORE `ensure` (a half-created database must still be droppable) and the template a restore used; `teardownClaimed` drops by recipe and only falls back to the manifest for old rows. `pruneTemplates` keeps per `<ds>-<preset>` group (name before `@`) the newest `templatesKeep` plus every referenced one, after `templateGraceMs`. `poolDoctor` must stay conservative: namespaces only in `backlot_` naming AND of a stack id this state root knows (`foreign-namespace` otherwise, never fixed), processes only by this state root's tag, files only under the state root. `cleanup.test.ts` covers recipes, retention, doctor dry/fix and the tether.

## Logs are stamped files the CLI reads itself

Decision 0038. The supervisor's `LogWriter` (`src/core/logs.ts`) stamps whole lines per stream, writes a `-- runly: <svc> started --` marker per launch and rotates once at `logCapBytes`; builds write `<svc>.build.log`, upkeep `upkeep.build.log`. The daemon only resolves files (`logs-spec`); `src/cli/logs.ts` reads, interleaves, filters and follows them, so `-f` holds no RPC open. `--until` returns 0 on a match and 124 on `--timeout`.

## Templates, crash loops, activity, copies and supervision (decision 0039)

- **A template whose key matches is reused.** `@rebake-template` firing on a bind no longer rebakes: only `--pristine` calls `ds.rebake()` (this datastore's current-key markers only). A fired rule reloads the datastore only when `env.templates[ds]` is not the current ref (`staleTemplate` in `bindAndStartInner`). `destroy` keeps `worktrees/<stack>/` but forgets the upkeep rules without `outputs:` (`forgetRulesWithoutOutputs`, 0.19): a pool's `git clean` after destroy removes what they made, and the ledger cannot tell. A rule with `outputs:` reruns when one is missing. Do not reintroduce a rebake keyed on the environment's ledger — that was 90–110 s per `up` after a teardown.
- **The template lock is readers-writer and two-level** (0.19): `withDatastoreLock(stack, ds, write)` takes the stack lock SHARED and then the `<stack>/<ds>` lock (shared or exclusive), so datastores of one stack bake and restore in parallel while `withBakeLock` (stack, exclusive — pruning) still excludes all of them. Every restore takes the read side; anything that drops or replaces a template takes the write side. The bake check is double-checked: the marker is tested without the write lock and again under it, so restores of an existing template never queue behind an exclusive check. A restore that failed rebakes only if the marker still carries the `nonce` it restored from (a sibling's rebake writes a new one), and drops its half-made target before every retry. A restore outside the lock is the B2 cascade (a sibling's rebake dropped the template mid-copy).
- **Data and builds overlap on a full bind** (`Promise.allSettled`, both settle before an error is thrown; data error first). `trace.overlapped` records their wall times.
- **A crash loop in a LEASED environment is not `degraded`.** The supervisor's `onDegraded(service, exit)` → `serviceFailed` records `failedServices` (memory only), stops the service under the env lock, and `ps`/`ctx`/wake/`resumeForVerb` honour it; `startServices` clears it. Only unleased environments are degraded and recycled (sweeper skips leased degraded rows).
- **Activity is only verbs that use the env** (`touch()` callers: exec, token, preview; binds and down set `lastUsedAt`). Never add `touch()` to a read-only verb.
- **`db with`'s command is tagged `BACKLOT_DB_COPY`** and recorded on the copy row (`child`); `dropDbCopy` → `stopCopyUsers` first. `ensureDaemon` strips the tag so a daemon spawned from inside such a command does not inherit it.
- **The proxy replays until the first byte back** (`Carry` in `proxy.ts`, 1 MB cap, 5 resets while `up`). Anything after the service answered is never retried.
- **`runly daemon install`** (`src/cli/daemon-unit.ts`): one unit per state root; `ensureDaemon` starts it only when it runs THIS build (`unitRunsThisBuild`), else spawns as before. `BACKLOT_SYSTEMCTL`/`BACKLOT_LAUNCHCTL` exist for tests; never let a test touch the real user manager.
- `tests/bench-findings.test.ts` and `tests/proxy-reset.test.ts` are the regression tests.

## exec runs in the CLI; idle unleased environments expire; the unit's environment is an allowlist (0.19)

- **`exec` is the CLI's child** (decision 0040): `exec-env` resumes and touches the environment under the env lock and returns its variables; the CLI spawns the command (inherited stdio, the caller's env, `serviceTag(env, EXEC_SERVICE)`) and heartbeats `exec-touch` every minute. `scanTagged` skips `EXEC_SERVICE`, so no gc, recycle or shutdown reaps it — do not move exec back into the daemon or drop that skip. No deadline unless `BACKLOT_CMD_TIMEOUT_S` is set. `runBoundedIO` is gone; `token` splits streams through `runBounded`'s `onOutput`.
- **`resumeForVerb` starts what a daemon restart stopped**, like a wake; only a failed bind (`failStreak > 0`) is refused. `bindFailures` (memory) feeds `ctx.lastUpFailed` and `ps.failedUps`; after a restart only the fact survives.
- **`BACKLOT_UNLEASED_TTL`** (decision 0041, 24 h): the sweep recycles an unleased env whose `envActivityAt` is older; `worktrees/<stack>/` and templates stay.
- **Unit environment** (decision 0043): `captureEnvironment` in `daemon-unit.ts` — `CAPTURE_EXACT`, `CAPTURE_PREFIXES`, `BACKLOT_*`, manifest `$NAME` references, `--env NAME`; never `NEVER_CAPTURE` or an `env_from` input. `commandFailure`/`environmentHint` (`util.ts`) turn a missing-tool failure into an env-error that says how to fix the unit. WorkingDirectory=/append: paths are never quoted (`systemdPath`).
- `tests/regressions/v019-*.test.ts` are the regression tests, one per finding.

## Version skew is a first-class failure, and the daemon outlives the install

The CLI spawns the daemon from **its own `dist/`** (`ensureDaemon`), so installing a
new runly never replaces a daemon that is already running — it serves old code for
the rest of its life, and an old daemon *ignores* arguments it does not know rather
than rejecting them. `ping` therefore carries the daemon's version, and a mismatch
**refuses** every verb except `update`, `doctor` and `daemon stop` with
`infra-error`. `runly update` is the remedy: it restarts the daemon (shared code
path with `daemon stop`), and the next verb's autospawn is what makes the new daemon
the installed build. Leases survive; an in-flight (`busy`) operation and a downgrade
are the only refusals. See
[decision 0024](docs/decisions/0024-updating-the-running-daemon.md) and
`tests/daemon-update.test.ts`.

Two sharp edges. **`src/core/version.ts` is the only source of version truth** — a
second one already drifted (the MCP adapter shipped 0.4.0 while the package was
0.5.0); `BACKLOT_FAKE_VERSION` exists solely so a test can make a daemon claim a
different version than its CLI. **Any test that stands in for the daemon must answer
`ping` with `VERSION`**, or the CLI treats the stand-in as an old daemon and refuses
before the behaviour under test ever runs (this broke `cli-contract` and
`daemon-spawn` when the gate landed).

Skew reaches the **manifest** too, as of the `auth.logins` list form
([0026](docs/decisions/0026-a-stack-may-advertise-several-logins.md)): a stack using it
fails validation on a pre-0.10.0 runly with `the runly manifest is invalid`, which
reads as a broken manifest rather than an old install. Hence the singular
`{user, password}` form must keep validating indefinitely, and `ctx.logins` must stay a
single object (the primary, manifest entry 0) — `allLogins` is where the set lives.

`JOURNAL_SCHEMA_VERSION` (`src/core/journal.ts`) is stamped into `PRAGMA
user_version`; a daemon refuses to open a journal stamped newer than it understands.
Bump it only when a change makes an older daemon **misread** this journal — the
additive `ALTER TABLE` migrations are not bumps.

For what `env.presets` means (the preset each datastore holds) and why schema 4
refuses older daemons, see the `JOURNAL_SCHEMA_VERSION` comment in `src/core/journal.ts`.

See [journal upgrade barrier](docs/architecture.md#journal-upgrade-barrier) for
survivor group ownership and old-reader refusal;
`tests/survivor-ownership.test.ts` covers failed eviction and group retry.

## Caller environment inputs

`services.*.env_from` allowlists caller variables (`required`/`optional`). Explicit
`up` refreshes them; `reset-data` preserves the lease's
memory-only inputs. A supplied value overrides a same-named `env` entry; an omitted
optional value keeps the service's explicit `env` default, and without one it masks
the same-named daemon variable. Only caller-supplied values are redacted from logs.
Never journal or expose input values/hashes in context or diagnostics. A daemon
restart needs a fresh `up` to resupply them. New holders must restart configured
services even on identical source: warm reuse must not inherit another lease's
inputs. Declaration changes also invalidate the process configuration. See
`src/core/caller-env.ts` and `tests/caller-env.test.ts`.
CLI autospawn must use the target stack's cwd and strip declared input names
from the daemon environment; otherwise the first caller contaminates every later
exec/unconfigured service despite correct per-lease service masking.

Supervisor probe matching uses a raw, memory-only buffer; logs and error excerpts
use the redacted buffer. Combining them breaks readiness when a declared value
also matches `ready.log`/`fatal_logs`. Redaction retains split-value prefixes per
output stream, so no raw prefix reaches disk before its remaining bytes arrive.

## Cutting a release

A merged fix does not reach consumers until this happens — `main` can sit ahead of
the newest npm version for a while (the multi-login work landed as #59 but shipped
in 0.10.0, several days later), and every consumer on the old version keeps hitting
the bug in the meantime. There is **no publish automation**: `ci.yml` has no publish
job (typecheck, test, the README Node-pin check and the `hello-web` smoke) and there
is no `release.yml`, so after the version-bump PR merges the owner does the rest by
hand — `npm publish`, the annotated `vX.Y.Z` tag on the merge commit (`v0.9.1` →
`cc2339d`), and the GitHub release notes. A release-prep commit only ever touches
`package.json` and `package-lock.json` (`"version"` in both places, e.g. `22469d7`,
`c46944e`), titled `chore: X.Y.Z — version bump for the release` with a body naming
what shipped since the last tag; follow semver off what actually changed
(additive/back-compat = minor, fix-only = patch) rather than defaulting to patch.

For packaging guarantees, see [decision 0029](docs/decisions/0029-cli-only-agent-interface.md).
`tests/package-cli-only.test.ts` exercises the actual tarball with stale build outputs;
a green integration suite alone does not verify the published artifact.

## Claude Code plugin

The repo doubles as its own Claude Code plugin marketplace (docs/config only — it
does not touch the CLI build). Layout:
- `.claude-plugin/marketplace.json` — marketplace manifest at repo root.
- `plugins/runly/.claude-plugin/plugin.json` — the plugin manifest; **bump its
  `version` when the skill changes** (independent of `package.json`'s CLI version).
- `plugins/runly/skills/runly/SKILL.md` — the **upstream canonical** runly
  skill. Keep it short, task-oriented and generic; never hardcode a consuming
  repo's services or presets. It must not contradict `README.md`.

runly is CLI-only: the plugin ships **only the skill — no `.mcp.json`.** Install
is `/plugin marketplace add ChristianKohlberg/backlot && /plugin install runly`.

## Docs

`README.md` is only the manifest and command reference plus a quickstart;
`docs/overview.md` is the user guide (lifecycle, ports, testing, data, budget,
previews, security); `docs/architecture.md` is the design and the configuration
table. Describe current behaviour only — no upgrade notes or version history (git
and `docs/decisions/` keep it). `ctx --env` and `up --env` print `export` lines,
so examples use `eval "$(runly ctx --env)" && <tests>`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

## Shared templates (decision 0044) and preview restore (decision 0045)

- A datastore with an `@rebake-template` key and without `share_templates: false` keeps its templates in `templates/<name>@shared/`; every other in `templates/<stack id>/`. Always build the driver with `templateScope(stack, bakeKeys, ds)` in the engine — a bare bake key means "per stack" (what unit tests use).
- Restores read the database name from the MARKER (`parseBakedMarker(...).ns`), never recompute it: an adopted pre-0.20 template keeps its old name, and a bake whose name another marker holds appends a nonce. A bake never drops a database another marker names; retention and doctor remove such a marker without its database.
- Retention and `pool doctor` share one classifier, `templateVerdicts` (`src/core/retention.ts`); change it there, not in one of them. `worktrees/<stack>/templates.json` (written at each restore) is a reference.
- `leases.preview_restore` is written only by `setLeasePreviewRestore`, never by `saveLease` (a stale lease snapshot would erase it). Ending a preview on purpose must call `forgetPreview`; reaping a tunnel (shutdown, recover) must not. `tests/shared-templates.test.ts` and the restart block of `tests/preview-tailscale.test.ts` are the regression tests.

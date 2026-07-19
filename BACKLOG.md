# backlot backlog

Known work, roughly prioritized. Committed to the repo so it survives sessions.
Each item notes severity and where it was found.

## Dogfood findings (2026-07-19, real 0.6.0 session against the Revamp monorepo)

A full driven session (cold bind, ctx, sync, an hour-equivalent watch matrix,
run/detach, reset-data, suspend, release, recycle) on the founding consumer.
The rewritten paths held up (watch projection flawless across atomic renames,
deletions, storms; ports stable across six binds; teardown left zero orphans).
What it exposed:

- [x] **P1 · `backlot sync` full-rebinds on any source change — 57s and three
  service restarts for a one-line edit — while the watch path proves the 2s
  projection exists.** FIXED 2026-07-20: sync routes through the watch
  projection when every service declares the new `hot_reload: true` manifest
  field (owner decision — backlot cannot detect self-reloading run commands,
  so the manifest states it; any undeclared service keeps the full rebind,
  since projecting under a non-watching process serves stale code). Revamp
  wants `hot_reload: true` on its ng-serve/web services to collect the 2s.
  Original entry: syncLease() just calls up(), and bindAndStart's fast
  path dies on any @source change, hitting stopAll. The sync verb should take
  the watch-style source-only projection when no upkeep/rebake is pending and
  services are healthy, falling back to the full bind exactly like watch does.
  The headline loop verb is currently 25x slower than the machinery beneath it.
- [x] **P1 · The sleep pardon is INERT on Apple Silicon — CONFIRMED by a real
  lid-close test (2026-07-19).** It fired only when wall-clock outran
  performance.now(), but mach_absolute_time keeps advancing through real sleep
  on Apple Silicon — the lid-close test showed the lease dying mid-sleep with
  NO event of any kind: no divergence, no pardon, no log line. Decision 0009's
  laptop-sleep story was dead code on the primary platform. FIXED 2026-07-19,
  **pending the human lid-close re-run** (a real lid close cannot be automated;
  docs/soak.md records the human-only protocol): darwin sweeps now read the
  kernel's own record (`sysctl -n kern.sleeptime kern.waketime`) and pardon
  waketime − sleeptime for a wake newer than both the last pardoned wake and
  the previous sweep tick (guards: sleeptime < waketime, absurd gaps capped;
  a failed sysctl falls back to the old detector — never breaks the sweep).
  The wall-vs-mono divergence path is kept as the Linux detector and a second
  macOS detector; the two cannot double-pardon one sleep (last pardoned
  waketime is tracked, and a wake at/before the previous sweep tick is stale).
  Every pardon now logs a kind `pardon` event naming the gap and the detector
  — the confirmed test's "no event of any kind" is closed too. Parsing and
  the pardon decision are pure exported functions (src/core/sleep.ts),
  unit-tested red-first (tests/sleep-pardon.test.ts encodes the confirmed
  scenario), and the parser is verified against this machine's real
  post-sleep sysctl output.
- [ ] **P2 · Cold bind measured 191s vs the ~50s 0.2 baseline — and nothing
  says where the time went.** --progress shows phase names without durations;
  run verdicts conflate bind time into durationMs (91.9s reported for a
  sub-second check). Add per-phase durations to progress and the verdict
  (bindMs vs checkMs) BEFORE diagnosing the regression; suspects include the
  29k-file project, emulated MSSQL seeding, and dotnet build.
- [ ] **P2 · Watch lifecycle is invisible and uncontrollable.** up --watch
  returns immediately with nothing saying a daemon-resident watcher engaged;
  status/pool ls carry no watching flag; no stop verb; a later plain up does
  NOT disengage it (only release does). Surface it and give it an off switch.
- [ ] **P2 · The event log misses the events that matter.** events.jsonl
  recorded watch projections and recovery but no bind/upkeep/recycle/
  lease-expiry events — an upkeep-triggered full rebind left no trace; and
  daemon.log stayed empty all session.
- [ ] **P3 · Old-shape datastore namespaces are unreclaimable on shared
  servers.** The 0.6 ns scheme (name-suffixed) strands prior-shape
  `backlot_*_e1` DBs on the shared MSSQL — no gc reaches them; pool gc or a
  doctor hint should surface server-side orphans matching the backlot_ prefix.
- [ ] **(Revamp-side, for the owner)** `scripts/mint-jwt.py` rejects the
  `--json` its own manifest passes (token verb broken); one genuinely failing
  e2e (impersonation "QA ReadOnly" banner). backlot classified both correctly.

## Review sweep (2026-07-19, two parallel reviewers over src/ halves)

Post-fleet-review sweep after the macOS fixes landed. Every finding below was
verified against the code by the reviewer, and the top entries independently
re-verified (the stack-id collision empirically). FIXED 2026-07-19 in the
same-day follow-up branch, each behind a test that failed against the unfixed
code — except the quiesce/acquire race, held back below for want of an honest
reproduction.

- [x] **P1 · Unbounded repo-declared commands wedge an environment forever.**
  `runBounded` (src/core/exec.ts) closed this class for datastore and appliance
  commands, but SIX sites still run repo shell via raw `execFile('sh', ['-c'])`
  with no timeout and no detached group: `exec` (engine.ts:1002, also missing
  the `BACKLOT_STATE_ROOT` tag, so a hung child that outlives the daemon is
  invisible to `pool gc`), `token` (engine.ts:1027), service `build`
  (engine.ts:577), the `ready.cmd` probe (supervisor.ts:221), upkeep rules
  (upkeep.ts:71), and template pruning's `drop` marker (retention.ts:119 via
  `runQuiet`). A command that blocks on stdin or a half-up DB holds the env's
  `busy` bit forever: the sweeper skips it, `--force` teardown refuses it, and
  every later verb queues behind it until the daemon is restarted — the exact
  wedge exec.ts's own docstring says was closed.
- [x] **P1 · Stack identity collides for sibling worktrees.** `loadStack`
  (manifest.ts:125) keys identity on `base64url(root).slice(-8)` — only the
  last ~6 BYTES of the path. `/work/agent-1/myapp` and `/work/agent-2/myapp`
  (the agent-per-worktree layout this tool exists for) yield the SAME id
  (verified: both `9teWFwcA`), silently merging their pools, journals, and
  baked templates — cross-worktree bind thrash, and for command datastores a
  possible wrong-schema template restore. Use a content hash of the full root.
- [x] **P2 · The capacity queue is global FIFO, so stacks block each other.**
  `acquireEnv` (engine.ts:391) keeps ONE `waiting` queue for the whole engine
  while capacity is per-stack: a waiter queued on full stack A makes stack B's
  `up` (free capacity, would succeed instantly) poll behind it and possibly
  report "pool at capacity" for a pool that never was; a holder's own rebind —
  trivially satisfiable from `leaseForHolder` — also stalls behind the head.
  Queue per stack, and let lease-holding rebinds bypass the queue.
- [x] **P2 · Leased-idle quiesce races an in-flight acquire, and its guard
  cannot fire.** FIXED 2026-07-19 by decision 0021: the quiesce now runs
  under the environment lock with NO borrowed `recycling` state. That closes
  both halves at once — the idle re-check is serialized against bind
  epilogues (a concurrent acquire either aborts the quiesce or rebinds the
  warm env; nothing throws, nothing charges failStreak), and a crash
  mid-quiesce leaves plain `hot` + dead pids, the ordinary recovery case
  (reap, warm, lease kept). Enforced by a journal-polling invariant test:
  `recycling` must never be published during a heat reclaim. Original
  hold-back note: the race window (between
  tryClaim and the busy mark) is microseconds and closes only with test-only
  interleaving hooks — no honest fails-without-it reproduction exists, so per
  this repo's rules the fix waits for one. The secondary defect (quiesce
  borrows the `recycling` state, so a crash mid-quiesce escalates a heat
  reclaim into full env+lease deletion on recovery) needs a distinct state or
  recovery discrimination — a state-machine change that deserves its own
  decision. Both remain open. The sweeper's post-claim re-check (engine.ts:1362) reads
  `lastUsedAt`, but `tryClaim` never updates it (only the bind epilogue and
  `touch` do) — so a holder returning exactly at the idle boundary can have
  the env flipped to `recycling` under its freshly-refreshed lease: the bind
  throws "being recycled — retry" and `failStreak` counts an innocent env
  toward pristine escalation. Also: quiesce borrows the `recycling` state, so
  a daemon crash mid-quiesce makes recovery run full `teardownClaimed` —
  deleting the env AND the live lease for what was only a heat reclaim.
  `tryClaim` should stamp `lastUsedAt` (or the sweeper re-read the lease).
- [x] **P2 · `leasedIdleTtlMs` default ignores a configured `idleTtlMs`.**
  policy.ts:95 hardcodes 60 min instead of the documented `2 × idleTtlMs`
  (architecture.md §11). Set `BACKLOT_IDLE_TTL_MS=2h` and a LEASED env now
  quiesces before an ABANDONED one — inverting the lease-liveness intent.
- [x] **P2 · `rebake` runs outside `withBakeLock`.** engine.ts:523 calls
  `rebake` unserialized; `SqliteDs.rebake` is a recursive rm of the stack's
  template dir. Two envs binding in parallel after a seed edit: A's rebake can
  delete the template between B's bake and B's restore copy → ENOENT surfaces
  as an infra-error and bumps B's `failStreak`. Take the bake lock around
  rebake (the command-family driver self-heals via restore-retry; sqlite has
  no retry).
- [x] **P2 · `backlot pull` is not idempotent.** After a successful pull, the
  worktree hash equals the env hash but no longer equals the bind-time
  baseline, so a second pull (agent retry, timed-out first attempt) throws
  "changed in BOTH — refusing to overwrite" over byte-identical content
  (sync.ts:397). Skip outputs whose worktree content already matches the env.
- [x] **P3 · A daemonizing `run:` burns the full readiness timeout and is
  misclassified.** The exit-0-immediately detector (supervisor.ts:158) fires
  in <2s and sets `expectedExit`, but `waitReady`'s early-exit needs
  `restarts >= 3` (supervisor.ts:200), so the boot polls a dead probe for the
  full `ready.timeout` and then reports env-error — for what is the repo's
  own daemonizing command (a work-error), and §9 promises seconds.
- [x] **P3 · The submodule refusal's advertised escape hatch cannot work.**
  sync.ts:93 throws on any gitlink before `sync.include` is consulted, and
  include only admits single files — so the error's own remedy ("declare the
  paths you need under sync.include") is unreachable. Carve out covered
  gitlinks or stop advertising the hatch.
- [x] **P3 · Clean-slate binds cannot purge `.git`/`node_modules` droppings.**
  `cleanUntracked` reuses `walkAll` (sync.ts:117), whose name-skip was meant
  for source enumeration — so a check's stray `git clone` or an undeclared
  `node_modules` survives every `--pristine` bind, contradicting "a poisoned
  env tree self-heals on the next clean-slate bind" (§6). Empty directories
  survive too (walkAll never emits directories).
- [x] **P3 · `CommandDs.ns()` lacks the 63-byte truncation defense that
  `templateNs()` added for the same bug** (datastores.ts:250 vs :290). Long
  stack + datastore names truncate to the same Postgres identifier, so two
  datastores resolve to one database and a clean-slate drop of one destroys
  the other's data — the exact failure the ns scheme's comment claims to
  prevent.

## Review round 2 (2026-07-19, adversarial pass over the day's own diff)

One refute-posture reviewer over `81ac100..main` (the macOS fixture fixes plus
the sweep-fix batch) found eight defects IN THE DAY'S OWN CHANGES; all eight
were fixed the same day, red-first where behavior changed:

- [x] **P2 · Clean-slate sweep outran the fingerprint ledger.** reset-data
  swept an undeclared upkeep output (node_modules) while the unchanged trigger
  hash skipped the rule — services booted against half a tree. syncIntoEnv now
  reports sweptDroppings separately from mirror deletions, and a bind whose
  sweep removed anything clears the env's ledger before upkeep runs.
- [x] **P2 · The sha256 id migration stranded pre-upgrade envs.** Old-id rows
  counted against POOL_MAX_TOTAL and held ports forever (the only orphan test
  was "stackRoot missing"). The sweeper now also reaps an unleased env whose
  root resolves to a DIFFERENT stack id; an unparseable manifest (mid-edit) is
  deliberately not proof of orphanhood.
- [x] **P3 · The holder bypass resurrected expired-but-unswept leases** ahead
  of the waiter queued on that very expiry (leaseForHolder never filtered on
  expiresAt; the sweep lag is up to 15s). The bypass now requires a LIVE
  lease; at the head of the queue re-upping your own lapsed lease remains a
  legitimate claim.
- [x] **P3 · Template pruning mutated stack template dirs outside the bake
  lock** — the one writer left outside it, reopening the deleted-mid-restore
  race. pruneTemplates now takes the same stack-scoped lock.
- [x] **P3 · A sync.include entry that wasn't an existing file disarmed the
  gitlink refusal** while projecting nothing — the silent-omission failure
  with no error at all. Only existing FILES beneath the gitlink now count.
- [x] **P3 · The new capacity test was timing-fragile on slow runners** (cold
  provision inside an 8s lease window). Stack B is pre-warmed and the TTL and
  bounds widened; the signal measured is queue behavior only.
- [x] **P4 · sweepDroppings lacked the deletion mirror's case-insensitivity
  guard**: on APFS a case-only rename left the OLD casing on disk, and the
  sweep deleted the file sync had just guaranteed. Same lowered-key probe as
  the mirror now applies.
- [x] **P4 · docs/overview.md overpromised reset-data** ("keeps build
  caches") after the sweep change made that true only for DECLARED caches.
  Corrected.

## From the Go evaluation (2026-07, decision 0020)

Declining the rewrite came with a short list of in-language fixes that close the
same ground. The process-level rejection guards, the floating-promise catches and
the README/engines pin check landed with the decision; these did not.

- [x] **P2 · Move `syncIntoEnv` onto a worker thread.** FIXED 2026-07-19 (PR #20): per-call worker via sync-thread.ts, same BrokerError contract; bind --ref's archive extraction bounded too; red test measured a 5s status stall during a 24k-file sync, green answers in a fraction of the bind. Original entry: The one open
  language-attributable item (17 synchronous fs/exec calls in one 412-line module)
  blocks the daemon's event loop for every concurrent environment during a large
  bind. `worker_threads` is stable and currently unused here. Same treatment for
  `bind --ref`'s `git archive | tar -x`. Closes the "different environments bind in
  parallel" caveat now documented in architecture.md.
- [x] **P3 · Ban non-null `!` assertions in sync.ts and engine.ts via eslint.** FIXED 2026-07-19 (PR #14): eslint is a real devDependency with a flat config, the rule is enforced for both files, and all 14 sites became classified errors. Original entry:
  Two confirmed findings were a `!` suppressing a contract the type system had
  correctly flagged, and ~26 assertion sites remain — concentrated in the
  `getEnv(...)!` cluster where three lost-update findings already lived. (Note:
  `npm run lint` currently fails outright — eslint is not in devDependencies.)
- [x] **P3 · Guard the AF_UNIX `sun_path` limit in `socketPath()`.** A deep
  `BACKLOT_STATE_DIR` silently truncates the socket path; client and daemon
  truncate identically so it appears to work, which makes it a latent
  cross-state-dir collision. Fail loudly above ~100 bytes. FIXED 2026-07-19:
  `socketPath()` refuses paths over 103 bytes (macOS's 104-byte `sun_path`, the
  tighter leg) naming the limit and the path; classified infra-error, verified
  empirically (a 257-byte state dir bound a truncated colliding socket).
- [x] **P3 · Suppress the `node:sqlite` ExperimentalWarning on daemon spawn** so
  daemon.log stays signal, without hiding it from a direct CLI run. FIXED
  2026-07-19: the CLI spawns the daemon with
  `--disable-warning=ExperimentalWarning` — only that class, only for the
  spawned daemon; direct runs still warn.

## Promised but not implemented (2026-07-18 fleet review)

The review found several documented capabilities the code does not deliver.
They are recorded here rather than quietly corrected away, because each is a
real product gap someone reading the docs would expect to work.

- [x] **P2 · `--watch` two-stage reload.** FIXED 2026-07-19: watch saves take a source-only projection under the env lock (services kept; pid-stability test proves it), with a deliberate fallback to the full bind when the save would fire an upkeep rule or rebake — a lockfile change genuinely needs the restart. Original entry: Docs promised the watcher projects a
  file and the environment's own dev-server picks it up. In fact the sync takes
  the ordinary bind path, whose fast path requires an unchanged source hash —
  which a watch-triggered sync never has — so every save stops and restarts the
  services. architecture.md now states the gap; closing it needs a source-only
  sync path that skips the service lifecycle.
- [x] **P2 · Decision 0016 (data states) is unimplemented.** RESOLVED 2026-07-19 by decision 0022: the doctrine is in force, the mechanisms are formally deferred with named forcing conditions — the record no longer promises unbuilt features. Original entry: No `states:`,
  no `inputs:`, no per-check `state:`, no `--state`, no snapshot/restore. The
  decision is marked Accepted, so either build it or supersede it with a new
  decision — an Accepted decision the code ignores is worse than no decision.
- [ ] **P3 · The substrate seam is spec-only.** docs/driver-spec.md describes
  remote substrates and `pool reconcile` adoption, but no remote driver exists
  and nothing exercises the seam. The local paths hard-code local assumptions
  (process groups, /proc tags, file copies), so the first real driver will
  find the seam narrower than the spec suggests.
- [x] **P3 · MCP has no long-running-operation story.** PARTLY CLOSED
  2026-07-19: the adapter now exposes the detach/job verbs as tools —
  `backlot_run_detach` (submit, returns `{jobId}` immediately), `backlot_job`
  (poll by id to the journaled verdict), `backlot_job_ls` — thin over the
  same `run-detach`/`job`/`job-ls` RPCs the CLI's `run --detach` and
  `job <id>` use, so an agent driving a slow bind over MCP no longer has to
  block. Still open: progress frames are still dropped and there is no
  cancel — both need daemon-side work (a cancel path through the serialized
  queue, MCP progress notifications) and a design decision, not adapter code.
- [x] **P3 · Probe host and advertised host disagree.** DECIDED 2026-07-19 (owner): keep advertising `localhost`, document the IPv4-only caveat (architecture §11) — every mainstream client falls back to 127.0.0.1, proven across this repo's own test history. Original entry: Port probing binds
  `127.0.0.1` (and now the wildcard) while `ctx` advertises `http://localhost:…`.
  On a dual-stack host `localhost` can resolve to `::1`, where a service bound
  only to IPv4 is not listening — so a probed-free, "ready" service can still be
  unreachable for the consumer. Changing the advertised host is a visible
  contract change (tests and consumers expect `localhost`), so it needs a
  deliberate decision rather than a quiet swap.
- [x] **P3 · `/bin/sh` differs across the two supported platforms.** Service and
  check commands run under `sh`, which is dash on Ubuntu and bash-as-sh on
  macOS, so the same stack.yaml can behave differently on the two legs backlot
  tests. Either document sh-portable-only, or pick a shell explicitly.
  DOCUMENTED 2026-07-19 (sh-portable-only): architecture.md §12 and the
  schema's `run:`/`build:` descriptions now say write POSIX sh, no bashisms —
  picking a shell would be a behavior change deserving its own decision.

- [x] **P2 · hello-multi smoke is flaky in CI on BOTH legs.** DIAGNOSED AND
  FIXED 2026-07-19. The service that died was the api, and it died of
  `SQLITE_BUSY`: api and worker share one sqlite file with no busy timeout, so
  a read landing inside the worker's commit window (an exclusive lock held for
  microseconds) threw `Error: database is locked` — uncaught inside the http
  handler, killing the process mid-request. That is the captured signature
  exactly: "other side closed" on a kept-alive socket, then a verdict of
  env-error "while a service was not running". Proven two ways: hammering the
  read/write race locally crashes the unfixed api in under a second, and a
  20-iteration CI loop reproduced the flake on iteration 12 in the RAW fixture
  test (no daemon), pinning it on the fixture rather than the engine. Why only
  CI: the collision window is microseconds on a fast local machine and the
  natural cadence is one write per 200ms; slow shared vCPUs widen both. Fixed
  with `PRAGMA busy_timeout` on both connections (WAL was rejected: the sqlite
  driver templates by file copy, and `-wal` sidecars would complicate that
  contract). Regression test holds `BEGIN EXCLUSIVE` under a live api read —
  deterministic, no race needed — and fails without the fix.

- [x] **P2 · macOS: hello-python never passes its readiness probe.** DIAGNOSED
  AND FIXED 2026-07-19, by measuring on the runner itself (a debug workflow on
  `macos-latest`): `socket.gethostbyaddr('127.0.0.1')` takes **35.016s** there —
  the runner's resolver is broken (firewall disabled, real Homebrew Python;
  those theories are dead). stdlib `HTTPServer.server_bind()` calls
  `socket.getfqdn(host)`, i.e. exactly that reverse lookup, BEFORE the server
  accepts — so the constructor stalled past the manifest's 30s readiness
  timeout on every boot. Deterministic on the runner, invisible on any Mac with
  working DNS, and unrelated to dual-stack (the probe never had a socket to
  reach on ANY address). The misleading part of the evidence was the fixture's
  own log: `server.py` printed "listening" before constructing the server, so
  the failure quoted a socket that did not exist. Fixed by overriding
  `server_bind` to skip the FQDN lookup (a loopback service never uses that
  name) and printing "listening" only after the bind. Regression tests: a
  `sitecustomize.py` that stalls `gethostbyaddr` 30s reproduces the runner
  locally (readiness must still pass), and a squatted port must produce a
  Traceback with NO "listening" line. Both fail without the fix.

## CI — macOS-runner failures (2026-07-11) — DIAGNOSED 2026-07-18

- [x] **P2 · macOS runners: `run`-flow tests die on "pool at capacity (1/1) —
  waited 60s".** Root cause found by the 2026-07-18 fleet review, and it is NOT
  a slow-runner timing problem as this entry previously hypothesised. It is
  arithmetic: `poolMaxHeuristic` is `min(floor(cores/2), floor(memGB/4))`, and
  `macos-latest` is 3 vCPU / 7 GB, so both terms are 1. Every failing flow does
  a session `up` and then a `run`, and `run` always mints its own ephemeral
  holder (`engine.ts`, `holder = run-<id>`), so it needs a SECOND environment
  that a 1-env pool may never create. The 60s wait could never succeed on any
  runner at any speed. ubuntu-latest (4 vCPU / 16 GB) gives 2 and passes; real
  Macs give >= 2 and pass.
  Fixed on two fronts: capacity waits now fail fast with a structural
  diagnosis naming the blocking lease instead of burning the window and
  blaming timing, and CI pins `BACKLOT_POOL_MAX=2`.
  Owner decision (2026-07-18): the heuristic floor is now **2**, not 1. A
  default under which the primary workflow cannot run is the worse failure, and
  a cap is not a reservation — the second environment is only created when the
  user actually asks for concurrent work. `BACKLOT_POOL_MAX=1` opts back out on
  a constrained host, at the price of that loop.

## Polish — found during live Revamp/parallel testing (2026-07-03)

- [x] **P1 · Progress while queued behind a busy env.** FIXED 2026-07-19:
  `envLocked` gained a wait heartbeat ("waiting for another operation on this
  environment … Ns", 1s cadence) threaded from up/run/reset-data's onProgress;
  a free lock never emits. Red-first test in tests/progress.test.ts.
  Original finding: A verb (`up`/`run`/…) that
  resolves to an environment currently held by another in-flight operation prints
  `acquiring an environment` and then goes **silent** until the env lock frees —
  because the progress emitter only fires *inside* `bindAndStart`, which is blocked on
  `envLocked`. A legitimate wait looks identical to a hang (this is exactly what read
  as "stuck" in testing). Fix: emit a `waiting for another operation on this
  environment … Ns` heartbeat from the CLI (or daemon) while queued on the env lock.
  Small; high felt-quality on the shared-directory / fleet path.

- [x] **P2 · Retry once on a lost daemon cold-start race.** Firing several verbs in
  parallel with **no daemon running** makes them all cold-spawn the daemon; the
  singleton guard prevents corruption (one wins the socket, losers exit 0), but the
  loser's *client* can occasionally fail its ping window instead of falling through to
  the winner. Fix: in `cli/client.ts ensureDaemon`, if our spawned daemon loses the
  race, ping again for the winner before giving up. Also document "warm the daemon
  with a cheap `backlot status` before parallelizing" for fleets. Small.
  FIXED 2026-07-19: a spawned daemon that exited 0 proves a winner exists, so
  `ensureDaemon` grants the winner a second ping window; warm-the-daemon note
  added to architecture.md §5.

- [x] **P3 · `logs <service>` on a service that has produced no output errors.** FIXED 2026-07-19 (PR #14): empty log for a silent declared service; unknown services get a work-error naming the declared ones. Original entry: A
  silent service has no `.log` file yet, so `logs` returns `no logs for service` (a
  false env-error). Should return an empty log, not fail. Trivial.

## Data states / seeding (ADR-0016 — DEFERRED by ADR-0022, 2026-07-19)

The seeding philosophy is decided in [ADR-0016](docs/decisions/0016-data-states-not-seeds-three-baselines-scenarios-in-tests.md);
its doctrine (three baselines, scenarios in tests) is in force. The mechanisms
below are NOT active work: each waits for its forcing condition
([ADR-0022](docs/decisions/0022-data-state-mechanisms-deferred.md)) — per-check
selection that default_preset cannot express (S1), @rebake-template demonstrably
failing a consumer (S2), repeated loss of hand-built repro state (S3), the remote
substrate shipping (S4). Do not pick these up without one.

- [ ] **S1 · `--state` selection + per-check `state:`.** Expose the presets already
  declared (today only `default_preset` is reachable — every other preset is dead
  weight). Runtime `backlot up --state <name>`; a check declares its state
  (`checks.e2e.state: dev`). Small; unlocks the states that already exist.
- [ ] **S2 · `states:` with declared `inputs` → content-hash template keying.** Replaces
  command-string keying (decision 0008) for states, so editing a seed auto-rebakes
  instead of silently serving a stale template. `inputs` are declared globs; backlot
  reuses the stat-gated hasher. The highest-value seeding fix.
- [ ] **S3 · `snapshot` / `restore` verbs.** Rewind to a runtime-chosen point (the
  debugging loop) via the datastore's native clone (sqlite copy / postgres template /
  MSSQL BACKUP-RESTORE). Note the restore-blips-connections caveat. **Snapshots MUST
  carry the current schema/migration fingerprint; `restore` refuses-or-warns on a
  mismatch** (ADR-0016 §6 — restoring across a migration is unsafe).
- [ ] **S3b · Migrations in place.** Document + support the `upkeep` rule keyed on the
  migrations dir that advances a live env's schema (delta only, data preserved) while
  fresh/reset binds rebuild from the rebaked template (ADR-0016 §6). Mostly mechanism
  that already exists (fingerprint ledger); the work is the schema-fingerprint tagging
  shared with S3 and the docs/example.
- [ ] **S4 (later) · Composable/layered states** consuming the repo's existing per-layer
  hashes; **shared/"golden" states** across machines (coupled to the remote substrate).

## Roadmap (from the design + reviews)

- [ ] **Remote substrate driver (0.3).** The one big rock. A `morph`/`ssh` substrate:
  daemon-on-the-box + local CLI forwarding verbs over an SSH-tunneled socket, worktree
  capture moves CLI-side, detached submit-and-poll runs (already built), provider-side
  TTLs, `pool reconcile` adopt/reap of forgotten instances. Requires threading the
  fs/exec seam through sync + supervision. Freezes the `SubstrateDriver` interface
  (`src/drivers/types.ts`, currently design-only).

- [x] **mssql `template_restore`.** PROVEN LIVE 2026-07-19: tests/mssql.test.ts (docker- and image-gated) drives BACKUP/RESTORE bake+restore against MSSQL 2022, 4/4. Original entry: Revamp binds currently re-seed (~30–50s) instead of
  restoring from a baked template in seconds. Add a backup/restore command pair to
  Revamp's `stack.yaml` datastore. Deferred by the captain.

- [x] **Content-hash template keying.** Substantially closed by bake keys + @rebake-template; the full inputs-hash version is S2, deferred by decision 0022. Original entry: Templates are keyed by the `create:` command
  string, not seed content; editing a seed needs an `@rebake-template` upkeep rule to
  invalidate. Content-hashing would remove that manual step. (Documented limitation.)

- [x] **Sync on the event loop.** FIXED 2026-07-19 with the worker-thread entry above (PR #20). Original entry: `syncIntoEnv` + `git archive` (`bind --ref`) run
  synchronously on the daemon's single thread, stalling all RPCs/sweeper for the
  duration on a big repo. Matters only at fleet scale; the remote refactor touches the
  same seam. (Documented limitation.)

## Release logistics (outward-facing — captain's call)

- [x] Create the GitHub repo + push (currently local-only on the captain's machine).
- [x] First CI run (the workflow exists but has executed zero times).
- [x] `npm publish` — 0.5.0 is live on npm (this entry was stale); 0.6.0 to be published manually by the owner after the 2026-07-19 batch.

## Revamp adoption (in the Revamp repo, not here)

- [x] STALE — Revamp's manifest is already committed (ADR-0059, their PR #364) and validates against backlot 0.5. Original entry: Decide + commit Revamp's `stack.yaml` through the pipeline (bean `revamp-ksa3`,
  draft). Add an ADR on the relationship to `scripts/verify`.
- [x] Port the remaining `verify` lanes (unit/static/integration/ui) as `checks` — concrete mapping proposal committed on Revamp branch `chore/backlot-checks-mapping-proposal` (local only, not pushed) 2026-07-19; open questions recorded there (env-bind cost for DB-less lanes, integration capacity, ui port ownership).
- [x] STALE — the branch no longer exists and the seeded-names fix appears landed on Revamp main (their #305: the spec selects the seeded user by stable login attribute). Original entry: Land the impersonation e2e fix (branch `fix/impersonation-e2e-seeded-names`,
  bean `revamp-m2pk`, ready for PR).

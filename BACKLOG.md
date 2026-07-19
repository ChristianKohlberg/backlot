# backlot backlog

Known work, roughly prioritized. Committed to the repo so it survives sessions.
Each item notes severity and where it was found.

## From the Go evaluation (2026-07, decision 0020)

Declining the rewrite came with a short list of in-language fixes that close the
same ground. The process-level rejection guards, the floating-promise catches and
the README/engines pin check landed with the decision; these did not.

- [ ] **P2 · Move `syncIntoEnv` onto a worker thread.** The one open
  language-attributable item (17 synchronous fs/exec calls in one 412-line module)
  blocks the daemon's event loop for every concurrent environment during a large
  bind. `worker_threads` is stable and currently unused here. Same treatment for
  `bind --ref`'s `git archive | tar -x`. Closes the "different environments bind in
  parallel" caveat now documented in architecture.md.
- [ ] **P3 · Ban non-null `!` assertions in sync.ts and engine.ts via eslint.**
  Two confirmed findings were a `!` suppressing a contract the type system had
  correctly flagged, and ~26 assertion sites remain — concentrated in the
  `getEnv(...)!` cluster where three lost-update findings already lived. (Note:
  `npm run lint` currently fails outright — eslint is not in devDependencies.)
- [ ] **P3 · Guard the AF_UNIX `sun_path` limit in `socketPath()`.** A deep
  `BACKLOT_STATE_DIR` silently truncates the socket path; client and daemon
  truncate identically so it appears to work, which makes it a latent
  cross-state-dir collision. Fail loudly above ~100 bytes.
- [ ] **P3 · Suppress the `node:sqlite` ExperimentalWarning on daemon spawn** so
  daemon.log stays signal, without hiding it from a direct CLI run.

## Promised but not implemented (2026-07-18 fleet review)

The review found several documented capabilities the code does not deliver.
They are recorded here rather than quietly corrected away, because each is a
real product gap someone reading the docs would expect to work.

- [ ] **P2 · `--watch` two-stage reload.** Docs promised the watcher projects a
  file and the environment's own dev-server picks it up. In fact the sync takes
  the ordinary bind path, whose fast path requires an unchanged source hash —
  which a watch-triggered sync never has — so every save stops and restarts the
  services. architecture.md now states the gap; closing it needs a source-only
  sync path that skips the service lifecycle.
- [ ] **P2 · Decision 0016 (data states) is unimplemented.** No `states:`,
  no `inputs:`, no per-check `state:`, no `--state`, no snapshot/restore. The
  decision is marked Accepted, so either build it or supersede it with a new
  decision — an Accepted decision the code ignores is worse than no decision.
- [ ] **P3 · The substrate seam is spec-only.** docs/driver-spec.md describes
  remote substrates and `pool reconcile` adoption, but no remote driver exists
  and nothing exercises the seam. The local paths hard-code local assumptions
  (process groups, /proc tags, file copies), so the first real driver will
  find the seam narrower than the spec suggests.
- [ ] **P3 · MCP has no long-running-operation story.** Progress frames are
  dropped, there is no cancel, and the detach/job verbs are not exposed — so an
  agent driving a slow bind over MCP can only block. The CLI has `--detach`;
  the adapter should surface it.
- [ ] **P3 · Probe host and advertised host disagree.** Port probing binds
  `127.0.0.1` (and now the wildcard) while `ctx` advertises `http://localhost:…`.
  On a dual-stack host `localhost` can resolve to `::1`, where a service bound
  only to IPv4 is not listening — so a probed-free, "ready" service can still be
  unreachable for the consumer. Changing the advertised host is a visible
  contract change (tests and consumers expect `localhost`), so it needs a
  deliberate decision rather than a quiet swap.
- [ ] **P3 · `/bin/sh` differs across the two supported platforms.** Service and
  check commands run under `sh`, which is dash on Ubuntu and bash-as-sh on
  macOS, so the same stack.yaml can behave differently on the two legs backlot
  tests. Either document sh-portable-only, or pick a shell explicitly.

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

- [ ] **P1 · Progress while queued behind a busy env.** A verb (`up`/`run`/…) that
  resolves to an environment currently held by another in-flight operation prints
  `acquiring an environment` and then goes **silent** until the env lock frees —
  because the progress emitter only fires *inside* `bindAndStart`, which is blocked on
  `envLocked`. A legitimate wait looks identical to a hang (this is exactly what read
  as "stuck" in testing). Fix: emit a `waiting for another operation on this
  environment … Ns` heartbeat from the CLI (or daemon) while queued on the env lock.
  Small; high felt-quality on the shared-directory / fleet path.

- [ ] **P2 · Retry once on a lost daemon cold-start race.** Firing several verbs in
  parallel with **no daemon running** makes them all cold-spawn the daemon; the
  singleton guard prevents corruption (one wins the socket, losers exit 0), but the
  loser's *client* can occasionally fail its ping window instead of falling through to
  the winner. Fix: in `cli/client.ts ensureDaemon`, if our spawned daemon loses the
  race, ping again for the winner before giving up. Also document "warm the daemon
  with a cheap `backlot status` before parallelizing" for fleets. Small.

- [ ] **P3 · `logs <service>` on a service that has produced no output errors.** A
  silent service has no `.log` file yet, so `logs` returns `no logs for service` (a
  false env-error). Should return an empty log, not fail. Trivial.

## Data states / seeding (ADR-0016)

The seeding philosophy is decided in [ADR-0016](docs/decisions/0016-data-states-not-seeds-three-baselines-scenarios-in-tests.md).
Sequenced implementation:

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

- [ ] **mssql `template_restore`.** Revamp binds currently re-seed (~30–50s) instead of
  restoring from a baked template in seconds. Add a backup/restore command pair to
  Revamp's `stack.yaml` datastore. Deferred by the captain.

- [ ] **Content-hash template keying.** Templates are keyed by the `create:` command
  string, not seed content; editing a seed needs an `@rebake-template` upkeep rule to
  invalidate. Content-hashing would remove that manual step. (Documented limitation.)

- [ ] **Sync on the event loop.** `syncIntoEnv` + `git archive` (`bind --ref`) run
  synchronously on the daemon's single thread, stalling all RPCs/sweeper for the
  duration on a big repo. Matters only at fleet scale; the remote refactor touches the
  same seam. (Documented limitation.)

## Release logistics (outward-facing — captain's call)

- [ ] Create the GitHub repo + push (currently local-only on the captain's machine).
- [ ] First CI run (the workflow exists but has executed zero times).
- [ ] `npm publish` (name `backlot` is free; package is publish-shaped).

## Revamp adoption (in the Revamp repo, not here)

- [ ] Decide + commit Revamp's `stack.yaml` through the pipeline (bean `revamp-ksa3`,
  draft). Add an ADR on the relationship to `scripts/verify`.
- [ ] Port the remaining `verify` lanes (unit/static/integration/ui) as `checks`.
- [ ] Land the impersonation e2e fix (branch `fix/impersonation-e2e-seeded-names`,
  bean `revamp-m2pk`, ready for PR).

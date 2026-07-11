# backlot backlog

Known work, roughly prioritized. Committed to the repo so it survives sessions.
Each item notes severity and where it was found.

## CI — diagnosed during the template-identity work (2026-07-11)

- [ ] **P1 · Linux rebind race: "port … occupied by a foreign process".** The
  dominant CI failure (red on main since 2026-07-03, both runners): every
  rebind-to-the-same-port flow — `sync`, `reset-data`, crash recovery, quiesce
  → rebind, ephemeral reset — fails on Linux with an env-error from the
  pre-start `probeFree` check, while the same suite is green on macOS.
  Teardown *does* await the service process's `exit` event and the spawn/kill
  chain looks correct, so the actual port holder at probe time needs live
  socket forensics. Repro (fails deterministically in a stock container):
  `docker run --rm -v $PWD:/src:ro node:22 bash -c "cp -r /src /work && cd /work && npm ci && npx vitest run tests/cli.test.ts"`
  → instrument with `ss -ltnp` at the failure instant. Any fix lands in the
  supervisor/port-broker core (process groups? probe retry window?), where
  crash recovery, watchers, and restart timers interact — treat as its own
  session, with both-platform verification. Until fixed, CI is red for every
  PR and cannot gate merges.

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

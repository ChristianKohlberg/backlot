# infront backlog

Known work, roughly prioritized. Committed to the repo so it survives sessions.
Each item notes severity and where it was found.

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
  with a cheap `infront status` before parallelizing" for fleets. Small.

- [ ] **P3 · `logs <service>` on a service that has produced no output errors.** A
  silent service has no `.log` file yet, so `logs` returns `no logs for service` (a
  false env-error). Should return an empty log, not fail. Trivial.

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
- [ ] `npm publish` (name `infront` is free; package is publish-shaped).

## Revamp adoption (in the Revamp repo, not here)

- [ ] Decide + commit Revamp's `stack.yaml` through the pipeline (bean `revamp-ksa3`,
  draft). Add an ADR on the relationship to `scripts/verify`.
- [ ] Port the remaining `verify` lanes (unit/static/integration/ui) as `checks`.
- [ ] Land the impersonation e2e fix (branch `fix/impersonation-e2e-seeded-names`,
  bean `revamp-m2pk`, ready for PR).

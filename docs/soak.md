# The soak: the test the fixtures can't be

The vitest suite proves runly's invariants in seconds-long fixture runs. What
no fixture run can prove is **longevity**: a daemon that is still correct after
hours of editor-realistic rebind traffic, pool churn, capacity pressure, and the
occasional violent death. Leaks, journal drift, and unbounded growth are
properties of *duration* — so `scripts/soak.mjs` buys duration, and holds
everything it does to the same contract the suite does.

```bash
npm run build
SOAK_MINUTES=10 node scripts/soak.mjs        # local; default 10 minutes
```

Nightly it runs for 20 minutes on ubuntu-latest via `.github/workflows/soak.yml`
(cron + `workflow_dispatch`). It is deliberately **not** part of the PR `ci`
workflow: a merge gate must answer in minutes, and a soak that fits in minutes
is not a soak.

## What it covers

The harness drives the **real CLI** (`dist/cli/index.js`) against generated
fixture stacks in a dedicated temp `BACKLOT_STATE_DIR`, cycling continuously:

- **Session loop** — `up`, repeated `up` with real file churn, `exec` reading the
  worktree back, `logs`, `ctx`, `release`.
- **Restart traffic** (decision 0032) — a source edit + `up` must keep a
  service that has no `build:` (same pid), and an upkeep-trigger touch
  (`deps.lock`) + `up` must take the full bind: the upkeep marker appears in
  the worktree *and* the service comes back on the same URL with a new pid.
  Requests sent to that URL throughout the restart must all be answered — the
  daemon's proxy holds them until the new process is ready (decision 0033) —
  and the URL's port must stay inside the public block 20000–29999.
- **Env export** — `runly ctx --env` must print parseable `RUNLY_*=value`
  lines, and the stack's own check, run with them outside runly, must pass.
- **Capacity churn** — a second stack whose one environment (decision 0032) is
  held by a short-TTL holder while a second holder queues on its expiry, plus a quiesce cycle under a
  short `BACKLOT_LEASED_IDLE_TTL_MS`: leased-idle env goes warm, `exec` refuses
  with the rebind hint, `up` brings the same env back hot. The sweeper
  (`BACKLOT_SWEEP_MS=1000`) must keep reclaiming all of it, all run long.
- **Chaos ticks (~every 2 min)** — `SIGKILL` the daemon (the next verb must
  auto-respawn and recover), `SIGSTOP`/`SIGCONT` for 60–90 s, and deleting a
  worktree mid-lease (the stale-root reap must remove the env row *and* its
  directory unaided).

Throughout: **every** verb invocation must emit one parseable JSON object on
stdout with an exit code derivable from that body (the decision-0010 contract);
daemon RSS is sampled via `ps` and fails the run if it grows past 3× its
5-minute baseline; and the run ends with a **convergence audit** — daemon down,
no process anywhere still carrying `BACKLOT_STATE_ROOT` for the soak state dir,
no env dir on disk without a journal row, no journal lease pointing at an env
that doesn't exist.

Exit 0 prints a stats table. Any error exits non-zero with a ranked failure
summary and appends the daemon's own account (`daemon.log`, `events.jsonl`
tails) to the soak log; the temp dir is kept for inspection.

## What it deliberately doesn't cover

- **Real sleep.** The sweeper's sleep pardon has two detectors, and `SIGSTOP`
  triggers neither: on macOS it reads the kernel's own sleep record
  (`kern.sleeptime`/`kern.waketime`, which a stopped process does not touch —
  the kernel records no sleep), and on Linux it fires when wall-clock time
  outruns the monotonic clock — which is what actual suspend looks like there,
  and exactly what `SIGSTOP` does *not* look like (both clocks keep advancing
  while the process is stopped, so the engine correctly reads it as
  starvation, not sleep). The chaos `SIGSTOP` tick therefore asserts survival
  and resumption, not a pardon. The pure parsing/decision halves are
  unit-tested (tests/sleep-pardon.test.ts), but the end-to-end proof remains
  a genuine lid-close test: a human and a laptop.
- **Real repos.** The fixtures are honest (git worktrees, sqlite
  datastore, upkeep rules, readiness gates) but tiny; multi-gigabyte trees and
  minutes-long builds are a different experiment.
- **Docker-backed datastores** (postgres/mssql) — covered by their own suites;
  the soak stays runnable on a bare runner.
- **App behaviour beyond the contract.** The soak asserts classes and exit
  codes, not your app's behaviour — that is what your own tests are for.

## Reproducing a failure

Every run prints its seed; all "random" timing, file choice, storm sizing, and
chaos rotation derive from it. A failure report ends with the exact line to
run, e.g.:

```bash
SOAK_SEED=1728382910 SOAK_MINUTES=20 node scripts/soak.mjs
```

Same seed + same duration replays the same schedule. It cannot replay OS
scheduling, so treat the seed as a strong lead, not a guarantee — if a seeded
rerun passes, the ranked summary plus the kept state dir
(`daemon.log`, `events.jsonl`, `journal.db`) is the evidence trail. Useful
knobs: `SOAK_DIR` pins the state/fixture dir (fault injection, post-mortems),
`SOAK_KEEP=1` keeps it even on success, `SOAK_LOG` sets the log path. Runs
under 8 minutes shrink the SIGSTOP window (to ~20 s) so validation runs aren't
one long pause; at 8 minutes and above it is the full 60–90 s.

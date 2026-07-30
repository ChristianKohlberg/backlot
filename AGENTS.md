# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Build & test

- Build: `npm run build` (compiles TypeScript to `dist/`; required before running tests)
- Test: `npm test` runs vitest over all files in `tests/`; tests use the compiled `dist/cli/index.js`
- Single file: `npm test -- tests/foo.test.ts`

## Architecture notes

See `docs/` for decision log. Key files:
- `src/daemon/engine.ts` — pool + lease + bind orchestration (the core)
- `src/daemon/supervisor.ts` — per-env process supervision, `killGroupVerified`, `reapPids`
- `src/core/procscan.ts` — `scanTagged` (Linux-only /proc scan by BACKLOT_ENV_ID tag)
- `src/core/journal.ts` — SQLite journal (disk is truth)

## Service process lifecycle & teardown sharp edges

Services are spawned detached (`detached: true` in `spawn`) so they outlive the daemon intentionally — this is the crash-recovery contract. The BACKLOT tag (`BACKLOT_ENV_ID`, `BACKLOT_SERVICE`, `BACKLOT_STATE_ROOT`) is injected into every service's environment and inherited by grandchildren; `scanTagged` uses it to find orphans even after the process moved to a new session.

Consequence: a group kill (`killGroupVerified`) is not sufficient teardown — a service that called `setsid()` or spawned a detached grandchild escapes the `-pgid` signal and can keep holding its port. `stopAll()` must therefore always be followed by a reap of journal-recorded pids plus a tag scan before trusting any port-free check. **Every `stopAll()` call site is bound by this** — `bindAndStart`, `teardownClaimed`, the quiesce path, and `shutdown()`. Deferring the reap to "the next bind will handle it" is the bug (#34): a quiesced env can sit cold for hours, and a stopping daemon has no next anything. `reapEnvProcesses` in `src/daemon/engine.ts` owns this invariant (see its doc comment for the failure modes and the survivor-preservation contract); `tests/env-port-survivor.test.ts` and `tests/agent-lease-and-recycle.test.ts` are the regression tests. Crash recovery follows the same rule: `recover()` reaps recorded pids for every journaled env and re-runs `teardownClaimed` for `state='recycling'` rows.

Recorded `servicePids` hold only the **top-level service pids** — a service's own children were never on the books, so the tag scan is the only thing that finds them. For anything that also scrubbed the tag, `reapEnvTree` reaps by cwd (`scanByCwd`, which matches a `(deleted)` cwd too). That path is **teardown-only**: a quiesced env keeps its tree on disk and someone's shell may legitimately be sitting in it.

## Leases: `--ttl` is the agent form, `--holder-pid` is not

`--holder-pid` / `BACKLOT_HOLDER_PID` frees the environment the moment the named process exits, which only helps a caller that outlives the command. `BACKLOT_HOLDER_PID=$$` from an agent harness names an already-exited shell, so the lease is reclaimable on arrival: the sweeper's dead-holder rule frees the env, the next binder takes it, and the first caller is left looking at a different, unseeded store through the same URL. It presents as a stale seed template — the wrong subsystem entirely. Binds naming a dead pid are now refused (exit 64). See the lease bullet in `docs/architecture.md`.

## Data-only leases

`up --data-only` binds an ordinary pooled environment's **datastores only** — no services, no builds — for test lanes that need a seeded database rather than an application ([decision 0023](docs/decisions/0023-data-only-leases.md)). The sharp edge: `activeServices: []` cannot express "no services", because an empty *selection* has always meant "the whole app" in `resolveServiceClosure`. The durable flag is `EnvRow.dataOnly`, and it follows the slice's inheritance rule — explicit request wins, a fresh claim never inherits, a continuing lease preserves. Such an environment is published `warm` (nothing is running, which is what warm means), so `assertUsable` must not read warm as "the daemon restarted and lost your services". `tests/data-only-lease.test.ts` covers it.

Pool commands are shared-box operations: `pool recycle` with no id targets **every** environment, and `--force` is the only thing that takes one out from under a live lease. In `status`, `heat: 'cold'` means quiesced-and-free, not stuck; the `available` and `summary` fields say so outright because reading 'cold' as 'broken' is what caused #40.

## Two pool caps, and why the machine-wide one evicts

`poolMax` is per stack, `poolMaxTotal` machine-wide, and **both gate `createEnv` only** — reuse is never capacity-checked, which is why the env *row count* is what bounds worst-case concurrent load. Idle reclamation takes heat, not the row, so cold environments used to hold machine-wide slots forever and lock out any new stack (#46). `evictForMachineCapacity` now gives up the least-recently-used cold env (unleased, not busy, idle past `idleTtlMs`, `hot` or `warm`) when — and only when — the machine-wide cap is the binding one. Do NOT re-restrict that to `warm`: the sweeper only quiesces every `BACKLOT_SWEEP_MS`, so an abandoned env is `hot` while already condemned, and requiring `warm` refused callers for a whole sweep interval while claiming waiting would not help (caught by driving it, not by a test — there is now one). It must run **outside the pool lock** (`poolLocked` is a non-reentrant promise chain and `recycleOne` takes it), and `claimForTeardown` re-validates, so a candidate leased in the gap is declined rather than stolen.

The consequence worth remembering: **waiting can never clear a machine-wide block**, because a release leaves the row behind. `structuralCapacityBlock` therefore treats it as structural unless something is evictable or transient — the old code explicitly assumed the opposite ("another stack will release") and burned the full window (#47). `tests/pool-machine-capacity.test.ts` covers all of it.

There is a **third ceiling**: `poolMaxDataOnly` for data-only environments, which are charged against neither application cap ([decision 0025](docs/decisions/0025-data-only-environments-are-priced-separately.md)) — the app caps measure cores and memory, and a data lease runs nothing. So `poolMax`/`poolMaxTotal` now mean *application* environments (`appEnvs()`), and every capacity decision buckets by shape, eviction included. The sharp edge: because reuse is never capacity-checked, **changing an environment's shape is a capacity event** — `convertShape` moves the row between buckets only if the destination has room, and writes it at claim time so a concurrent claim sees the new bucket. Unmetered, that conversion turns the cheap ceiling into application capacity. Pinning the shape instead is simpler and was rejected: it silently removes 0023's supported both-ways lease switching (`tests/data-only-lease.test.ts` catches this — heed it).

## Version skew is a first-class failure, and the daemon outlives the install

The CLI spawns the daemon from **its own `dist/`** (`ensureDaemon`), so installing a
new backlot never replaces a daemon that is already running — it serves old code for
the rest of its life, and an old daemon *ignores* arguments it does not know rather
than rejecting them. `ping` therefore carries the daemon's version, and a mismatch
**refuses** every verb except `update`, `doctor` and `daemon stop` with
`infra-error`. `backlot update` is the remedy: it restarts the daemon (shared code
path with `daemon stop`), and the next verb's autospawn is what makes the new daemon
the installed build. Leases survive; an in-flight (`busy`) operation and a downgrade
are the only refusals. **The MCP adapter enforces the same gate on its own** — the
CLI's lives in `main()`, so an MCP client would otherwise be unprotected — and there
is deliberately no MCP tool that restarts the daemon. See
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
fails validation on a pre-0.10.0 backlot with `the backlot manifest is invalid`, which
reads as a broken manifest rather than an old install. Hence the singular
`{user, password}` form must keep validating indefinitely, and `ctx.logins` must stay a
single object (the primary, manifest entry 0) — `allLogins` is where the set lives.

`JOURNAL_SCHEMA_VERSION` (`src/core/journal.ts`) is stamped into `PRAGMA
user_version`; a daemon refuses to open a journal stamped newer than it understands.
Bump it only when a change makes an older daemon **misread** this journal — the
additive `ALTER TABLE` migrations are not bumps.

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

## Claude Code plugin

The repo doubles as its own Claude Code plugin marketplace (docs/config only — it
does not touch the CLI build). Layout:
- `.claude-plugin/marketplace.json` — marketplace manifest at repo root.
- `plugins/backlot/.claude-plugin/plugin.json` — the plugin manifest; **bump its
  `version` when the skill changes** (independent of `package.json`'s CLI version).
- `plugins/backlot/skills/backlot/SKILL.md` — the **upstream canonical** backlot
  skill. Keep it generic/stack-agnostic; never hardcode a consuming repo's
  services or presets. `README.md` is the source of truth for its content.

backlot is CLI-only: the plugin ships **only the skill — no `.mcp.json`.** Install
is `/plugin marketplace add ChristianKohlberg/backlot && /plugin install backlot`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

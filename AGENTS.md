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

Pool commands are shared-box operations: `pool recycle` with no id targets **every** environment, and `--force` is the only thing that takes one out from under a live lease. In `status`, `heat: 'cold'` means quiesced-and-free, not stuck; the `available` and `summary` fields say so outright because reading 'cold' as 'broken' is what caused #40.

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

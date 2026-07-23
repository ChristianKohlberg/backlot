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

Consequence: a group kill (`killGroupVerified`) is not sufficient teardown — a service that called `setsid()` or spawned a detached grandchild escapes the `-pgid` signal and can keep holding its port. `stopAll()` must therefore always be followed by a reap of journal-recorded pids plus a tag scan before trusting any port-free check. `reapEnvProcesses` in `src/daemon/engine.ts` owns this invariant (see its doc comment for the failure modes and the survivor-preservation contract); `tests/env-port-survivor.test.ts` is the regression test. Crash recovery follows the same rule: `recover()` reaps recorded pids for every journaled env and re-runs `teardownClaimed` for `state='recycling'` rows.

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

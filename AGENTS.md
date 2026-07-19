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

**Port-survivor bug (fixed 2026-07-19, `fm/backlot-env-reap`):** A service that called `setsid()` or spawned a detached grandchild (new process group) could escape the `-pgid SIGKILL` in `killGroupVerified`. The group leader's group became empty so `killGroupVerified` returned `true`, but the grandchild was alive in its own group holding the port. On the next `bindAndStart`, the fresh supervisor's `stopAll()` was a no-op and the port-free check failed.

Fix: `engine.reapEnvProcesses(env)` is called after every `stopAll()` in `bindAndStart`. It:
1. Re-runs `reapPids(env.servicePids)` (platform-independent) to retry kills for journal-recorded survivors.
2. Runs `scanTagged` (Linux only) to find and kill any process still carrying this env's BACKLOT tag in its environment, regardless of process group.

**Crash path:** if the daemon dies mid-teardown, the env stays in `state='recycling'`. `recover()` on next start calls `teardownClaimed` again. For `state='warm'` envs, `recover()` calls `reapPids(servicePids)`. If that leaves survivors (phantom pids from pid-reuse), the next `bindAndStart` handles them via `reapEnvProcesses`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

# Contributing

Thanks for looking at backlot. A few ground rules keep this project what it is:

- **Read [docs/architecture.md](docs/architecture.md) first.** It is short and it is
  the product. PRs that fight the anti-scope (decision 0001) will be declined kindly:
  no compute ownership, no build-system knowledge, no CI features, no agent features.
- **Decisions are recorded, not implied.** Anything that changes the model gets a new
  entry in [docs/decisions/](docs/decisions/) superseding the old one — never an edit
  in place.
- **Policy lives in the engine; transport lives in drivers.** A driver PR that adds
  policy (pooling, hygiene, classification) is a design bug — see
  [docs/driver-spec.md](docs/driver-spec.md).
- **`examples/hello-web` is the contract.** Engine properties are proven as
  integration tests against it, on macOS *and* Linux. If your change can't be
  demonstrated there (or in a new equally-tiny example), that's a signal.
- Node ≥ 22.5, `pnpm install`, `pnpm typecheck && pnpm test` before pushing.
- Agent-authored contributions are welcome and expected — this tool exists for
  agents. The same review bar applies to everyone.
- **Coverage** (optional, not a CI gate — it re-runs the whole integration suite):
  `npm run coverage` produces a text summary and `coverage/lcov.info`. Because the
  suite drives the built CLI as a subprocess (which spawns the daemon, which spawns
  workers), in-process instrumentation would see almost nothing; instead the script
  sets `NODE_V8_COVERAGE` for the whole run so every spawned node process writes raw
  V8 coverage, then `c8` merges it against `dist/` and maps it back to `src/` via
  sourcemaps. Numbers therefore reflect what the *real* product loop executed.
  Two known blind spots when reading them: a process that dies by SIGKILL never
  writes its dump (so suites that SIGKILL their daemon/MCP process in cleanup
  contribute nothing for that process's whole life — prefer a plain
  `process.kill(pid)`, which the daemon handles gracefully), and tests that
  import `../src/*.ts` in-process run through vitest's transform, which this
  dist-mapped view does not count.

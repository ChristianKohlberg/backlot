# 0038. Logs are time-stamped, interleaved, followable and capped; a build may be skipped when its inputs are unchanged

- Status: Accepted
- Date: 2026-10
- Amends: [0032](0032-environments-run-in-the-callers-worktree.md) — "runly caches
  no builds" gains one opt-in exception, `build: { when: }`;
  [0012](0012-commands-first-services.md) — `outputs:` may compare content
- Context: `runly logs <service>` printed the tail of one file, so an agent
  waiting for "compiled successfully" polled it in a loop, could not see two
  services in order, and could not tell this process's output from the last
  one's. Build output went nowhere once the `up` returned. And since 0032 every
  `up` ran every build, which for a .NET API and an Angular SPA is a minute of
  nothing changing.

## Decision

**Log lines are stamped.** The supervisor writes `<ISO-8601> <line>` for every
line a service prints (stdout and stderr, each stream buffered to whole
lines), and a start marker `-- runly: <service> started (pid N) --` at every
process start. A file is capped at `BACKLOT_LOG_CAP_BYTES` (default 20 MB) and
rotated once to `<service>.log.1`. Logs live in the environment's directory:
they survive idle stops and daemon restarts and are deleted with the
environment.

**`runly logs [service…]`** (none named = all) interleaves the services by
time, prefixing `service | ` when there are several:

- `--lines N` (default 40), `--since up` (from each service's last start
  marker), `--since <duration>` (`90s`, `10m`, `2h`), `--grep <regex>`;
- `-f`/`--follow` keeps reading; `--until <regex>` (implies `-f`) exits 0 at the
  first matching line, `--timeout <s>` exits 124 when it runs out (like
  timeout(1));
- `--build`: each service's last build output (`<service>.build.log`) and the
  upkeep output of the last `up` that ran a rule (`upkeep.build.log`);
- `--json`: `{ lines, entries: [{service, at, text}] }` — `lines` keeps its
  pre-0.16 meaning (the text).

The daemon only resolves which files (`logs-spec`); the CLI reads and follows
them, so a long `-f` holds no daemon request open. Start markers are written to
the file but not printed.

**Build skip.** `build:` may be `{ run, when: [globs] }`. Its inputs are the
files the globs match, listed the way upkeep triggers are (0032: git's file
list filtered by the globs, minus `caches:`), each identified by path, size and
mtime, together with the build command. When they are unchanged since the last
**successful** build of that service in that worktree, the build is skipped:
`up` reports `build <svc>: skipped (when: unchanged)` and
`bindDiagnostics.builds[].reason = 'when-unchanged'`. The ledger is
`worktrees/<stack>/builds.json` in the state root; an entry is removed before
its build runs and written only after it succeeds. `up --rebuild` runs every
build regardless; `--pristine` forgets the ledger. A plain string `build:` runs
on every `up` as before, and on a start on demand only if it never succeeded
in this worktree.

**Outputs may compare content.** `outputs:` may be
`{ paths: [globs], compare: content | stat }`. `stat` (the default, and what a
list means) compares path, size and mtime; `content` hashes the files, so a
build that rewrites identical bytes does not restart the service.

## Consequences

- `runly logs -f --until 'compiled successfully' --timeout 300` replaces a
  polling loop.
- `when:` is opt-in and the manifest's author owns its correctness: a glob that
  misses an input means a stale build until `--rebuild`.
- Two copies of each log at most: 40 MB per service with the default cap.

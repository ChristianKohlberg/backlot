# Find hidden work and tune from observations

Read this for every new setup or performance-oriented manifest change. A valid
manifest and one successful up are only the starting point. Initial use needs
monitoring to refine cache boundaries, resource estimates and idle behavior.

## Trace cost before introducing skips

Read the actual command chain, including shell helpers, container entrypoints,
workspace build orchestration, test global setup and ORM hooks. Look for:

- Dependency installation repeated in upkeep, build and dev-server startup.
- Restore/migration/seed work repeated by each app process after runly restored it.
- A test suite creating its own server/database despite receiving runly URLs.
- Monorepo builds rebuilding every package for a single changed service.
- Docker image builds/pulls hidden in every start command.
- Watchers scanning node_modules, generated sources or whole sibling worktrees.
- Rewritten timestamps causing restarts despite unchanged build bytes.
- Trigger globs covering output folders, or triggers missing ignored config.
- Shared mutable output/cache directories that race across worktrees.

Prefer the repo tool's existing incremental build/cache when correct. Do not
replace the toolchain or add another caching service just to configure runly.

## Distinguish the mechanisms

| Mechanism | What it saves | What to check |
| --- | --- | --- |
| Package manager/compiler cache | Downloads or computation inside the repo's tool | Toolchain/platform keys, permissions and safe concurrent access |
| upkeep when + outputs | Repeated install/generation | Complete content triggers and an output whose absence detects cleanup |
| build when | Entire successful build command | Command + matched path/size/mtime; hidden inputs are not covered |
| service outputs | Restart after a build | Files actually consumed by the running app; stat vs content tradeoff |
| @rebake-template | Migrations/seeds across restores/worktrees | Complete data inputs and safe sharing |
| caches | Excludes generated paths from trigger enumeration | Not a stored artifact cache or an invalidation rule |

Do not add build when if correctness depends on unrepresented environment values,
toolchain versions, remote state or generated inputs excluded from enumeration.
Either track a suitable non-secret version/config input, keep the normal
incremental build, or require an explicit rebuild when that input changes.
Never store secret values in fingerprints or manifests.

Include shared libraries, workspace manifests, lockfiles, build config,
code-generation schemas and relevant static assets in build inputs. Inspect what
the globs actually match, especially ignored files. Use sync.include deliberately;
do not widen to every ignored file. Keep caches narrowly scoped to generated
paths so real source is not accidentally excluded.

An upkeep output like node_modules only proves that path exists, not that every
package inside it is intact. State that limitation and test ordinary recovery from
missing outputs. Runly's build skip uses stat fingerprints, not content hashes.
outputs.compare: content avoids timestamp-only restarts but adds file-reading
cost; use it on measured expensive restarts with bounded output sets.

Do not share mutable build output directories across worktrees merely to save
space. A tool-managed content-addressed download cache and a shared dist directory
have different correctness properties. Keep worktree-specific generated files
and database files out of unrelated shared caches.

## Observe representative early usage

Use bounded observations during initial setup and a short follow-up checklist
for the first real development sessions. Do not launch an indefinite monitor or
schedule anything without a request. If this session cannot exercise normal
usage, explicitly label tuning provisional and hand back the measurements needed.

Capture a small baseline table: scenario, elapsed time, phase costs, services
started/restarted, template baked/reused, resource peaks/queueing, and outcome.
Use stats --since 30m --json and bounded monitor --interval 2s --timeout 60
--json captures, plus bindDiagnostics from up --json, logs --build, ps --all, plan --json,
status events, and bounded OS/container measurements as appropriate.
Read-only snapshots are fine; avoid a noisy continuous ps polling loop.
Redact credentials and connection strings from saved observations.
Check collection.retainedSince, truncation, storage errors and sample counts.
Stats history uses minute buckets and approximate histogram quantiles; monitor
JSON is NDJSON. Proxy first-byte observations are per TCP connection, not per
application request. Shared budget figures are declared costs, not resource
measurements. Use recentOperations to relate the triggering cold connection to
its wake; it is bounded and does not trace every waiting connection.

Exercise the relevant scenarios, using disposable test data/worktrees where
needed; do not reset a user's database to manufacture a cold start:

| Scenario | Expected evidence |
| --- | --- |
| First setup / fresh worktree | Where install, build, bake, restore and readiness time goes |
| Repeated unchanged up | No unexpected install, template rebake or restart |
| Edit one service or shared dependency | Necessary build/restart happens, unrelated work stays bounded |
| Remove generated output in a disposable checkout | Rebuild/upkeep repairs it rather than trusting a stale ledger |
| Change a seed/migration in a disposable fixture | Template invalidates and restored data reflects the change |
| Another worktree / parallel start | Data isolation, cache correctness and shared-server headroom |
| Idle then request | Services stop, wake latency is acceptable, shared appliances remain |
| Long-lived connection / background work | Heartbeats and traffic explain activity; useful silent work is not killed |

Separate correctness failures from performance costs. Missed invalidation or
cross-worktree data contamination must be fixed before enabling further skips.
Observe resource peaks during both builds and running load: ps snapshots alone
can miss spikes. Separate build resource declarations from running declarations;
shared database/container usage also consumes machine capacity.

Tune one cause at a time and compare the same scenario:

- Slow unchanged up: locate repeated upkeep/build work before adding when.
- Slow cold starts: compare dependency install, template bake/restore and probes.
- Frequent identical-output restarts: narrow outputs or evaluate content comparison.
- OOM or sustained queueing: measure peaks/concurrency; adjust costs or serialize
  genuinely conflicting builds rather than bypassing admission.
- Repeated wake latency: investigate real startup cost before lengthening idle.
- Services never idle: inspect WebSocket/polling traffic or background heartbeats.
- Long-running workers stop mid-job: choose deliberate worker lifetime or a
  heartbeat-owning exec workflow; proxy silence does not prove useful work stopped.

A timeout increase is justified by observed slow-but-progressing startup, not by
an unidentified deadlock. Record the reason for each nondefault setting.

## Handoff and initial monitoring

Leave a concise repo-appropriate setup/tuning note with:
- What was measured versus assumed and under which workload.
- Current topology and each cache's input/output/invalidation boundary.
- The first-session observations still needed, with commands to collect them.
- Concrete signs that require revisiting settings (unexpected rebakes, stale output,
  wake failures, excessive restarts, queues, memory pressure or isolation failures).
- Any external dependency or concurrency case not yet verified.

Explain that the initial configuration needs observation during real development.
After representative cold/warm/edit/idle and parallel-worktree paths behave
correctly and repeatably, stop tuning unless new evidence warrants a change.
Do not call a setup optimized based solely on schema validation or one green up.

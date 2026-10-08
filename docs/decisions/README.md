# Decision log

Decisions, MADR-lite, append-only. To change a decision, add a new one that amends
or supersedes it, point the old one's `Status:` line at it, and update this index —
never rewrite a decision's body. The Status column names the decisions that changed
each one; the decision's own `Status:` line says how.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-thesis-and-anti-scope.md) | Thesis and anti-scope (never own compute / not a build system / not CI / not the agent) | Accepted |
| [0002](0002-core-nouns.md) | Core nouns: Stack, Substrate, Environment, Binding, Lease, Run | Amended by 0032, 0034 |
| [0003](0003-durable-environments-disposable-leases.md) | Environments are durable; leases are disposable | Amended by 0032, 0035 |
| [0004](0004-watchers-never-move-bindings-move.md) | Watchers never move; bindings move | Superseded by 0032 |
| [0005](0005-git-sync-immutable-bindings.md) | Git sync transport; immutable bindings; verbs sync, watch streams | Superseded by 0032 |
| [0006](0006-convergence-over-checkpointing.md) | Convergence over checkpointing | Accepted |
| [0007](0007-hygiene-levels.md) | Hygiene levels: reuse / reset-data / pristine + auto-escalation | Amended by 0032, 0034, 0039 |
| [0008](0008-lazy-upkeep-fingerprint-ledger.md) | Lazy upkeep via a per-environment fingerprint ledger | Amended by 0032 |
| [0009](0009-local-daemon-no-central-service.md) | Per-machine auto-spawned daemon; no central service; disk is truth | Amended by 0019, 0039 |
| [0010](0010-error-taxonomy.md) | Error taxonomy: work-error / env-error / infra-error | Accepted |
| [0011](0011-nothing-precious-outputs-writeback.md) | Environments hold nothing precious; explicit outputs write-back | Amended by 0032 |
| [0012](0012-commands-first-services.md) | Services are commands, not containers; backing infra external + probed | Amended by 0032, 0038 |
| [0013](0013-typescript-node-npm-apache2.md) | TypeScript on Node ≥ 22, one npm package, Apache-2.0 | Amended by 0030 |
| [0014](0014-cli-json-api-mcp-later.md) | CLI with --json is the v1 agent API; MCP later | MCP portion superseded by 0029 |
| [0015](0015-remote-submit-and-poll.md) | Remote runs are submit-and-poll; provider TTLs mandatory | Local half superseded by 0032 |
| [0016](0016-data-states-not-seeds-three-baselines-scenarios-in-tests.md) | Data states not seeds: three baselines, scenarios in tests, snapshots for the expensive middle | Mechanisms deferred by 0022; §4 lapsed with 0032 |
| [0017](0017-rename-infront-to-backlot.md) | Rename: infront → backlot — the standing-sets metaphor, collision-free, real word | Superseded by 0030; MCP portion by 0029 |
| [0018](0018-appliances-ensured-not-owned.md) | Appliances are ensured, not owned: backlot starts shared backing servers but never stops them implicitly | Accepted |
| [0019](0019-service-ownership-by-tag-not-pid.md) | Service ownership is proven by tag and process group, not by a recorded pid | Accepted |
| [0020](0020-rewrite-in-go-considered-and-declined.md) | A rewrite in Go was considered and declined — the defects were design and POSIX, not language | MCP remarks superseded by 0029 |
| [0021](0021-quiesce-is-not-a-teardown.md) | A quiesce runs under the environment lock, not as a borrowed teardown — disk is truth, so a borrowed state is a borrowed crash contract | Amended by 0035 |
| [0022](0022-data-state-mechanisms-deferred.md) | Data-state mechanisms are deferred until a consumer forces them — 0016's doctrine stands, its unbuilt features stop pretending to be pending | Accepted |
| [0023](0023-data-only-leases.md) | A lease may cover the datastores alone (`up --data-only`) — the environment is unbundled downward, not split into a second pool | Superseded by 0034 |
| [0024](0024-updating-the-running-daemon.md) | `backlot update` reconciles the running daemon to the installed build — version skew is refused, and backlot never installs itself | MCP remarks superseded by 0029 |
| [0025](0025-data-only-environments-are-priced-separately.md) | A data-only environment answers to its own ceiling, and changing an environment's shape is a metered capacity event | Superseded by 0034 |
| [0026](0026-a-stack-may-advertise-several-logins.md) | A stack may advertise several logins — `ctx.logins` stays the primary, `allLogins` carries the set | Accepted |
| [0027](0027-lease-scoped-public-preview.md) | Lease-scoped public preview is explicit, supervised, and separate from `expose` | Amended by 0045 |
| [0028](0028-named-preview-hostnames.md) | A preview may publish under a hostname we own, and the publisher is where that lives | Accepted |
| [0029](0029-cli-only-agent-interface.md) | Agents use the CLI; remove the MCP adapter | Accepted |
| [0030](0030-rename-backlot-to-runly.md) | Rename Backlot to Runly while preserving existing state, namespaces and the CLI alias | Amended by 0042 |
| [0031](0031-tailscale-preview-publisher.md) | A preview may publish on the tailnet, through a foreground `tailscale serve` | Amended by 0033 |
| [0032](0032-environments-run-in-the-callers-worktree.md) | Environments run in the caller's worktree, one per worktree; `up` is the only bind verb and restarts only services whose build output changed; runly runs no checks (`ctx --env` instead of `run`/`job`/`checks:`); no per-stack ceiling; runly caches no builds; `runly warm` prepares an idle worktree | Amended by 0034, 0036, 0037, 0038, 0039, 0040 |
| [0033](0033-the-daemon-holds-public-ports-behind-an-l4-proxy.md) | The daemon holds every public port behind an L4 proxy for the environment's life; services listen on a fresh internal port; connections are held while a service starts and client bytes are counted; ports come from three disjoint blocks (public 20000–29999, internal 30000–31999, tunnel 32000–32767) below the ephemeral range | Amended by 0035 |
| [0034](0034-additive-up-database-copies-and-ps.md) | `up` is additive and `down` stops what it names; a `--preset` reloads one datastore and restarts its users, no preset keeps the data, `ctx` reports each datastore's preset; `--data-only` is removed — a database alone is a `runly db new\|with` copy, reaped like an environment (holder or worktree gone), no TTL; `runly ps` shows services and copies | Amended by 0035, 0039, 0042 |
| [0035](0035-services-idle-on-their-own-clock-and-wake-on-demand.md) | Each service stops after 10 idle minutes (no verb, no client byte; `idle:` per service), keeping lease, data and port; a connection starts it again and is held meanwhile (chained through the proxy, also across a crash restart); activity persists; a dead tether (1-min grace; Claude Code's `CLAUDE_PID` automatically) or a removed worktree tears everything down; `runly destroy` | Amended by 0039, 0041 |
| [0036](0036-a-server-wide-load-budget.md) | A server-wide load budget (declared `resources:` or a conservative default; memory, cpu, free-memory reserve, load) admits every start and build FIFO with a bounded wait; builds hold their share only while building; `runly plan` says "starts now" or what it would wait for; the pool cap only bounds held rows | Accepted |
| [0037](0037-cleanup-by-reference-and-pool-doctor.md) | Drop recipes are recorded on the environment row; templates are kept per datastore+preset (newest 1) plus every referenced one, after a grace; `runly pool doctor [--fix]` lists and removes only runly's own leftovers; the test suite proves it leaks no process | Amended by 0044 |
| [0038](0038-time-stamped-logs-and-build-skip.md) | Logs are time-stamped and interleaved with `--since up\|<duration>`, `--grep`, `-f --until --timeout` (124), `--build`, 20 MB + one rotation; `build: {run, when}` skips an unchanged build (`up --rebuild` forces); `outputs: {paths, compare: content}` | Accepted |
| [0039](0039-teardown-keeps-templates-a-leased-environment-survives-a-crash-loop.md) | Templates and the worktree's records outlive an environment (a template whose key matches is reused; only `--pristine` rebakes), data and builds overlap, restores share the template lock and a failed one is logged and retried; a crash loop in a LEASED environment stops and reports the service (`failed`) and keeps the environment; the proxy retries a connection dropped before the first byte; `db with` stops its command with its copy; only verbs that use an environment are activity; `runly daemon install` supervises the daemon; `copies_only` datastores | Amended by 0040, 0041, 0043, 0044, 0045 |
| [0040](0040-exec-runs-in-the-cli.md) | `runly exec` runs its command in the CLI (caller's terminal and environment, real exit code, nothing cut, no environment lock, no default deadline); `exec` and `token` start services a daemon restart stopped | Accepted |
| [0041](0041-idle-unleased-environments-expire.md) | An unleased environment unused for `BACKLOT_UNLEASED_TTL` (24 h) is torn down, templates and worktree records kept; upkeep `outputs:`, and `destroy` forgets rules without them | Accepted |
| [0042](0042-retire-the-pre-016-migrations.md) | The pre-0.16 migrations are removed; a journal below schema 4 is refused | Accepted |
| [0043](0043-the-daemon-units-environment.md) | The daemon unit carries an allowlisted environment (`--env NAME`), says what it left out, and a missing tool reads as an env-error with a hint | Accepted |
| [0044](0044-content-keyed-templates-are-shared-across-worktrees.md) | A content-keyed template (an `@rebake-template` key) is shared by every worktree of the same stack name (`<name>@shared/`, bake single-flight, `share_templates: false` opts out); `--pristine` bakes a private one; retention keeps what any live worktree last restored from; per-worktree templates with the same key are adopted | Accepted |
| [0045](0045-a-daemon-restart-re-publishes-the-leases-previews.md) | A daemon restart re-publishes each lease's preview (same publisher, pinned address, same public port) from `leases.preview_restore`; failures are events and `ctx.previewRestore` | Accepted |

# Decision log

Founding decisions, MADR-lite, append-only. To change a decision, add a new one that
supersedes it and update this index — never edit a decision in place.

| # | Decision |
| --- | --- |
| [0001](0001-thesis-and-anti-scope.md) | Thesis and anti-scope (never own compute / not a build system / not CI / not the agent) |
| [0002](0002-core-nouns.md) | Core nouns: Stack, Substrate, Environment, Binding, Lease, Run |
| [0003](0003-durable-environments-disposable-leases.md) | Environments are durable; leases are disposable |
| [0004](0004-watchers-never-move-bindings-move.md) | Watchers never move; bindings move |
| [0005](0005-git-sync-immutable-bindings.md) | Git sync transport; immutable bindings; verbs sync, watch streams |
| [0006](0006-convergence-over-checkpointing.md) | Convergence over checkpointing |
| [0007](0007-hygiene-levels.md) | Hygiene levels: reuse / reset-data / pristine + auto-escalation |
| [0008](0008-lazy-upkeep-fingerprint-ledger.md) | Lazy upkeep via a per-environment fingerprint ledger |
| [0009](0009-local-daemon-no-central-service.md) | Per-machine auto-spawned daemon; no central service; disk is truth |
| [0010](0010-error-taxonomy.md) | Error taxonomy: work-error / env-error / infra-error |
| [0011](0011-nothing-precious-outputs-writeback.md) | Environments hold nothing precious; explicit outputs write-back |
| [0012](0012-commands-first-services.md) | Services are commands, not containers; backing infra external + probed |
| [0013](0013-typescript-node-npm-apache2.md) | TypeScript on Node ≥ 22, one npm package, Apache-2.0 |
| [0014](0014-cli-json-api-mcp-later.md) | CLI with --json is the v1 agent API; MCP later |
| [0015](0015-remote-submit-and-poll.md) | Remote runs are submit-and-poll; provider TTLs mandatory |
| [0016](0016-data-states-not-seeds-three-baselines-scenarios-in-tests.md) | Data states not seeds: three baselines, scenarios in tests, snapshots for the expensive middle |
| [0017](0017-rename-infront-to-backlot.md) | Rename: infront → backlot — the standing-sets metaphor, collision-free, real word |
| [0018](0018-appliances-ensured-not-owned.md) | Appliances are ensured, not owned: backlot starts shared backing servers but never stops them implicitly |
| [0019](0019-service-ownership-by-tag-not-pid.md) | Service ownership is proven by tag and process group, not by a recorded pid |
| [0020](0020-rewrite-in-go-considered-and-declined.md) | A rewrite in Go was considered and declined — the defects were design and POSIX, not language |
| [0021](0021-quiesce-is-not-a-teardown.md) | A quiesce runs under the environment lock, not as a borrowed teardown — disk is truth, so a borrowed state is a borrowed crash contract |
| [0022](0022-data-state-mechanisms-deferred.md) | Data-state mechanisms are deferred until a consumer forces them — 0016's doctrine stands, its unbuilt features stop pretending to be pending |

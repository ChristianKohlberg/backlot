# Recommend the service and data topology

Use this when deciding what belongs in services, datastores, or appliances.
Base the recommendation on repository evidence, not a generic preferred stack.

## Map the existing system

Inspect package scripts, Compose files, Dockerfiles, CI service definitions,
connection-string construction, migrations, seeds, authentication setup, and
test fixtures. Trace wrappers: npm scripts may invoke a second build, and a
container entrypoint may silently migrate or seed on every start.

For each component record:

- How it starts and where its command executes (host or container).
- Its dependencies, readiness signal, and actual resource use if measurable.
- Which data is mutable, who owns it, and how it is isolated and removed.
- Whether it must outlive an idle application environment.

Recommend a concrete mapping, naming the files supporting it and unresolved
assumptions. Preserve an intentional existing container workflow.

## Choose the ownership boundary

| Component | Typical runly representation | Reason |
| --- | --- | --- |
| App/API/frontend/worker with environment-scoped lifetime | services | Supervised, stopped at idle, restarted and observed through runly |
| Per-worktree seeded database/file | datastores | Independent namespace, restoration and recorded cleanup |
| Existing shared PostgreSQL/MySQL/MSSQL/Redis server | External server, optionally appliances | Reuse the server while isolating each environment's data |
| Database used only by tests | copies_only datastore + db with | No application database provisioned unnecessarily |
| Durable external API or managed database server | Explicit external prerequisite | No invented local lifecycle or destructive ownership |

Prefer one compatible local server with separate namespaces over a whole database
container per worktree when the engine and application support that isolation.
Explain exceptions: incompatible versions/extensions/configuration, isolation
requirements, or a workload too disruptive to share. Do not replace the app's
database engine with SQLite just because its setup is easier.

Use native app commands when they already work in the worktree. If the repo needs
app containers, verify their lifecycle rather than treating docker run as a
normal child process. Killing the Docker CLI is not proof the container stopped;
detached Compose services outlive the launcher. Do not promise idle/teardown
semantics until the wrapper's stop and failure paths demonstrably remove only its
own containers. An appliance is appropriate only if that component is deliberately
shared and long-lived.

## Containerized backing servers

Reuse an existing suitable Compose service/server when possible. For a runly
appliance, use a repo-owned idempotent helper that starts or adopts the intended
container and returns (docker run -d / compose up -d semantics). Handle an already
created but stopped container. Choose an explicit compatible image version from
the repo's requirements; do not casually introduce latest or upgrade data volumes.

A machine-shared appliance needs a stable identity across worktrees. Check Compose
project names, container names, published host ports and volume names: default
directory-based names can create duplicate servers in every checkout. Bind local
database ports to loopback unless remote access is required. Keep container volume
paths independent of any disposable worktree.

Use both probe and a protocol-level ready command that verifies the expected
server can answer queries. A port answering TCP proves neither identity nor
authentication. runly identifies appliances by probe address; verify that an
existing listener is the intended server before adopting it.

Document volume persistence, credentials source, image/config ownership, resource
limits and explicit stop behavior. Appliance stop is a shared operation: never
make an environment cleanup call compose down -v on the shared server. Appliances
remain running during idle and destroy; report their ongoing resource footprint.
Container memory/CPU limits are separate from runly resource declarations.
Build/upkeep commands do not receive caller env_from inputs; provide required
server credentials through the repo's established local configuration mechanism,
without committing values or placing caller secrets into the daemon unit.

## Make the datastore contract real

Trace create, restore, URL and drop end to end. The app and test runner must use
the generated namespace, not a fallback default database hidden in config.
For container commands, distinguish host localhost/host ports from a container's
own localhost; decide where the database client runs and translate filesystem
paths only when actually mounted there.

Use disposable namespaces to demonstrate:

1. Create applies schema and seeds once; advertised logins actually work.
2. Restore from the template produces a usable independent namespace.
3. Mutating one copy does not alter the template or another copy.
4. Drop removes exactly its target, including partial-creation cleanup.
5. A preset/reset restores the intended dataset, without affecting another store.

Server drivers execute repo-declared create/drop/template_restore commands; the
driver name does not supply those commands automatically. Preserve quoting and
safe identifier handling in helpers. A command succeeding without checking the
actual database is insufficient.

For Redis and similar stores, verify namespace isolation is real: an isolated
prefix is not compatible with a global FLUSHALL. Do not share a destructive reset
command across environments. Use a dedicated isolated backing instance if the
application cannot constrain its keys/flush operation.

Recommend templating when measured migration/seed cost dominates startup and
the server supports a trustworthy restore. Include migration files, seed data,
schema-generation inputs and relevant scripts/config in the template trigger.
Templates are snapshots: ensure connections/files are consistent at capture.
Avoid remote downloads or time-dependent seeds being silently cached forever;
make their version an explicit tracked input, or keep templates private and
document manual invalidation. Never bake real credentials into shared fixtures.

Keep presets small and purpose-specific; put large optional test datasets behind
an explicit preset. Compare bake versus restore time and confirm repeated worktrees
reuse the intended key. Use share_templates: false when content depends on a
worktree path or state the key cannot represent.

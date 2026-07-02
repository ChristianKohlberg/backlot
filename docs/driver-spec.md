# Driver spec

infront has exactly two extension seams. Thinness is deliberate — it is what
"never own compute" looks like in code. The authoritative shapes live in
[`../src/drivers/types.ts`](../src/drivers/types.ts); this document is the prose
contract a driver author reads first.

Drivers are in-tree TypeScript modules in v1. The interfaces below are the freeze
candidates for 0.3, after which external drivers become supportable.

## Substrate driver

Where environments physically live. `local` supervises processes in a directory;
remote drivers (morph, sprites, ssh) do the same over a connection.

| Verb | Contract |
| --- | --- |
| `provision(spec)` | Create an environment home (directory or instance). Returns a handle with an exec transport and a filesystem root. Must be idempotent per env id. |
| `exec(env, cmd, opts)` | Run a command in the environment (cwd = env tree). Long-running service processes are started through this too; the **daemon** owns supervision policy, the driver owns the transport. Remote runs must support `detach: true` (submit-and-poll; see decision 0015). |
| `gitEndpoint(env)` | A git remote/path the sync layer can fetch/push through. |
| `expose(env, port)` | A consumer-reachable URL for a port. Local: `http://localhost:<port>`. Remote: the provider's tunnel/proxy URL. |
| `destroy(env)` | Irrevocably remove the environment. Safe by invariant 0011. |

Optional capabilities (declared, engine degrades gracefully):

- `pause` / `resume` — quiesce billing/RAM without losing state.
- `checkpoint` / `restore` — snapshot-based provisioning acceleration (decision 0006).
- Remote drivers **must** set a provider-side TTL on everything they create and tag
  instances with `{stack, pool, env}` metadata for `pool reconcile` (decision 0015).

## Datastore driver

What gives an environment its data state.

| Verb | Contract |
| --- | --- |
| `create(ns, preset)` | Create + seed the namespace (runs the manifest's `create:` command with `{{ns}}`/`{{preset}}` resolved). |
| `drop(ns)` | Remove the namespace. Must refuse anything outside infront's namespace pattern (belt-and-suspenders against config errors). |
| `url(ns)` | The connection string consumers receive. |
| `probe()` | Is the external server reachable? Failure is an `infra-error`, never a code blame. |

Optional capabilities:

- `templateBake(preset, seedHash)` / `templateRestore(ns, preset, seedHash)` — bake
  once per seed-content hash, restore in seconds thereafter. Postgres: native
  `CREATE DATABASE … TEMPLATE`; MSSQL: backup/restore; SQLite: file copy. Templates
  are machine-global and immutable-keyed; baking a new hash alongside an old one is
  the only sanctioned background work (decision 0008).
- `ephemeral: true` — no presets; `reset-data` = flush (Redis-class stores).

## What drivers never do

Decide policy. Pool sizing, lease TTLs, hygiene escalation, upkeep, sync, error
classification, and artifact collection are all engine concerns. A driver that wants
policy is a design bug.

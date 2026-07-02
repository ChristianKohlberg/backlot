# Driver spec

infront has two extension seams. Thinness is deliberate — it is what "never own
compute" looks like in code.

**Status (v0.4):** only the **datastore** seam is live, and its authoritative shape is
[`../src/drivers/datastores.ts`](../src/drivers/datastores.ts) (`DsDriver`) — described
below. The **substrate** seam is designed but not yet implemented: the engine currently
hardcodes local process supervision, and no `SubstrateDriver` type is wired. The
substrate interface freezes for 0.3 (the remote-substrate milestone); the sketch at the
end of this doc is a design target, not a callable contract. Drivers are in-tree
TypeScript modules; external drivers become supportable once the seams freeze.

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

The real interface is `DsDriver` (`src/drivers/datastores.ts`) — a handle-based shape,
because the sqlite driver's namespace is a file path derived from the environment:

| Method | Contract |
| --- | --- |
| `ns(h)` | The namespace for an environment (sqlite: a file path under the env's data dir; server drivers: a SQL-safe db name). Rejects path-escaping keys. |
| `url(h)` | The connection string consumers receive (server drivers template `url:` with `{{ns}}`). |
| `probe()` | Is the external server reachable? Failure is `infra-error`, never code blame. sqlite is a no-op. |
| `ensure(h, preset, force, exists)` | Create/restore the namespace at `preset`. `force` recreates; `exists` short-circuits an already-present ns on a `reuse` bind. Runs the manifest's `create:` / `template_restore:` / `drop:` commands with `{{ns}}`/`{{preset}}`/`{{template}}` resolved. |
| `drop(h)` | Best-effort removal (recycle) — the manifest's `drop:` command, or `rm` for sqlite. |
| `rebake()` | Invalidate baked templates (the `@rebake-template` upkeep built-in). |

Template behavior (via `template_restore:` for server drivers, `template: true` for
sqlite): bake once, keyed by the **`create:` command string** (not seed content — see
architecture §7), then restore per environment. `ephemeral: true` (Redis-class): no
presets/templates; `drop:` is the flush on reset, `create:` runs only on first bind.

**Namespace-drop safety:** the sqlite driver rejects keys containing `/`, `\`, or `..`,
and the command family sanitizes the ns to `[A-Za-z0-9_]` — but a server driver's
`drop:` command is repo-authored and runs verbatim, so its blast radius is the
manifest author's responsibility (the general trust model, README §Security).

## What drivers never do

Decide policy. Pool sizing, lease TTLs, hygiene escalation, upkeep, sync, error
classification, and artifact collection are all engine concerns. A driver that wants
policy is a design bug.

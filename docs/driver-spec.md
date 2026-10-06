# Driver spec

runly has three extension seams. Thinness is deliberate — it is what "never own
compute" looks like in code.

**Status:** the **datastore** seam is live, and its authoritative shape is
[`../src/drivers/datastores.ts`](../src/drivers/datastores.ts) (`DsDriver`); the
**preview publisher** seam (`PreviewPublisher`,
[`../src/drivers/preview.ts`](../src/drivers/preview.ts)) is live with three adapters
(`cloudflare-quick`, `cloudflare-named`, `tailscale`). The **substrate** seam is
designed but not implemented: the engine supervises local processes itself, and the
`SubstrateDriver` sketch in [`../src/drivers/types.ts`](../src/drivers/types.ts) is a
design target, not a callable contract. Drivers are in-tree TypeScript modules.

## Substrate driver

Where environments physically live. `local` supervises processes in a directory;
remote drivers (morph, sprites, ssh) do the same over a connection.

| Verb | Contract |
| --- | --- |
| `provision(spec)` | Create an environment home (directory or instance). Returns a handle with an exec transport and a filesystem root. Must be idempotent per env id. |
| `exec(env, cmd, opts)` | Run a command in the environment's worktree. Long-running service processes are started through this too; the **daemon** owns supervision policy, the driver owns the transport. Long remote operations must be submit-and-poll, never a held pipe (decision 0015). |
| *(open)* | How a remote substrate reaches the caller's worktree. The git-sync transport this seam once assumed was removed with the source copy (decision 0032). |
| `expose(env, port)` | A consumer-reachable URL for a port — how *this substrate* is reached at all, wired for every port at boot. Local: `http://localhost:<port>`. Remote: the provider's tunnel/proxy URL. Never public preview: publishing to the internet is opt-in per invocation and belongs to the preview seam below (decision 0027). |
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
| `ns(h)` | The namespace for an environment or copy (sqlite: a file path under its data dir; server drivers: a SQL-safe db name). Rejects path-escaping keys. |
| `url(h)` | The connection string consumers receive (server drivers template `url:` with `{{ns}}`). |
| `probe()` | Is the external server reachable? Failure is `infra-error`, never code blame. sqlite is a no-op. |
| `ensure(h, preset, force, exists)` | Create/restore the namespace at `preset`. `force` recreates; `exists` short-circuits an already-present ns on a `reuse` bind. Runs the manifest's `create:` / `template_restore:` / `drop:` commands with `{{ns}}`/`{{preset}}`/`{{template}}` resolved. |
| `drop(h)` | Best-effort removal (recycle) — the manifest's `drop:` command, or `rm` for sqlite. |
| `dropRecipe(h)` / `dropCommand(h)` | The drop as data, recorded on the environment or copy row before the namespace is created, so it can be dropped later without the manifest (decisions 0034, 0037). |
| `templateRef(preset)` | The template a restore uses, so retention keeps every referenced one (decision 0037). |
| `rebake()` | Invalidate baked templates (the `@rebake-template` upkeep built-in). |

Template behavior (via `template_restore:` for server drivers, `template: true` for
sqlite): bake once per preset, keyed by the **`create:` command string** plus the
trigger content of an `@rebake-template` rule (architecture §7), then restore per
environment and per copy. `ephemeral: true` (Redis-class): no
presets/templates; `drop:` is the flush on reset, `create:` runs only on first bind.

**Namespace-drop safety:** the sqlite driver rejects keys containing `/`, `\`, or `..`,
and the command family sanitizes the ns to `[A-Za-z0-9_]` — but a server driver's
`drop:` command is repo-authored and runs verbatim, so its blast radius is the
manifest author's responsibility (the [security model](overview.md#security-model)).

## Preview publisher

How one leased service is published by `runly preview` — a seam so adapters drop in
without touching the verb. The real interface is `PreviewPublisher`
(`src/drivers/preview.ts`); the shipped adapters are `cloudflare-quick` (a `cloudflared`
quick tunnel, the default), `cloudflare-named` (a named tunnel under a zone you own,
decision 0028) and `tailscale` (a foreground `tailscale serve`, decision 0031), selected
by the manifest's `preview.publisher`, else `BACKLOT_PREVIEW_PUBLISHER`, else the default.
Each publisher turns the manifest's `preview` block into an address itself.

| Method | Contract |
| --- | --- |
| `checkPrerequisite()` | Is the external tool usable? Its absence is an **env-error**, and `doctor` reports it for every stack that has preview configured. |
| `start({envId, service, localUrl, logDir})` | Spawn a supervised, backlot-tagged tunnel and return `{url, pid}`. The adapter **owns the process until it returns a pid**: if it throws, it must already have killed it — nothing downstream can reap a tunnel whose pid was never recorded, and a live one is a public, unauthenticated URL nobody can name. |
| `stop(rec)` | True **only** when the tunnel is confirmed gone; a false verdict keeps the caller's record, because a forgotten preview pid is a URL no one can ever reclaim. |

The engine, not the adapter, owns the lifetime: the tunnel is journaled on the lease row
and reaped when the *lease* ends, never when the services it publishes restart
([decision 0027](decisions/0027-lease-scoped-public-preview.md)).

## What drivers never do

Decide policy. Pool sizing, lease TTLs, the load budget, hygiene escalation, upkeep,
idle and teardown, and error classification are all engine concerns. A driver that
wants policy is a design bug.

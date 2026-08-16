# 0027. Lease-scoped public preview is explicit, supervised, and separate from expose

- Status: Accepted
- Date: 2026-08
- Context: agents and humans on the host can reach a leased service at
  `localhost`, but sharing that view with someone on another machine today means
  running `cloudflared tunnel --url …` by hand. That tunnel outlives the lease,
  nobody reaps it, and its URL is not recorded anywhere backlot knows about.
- Relates to: [0003](0003-durable-environments-disposable-leases.md) (leases are
  disposable), [0010](0010-error-taxonomy.md) (error classes), driver-spec
  (`expose` is for remote substrates, not local publishing)

## Decision

`backlot preview <service>` publishes **one** service port from the caller's
**existing lease** through a named **preview publisher** adapter (default:
Cloudflare quick tunnel via `cloudflared`). `backlot preview stop` tears it down.
The public URL is reported in the context blob (`previewUrls`) alongside local
`urls`.

Preview is **never** wired through the local substrate driver's `expose()` —
that function also supplies internal service URLs at boot and must not publish
every port as a side effect of starting the stack.

The tunnel process is a **supervised, tagged child** of the lease, and the lease
is exactly its lifetime: `release`, TTL lapse, a sweep that deletes the lease,
teardown, daemon shutdown, and crash recovery all reap it. Preview state (pid,
URL, service, local port) is journaled on the lease row.

Scoped to the lease means scoped to the lease and **not** to the service
incarnation it publishes. A `sync`, a rebind, or an idle quiesce restarts or
stops services while the lease continues, and the tunnel survives all of them —
ports are stable for an environment's lifetime ([0004](0004-watchers-never-move-bindings-move.md)), so
it is aimed at the same place when the services come back. Four things do break
that, and none of them may be silent. The bind is the boundary that notices,
because it is where the manifest is re-read and the running set decided — and so
is the `--watch`/`sync` **projection**, which re-reads the manifest and refreshes
the lease clock without rebinding, so a kill switch flipped under a watcher must
not wait days for the next full bind. It **reports** rather than throws, since
the bind itself is legitimate and failing it would strand the caller. Three tear
the tunnel down:

- **`preview.forbidden` is now set** (work-error class). The kill switch has to
  act on what is already published, not only refuse the next `preview` — and it
  acts as soon as the manifest is read, not at the epilogue like the rest, so a
  bind that fails later cannot leave a forbidden stack public. The other two are
  reconciled once the bind has COMMITTED its shape: judged from the requested
  slice at the top, a bind that then failed tore a tunnel down against a change
  that never happened.
- **The previewed service left the running set** (env-error class) — a narrowed
  slice (`up api`) or a conversion to `--data-only`. Unlike a quiesce, nothing
  brings it back this lease, so the URL would publish a port with nothing behind
  it. `previewStart` already refuses an out-of-slice service; this is the same
  rule applied to a tunnel that is already up.
- **The service moved to a different local port** (env-error class; its `port`
  key was renamed — existing keys are never reassigned). Only a real bind
  allocates for a renamed key, so a projection skips this one: until then the
  service is still listening exactly where the tunnel points.

The running set a reconcile judges against is the environment's **durable
shape**, never the supervisor's live pid map — a service in restart backoff is
absent from that map for a second, and reading it as "left the slice" would kill
a tunnel the restart makes correct again.

One keeps the tunnel and warns:

- **`--reset-data` or `--pristine` under a live preview.** The public URL is
  unchanged but now serves different data.

The message rides back on the **bind's own result** as `previewNotice` (`up`,
`sync`, `reset-data`), not through shared state a later unrelated `ctx` read
could consume first.

Because the tunnel outlives service restarts, the process-tag reclaim paths
(`reapEnvProcesses`' scan and `pool gc`) must **skip** a preview pid a live lease
still records — otherwise Linux would shoot it at a boundary where macOS keeps
it, which is the one platform split this reap cannot have.

Stacks may forbid preview in the manifest (`preview.forbidden: true`); refusal is
a **work-error**. `cloudflared` is an external prerequisite; its absence is an
**env-error**, and `doctor` reports it when preview is configured.

## Security posture

A quick-tunnel URL is **public and unauthenticated**. Anyone who holds the link
reaches the service — there is no access policy on the default publisher. Stacks
with fixed dev credentials or a known signing key must set `preview.forbidden`.

## Consequences

- New verbs: `preview`, `preview-stop` (CLI: `backlot preview …`, `backlot preview stop`).
- `ctx` gains `previewUrls` (parallel to local `urls`); a bind's response adds
  `previewNotice` when that bind invalidated or reclassified a live preview.
- Journal `leases` table gains nullable preview columns (additive migration).
- Publisher adapters live in `src/drivers/preview.ts`; stable named tunnels can
  be added without reworking the verb. An adapter **owns the process it spawned
  until it returns a pid** — if `start` throws, it must already have killed it,
  because nothing downstream can reap a tunnel whose pid was never recorded.
  `BACKLOT_PREVIEW_START_TIMEOUT_MS` overrides the wait for a URL (default 45s).
- Not addressed: authenticated preview (Cloudflare Access), stable hostnames, or
  remote-substrate `expose` — those are separate publisher implementations.

# 0028. A preview may publish under a hostname we own, and the publisher is where that lives

- Status: Accepted
- Date: 2026-08
- Context: [0027](0027-lease-scoped-public-preview.md) shipped preview with one
  publisher, `cloudflare-quick`, which is handed a random `*.trycloudflare.com`
  name at connect time. That is right for "look at this for ten minutes" and
  wrong for everything that outlives a sitting: a bookmark, a link in a ticket,
  a device that has to be told an address by hand, an OAuth callback, an app
  build pinned to a dev server. Every restart invalidates all of them.
- Relates to: [0027](0027-lease-scoped-public-preview.md) (the seam this fills),
  [0004](0004-watchers-never-move-bindings-move.md) (ports are stable for an
  environment's lifetime)

## Decision

**A second publisher, `cloudflare-named`, publishes to a hostname the operator
owns** — `<service>-<prefix>.<domain>` — through a Cloudflare *named* tunnel it
creates on first use and reuses thereafter. The manifest carries `preview.domain`
and, optionally, `preview.prefix`.

Everything 0027 decided still holds and is not restated here: the tunnel is a
supervised, tagged child of the lease, the lease is exactly its lifetime, and
every reconcile, reap and recovery path already knows it. A publisher is an
adapter behind a stable interface, and that is the whole point of the seam.

Three things follow, and each is a choice with an alternative that looks
cheaper.

**The publisher names the host; backlot does not.** `start()` gained a
`settings` argument carrying the manifest's `preview` block verbatim, rather
than the engine computing a hostname and handing it down. A hostname is a
publisher's dialect: `cloudflare-quick` cannot accept one, a future
`ssh-reverse` would want a port instead. Teaching the engine one publisher's
vocabulary is how an adapter seam stops being one.

**The tunnel and its DNS record outlive the lease.** They are created once per
`<prefix, service>` and reused. Making them per-lease would be tidier on paper
and would churn objects in the operator's Cloudflare account every few minutes,
with their reaping a second lifecycle to get right — and the whole reason to
name a tunnel is that the address survives. `stop()` therefore kills only the
process. Until the next publish the hostname answers with Cloudflare's "tunnel
not running" page: a visible, correct answer, and specifically **not** a pointer
at whatever else may now hold that local port.

**Uniqueness comes from the environment, not the manifest.** `prefix` defaults
to the environment id, which is unique by construction. A pooled stack has
several environments and one manifest, so a prefix written there is shared by
all of them, and the second publish of `web` takes the hostname from the first —
`route dns --overwrite-dns` says so out loud. The default is the safe one; the
manifest key exists to pin a name a human has to remember, and is correct only
where one environment of a stack runs at a time.

## Consequences

- **A wildcard record was considered and rejected.** `*.example.dev` → tunnel
  needs no per-hostname DNS at all, which is less privilege and less state — but
  it binds the entire zone to a single tunnel, so every previewed service must
  be served by one shared cloudflared process with one shared ingress file.
  0027's contract is one process per publication and `stop()` meaning
  *confirmed gone*; a shared process cannot honour it, because the pid another
  publication still references may not be killed. One tunnel per
  `<prefix, service>` keeps the contract and costs a DNS record.
- **Authorisation is not backlot's.** A named hostname is the thing you can put
  an access policy in front of, and Cloudflare Access matches on hostname
  patterns independently of DNS — so an operator covers `*.example.dev` once, by
  hand, and backlot needs no API token and holds no new secret. Publishing an
  unauthenticated URL remains exactly as dangerous as 0027 said it was; naming it
  makes the danger *durable*, which is an argument for the policy, not against
  the name.
- **The prerequisite is heavier.** `cloudflare-quick` needs a binary;
  `cloudflare-named` needs a binary **and** an origin certificate from
  `cloudflared tunnel login`, plus a zone. `checkPrerequisite` names the command
  that fixes it, because "unauthorized" from a tunnel create is not a sentence an
  operator can act on.
- **A manifest that names this publisher fails validation on an older backlot**
  with `the backlot manifest is invalid`, which reads as a broken manifest rather
  than an old install — the skew already documented for `auth.logins`. The
  release notes have to say the minimum version.

# 0031. A preview may publish on the tailnet, through a foreground `tailscale serve`

- Status: Accepted
- Date: 2026-10
- Context: [0027](0027-lease-scoped-public-preview.md) and
  [0028](0028-named-preview-hostnames.md) give preview two Cloudflare
  publishers, and both put the service on the public internet: the quick one
  unauthenticated, the named one behind whatever Access policy the operator
  remembered to write. A team whose reviewers already sit on one tailnet wants
  the opposite default — reachable by every device on the tailnet, by nobody
  else, with no zone, no tunnel object and no policy to keep in step. Until now
  that meant a hand-written `sudo tailscale serve --bg` next to runly, which
  nothing reaps: it outlives the lease, points at a port the pool may hand to
  someone else, and survives a rebind that moved the service.
- Relates to: [0027](0027-lease-scoped-public-preview.md) (lifecycle this reuses
  unchanged), [0028](0028-named-preview-hostnames.md) (the publisher seam and
  `settings`), [0004](0004-watchers-never-move-bindings-move.md) (ports are
  stable for an environment's lifetime)

## Decision

**A third publisher, `tailscale`, serves the previewed service on this
machine's tailnet name** — `https://<machine>.<tailnet>.ts.net:<port>` — by
running `tailscale serve --https=<port> <local url>` as a supervised, tagged
child of the lease. The manifest selects it with `preview.publisher: tailscale`
and may pin the port with `preview.https_port`.

Three choices follow, each with an alternative that looks simpler.

**Foreground, never `--bg`.** A foreground serve config is a session of the
`tailscale serve` process: tailscaled drops it when the process exits, by
SIGTERM or SIGKILL alike (measured on tailscale 1.102 — the URL answers 200
while the process runs and nothing a second after either signal). So the
tailnet mapping has exactly the lifetime of a pid on the lease row, and every
path 0027 built — `preview stop`, release, the reconcile on a moved port, the
teardown and `pool gc` reap — removes the URL by removing the process. `--bg`
writes persistent config that survives the process, the lease and a daemon
crash; nothing in the journal could ever name it again, which is the exact
failure 0027's "keep the record until the tunnel is confirmed dead" exists to
prevent.

**The operator, not sudo.** Changing serve config needs root or the machine's
tailscale *operator*. sudo per publish was rejected on measurement, not taste:
with `use_pty` sudo runs the command in its own process group, so the group
kill reaches sudo and not `tailscale serve`; with `env_reset` the runly tags are
stripped, so the tag scan cannot find the survivor either. A SIGKILLed sudo
left a live `tailscale serve` — and therefore a live URL — that no runly path
could reap. The prerequisite is instead `sudo tailscale set --operator=<user>`,
once per machine, and `checkPrerequisite` names that command.

**A derived port, not an allocated one.** Unpinned, the port is
`21000 + hash(environment id, service) mod 1000`, walking forward past any port
this machine already serves (persistent config and live foreground sessions
alike). Derived means stable: the same environment re-publishing after a
rebind or a `preview stop` hands back the address the reviewer already has,
which is what a tailnet name is for. A pinned `https_port` that is already
served is a work-error rather than a takeover — taking it would silently
repoint someone else's address.

## Consequences

- The exposure is the tailnet, not the internet: anyone on the tailnet (subject
  to its ACLs) reaches the service, nobody else. Stacks with fixed dev logins
  that `forbidden` keeps off the public publishers may consider this one
  acceptable; `forbidden` still refuses every publisher, by design — it says
  "never publish", not "never publish publicly".
- One preview per lease still holds (0027). A stack that wants two services on
  the tailnet runs two leases or waits for multi-service preview.
- Funnel (`tailscale funnel`, public) is deliberately not part of this
  publisher: it would reintroduce the public exposure the publisher exists to
  avoid, and it only allows ports 443, 8443 and 10000.
- Tests fake the CLI (`BACKLOT_TAILSCALE`); a real one would change the serve
  config of whatever machine runs the suite.

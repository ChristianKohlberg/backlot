# 0033. The daemon holds every public port behind an L4 proxy; ports come from three disjoint blocks

- Status: Accepted — amended by [0035](0035-services-idle-on-their-own-clock-and-wake-on-demand.md): the wake hook ("step 6") is installed — a connection to an idle-stopped service starts it; a refused connection during a crash restart is held
- Date: 2026-10
- Amends: [0031](0031-tailscale-preview-publisher.md) — derived tailnet ports move
  from 21000–21999 to the tunnel block
- Context: until 0.13 an environment's port was the port its service listened
  on. The number came from the OS (`listen(0)`), so it sat in the ephemeral
  range that outbound connections also draw from, and it was free for anybody
  whenever the service was not running — a quiesced environment, a restart, a
  daemon that was down. A client that connected during a restart was refused,
  so every `up` that restarted a dev server broke an open browser tab or a
  running test. And runly had no way to tell whether anyone was still *using*
  an environment: its only clock was its own verbs, which says nothing about a
  human clicking through the app or a test suite hammering it. The lifecycle
  work (idle quiesce, start on demand, decision pending as step 6) needs that
  signal.

## Decision

**Two ports per service port.** The **public** port is what everyone outside
the service sees: `ctx` and `ctx --env`, `exec`, builds, `{{ports.x}}` in other
services, `{{services.x.url}}`, and the preview tunnels. The daemon listens on
it, on 127.0.0.1 and ::1, for the environment's whole life — from the first
bind until teardown, not just while services run — and pipes TCP to the
**internal** port, which the service is started on and which is chosen fresh at
every start. Readiness probes go straight to the internal port.

**The proxy is pure L4.** It reads no protocol: HTTP, WebSockets, gRPC and a
database wire protocol pass the same way. Half-closes are forwarded. It knows
three states per port, set by the engine:

- **up** — forward to the current internal port;
- **starting** — hold new connections (paused, so nothing they send is lost)
  until the service is ready, then forward them; bounded by
  `BACKLOT_PROXY_HOLD_MS` (default 90 s), after which a held connection is
  closed. A bind that fails closes them at once;
- **down** — close the connection at once, which is what a client saw before
  the proxy existed. A **wake hook** (`ProxyHub.setWakeHook`) may instead claim
  the connection and start the environment; nothing installs one yet (step 6).

**It counts.** Per environment and port: client→server bytes, the time of the
last client byte, open, held and accepted connections. `status --json` and
`ctx --json` carry them as `proxy`. Counters live in daemon memory and start at
zero with each daemon life. runly's own probes never reach the proxy, so they
are never counted; a preview tunnel does reach it, so tunnel traffic counts.

**Templating.** In a service's **own** `run:` and `env:`, `{{ports.<its key>}}`
is the internal port — that is where it must listen. Everywhere else, and for
every other key, `{{ports.x}}` is public. `{{public_ports.x}}` is always the
public port (a service that advertises its own address uses it).
`{{services.x.url}}` is always public.

**Services talk to each other through the public port.** The SPA dev server
that forwards `/api` to the API reaches it through the proxy. That is the
simplest rule (one address per service, the same one a human uses), a request
held across an API restart reaches the new process instead of failing, and the
traffic counts as activity — which is right: a browser driving the SPA is using
the API too.

**Three disjoint port blocks, all below every common ephemeral range** (Linux
32768–60999, macOS/BSD 49152–65535):

| Block | Default | Used for | Override |
| --- | --- | --- | --- |
| public | 20000–29999 | environment ports, held by the proxy | `BACKLOT_PORT_RANGE` |
| internal | 30000–31999 | where services listen, fresh per start | `BACKLOT_INTERNAL_PORT_RANGE` |
| tunnel | 32000–32767 | derived tailnet HTTPS ports (0031) | `BACKLOT_TUNNEL_PORT_RANGE` |

A public port is allocated once per environment and port key, recorded in the
journal and never handed out while any environment row records it or the proxy
holds it; a candidate must also probe free on loopback and the IPv4 wildcard
(so a port a tunnel binds on the tailnet IP is skipped). Allocation scans from a random
offset and skips anything inside the ephemeral range read from
`/proc/sys/net/ipv4/ip_local_port_range`. The daemon logs a warning when a
configured block overlaps that range or another block; `status --json`
reports the blocks under `ports`.

**A public port moves only when it cannot be held.** At daemon start the proxy
takes back every recorded port before serving any verb, and every bind checks
it again. A port is reallocated (journalled at once, reported in the bind's
progress and as a `proxy` event) when it lies outside the public block — a
journal written by 0.13 — or when another process took it while no runly
listener held it (the daemon was down). runly never touches that process. A
moved port is a full bind (services that template other services' addresses
must restart), and preview reconciliation (0027) tears down a tunnel aimed at
the old port, as for any port move.

**Pinned tunnel ports stay free.** `preview.https_port` and `--https-port` may
name any port, including one in the public block: `tailscale serve` binds the
tailnet address only (measured: 127.0.0.1 and ::1 bind fine on a port tailscale
serves), so it cannot collide with the proxy's loopback listeners, and the
public allocator skips a port tailscale already binds.

## Consequences

- A URL stays good for the environment's life; a restart no longer refuses
  connections, it delays them.
- The daemon holds one or two listening sockets per service port of every
  environment, and every proxied connection costs it two sockets. That is
  small next to the services themselves; the hold queue is capped per port.
- A daemon restart (`runly update`) takes the public ports back before any
  bind. Services were already stopped by a daemon restart (0009), so nothing
  changes there.
- The first 0.14 daemon moves every port a 0.13 journal recorded, once. A
  preview tunnel does not survive a daemon restart anyway (0027); re-publish.
- A service that ignores `{{ports.x}}` and listens on a hard-coded port was
  already unsupported; now it is also unreachable through its public port.
- Step 6 builds idle detection on `proxy.lastActivityAt` and start-on-demand on
  the wake hook. Neither is policy here.

## Alternatives considered

- **HTTP-aware reverse proxy.** Would give request counts and could answer
  `503` with a retry hint, but every non-HTTP service (a database, a gRPC API)
  would need a second path, and WebSockets and HTTP/2 need care that TCP gets
  for free. Rejected: bytes are enough for an activity signal.
- **Keep one port and hold it with `SO_REUSEPORT`.** Platform-specific and
  still refuses connections between the old process exiting and the new one
  binding. Rejected.
- **Hold public ports only while leased.** The pool keeps unleased
  environments warm and reuses them; a port free for anyone while unleased can
  be taken, and then moves. Holding for the environment's life is simpler and
  stronger.
- **Keep the OS allocator.** Ports in the ephemeral range collide with
  outbound source ports, are unpredictable across a box, and cannot be
  firewalled or forwarded as a block. Rejected.

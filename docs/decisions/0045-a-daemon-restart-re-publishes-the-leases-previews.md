# 0045. A daemon restart re-publishes the leases' previews

- Status: Accepted
- Date: 2026-10
- Amends: [0027](0027-lease-scoped-public-preview.md) — what crash recovery and
  `shutdown` do to a lease's preview; [0039](0039-teardown-keeps-templates-a-leased-environment-survives-a-crash-loop.md)
  — the supervised daemon
- Context: a preview is scoped to the lease, and leases survive a daemon
  restart; their tunnels did not. `recover()` reaped every tunnel (rightly:
  a tunnel whose daemon died is supervised by nobody) and took the public
  ports back, but nothing published again, so a tailnet or Cloudflare URL
  stayed dead until someone ran `runly preview` again. Measured on the
  founding box: after a daemon kill, the demo URL answered 000 until a manual
  re-run. With the daemon under systemd (0039), a restart is routine.

## Decision

The lease row keeps what `runly preview` published, separately from the live
tunnel: `leases.preview_restore` = service, URL, the public port it was
aimed at, the publisher, and the settings that reproduce the address (the
manifest's `preview` block, the caller's `--https-port`, and what the
publisher pinned — `tailscale` pins the derived port it chose). It is written
only by its own setter, never by a lease save, so a stale lease snapshot
cannot erase it.

`shutdown()` and `recover()` reap the tunnel as before and keep the record.
Once `recover()` holds the public ports, it publishes every recorded preview
again, in the background (a publisher may take up to 45 s), each under its
environment's lock: same publisher, same settings, aimed at the same public
port. Nothing behind the port is started for it — the first request wakes
the service as any request does. A restore checks what a publish checks (the
lease, `preview.forbidden`, the service is wanted, the port is unchanged) and
stops a tunnel it started for a lease that ended meanwhile.

Success is an event, a warning when the address changed (`cloudflare-quick`
cannot keep one). Failure is an error event and `ctx.previewRestore =
{ service, url, state: 'failed', error }`; while it runs, `state:
'restoring'`. The record stays, so the next restart tries again; `runly
preview` replaces it, and `preview stop` forgets it (also one that failed).
Ending a preview on purpose — `preview stop`, a bind that tears it down
(`forbidden`, the service `down`, its port moved), a tunnel the sweeper finds
dead — forgets the record; the lease ending deletes it.

A row from before 0.20 has no record; `recover()` writes one from its
preview columns before reaping (publisher: the manifest's).

## Consequences

- A preview survives a daemon crash, an update and `daemon stop`, at the
  same address for `tailscale` and `cloudflare-named`.
- A lease that is never used again keeps its preview published after a
  restart until the lease ends — as it would have without the restart.
- A tunnel that dies on its own while the daemon runs is still reported
  and not restarted.

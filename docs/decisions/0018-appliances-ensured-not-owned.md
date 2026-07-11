# 0018. Appliances: singular backing servers are ensured, never owned

- Status: Accepted

## Decision

A stack may declare `appliances:` — singular, machine-shared backing servers (a
Postgres server, a Redis, a MinIO) that environments point at but that belong to
no environment. Each appliance declares:

- `probe:` (required) — `host:port`. Reachability IS the appliance's identity:
  whoever answers is the appliance, no matter who started it.
- `start:` (optional) — a daemonizing repo command (`docker run -d …`, `brew
  services start …`) run **once, machine-wide** (a state-dir lock keyed by the
  probe target serializes concurrent starters across stacks) when the probe
  fails. Absent `start:`, an unreachable appliance stays what it is today: an
  infra-error the human resolves.
- `stop:` (optional) — used only by the explicit `backlot appliance stop <name>`
  verb. backlot **never stops an appliance automatically** — appliances are
  durable the way environments are; heat is the point.
- `ready:` (optional) — a command polled after TCP accepts (exit 0 = ready),
  because servers like Postgres accept connections before they serve them.

Binds ensure appliances before anything else. Every appliance failure is an
`infra-error` by construction — an appliance is never anyone's code.

## Rationale

Decision 0012 keeps backing infra external and merely probed — which is honest
but leaves the worst first-run experience in the product: `infra-error: is the
server running?` means a human context-switch to some compose file backlot
pointedly knows nothing about. In practice every repo has exactly one blessed
way to bring these servers up, and it is a shell command. Letting the manifest
declare that command closes the gap without violating "never own compute":

- backlot still runs **commands, not containers** — `docker run -d` is a
  command like any other; Docker (or launchd, or systemd) owns the process.
- backlot still **never supervises** the appliance: no restart budget, no
  readiness watching after boot, no teardown on recycle. Adopt-if-answering
  also means a compose-started or teammate-started server is simply *up*.
- The error taxonomy sharpens: "unreachable and I was told nothing" and
  "unreachable after the declared start failed" are both infra-errors, but the
  second carries the start command's output — actionable either way.

The name is deliberate: an appliance sits in the corner and hums. You plug
things into it; you do not lease it, namespace it, or bind work to it. The
per-environment slicing of an appliance's capacity stays where it lives today
— in `datastores:` namespaces.

## Anti-scope

No dependency ordering between appliances, no health supervision, no automatic
stop/reap (not even `pool recycle --all`), no per-environment appliances (that
is a service), no compose-file parsing. If an appliance needs orchestration,
its `start:` command can call whatever orchestrator the repo already has.

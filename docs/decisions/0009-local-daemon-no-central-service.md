# 0009. A per-machine auto-spawned daemon; no central service; disk is truth

- Status: Accepted

## Decision

- No deployed/central service. One per-machine state root: a SQLite journal (pool,
  leases, bindings, ports) + environment directories, under XDG state/cache dirs.
  Pools are keyed per stack.
- The CLI auto-spawns a **per-machine daemon** on first use (tmux/Docker pattern),
  speaking HTTP over a unix socket. The daemon is the **parent process of every
  service** it supervises.
- Local even when compute is remote: remote environments are pool entries driven over
  SSH by the local daemon.
- **Disk is truth; daemon memory is a cache.** Restart/reboot recovery reconciles:
  dead PIDs → envs marked warm; expired leases → released; orphaned run namespaces →
  dropped (pattern-guarded).
- Laptop sleep: on wake the daemon detects the clock jump and **pardons the gap**
  (deadlines shift by sleep duration) with a **wake grace** before health probes count.
- Team mode (same daemon on a shared host, TCP + auth) is a possible future, not v1.

## Rationale

Processes need a parent: readiness, lease expiry, and idle quiescing must happen while
no CLI runs. Daemon-as-parent makes crash detection SIGCHLD-instant and deletes the
port-polling/PID-guessing zombie machinery hand-rolled harnesses accumulate.

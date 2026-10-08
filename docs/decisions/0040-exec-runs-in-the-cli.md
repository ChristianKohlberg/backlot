# 0040. `runly exec` runs its command in the CLI; exec and token resume an environment a daemon restart stopped

- Status: Accepted
- Date: 2026-10
- Amends: [0032](0032-environments-run-in-the-callers-worktree.md) — where
  `exec` runs; [0039](0039-teardown-keeps-templates-a-leased-environment-survives-a-crash-loop.md)
  — a verb no longer refuses an environment a daemon restart stopped
- Context: the daemon ran `exec`'s command under the environment's lock with
  piped output. The command saw the daemon's environment, not the caller's;
  its output came back after it ended, cut to the last 8 KB per stream; every
  non-zero exit became 1; nothing could be typed into it; the environment's
  lock was held for the whole run, so an `up` next to a long test run waited
  for it; and the daemon killed it at 600 s. After a daemon restart (`runly
  update`), `exec` and `token` refused with "run 'runly up'" although a
  connection to the same port would have woken the service.

## Decision

`exec` is one RPC (`exec-env`) and a local spawn. The daemon resumes the
environment (starts its stopped services, as a wake would) and records the
use, under the environment's lock, and returns the variables `ctx --env`
prints plus `BACKLOT_URL_*`, `BACKLOT_PORT_*`, `BACKLOT_DS_*`. The CLI runs the
command in the worktree with the caller's environment plus those variables and
the environment's process tag, on the caller's terminal, and exits with its
code (128+n for a signal). `--json` collects stdout and stderr whole. While it
runs the CLI touches the environment once a minute; no lock is held. The
command is the caller's process: the tag identifies it, but no daemon path (gc,
recycle, shutdown) reaps it. It has no deadline unless `BACKLOT_CMD_TIMEOUT_S`
sets one (then exit as a work-error, the group killed).

`exec` and `token` start services that a daemon restart stopped, the same way
as idle-stopped ones. A failed `up` is still redone only by `up`.

## Consequences

- `exec` exit codes are the command's; scripts that relied on "0 or 1" see the
  real code.
- An environment destroyed while an `exec` runs does not stop the command.

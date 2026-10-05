# 0037. Teardown carries its own drop recipes; templates are collected by reference; `runly pool doctor` finds what was left behind

- Status: Accepted
- Date: 2026-10
- Amends: [0032](0032-environments-run-in-the-callers-worktree.md) —
  `templatesKeep` counts per datastore and preset, not per stack
- Context: three kinds of leftovers accumulated on long-lived boxes. An
  environment's server-side databases were dropped with the `drop:` command
  from the manifest *at teardown time* — gone or different once the worktree
  was deleted or moved to another branch, so the databases stayed. Templates
  were kept "the newest four per stack", which kept old seeds no environment
  used and dropped ones an environment was still restored from. And nothing
  could say what was orphaned: the test suite alone left service processes
  behind on every run, because fixtures SIGKILLed the daemon and deleted its
  state root, which hid the survivors from every later sweep.

## Decision

**Drop recipes are recorded on the row.** Before a datastore is created for
an environment, how to drop it is written on the environment row
(`envs.drop_recipes`: a command and its directory, or a file path under the
state root). Teardown uses the recorded recipe and falls back to the manifest
only for rows older than 0.16. Copies did this already (0034).

**Templates are collected by reference.** Every environment and copy records
which template it was restored from (`envs.templates`, `db_copies.template`).
In each stack, per datastore and preset (the template name before its content
key), retention keeps the newest `templatesKeep` (default **1**: the current
seed content), plus every template a row references; anything else goes once
it is older than `BACKLOT_TEMPLATE_GRACE_MS` (default 1 h — a just-baked
template a restore is about to reference is not raced). A stack that can never
be bound again — no row names it and its worktree is gone — keeps nothing.
Server-side templates are dropped with their persisted command (as before).

**`runly pool doctor [--fix] [--json]`** — a dry run by default — lists:

- environment directories, copy directories and worktree records no row names
  (the latter only when its worktree is gone);
- template markers that are superseded and unreferenced, or of a dead stack;
- server-side namespaces reported by a datastore's new `list:` hook that are in
  runly's naming (`backlot_<stack>_…`, `backlot_tpl_<stack>_…`) and that no
  environment, copy or template references;
- service processes carrying this state root's tag whose environment is gone
  or should run nothing;
- public listeners of environments the journal no longer has.

`--fix` removes them. It touches only what is runly's: files under the state
root in runly's layout, processes tagged with **this** state root, namespaces
whose stack id this state root has a record of. A namespace in runly's naming
of a stack it does not know (another state root's) is listed as
`foreign-namespace` and never touched; names outside runly's naming are not
listed at all. `runly doctor` keeps its health and drift report.

**The test suite proves it leaks nothing.** One private TMPDIR per run
(vitest `globalSetup`); every fixture disposes of a state root in one order —
stop the daemon with SIGTERM and wait, kill whatever still carries the state
root's tag, then remove the directory; and the run ends with a /proc scan for
any process whose `BACKLOT_STATE_ROOT`/`BACKLOT_STATE_DIR` lies under that
TMPDIR. One found fails the run (`BACKLOT_LEAK_CHECK=report` only reports).

## Consequences

- Deleting a worktree no longer strands its databases on a shared server.
- A box keeps one template per datastore and preset plus the ones in use,
  instead of four per stack regardless.
- `pool doctor` needs `list:` to see server-side namespaces; without it, only
  what is on disk and in /proc is checked.
- Known gap: a namespace long enough to be shortened (63 bytes, with a hash)
  may lose its stack prefix and is then reported as foreign, never fixed.

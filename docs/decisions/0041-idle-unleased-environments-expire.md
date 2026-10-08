# 0041. An unleased environment nobody uses for 24 hours is torn down

- Status: Accepted
- Date: 2026-10
- Amends: [0035](0035-services-idle-on-their-own-clock-and-wake-on-demand.md)
  — how an environment ends; [0039](0039-teardown-keeps-templates-a-leased-environment-survives-a-crash-loop.md)
  — what `destroy` keeps of the upkeep ledger
- Context: a released or expired lease left its environment in place for the
  worktree's next `up`: its services stopped, but its databases, ports and
  directory stayed until the machine-wide cap evicted it — on a big box,
  never. Worktrees nobody came back to held databases for weeks. Separately,
  `destroy` kept the worktree's upkeep ledger (0039), and a worktree pool that
  then ran `git clean -fdx` removed what the rules had made (`node_modules`)
  while the ledger still said they were done.

## Decision

The sweep tears down an environment that has no lease and has not been used
(no verb that uses it, no client byte) for `BACKLOT_UNLEASED_TTL` (default
24 h, a duration or `off`; `unleasedTtl` in `config.json`): services, data,
ports, its row. Templates and the worktree's records (upkeep ledger, trigger
cache, build ledger) stay, so the next `up` there restores from a template
and skips upkeep whose output is still there.

An upkeep rule may declare `outputs:` (a path or a list): it runs again when
one is missing. `destroy` forgets the rules that declare none, so they run on
the next `up`; the ones that declare outputs are trusted while they exist.

## Consequences

- A worktree left alone for a day starts with a restore, not a reuse.
- Rules that install dependencies should declare `outputs:` to keep the
  benefit of the ledger across a pool's destroy + clean.

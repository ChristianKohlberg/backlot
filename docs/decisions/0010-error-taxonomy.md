# 0010. Error taxonomy: work-error / env-error / infra-error

- Status: Accepted

## Decision

Every failure backlot reports carries a class, in JSON:

- `work-error` — the synced code is at fault (compile error, upkeep failure triggered
  by the binding's own change, failing check). The consumer fixes and re-syncs.
- `env-error` — the environment is at fault (stale cache, missing toolchain, flapping
  service). backlot auto-remediates by recycling.
- `infra-error` — something external (backing DB unreachable, registry down). An
  actionable message; nobody's code is blamed, nothing is recycled.

Declared `fatal_logs` markers fail a boot in seconds instead of timing out readiness;
a service crash mid-run fails the run explicitly — never a silently wrong verdict.

## Rationale

The single most valuable bit for an agent is "is this my code or the environment?" —
it determines the next action mechanically. Making the classification a first-class
output (not prose in a log) is the product's core contract.

# 0007. Hygiene levels: reuse / reset-data / pristine, with auto-escalation

- Status: Accepted

## Decision

Every bind carries a hygiene level:

- `reuse` — keep everything (human inspect loop; fastest).
- `reset-data` — restore the data template, keep build caches (default for runs).
- `pristine` — a fresh environment (merge-grade verdicts).

Two consecutive failures of the same kind on the same warm environment auto-escalate
to `pristine`. Environments also recycle mechanically (max bindings or age).
`reset-data` is additionally exposed as a mid-lease verb (replay a repro against
pristine data). Ephemeral stores (Redis-class) implement reset as flush.

## Rationale

Warm pools trade hygiene for speed; a product must name that trade instead of averaging
it away. Auto-escalation is the standard defense against stale-cache heisenbugs.
**Warm is a cache, not a home** — the pool stays honest only while discarding any
environment is cheap, which is why the pristine path must stay fast (templates, shared
package stores).

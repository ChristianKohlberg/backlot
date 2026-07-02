# 0002. Core nouns: Stack, Substrate, Environment, Binding, Lease, Run

- Status: Accepted

## Decision

The whole system is expressed in five nouns and one verb-noun:

- **Stack** — the repo's declaration (`stack.yaml`): services, datastores, presets,
  upkeep rules, checks. The only repo-specific artifact.
- **Substrate** — where environments physically live, behind a driver (`local`,
  later `docker`/`morph`/`sprites`/`ssh`).
- **Environment** — a pooled slot on a substrate: own tree copy, warm caches, running
  services, allocated ports, a datastore namespace. Durable; owned by the pool.
- **Binding** — a source state (ref + dirty diff) plus a data state (preset at a
  hygiene level) attached to an environment. An immutable snapshot.
- **Lease** — temporary ownership with a TTL refreshed by any CLI touch.
- **Run** — a named check executed against a binding: exit code + JSON verdict +
  collected artifacts.

## Rationale

Every prior harness verb (demo, serve, infra, run, teardown) is a point in this space;
naming the axes is what lets one engine serve inspection, e2e, and agent loops without
special cases.

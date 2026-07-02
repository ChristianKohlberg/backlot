# 0001. Thesis and anti-scope

- Status: Accepted

## Decision

infront puts a working instance of a web application in front of a coding agent or
human — running, seeded, authenticated, provable — as a cheap repeatable act. It
**brokers** environments; it never provides them.

Hard boundaries, permanent:

1. **Never own compute** — local processes and BYO cloud sandboxes via drivers only.
2. **Never be a build system** — invoke the repo's commands, never understand them.
3. **Never be CI** — CI may call infront, never the reverse. CI proves committed state
   to a team; infront proves arbitrary (usually dirty) state to one consumer.
4. **Never be the agent** — no LLM calls, no browser driving, no test authoring.

Scope for v1: web applications (N HTTP-ish services + M datastores, browser as primary
consumer). Not: Kubernetes, Windows, secrets management, dashboards.

## Rationale

Tools in this space die of scope creep; every boundary above is a category with mature
incumbents (compute: Morph/Sprites/E2B; build: the repo's own tooling; CI: actions).
The unowned layer is the repo-aware broker between them.

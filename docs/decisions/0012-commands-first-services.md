# 0012. Services are commands, not containers; backing infra is external and probed

- Status: Accepted

## Decision

A service in `stack.yaml` is a shell command supervised by the daemon (`build:`,
`run:`, optional `watch_run:`), with symbolic ports and templated env injection.
Backing infrastructure (database servers, message brokers) is **externally run** —
typically the repo's own docker compose — and declared with a `probe:` so infront can
fail with `infra-error` instead of blaming code. Portless services (workers) declare
readiness by log marker or command. Containers may arrive later as a *substrate*
option, never as a service concept.

## Rationale

Commands are how web-app dev loops actually run; containerizing them would tax the
inner loop (especially on macOS) and force container stories onto repos that lack
them. Keeping infra external honors "never own compute" at the local scale too.

# 0013. TypeScript on Node ≥ 22, one npm package, Apache-2.0

- Status: Accepted

## Decision

- Implementation: TypeScript, Node ≥ 22 (built-in `node:sqlite` → zero native deps;
  stdlib process supervision, unix-socket HTTP, fetch probes).
- Distribution: **one** published npm package (`infront`), `npx infront up` as the
  install story. Package splits only when a third-party driver appears. Single-binary
  packaging (bun compile) is a later option, not an architecture fork.
- Manifest: YAML + published JSON Schema (editor autocomplete via `$schema`).
- License: Apache-2.0 (patent grant; the neighborhood convention — Tilt,
  container-use, Dagger).

## Rationale

The scoped audience (web applications) universally has Node; the broker's work is
orchestrating child processes, so a systems language buys unneeded performance at the
cost of iteration speed for maintainers and agent contributors. `node:sqlite` removes
the classic npx-daemon failure mode (node-gyp roulette).

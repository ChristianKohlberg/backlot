# infront

**infront puts a working instance of your web application in front of a coding agent
(or a human) — running, seeded, authenticated, provable — as a cheap, repeatable act.**

It brokers environments; it never provides them. Local processes today, your own cloud
sandboxes (Morph, Sprites, SSH) tomorrow — same verbs, same model.

> **Status: 0.4-core, gap-closing batch landed.** The local loop is complete and
> battle-proven: daemon with **per-environment concurrency**, warm pool, leases,
> stat-gated bind-by-sync, **`--watch` streaming**, sqlite + server datastores
> (postgres/mssql/mysql) with template restore and **ephemeral (flush) stores**,
> checks with verdicts/artifacts, detached submit-and-poll runs, **hygiene
> auto-escalation + degraded auto-reap**, idle quiesce, crash recovery, a `token`
> verb, an MCP adapter (`infront-mcp`), and a foreign-runtime consumer (Python).
> Proven on a real .NET + Angular + MSSQL monorepo end to end — including its
> Playwright system-e2e suite running against infront-provisioned environments.
> Not yet: a live remote substrate driver (morph/ssh) and the npm publish. Design in
> [docs/architecture.md](docs/architecture.md); decisions in [docs/decisions/](docs/decisions/).

## Why

Coding agents need three things from an app under development, constantly: a running
seeded instance to **inspect**, a deterministic environment to **prove** changes in
(e2e, with a machine-readable verdict), and a seconds-fast **iterate** loop — all for
*uncommitted worktree state*, which CI can never serve. Hand-rolled harnesses converge
on the same machinery in every repo (port allocation, DB namespacing, capacity gating,
zombie reaping) and stay welded to that repo. infront is that machinery, extracted,
with the repo-specific knowledge moved into one declarative file.

The core trick: **environments are pooled, durable, and warm; work visits them.**
Binding your worktree to a warm environment is a git sync + fingerprint-gated upkeep —
seconds, not minutes. Abandoning an environment is a non-event: your lease lapses and
the environment returns to the pool with its heat intact. ([Why not checkpointing?](docs/decisions/0006-convergence-over-checkpointing.md))

## Quickstart

```bash
npm install && npm run build && npm link   # once, until infront is on npm
cd examples/hello-web
infront up --json          # lease a warm env: sync, seed, start, print URLs + creds
infront run smoke --json   # bind -> run the check -> JSON verdict -> release
infront ctx --json         # everything an agent needs, in one blob
infront release            # environment returns to the pool, warm
```

Requires Node ≥ 22.5 and git. The daemon auto-spawns on first use (unix socket,
per-machine state under `~/.local/state/infront`; isolate with `INFRONT_STATE_DIR`).

A repo opts in with one file, `stack.yaml` ([schema](schema/stack.schema.json)):

```yaml
name: myapp
services:
  api:
    run: dotnet run --no-build --project backend/Host
    port: api
    env: { ConnectionStrings__Main: "{{datastores.main.url}}" }
    ready: { http: /health }
datastores:
  main:
    driver: postgres
    create: bin/seed {{ns}} {{preset}}
    presets: [dev, empty]
    template: true
upkeep:
  - { when: pnpm-lock.yaml, run: pnpm install --frozen-lockfile }
checks:
  e2e: { run: pnpm e2e, artifacts: [test-results/**] }
```

Services are commands, not containers. Backing infrastructure (your DB server) stays
externally run — infront probes it and classifies its absence honestly
(`infra-error`, never blaming your code).

## What it is / is not

| infront is | infront is not |
| --- | --- |
| a warm pool of leased, isolated environments | a compute provider (bring your own, local or cloud) |
| bind-by-sync: your dirty worktree, in front, in seconds | a build system (it invokes your commands, never understands them) |
| seeded, template-restored data states | CI (CI may call infront; never the reverse) |
| machine verdicts with a work/env/infra error taxonomy | an agent (no LLM calls, no browser driving) |

Read [docs/architecture.md](docs/architecture.md) — it's short, and it *is* the product.

## License

Apache-2.0.

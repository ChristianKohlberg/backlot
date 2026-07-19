# backlot

**backlot puts a working instance of your web application in front of a coding agent
(or a human) — running, seeded, authenticated, provable — as a cheap, repeatable act.**

It brokers environments; it never provides them. Local processes today, your own cloud
sandboxes (Morph, Sprites, SSH) tomorrow — same verbs, same model.

> **Status: 0.4-core, gap-closing batch landed.** The local loop is complete and
> battle-proven: daemon with **per-environment concurrency**, warm pool, leases,
> stat-gated bind-by-sync, **`--watch` streaming**, sqlite + server datastores
> (postgres/mssql/mysql) with template restore and **ephemeral (flush) stores**,
> checks with verdicts/artifacts, detached submit-and-poll runs, **hygiene
> auto-escalation + degraded auto-reap**, idle quiesce, crash recovery, a `token`
> verb, an MCP adapter (`backlot-mcp`), and a foreign-runtime consumer (Python).
> Proven on a real .NET + Angular + MSSQL monorepo end to end — including its
> Playwright system-e2e suite running against backlot-provisioned environments.
> Published: [`npm i -g backlot`](https://www.npmjs.com/package/backlot). Not yet: a live remote substrate driver (morph/ssh). New here?
> Start with the two-page [docs/overview.md](docs/overview.md). Design in
> [docs/architecture.md](docs/architecture.md); decisions in [docs/decisions/](docs/decisions/).

## Why

Coding agents need three things from an app under development, constantly: a running
seeded instance to **inspect**, a deterministic environment to **prove** changes in
(e2e, with a machine-readable verdict), and a seconds-fast **iterate** loop — all for
*uncommitted worktree state*, which CI can never serve. Hand-rolled harnesses converge
on the same machinery in every repo (port allocation, DB namespacing, capacity gating,
zombie reaping) and stay welded to that repo. backlot is that machinery, extracted,
with the repo-specific knowledge moved into one declarative file.

The core trick: **environments are pooled, durable, and warm; work visits them.**
Binding your worktree to a warm environment is a git sync + fingerprint-gated upkeep —
seconds, not minutes. Abandoning an environment is a non-event: your lease lapses and
the environment returns to the pool with its heat intact. ([Why not checkpointing?](docs/decisions/0006-convergence-over-checkpointing.md))

## Quickstart

```bash
npm i -g backlot                           # or from a checkout: npm install && npm run build && npm link
cd examples/hello-web
backlot up --json          # lease a warm env: sync, seed, start, print URLs + creds
backlot run smoke --json   # bind -> run the check -> JSON verdict -> release
backlot ctx --json         # everything an agent needs, in one blob
backlot release            # environment returns to the pool, warm
```

Requires Node ≥ 22.13 and git. The daemon auto-spawns on first use (unix socket,
per-machine state under `~/.local/state/backlot`; isolate with `BACKLOT_STATE_DIR`).

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
externally run — backlot probes it and classifies its absence honestly
(`infra-error`, never blaming your code).

When the repo has one blessed way to bring that infrastructure up, declare it as an
**appliance** and backlot will *ensure* it — probe, start once machine-wide if dead,
wait for readiness — while still never owning it (no supervision, no automatic stop;
whatever answers the probe is adopted, no matter who started it):

```yaml
appliances:
  postgres:
    probe: localhost:5433
    start: docker run -d --name dev-postgres -p 5433:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg16
    ready: docker exec dev-postgres pg_isready -U postgres
    stop: docker rm -f dev-postgres   # used only by `backlot appliance stop`
```

`backlot appliance ls|start|stop` manages them explicitly; binds ensure them
implicitly. See [decision 0018](docs/decisions/0018-appliances-ensured-not-owned.md).

## What it is / is not

| backlot is | backlot is not |
| --- | --- |
| a warm pool of leased, isolated environments | a compute provider (bring your own, local or cloud) |
| bind-by-sync: your dirty worktree, in front, in seconds | a build system (it invokes your commands, never understands them) |
| seeded, template-restored data states | CI (CI may call backlot; never the reverse) |
| machine verdicts with a work/env/infra error taxonomy | an agent (no LLM calls, no browser driving) |

Read [docs/architecture.md](docs/architecture.md) — it's short, and it *is* the product.

## Security model

Be clear-eyed about what running backlot means:

- **`stack.yaml` commands execute with your privileges.** Services, seeds, upkeep
  rules, and checks are shell commands from the repo — exactly like `make`, npm
  scripts, or a Justfile. Cloning an untrusted repo and running `backlot up` runs
  that repo's commands as you. Review manifests you didn't write.
- **The daemon has no network surface.** It listens on a unix socket in your
  per-user state dir (filesystem permissions are the auth) — no TCP, no remote
  callers. Future remote substrates run the same model *on the remote box*, reached
  over your own SSH/provider credentials.
- **Environments are projections, not sandboxes.** Isolation between environments
  is namespacing (ports, directories, database namespaces), not a security
  boundary — code in an environment runs as you, on your machine. For untrusted
  code, put the *substrate* in a sandbox (a VM, a cloud box), not your laptop.

## License

Apache-2.0.

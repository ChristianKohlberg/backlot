# backlot

[![npm](https://img.shields.io/npm/v/backlot)](https://www.npmjs.com/package/backlot) [![ci](https://github.com/ChristianKohlberg/backlot/actions/workflows/ci.yml/badge.svg)](https://github.com/ChristianKohlberg/backlot/actions/workflows/ci.yml) [![release](https://img.shields.io/github/v/release/ChristianKohlberg/backlot)](https://github.com/ChristianKohlberg/backlot/releases)

**backlot puts a working instance of your web application in front of a coding agent
(or a human) — running, seeded, authenticated, provable — as a cheap, repeatable act.**

It brokers environments; it never provides them. Local processes today, your own cloud
sandboxes (Morph, Sprites, SSH) tomorrow — same verbs, same model.

> **Status: 0.6 — hardened by use.** The local loop is complete and battle-proven:
> daemon with **per-environment concurrency** (sync runs on a worker thread — a big
> bind never stalls other environments), warm pool, per-stack fair leasing,
> stat-gated bind-by-sync with **two-stage reload** (`--watch` saves and `sync`
> project files without restarting services that declare `hot_reload`), sqlite +
> server datastores (postgres/**mssql**/mysql) with template restore and ephemeral
> (flush) stores, checks with verdicts/artifacts, detached submit-and-poll runs,
> hygiene auto-escalation + degraded auto-reap, idle quiesce that survives daemon
> crashes, **laptop-sleep pardon from the kernel's own record**, every repo command
> bounded (nothing can wedge an environment), crash recovery, a `token` verb, an
> MCP adapter (`backlot-mcp`) with detached jobs, and a foreign-runtime consumer
> (Python). Proven end to end on a real .NET + Angular + MSSQL monorepo — its
> Playwright e2e suite runs as a backlot check, and 0.6 itself was verified by a
> driven session against that repo before release. Tested by 250+ CLI-integration
> tests and a nightly soak harness. Not yet: a live remote substrate driver
> (morph/ssh). New here? Start with the two-page [docs/overview.md](docs/overview.md).
> Design in [docs/architecture.md](docs/architecture.md); decisions in
> [docs/decisions/](docs/decisions/).

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

The one prerequisite: a `backlot.yml` at the repo root (the manifest — see the
example below). Every runnable fixture in [`examples/`](examples/) ships one, so
the fastest first contact is a checkout:

```bash
git clone https://github.com/ChristianKohlberg/backlot && cd backlot
npm install && npm run build && npm link   # (or, for your own repos: npm i -g backlot)
cd examples/hello-web
backlot up --json          # lease a warm env: sync, seed, start, print URLs + creds
backlot run smoke --json   # bind -> run the check -> JSON verdict -> release
backlot ctx --json         # everything an agent needs, in one blob
backlot sync               # edit locally, project it in — seconds; hot_reload services keep running
backlot release            # environment returns to the pool, warm
```

For your own repo: `npm i -g backlot`, write the `backlot.yml`, then the same
verbs. Requires Node ≥ 22.13 and git. The daemon auto-spawns on first use (unix
socket, per-machine state under `~/.local/state/backlot`; isolate with
`BACKLOT_STATE_DIR`).

The manifest, by example ([schema](schema/backlot.schema.json)):

```yaml
name: myapp
services:
  api:
    run: dotnet run --no-build --project backend/Host
    port: api
    env: { ConnectionStrings__Main: "{{datastores.main.url}}" }
    ready: { http: /health }
  web:
    run: pnpm exec ng serve --port {{ports.web}}
    port: web
    ready: { http: / }
    hot_reload: true      # ng serve watches its tree -> `sync` projects edits in seconds, no restart
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

- **`backlot.yml` commands execute with your privileges.** Services, seeds, upkeep
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

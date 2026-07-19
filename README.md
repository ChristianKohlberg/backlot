# backlot

[![npm](https://img.shields.io/npm/v/backlot)](https://www.npmjs.com/package/backlot) [![ci](https://github.com/ChristianKohlberg/backlot/actions/workflows/ci.yml/badge.svg)](https://github.com/ChristianKohlberg/backlot/actions/workflows/ci.yml) [![release](https://img.shields.io/github/v/release/ChristianKohlberg/backlot)](https://github.com/ChristianKohlberg/backlot/releases)

**backlot puts a working instance of your web application in front of a coding agent
(or a human) — running, seeded, authenticated, provable — as a cheap, repeatable act.**

It brokers environments; it never provides them. Local processes today, your own cloud
sandboxes (Morph, Sprites, SSH) tomorrow — same verbs, same model.

> **Status: 0.6.** The local loop — pool, leases, bind-by-sync, data states,
> verdicts — is complete, hardened by two full review cycles, and proven end to
> end against a real .NET + Angular + MSSQL monorepo (its Playwright e2e suite
> runs as a backlot check, and each release is verified by driving a real session
> before publish). The one unbuilt milestone is the remote substrate driver
> (Morph/SSH). Details live in the
> [release notes](https://github.com/ChristianKohlberg/backlot/releases).

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
    hot_reload: true      # ng serve reloads itself -> `sync` never restarts it
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
(`infra-error`, never blaming your code). If the repo has one blessed way to start
that infrastructure, declare it as an **appliance** and backlot ensures it without
ever owning it ([decision 0018](docs/decisions/0018-appliances-ensured-not-owned.md)).

## What it is / is not

| backlot is | backlot is not |
| --- | --- |
| a warm pool of leased, isolated environments | a compute provider (bring your own, local or cloud) |
| bind-by-sync: your dirty worktree, in front, in seconds | a build system (it invokes your commands, never understands them) |
| seeded, template-restored data states | CI (CI may call backlot; never the reverse) |
| machine verdicts with a work/env/infra error taxonomy | an agent (no LLM calls, no browser driving) |

## Learn more

- [docs/overview.md](docs/overview.md) — the two-page tour, with diagrams. Start here.
- [docs/architecture.md](docs/architecture.md) — the full design; it *is* the product.
- [docs/decisions/](docs/decisions/) — why it is the way it is.

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

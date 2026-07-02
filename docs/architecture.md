# infront — architecture

> **Thesis:** infront puts a working instance of a web application *in front of* a coding
> agent (or a human) — running, seeded, authenticated, provable — as a cheap, repeatable
> act. It brokers environments; it never provides them.

This document is the founding design. It was produced by working a real system
(a .NET + Angular + MSSQL monorepo with a home-grown verify harness) through every
failure mode we could think of, then generalizing. Individual decisions are recorded
in [`decisions/`](decisions/); this document is the connected whole.

---

## 1. The problem

Coding agents (and the humans supervising them) need three things from a web
application under development, constantly:

1. **Inspect** — a running, seeded, logged-in instance to look at and drive.
2. **Prove** — system-level tests (e2e) against a deterministic environment, with a
   machine-readable verdict.
3. **Iterate** — the fix-sync-retest loop, in seconds, against real running services —
   *before* committing and long before CI.

CI cannot serve this: CI proves *committed* state to *the team*; agents need to prove
*arbitrary dirty state* to *one consumer*, immediately. Hand-rolled harnesses converge
on the same machinery in every repo — port allocation, DB namespacing, capacity gating,
zombie reaping — welded to one codebase and permanently half-finished.

The result of *expensive* environments is a predictable pathology: everyone keeps theirs
alive "just in case," and the machine fills with abandoned half-dead stacks. Abandonment
is not a discipline failure; it is the rational response to expensive provisioning.

## 2. Non-goals (hard boundaries)

These are where tools like this die of scope creep. infront:

- **Never owns compute.** Local processes and BYO cloud sandboxes (Morph, Sprites, E2B,
  plain SSH) via drivers. No fleet, no billing, no scheduler.
- **Is never a build system.** It *invokes* the repo's commands; it never understands
  them. There is no plugin that knows what Angular is.
- **Is never CI.** CI may call infront; never the reverse.
- **Is never the agent.** No LLM calls, no browser driving, no test authoring. infront
  guarantees URLs, credentials, data states, and verdicts; what the consumer does with
  them is its business.

**Scope (v1):** web applications — N HTTP-ish services + M datastores, with a browser
as the primary consumer. Portless workers and multi-datastore stacks are in scope;
Kubernetes, Windows, secrets management, and dashboards are not.

## 3. The model — five nouns and a verb

| Noun | What it is |
| --- | --- |
| **Stack** | What a repo declares in `stack.yaml`: services, datastores, seed presets, upkeep rules, checks. The only repo-specific artifact. |
| **Substrate** | Where environments physically live, behind a driver: `local` (supervised processes in a directory), later `docker`, `morph`, `sprites`, `ssh`. |
| **Environment** | A pooled slot on a substrate: its own copy of the tree, warm caches, running services, allocated ports, a datastore namespace. Durable; belongs to the pool, never to a person or task. |
| **Binding** | A source state (ref + dirty diff) plus a data state (preset, at a hygiene level) attached to an environment. An immutable snapshot. |
| **Lease** | Temporary ownership of an environment, with a TTL refreshed by any CLI touch. Expiry returns the environment to the pool **warm** — nothing is torn down. |

Plus one verb-noun: a **Run** — a named check executed against a binding, producing an
exit code, a JSON verdict, and collected artifacts.

### The two inversions everything follows from

**Environments are durable; leases are disposable.** The abandonment pathology is fixed
structurally, not by reaping harder: when a lease lapses (agent crashed, human forgot),
the environment returns to the pool with all its heat intact. There is never anything
running *for nobody* — the pool is a fixed, intentional set.

**Watchers never move; bindings move.** An environment's dev servers watch the
*environment's own tree*, forever. Pointing them at different work means syncing
different work into that tree. Source worktrees visit environments; environments never
visit worktrees. Consequences: caches survive rebinds, ports (and therefore URLs) are
stable for an environment's lifetime, and the consumer's worktree is never touched.

### The safety invariant

**An environment never holds the only copy of anything.** The consumer's worktree
remains the sole source of truth; the environment's tree is a disposable projection;
templates are rebuildable by definition. Every reclaim decision — lease expiry, recycle,
teardown, even losing the machine — is therefore safe by construction. (Contrast with
worktree-hosted harnesses, where teardown must agonize over unlanded work.)

## 4. Convergence, not checkpointing

infront gets the checkpointing dividend **by convergence rather than restoration**. A
checkpoint (Morph, Sprites, CRIU) freezes opaque bytes and gives back *that exact
moment*. infront keeps live environments plus layered, individually-keyed caches — the
fingerprint ledger, machine-global package stores, baked DB templates, the compiler's
own incremental state — and on each bind *converges* what's there to what was asked for.

A checkpoint is a photograph; a warm environment is a kitchen already mise-en-place.

This buys three things checkpointing cannot:

1. **Arbitrary targets.** The primary request is "put my current dirty worktree in
   front of me" — a state that has never existed, so no snapshot of it can exist.
2. **Selective invalidation.** A lockfile hash busts the dependency layer; a seed hash
   busts the DB template; everything else survives. Checkpoint state is opaque.
3. **No hypervisor.** True process checkpointing does not exist on macOS. Convergence
   is the ~90% approximation with zero infrastructure demands.

The two mechanisms compose: remotely, where real checkpointing exists, the substrate
driver uses it — a remote pool is provisioned by *branching a golden snapshot*
(checkpoint-backed base) and converged the last mile by the same sync + upkeep pass.
Local pools are convergence all the way down. Same verbs above the driver line.

## 5. Topology — local-first, nothing to deploy

- **No central service.** One **per-machine state root**: a SQLite journal (pool,
  leases, bindings, ports) under the XDG state dir, and environment working
  directories under the cache dir. Pools are keyed per stack, so projects never share
  environments but all consumers of one project do.
- **A per-machine daemon, auto-spawned by the CLI on first use** (the tmux/Docker
  pattern), speaking HTTP over a unix socket. The daemon exists because processes need
  a parent: someone must supervise services, watch readiness, expire leases, and
  quiesce idle environments while no CLI is running.
- **Concurrency lives at the environment boundary**: a short pool lock serializes
  claim/release bookkeeping; one lock per environment serializes bind/exec/reset on it.
  Different environments (and different stacks) bind in parallel; the sweeper never
  expires or quiesces an environment with an operation in flight.
- **Local even when compute is remote.** A Morph environment is a pool entry whose
  driver executes over SSH. The consumer's machine is the brain; substrates are muscles.
- **Disk is truth; daemon memory is a cache.** After a daemon crash or reboot, the next
  CLI call respawns the daemon, which reconciles: env dirs present, recorded PIDs dead →
  mark envs `warm`; leases past TTL → released; orphaned run namespaces → dropped
  (pattern-guarded). A restart is a non-event.
- **Team mode** (same daemon on a shared host, TCP + auth) is a possible future, not v1.

### Environment states

`hot` (services up) → `warm` (services stopped, caches intact; reached by idle TTL) →
recycled (`pristine` rebuild). Rebind from hot ≈ seconds; from warm ≈ start + ready-wait;
pristine ≈ full provision (bounded by templates and shared caches, below).

## 6. Sync — "verbs sync, watch streams"

Nothing observes the consumer's worktree by default. Every action verb (`run`, `up`,
`sync`, `bind`) begins by capturing the worktree — ref + dirty diff + untracked files —
and projecting it into the environment: git fetch from the worktree path + patch
application. Git is the transport (deletes, renames, modes handled; object store shared;
works identically over SSH to a remote substrate — **the sync boundary is the
local/remote abstraction**).

- **Bindings are immutable snapshots.** A running check executes against the revision
  synced at start; edits mid-run cannot contaminate the verdict. New sync = new binding
  revision.
- `--watch` sessions opt into a daemon-side debounced worktree watcher that auto-syncs
  on save, feeding the environment's own dev-server watchers. Two-stage reload;
  stopped on release/expiry/quiesce/recycle. Watch activity refreshes the lease.
- The environment-side reset before each bind restores tracked files hard and cleans
  untracked ones, **except** declared `caches:` (node_modules, obj/, …) and `sync.keep`
  paths. A poisoned env tree self-heals on next bind.
- Git-ignored-but-needed files (`.env.local`) are declarable via `sync.include`.
- Oversized/binary diffs fall back to file copy past a threshold.

### Outputs — the one sanctioned write-back

Some artifacts are produced env-side but owned worktree-side (a regenerated lockfile, a
generated API client). Default remains "never touch the worktree"; the exception is
explicit: manifest-declared `outputs:` are reported in the verdict
(`outputs_changed: [...]`) and copied back **only** by `infront pull` (or `--pull`).
The environment may *offer* artifacts; it never silently writes.

## 7. Upkeep — the fingerprint ledger

Dependencies, generated code, and toolchain drift are handled by a **closed list** of
`(fingerprint → action)` rules in the manifest, executed at bind time, after sync,
before build/start:

- Each environment keeps a ledger: the hash of each trigger *as last applied in this
  env*. The incoming binding's hashes are compared against **that environment's**
  ledger — **direction-agnostic**, so binding *older* work also converges correctly.
  Environments don't upgrade; they converge to the binding they serve.
- **Pool divergence is normal and harmless.** Idle environments are never touched;
  staleness is bounded by one upkeep pass at next use. Machine-global package stores
  (pnpm store, NuGet cache) make the Nth environment's install mostly hard-linking.
- **No background mutation of environments** (v1): lazy is predictable, and
  predictability is what agents need. The one sanctioned proactive act is **background
  template baking**: DB templates are machine-global and immutable-keyed
  (`preset@seed-hash`), so a new hash can be baked alongside the old with no races.
- Toolchain-level bumps (global.json, .nvmrc) are env-recycle events, not upkeep —
  unless the repo manages toolchains declaratively (mise/asdf) via its own rule.
  infront never installs SDKs on its own initiative.

## 8. Data — presets, templates, hygiene

Datastore drivers expose `create(ns, preset)` / `drop(ns)` / `url(ns)` plus optional
`template_bake` / `template_restore`. Re-seeding runs once per seed-content hash; after
that, data states are restored from templates in seconds (Postgres: native
`CREATE DATABASE … TEMPLATE`; MSSQL: backup/restore; SQLite: file copy; Redis-class
stores: `ephemeral: true` — `drop:` is the flush, run on reset; `create:` runs only on
first bind; no presets or templates).

**Hygiene levels** per bind:

| Level | Meaning | Typical consumer |
| --- | --- | --- |
| `reuse` | keep everything | human inspect loop |
| `reset-data` | restore data template, keep all build caches | agent verify loops (default for runs) |
| `pristine` | fresh environment | merge-grade verdicts; auto-escalation |

Two consecutive bind failures on the same warm environment auto-escalate the next bind
to `pristine` (a per-env `failStreak` in the journal, cleared by any successful bind) —
the standard defense against stale-cache heisenbugs. A service that flaps past its
restart budget marks its environment `degraded`: skipped by acquisition, auto-reaped by
the sweeper. **Warm is a cache, not a home**: the pool stays honest only while
discarding any environment is cheap.

`reset-data` is also exposed mid-lease as a verb: replay your repro against pristine
data after twenty minutes of debugging mutation.

## 9. Supervision and the error taxonomy

**The daemon is the parent of every service process.** Crash detection is SIGCHLD —
instant and authoritative; no PID-reparenting guesswork, no port-health inference.
Readiness is probed (`http`, `log`, or command); declared `fatal_logs` markers fail a
boot in seconds instead of polling a dead port to timeout. Session services restart
with bounded backoff; flapping marks the environment degraded → recycled on release.
A crash mid-run fails the run explicitly — never a silently wrong verdict.

Every failure is classified — the field an agent branches on mechanically:

| Class | Meaning | Who acts |
| --- | --- | --- |
| `work-error` | the synced code is at fault (compile error, failing upkeep triggered by your change, test failure) | the consumer fixes and re-syncs |
| `env-error` | the environment is at fault (stale cache, missing toolchain, flapping service) | infront auto-remediates by recycling |
| `infra-error` | something external (backing DB down, registry unreachable) | actionable message; nobody's code is blamed |

## 10. Laptop reality

- **Sleep is a coherent pause** locally: daemon, services, and backing containers freeze
  and thaw together. On wake the daemon detects the clock jump and **pardons the gap**
  (every lease/idle deadline shifts by the sleep duration) and applies a **wake grace**
  before any health probe may declare degradation.
- **Leases need no heartbeat daemon** because losing a lease is designed to be
  worthless: any CLI touch refreshes the TTL; expiry returns the env warm; the source
  of truth never left the worktree. Agents that vanish cost nothing.
- **Remote is the mirror image**: the world keeps running (and billing) while the lid
  is shut. Therefore remote environments always carry **provider-side TTLs** as the
  backstop, and **remote runs are submit-and-poll, never a held SSH pipe** — a check
  executes detached on the box, journaled; the CLI reattaches. Orphan discovery:
  drivers tag instances so `pool reconcile` can adopt or reap what the journal forgot.
  Local orphans cost RAM; remote orphans cost money — the asymmetry drives the design.

## 11. The consumer's interface

The CLI **is** the API: every verb takes `--json`; stdout is data, stderr is human.

```
infront up [--watch] [--reset-data] [--ttl 4h]   # session lease: sync, upkeep, start, context
infront run <check> [--pristine] [--pull]        # run lease: bind → execute → verdict → release
infront ctx --json                               # the context blob (below)
infront sync · bind --ref <sha>                  # project new work into the current lease
infront exec <cmd>                               # run anything inside the leased env
infront logs <service> [--since 2m]              # supervised service logs
infront reset-data · pull · release
infront status · pool ls|recycle|reconcile|doctor
```

`ctx` returns one blob with everything a consumer needs: service URLs (stable per
environment), login credentials, a token-mint hook, datastore connection strings,
artifact directory, hygiene state, and recent service events. An agent holding this
blob needs nothing else from infront.

**Division of labor** (the bug-fix loop): the agent thinks, edits, greps, and commits
in its own worktree with its own harness — infront is where the code *runs*, never
where the agent *works*. Fast unit tests that need no system don't pay the broker tax
at all. An MCP wrapper ships after the verbs stabilize (v1.1); it is a thin adapter
over the same daemon socket.

## 12. The manifest

One file, `stack.yaml`, at the repo root, validated by a published JSON Schema
([`../schema/stack.schema.json`](../schema/stack.schema.json)). Everything `{{…}}` is
injected by the engine — symbolic ports, datastore URLs, service URLs — which is what
makes environments relocatable across substrates. Services are **commands, not
containers**; backing infrastructure (a DB server) is externally run and probed.

```yaml
name: myapp
services:
  api:
    build: dotnet build backend/Host
    run:   dotnet run --no-build --project backend/Host
    port:  api
    env:
      ASPNETCORE_URLS: http://localhost:{{ports.api}}
      ConnectionStrings__Main: "{{datastores.main.url}}"
    ready:      { http: /health, timeout: 300 }
    fatal_logs: 'Unhandled exception|Build FAILED'
  web:
    build: pnpm exec ng build myapp
    run:   npx serve-dist dist/myapp --proxy /api={{services.api.url}}
    watch_run: pnpm exec ng serve myapp --port {{ports.web}}
    port:  web
    ready: { http: / }
  worker:
    run:   bundle exec sidekiq            # portless: readiness by log marker
    ready: { log: "Booted" }
datastores:
  main:
    driver: postgres
    server: external
    probe:  localhost:5432
    create: bin/rails db:prepare db:seed  # or any repo command; {{preset}} {{ns}} available
    presets: [dev, empty]
    template: true
  cache:
    driver: redis
    ephemeral: true                       # reset-data = flush
caches: [node_modules, "**/obj", .angular]
sync:
  keep: [src/api-client.generated.ts]
  include: [.env.local]
outputs: [pnpm-lock.yaml, src/api-client.generated.ts]
upkeep:
  - { when: pnpm-lock.yaml, run: pnpm install --frozen-lockfile }
  - { when: "glob(db/migrate/**)", run: bin/rails db:migrate }
auth:
  logins: { user: qa-admin, password: Demo!1234 }
  token:  scripts/mint-token --role {{role}} --json
checks:
  e2e:
    run: pnpm e2e
    env: { API_PORT: "{{ports.api}}", SPA_PORT: "{{ports.web}}" }
    artifacts: [test-results/**]
```

What the manifest deliberately does **not** contain: pool sizes, TTLs, capacity math,
substrate names. Those are engine policy and user config, never repo knowledge.

## 13. Driver seams

Two thin interfaces (see [`driver-spec.md`](driver-spec.md) and
[`../src/drivers/types.ts`](../src/drivers/types.ts)); thinness is what "never own
compute" looks like in code.

**Substrate** (~6 verbs + capabilities): `provision`, `exec`, `gitEndpoint`,
`expose(port) → url`, `destroy`; optional `pause/resume/checkpoint/restore`. The engine
degrades gracefully — local has no checkpoint; Morph/Sprites do.

**Datastore** (~5 verbs + capabilities): `create(ns, preset)`, `drop(ns)`, `url(ns)`;
optional `templateBake/templateRestore`; `ephemeral` stores implement reset as flush.

## 14. Landscape position

The 2025–26 agent-sandbox wave (E2B, Daytona, Modal, Fly Sprites, Morph) commoditized
the **substrate** — warm, persistent, checkpointable compute — and validated this
design's premises (persistence over ephemerality, checkpoint/restore as table stakes).
None of them knows what makes a VM a *working instance of your app*: the seeded data,
the auth story, the upkeep rules, the verdict contract. Dev-stack orchestrators (Tilt,
Skaffold, Garden) own hot-deploy-to-Kubernetes, not leases, data states, or verdicts.
Dagger's container-use is the nearest OSS neighbor (branch+worktree+container per
agent, git as sync) but is per-task-ephemeral, local-only, and has no data/verdict
layer.

infront is the unowned layer between them: **the repo-aware environment broker** —
buy the substrate, declare the stack, broker the environments.

## 15. Milestones

1. **0.1 — the local loop. ✅ SHIPPED.** Daemon, CLI, local substrate, sqlite driver
   with template restore, verbs `up/run/sync/ctx/exec/logs/reset-data/pull/release/
   status/pool/daemon`. Both examples green through the real CLI (35 tests), including
   crash recovery and lease expiry. (postgres moved to 0.2 with mssql — shipping an
   untested driver would have violated the honesty bar.)
2. **0.2 — first real consumer. ✅ SHIPPED.** The command-datastore family
   (postgres/mssql/mysql — ALL mechanics repo-declared commands, zero embedded DB
   clients) with template bake + restore, proven against a live dockerized Postgres
   (native `createdb -T` restore) AND against the founding monorepo: a full .NET +
   MSSQL vertical (seeded per-env database on the shared server, built host, real
   login, real seeded domain data over an authenticated API) came up through
   `infront up` in ~50 s; `infront run` provisioned a second full environment in
   ~48 s. The consumer's e2e check migration is its own next step.
3. **0.3 — remote. ◐ PARTIAL.** Detached submit-and-poll runs shipped (`run
   --detach` → jobId; the verdict outlives the client, journaled). Driver spec
   stable. NOT yet: a live remote substrate driver (morph/ssh) — that requires
   threading the fs/exec seam through sync/supervision (the honest remaining work
   package) and is the one unshipped piece of the roadmap.
4. **0.4 — public-ready. ✅ CORE SHIPPED.** The generality gate passed with a
   deliberately-foreign consumer (stdlib-Python + sqlite — different runtime, same
   verbs); the MCP adapter shipped as a thin stdio wrapper over the same daemon RPC
   (`infront-mcp`), protocol-tested. Remaining before an actual announce: the remote
   substrate (0.3's tail), npm publish, and a docs site.

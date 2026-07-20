# backlot — architecture

> **Thesis:** backlot puts a working instance of a web application *in front of* a coding
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

These are where tools like this die of scope creep. backlot:

- **Never owns compute.** Local processes and BYO cloud sandboxes (Morph, Sprites, E2B,
  plain SSH) via drivers. No fleet, no billing, no scheduler.
- **Is never a build system.** It *invokes* the repo's commands; it never understands
  them. There is no plugin that knows what Angular is.
- **Is never CI.** CI may call backlot; never the reverse.
- **Is never the agent.** No LLM calls, no browser driving, no test authoring. backlot
  guarantees URLs, credentials, data states, and verdicts; what the consumer does with
  them is its business.

**Scope (v1):** web applications — N HTTP-ish services + M datastores, with a browser
as the primary consumer. Portless workers and multi-datastore stacks are in scope;
Kubernetes, Windows, secrets management, and dashboards are not.

## 3. The model — five nouns and a verb

| Noun | What it is |
| --- | --- |
| **Stack** | What a repo declares in `backlot.yml`: services, datastores, seed presets, upkeep rules, checks. The only repo-specific artifact. |
| **Substrate** | Where environments physically live, behind a driver: `local` (supervised processes in a directory), later `docker`, `morph`, `sprites`, `ssh`. |
| **Environment** | A pooled slot on a substrate: its own copy of the tree, warm caches, running services, allocated ports, a datastore namespace. Durable; belongs to the pool, never to a person or task. |
| **Binding** | A source state (ref + dirty diff) plus a data state (preset, at a hygiene level) attached to an environment. An immutable snapshot. |
| **Lease** | Temporary ownership of an environment, with a TTL refreshed by the verbs that BIND (`up`, `sync`, `bind`, `run`). Read-only verbs (`ctx`, `logs`, `token`, `pull`, `status`) do not refresh it. Expiry returns the environment to the pool **warm** — nothing is torn down. |

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

backlot gets the checkpointing dividend **by convergence rather than restoration**. A
checkpoint (Morph, Sprites, CRIU) freezes opaque bytes and gives back *that exact
moment*. backlot keeps live environments plus layered, individually-keyed caches — the
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
  quiesce idle environments while no CLI is running. Verbs fired in parallel on a
  cold machine all race to spawn it; the singleton election keeps that safe (one
  wins, losers concede, their clients fall through to the winner), but fleets
  should still warm the daemon with a cheap `backlot status` before parallelizing.
- **Concurrency lives at the environment boundary**: a short pool lock serializes
  claim/release bookkeeping; one lock per environment serializes bind/exec/reset on it.
  Different environments (and different stacks) bind in parallel — with the caveat
  that sync hashing, file copying and the `git` calls are synchronous, so a very
  large bind still blocks the daemon's event loop and delays others while it runs;
  the sweeper never
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
`sync`, `bind`) begins by capturing the worktree — the file set from `git ls-files`
(tracked + untracked-unignored, plus `sync.include`) — and projecting it into the
environment with **stat-gated, hash-verified copies**: a warm rebind stats instead of
re-hashing, only changed files copy (CoW clone where the filesystem supports it), and
deletions are mirrored from the previous binding. (The `git fetch` + patch transport is
the planned *remote-substrate* path for 0.3, where the sync boundary becomes the
local/remote abstraction; the local substrate is enumerate-and-copy.)

- **Bindings are immutable snapshots.** A running check executes against the revision
  synced at start; edits mid-run cannot contaminate the verdict. New sync = new binding
  revision.
- `backlot sync` takes the same source-only projection as a watch save — services
  kept, the dev servers' own watchers reload — when EVERY service declares
  `hot_reload: true` (its `run:` watches its own tree) and the save fires no
  upkeep rule. Any undeclared service forces the full rebind: projecting under
  a non-watching process silently serves stale code, the failure class this
  broker exists to prevent (owner decision, 2026-07-20).
- `--watch` sessions opt into a daemon-side debounced worktree watcher that auto-syncs
  on save — the **two-stage reload**: stage 1 projects the changed files into the env
  tree source-only (same sync implementation as every verb, under the env lock, never
  sweeping untracked env files), updating the sync cache, the `@source` fingerprint and
  `lastUsedAt`; stage 2 belongs to the services' own dev watchers (`watch_run`), which
  pick the projected change up. Services are NOT stopped or restarted on an ordinary
  save. **Caveat (deliberate):** a save that changes what an upkeep rule or
  `@rebake-template` fingerprints — a lockfile, a migration — falls back to the full
  bind path, which runs the rule and restarts services; skipping the rule silently
  would hand out an environment the manifest says is stale. Stopped on
  release/expiry/quiesce/recycle. Watch activity refreshes the lease.
- The environment-side reset restores tracked files hard on every bind. A **clean-slate**
  bind (`--reset-data` or `--pristine`) additionally removes untracked env-side files —
  droppings left by a check, service, or `exec` — **except** declared `caches:`
  (node_modules, obj/, …) and `sync.keep` paths. A plain `reuse` bind keeps them, so an
  undeclared build artifact is not destroyed on every bind; declare expensive output
  under `caches:` and a poisoned env tree then self-heals on the next clean-slate bind.
- Git-ignored-but-needed files (`.env.local`) are declarable via `sync.include`.
- Oversized/binary diffs fall back to file copy past a threshold.

### Outputs — the one sanctioned write-back

Some artifacts are produced env-side but owned worktree-side (a regenerated lockfile, a
generated API client). Default remains "never touch the worktree"; the exception is
explicit: manifest-declared `outputs:` are reported in the verdict
(`outputs_changed: [...]`) and copied back **only** by `backlot pull` (or `--pull`).
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
  predictability is what agents need.
- **Data templates are keyed by the `create:` command string, not by seed *content***
  (v1's honest limitation): editing a seed script does not auto-invalidate the template.
  Declare an `@rebake-template <datastore>` upkeep rule triggered on the seed files to
  invalidate it (see `examples/hello-multi/backlot.yml`). Content-hash keying is planned;
  until then that upkeep rule is the mechanism.
- Toolchain-level bumps (global.json, .nvmrc) are env-recycle events, not upkeep —
  unless the repo manages toolchains declaratively (mise/asdf) via its own rule.
  backlot never installs SDKs on its own initiative.

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
| `env-error` | the environment is at fault (stale cache, missing toolchain, flapping service) | backlot auto-remediates by recycling |
| `infra-error` | something external (backing DB down, registry unreachable) | actionable message; nobody's code is blamed |

## 10. Laptop reality

- **Sleep is a coherent pause** locally: daemon, services, and backing containers freeze
  and thaw together. On wake the daemon detects the clock jump and **pardons the gap**
  (every lease/idle deadline shifts by the sleep duration). There is no separate wake
  grace because degradation is judged only by a service's restart budget, not by a
  post-boot health poll — a slept service simply resumes. Detection is
  platform-specific: on macOS the sweeper reads the **kernel's own record**
  (`kern.sleeptime`/`kern.waketime` via sysctl) because the monotonic clock keeps
  advancing through real sleep on Apple Silicon, so clock divergence never appears
  there; on Linux it detects wall-clock outrunning the monotonic clock (which halts
  through suspend). One sleep is pardoned exactly once, and every pardon is logged
  as a `pardon` event naming the gap and the detector.
- **A lease can name its holder's process** (`--holder-pid`, `BACKLOT_HOLDER_PID`; the MCP
  adapter supplies its own automatically). The default holder is a worktree PATH, and nothing
  about a path can die — so a crashed agent held its environment for the whole TTL. A named
  process is checked against its start time, and a dead holder's lease is released in seconds.
- **A lease no longer exempts an environment from reclaiming HEAT.** Holding one used to keep
  services (and their memory) alive for the full TTL even if nothing had touched the
  environment since the bind. Now a leased env that goes untouched past `leasedIdleTtlMs`
  quiesces to warm: the lease survives, only the services stop, and the next verb rebinds.
  "Untouched" counts real use — `exec`, `ctx`, `logs`, `pull` — not just binds, so an actively
  worked environment is never quiesced underneath its agent.
- **Leases need no heartbeat daemon** because losing a lease is designed to be
  worthless: a binding verb refreshes the TTL (read-only verbs deliberately do not,
  so an idle agent that only polls `ctx` does not hold an environment forever);
  expiry returns the env warm; the source
  of truth never left the worktree. Agents that vanish cost nothing.
- **Remote is the mirror image**: the world keeps running (and billing) while the lid
  is shut. Therefore remote environments always carry **provider-side TTLs** as the
  backstop, and **remote runs are submit-and-poll, never a held SSH pipe** — a check
  executes detached on the box, journaled; the CLI reattaches. Orphan discovery:
  drivers tag instances so `pool reconcile` can adopt or reap what the journal forgot.
  Local orphans cost RAM; remote orphans cost money — the asymmetry drives the design.
- **Locally, the same tagging rule applies to service processes.** Every supervised
  service is spawned carrying `BACKLOT_ENV_ID` / `BACKLOT_SERVICE` / `BACKLOT_STATE_ROOT`,
  inherited by every descendant. Pids alone are not ownership: a recorded pid may have
  been recycled by the OS, and `sh -c` frequently forks so the recorded pid is only the
  wrapper. Cleanup therefore (a) pins each pid to one process *life* via its kernel
  start time, (b) verifies the whole process **group** is gone rather than trusting that
  the leader exited, and (c) falls back to `scanTagged` — a /proc sweep by tag — for
  processes no journal row can name. `pool gc` is that sweep as a verb; recovery and the
  sweeper run it automatically. A process is only ever reclaimed when no live env
  accounts for it. The state-root tag scopes all of this, so parallel installs and
  concurrent test daemons can never reap each other.

## 11. The consumer's interface

The CLI **is** the API: every verb takes `--json`; stdout is data, stderr is human.

```
backlot up [--watch] [--reset-data|--pristine] [--ttl <minutes>]  # session lease
backlot run <check> [--pristine] [--pull] [--detach]   # run lease → verdict → release
backlot job <id> | job ls                        # poll / list detached runs
backlot ctx                                      # the context blob (below)
backlot sync | bind --ref <sha>                  # project worktree | a committed ref
backlot exec <cmd...>                            # run anything inside the leased env
backlot logs <service> [--lines N]               # supervised service logs
backlot token --role <r>                         # mint a token via auth.token
backlot reset-data | pull | release
backlot status | doctor                          # pool state | active health check
backlot pool ls|recycle [--all]|reconcile|gc|doctor
backlot daemon stop
```

Every verb accepts `--json`. Exit codes: `0` ok · `1` work-error / failed check ·
`2` env-error · `3` infra-error · `64` usage. On a failure the `--json` body is
`{ok:false, error:{class,message,…}}`; a failed *check* under `run` is
`{ok:false, exitCode, failure:{class,…}}`.

**Progress.** The long verbs (`up`, `run`, `sync`, `bind`, `reset-data`) stream bind
phases (acquire → sync → upkeep → datastore → build → start-and-ready, with an elapsed
counter on builds and readiness waits). The daemon sends these as newline-delimited
`{type:"progress"}` frames ahead of the single `{type:"result"}` frame; the CLI renders
them **to stderr**, so the `--json` stdout stays one clean object. Shown for an
interactive terminal (a TTY) or with `--progress`; silent for a non-TTY/pipe/agent or
with `--quiet`. Agents are unaffected by default.

`ctx` returns one blob with everything a consumer needs: service URLs (stable per
environment), login credentials, a token-mint hook, datastore connection strings,
artifact directory, hygiene state, and recent service events. An agent holding this
blob needs nothing else from backlot.

**Division of labor** (the bug-fix loop): the agent thinks, edits, greps, and commits
in its own worktree with its own harness — backlot is where the code *runs*, never
where the agent *works*. Fast unit tests that need no system don't pay the broker tax
at all. The MCP adapter (`backlot-mcp`) is a thin stdio wrapper over the same daemon
socket — the same verbs as tools, never a second implementation.

### Configuration

Policy lives in the engine, never the manifest. Precedence per knob: environment
variable > `$STATE_DIR/config.json` > built-in default.

| Env var | config.json key | Default |
| --- | --- | --- |
| `BACKLOT_STATE_DIR` | — | `$XDG_STATE_HOME/backlot` (the per-machine root; 0700) |
| `BACKLOT_LEASED_IDLE_TTL_MS` | `leasedIdleTtlMs` | `2 x idleTtlMs` — a LEASED but untouched env stops its services (keeps the lease) |
| `BACKLOT_POOL_MAX` | `poolMax` | `min(cores/2, memGB/4)`, clamped **[2,8]** — the floor is 2 because `up` + `run` needs two envs |
| `BACKLOT_LEASE_TTL_MS` | `sessionTtlMs` / `runTtlMs` | 30 min / 10 min |
| `BACKLOT_IDLE_TTL_MS` | `idleTtlMs` | 30 min |
| `BACKLOT_WAIT_MS` | `waitMs` | 60 s (queue-at-capacity timeout) |
| `BACKLOT_ARTIFACT_DAYS` | `artifactDays` | 7 |
| `BACKLOT_JOB_DAYS` | `jobDays` | 7 |
| `BACKLOT_LOG_CAP_BYTES` | `logCapBytes` | 5 MB |
| `BACKLOT_TEMPLATES_KEEP` | `templatesKeep` | 4 per stack |
| `BACKLOT_SWEEP_MS` | — | 15 s (lease/idle sweep cadence) |
| `BACKLOT_RETENTION_MS` | — | 10 min (disk retention cadence) |

**Advertised host.** Service URLs advertise `http://localhost:…` while port
probing guarantees the IPv4 side (127.0.0.1 + wildcard). On dual-stack machines
`localhost` may resolve to ::1 first; every mainstream client (browsers, curl,
Node fetch, Python urllib) falls back to 127.0.0.1, which is why this is a
documented caveat and not a contract change (owner decision, 2026-07-19): an
IPv4-only service behind a `localhost` URL is reachable in practice, and
consumers with an exotic IPv6-only client should bind their service dual-stack.

The daemon writes a structured event log (`$STATE_DIR/events.jsonl`, size-capped)
surfaced by `status` and `doctor`.

## 12. The manifest

One file, `backlot.yml`, at the repo root, validated by a published JSON Schema
([`../schema/backlot.schema.json`](../schema/backlot.schema.json)). Everything `{{…}}` is
injected by the engine — symbolic ports, datastore URLs, service URLs — which is what
makes environments relocatable across substrates. Services are **commands, not
containers**; backing infrastructure (a DB server) is externally run and probed.

Every command in the manifest — service `run:`/`build:`, check `run:`, upkeep,
datastore hooks — executes under `sh`, which is **dash on Ubuntu and
bash-running-as-sh on macOS**, the two platforms backlot tests. Write POSIX sh
only: a bashism (`[[`, arrays, `set -o pipefail`) can pass on one leg and fail
on the other with the same backlot.yml.

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
    hot_reload: true                      # run: self-reloads -> `sync` projects, no restart
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
By 2026 the wave consolidated: Gitpod rebranded to Ona and was acquired by OpenAI; Daytona pivoted to agent sandboxes; Neon's branch-per-agent Postgres sold to Databricks (~$1B) with most databases agent-created — data states validated as a category; kubernetes-sigs/agent-sandbox even ships literal SandboxWarmPool/SandboxClaim CRDs, cluster-side. A dated scored map lives in [reviews/2026-07-20-landscape.md](reviews/2026-07-20-landscape.md). Dagger's container-use is the nearest OSS neighbor (branch+worktree+container per
agent, git as sync) but is per-task-ephemeral, local-only, and has no data/verdict
layer.

backlot is the unowned layer between them: **the repo-aware environment broker** —
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
   `backlot up` in ~50 s; `backlot run` provisioned a second full environment in
   ~48 s. The consumer's Playwright system-e2e suite now runs as an backlot check
   (`backlot run e2e`, ~58 s incl. provisioning via PLAYWRIGHT_REUSE against the
   backlot-provisioned servers) with verdict parity against the incumbent harness —
   identical pass/fail results on the same suite.
3. **0.3 — remote. ◐ PARTIAL.** Detached submit-and-poll runs shipped (`run
   --detach` → jobId; the verdict outlives the client, journaled). Driver spec
   stable. NOT yet: a live remote substrate driver (morph/ssh) — that requires
   threading the fs/exec seam through sync/supervision (the honest remaining work
   package) and is the one unshipped piece of the roadmap.
4. **0.4 — public-ready. ✅ CORE SHIPPED.** The generality gate passed with a
   deliberately-foreign consumer (stdlib-Python + sqlite — different runtime, same
   verbs); the MCP adapter shipped as a thin stdio wrapper over the same daemon RPC
   (`backlot-mcp`), protocol-tested. Remaining before an actual announce: the remote
   substrate (0.3's tail), npm publish, and a docs site.

# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Build & test

- Build: `npm run build` (compiles TypeScript to `dist/`; required before running tests)
- Test: `npm test` runs vitest over all files in `tests/`; tests use the compiled `dist/cli/index.js`
- Single file: `npm test -- tests/foo.test.ts`

## Architecture notes

See `docs/` for decision log. Key files:
- `src/daemon/engine.ts` — pool + lease + bind orchestration (the core)
- `src/daemon/supervisor.ts` — per-env process supervision, `killGroupVerified`, `reapPids`
- `src/core/procscan.ts` — `scanTagged` (Linux-only /proc scan by BACKLOT_ENV_ID tag)
- `src/core/journal.ts` — SQLite journal (disk is truth)

## Service process lifecycle & teardown sharp edges

Services are spawned detached (`detached: true` in `spawn`) so they outlive the daemon intentionally — this is the crash-recovery contract. The BACKLOT tag (`BACKLOT_ENV_ID`, `BACKLOT_SERVICE`, `BACKLOT_STATE_ROOT`) is injected into every service's environment and inherited by grandchildren; `scanTagged` uses it to find orphans even after the process moved to a new session.

Consequence: a group kill (`killGroupVerified`) is not sufficient teardown — a service that called `setsid()` or spawned a detached grandchild escapes the `-pgid` signal and can keep holding its port. `stopAll()` must therefore always be followed by a reap of journal-recorded pids plus a tag scan before trusting any port-free check. **Every `stopAll()` call site is bound by this** — `bindAndStart`, `teardownClaimed`, the quiesce path, and `shutdown()`. Deferring the reap to "the next bind will handle it" is the bug (#34): a quiesced env can sit cold for hours, and a stopping daemon has no next anything. `reapEnvProcesses` in `src/daemon/engine.ts` owns this invariant (see its doc comment for the failure modes and the survivor-preservation contract); `tests/env-port-survivor.test.ts` and `tests/agent-lease-and-recycle.test.ts` are the regression tests. Crash recovery follows the same rule: `recover()` reaps recorded pids for every journaled env and re-runs `teardownClaimed` for `state='recycling'` rows.

Recorded `servicePids` hold only the **top-level service pids** — a service's own children were never on the books, so the tag scan is the only thing that finds them. For anything that also scrubbed the tag, `reapEnvTree` reaps by cwd (`scanByCwd`, which matches a `(deleted)` cwd too). That path is **teardown-only**: a quiesced env keeps its tree on disk and someone's shell may legitimately be sitting in it.

## Publishers own their dialect — the engine must not learn one

`preview.publisher` selects an adapter; `src/drivers/preview.ts` holds the
registry. `start()` receives the manifest's `preview` block verbatim as
`settings`, and the **publisher** turns that into an address. Do not move
hostname derivation into the engine to save an argument: `cloudflare-quick`
cannot accept a hostname at all, and the next adapter will want a port or a
socket. That is what makes it a seam rather than one publisher with extra steps
([decision 0028](docs/decisions/0028-named-preview-hostnames.md)).

`cloudflare-named` creates a tunnel and a DNS record per `<prefix, service>` and
**reuses** them across leases — `stop()` kills only the process. That is
deliberate: the surviving name is the entire reason to use it, and a per-lease
tunnel would churn objects in the operator's account and add a second lifecycle
to reap. Its prerequisite is heavier than the quick publisher's (an origin
certificate from `cloudflared tunnel login`, not just the binary), and
`checkPrerequisite` names that command because "unauthorized" from a tunnel
create is not something an operator can act on.

A wildcard record was considered and **rejected**: it binds the whole zone to
one tunnel, which forces one shared cloudflared process for every previewed
service — and a shared process cannot honour 0027's `stop()` contract, because
the pid another publication still references may not be killed.

## The preview tunnel is scoped to the lease, not to the services it publishes

`backlot preview` journals its tunnel on the **lease row** (`preview_*`), not in
`env.servicePids` — so none of the service-reap machinery above owns it, and the
lifetime rule is deliberately different ([decision 0027](docs/decisions/0027-lease-scoped-public-preview.md)).
A rebind, a `sync` or an idle quiesce restarts or stops services while the lease
continues, and the tunnel **survives all of them**; ports are stable for an
environment's lifetime, so it is aimed at the same place when the services return.
It is reaped only when the lease ends (`release`, TTL lapse, dead holder, the
sweeper's torn-row prune), at `teardownClaimed` (before `deleteEnv` drops the row
that names it), at `shutdown()`, and in `recover()`.

The sharp edge: because the tunnel outlives service restarts, the tag-based
reclaim paths must **skip it** — `reapEnvProcesses`' scan filters out the process
group the env's live lease records, and `poolGc` skips every leased one. Do NOT
"simplify" those filters away: without them Linux shoots the tunnel at a boundary
where macOS keeps it, and that platform split is the whole bug class this feature
had to close, and all three of them (`pool gc`, the scan, doctor's orphan report)
must agree on `leasedPreviewPids(tagged)` or one will act on what another calls
healthy. That classifier exempts the verified leader's whole tagged process group
(a launcher's same-group tunnel child included), never a bare pid or a `preview:`
label, and `setsid` descendants are outside it — the contract is in
[decision 0027](docs/decisions/0027-lease-scoped-public-preview.md) and
`tests/preview-process-group.test.ts` is the regression test.

`reconcilePreviewForBind` owns what a bind **and a `sync`/`--watch` projection**
do to a live tunnel: it tears it
down when `preview.forbidden` appears, when the previewed service leaves the
running set (a narrowed slice or `--data-only` — nothing brings it back this
lease), or when its local port moves (a bind only — a projection allocates
nothing, and it judges the slice by the env's durable shape, not by live pids);
the slice and port causes are reconciled at the bind's **epilogue**, once the
shape they judge against is committed, while `forbidden` is enforced up front so
a failed bind cannot leave a stack published; `--reset-data`/`--pristine` keeps it and
warns that the *same* public URL now serves *new* data. It **never throws** — the
bind is legitimate — and the message rides back on the bind's own result as
`previewNotice`, not through shared state a later `ctx` read could drain first.
Both preview verbs re-read the lease *inside* `envLocked`, `clearLeasePreview` is
a compare-and-swap on the pid, and `endLease` re-reads between the stop and the
delete (it cannot take the env lock — `tryClaim` calls it under the pool lock),
so no stale snapshot can forget a tunnel someone else just published. `tests/preview-tunnel.test.ts`
covers all of it.

## Leases: `--ttl` is the agent form, `--holder-pid` is not

`--holder-pid` / `BACKLOT_HOLDER_PID` frees the environment the moment the named process exits, which only helps a caller that outlives the command. `BACKLOT_HOLDER_PID=$$` from an agent harness names an already-exited shell, so the lease is reclaimable on arrival: the sweeper's dead-holder rule frees the env, the next binder takes it, and the first caller is left looking at a different, unseeded store through the same URL. It presents as a stale seed template — the wrong subsystem entirely. Binds naming a dead pid are now refused (exit 64). See the lease bullet in `docs/architecture.md`.

## Data-only leases

`up --data-only` binds an ordinary pooled environment's **datastores only** — no services, no builds — for test lanes that need a seeded database rather than an application ([decision 0023](docs/decisions/0023-data-only-leases.md)). The sharp edge: `activeServices: []` cannot express "no services", because an empty *selection* has always meant "the whole app" in `resolveServiceClosure`. The durable flag is `EnvRow.dataOnly`, and it follows the slice's inheritance rule — explicit request wins, a fresh claim never inherits, a continuing lease preserves. Such an environment is published `warm` (nothing is running, which is what warm means), so `assertUsable` must not read warm as "the daemon restarted and lost your services". `tests/data-only-lease.test.ts` covers it.

Pool commands are shared-box operations: `pool recycle` with no id targets **every** environment, and `--force` is the only thing that takes one out from under a live lease. In `status`, `heat: 'cold'` means quiesced-and-free, not stuck; the `available` and `summary` fields say so outright because reading 'cold' as 'broken' is what caused #40.

## Two pool caps, and why the machine-wide one evicts

`poolMax` is per stack, `poolMaxTotal` machine-wide, and **both gate `createEnv` only** — reuse is never capacity-checked, which is why the env *row count* is what bounds worst-case concurrent load. Idle reclamation takes heat, not the row, so cold environments used to hold machine-wide slots forever and lock out any new stack (#46). `evictForMachineCapacity` now gives up the least-recently-used cold env (unleased, not busy, idle past `idleTtlMs`, `hot` or `warm`) when — and only when — the machine-wide cap is the binding one. Do NOT re-restrict that to `warm`: the sweeper only quiesces every `BACKLOT_SWEEP_MS`, so an abandoned env is `hot` while already condemned, and requiring `warm` refused callers for a whole sweep interval while claiming waiting would not help (caught by driving it, not by a test — there is now one). It must run **outside the pool lock** (`poolLocked` is a non-reentrant promise chain and `recycleOne` takes it), and `claimForTeardown` re-validates, so a candidate leased in the gap is declined rather than stolen.

The consequence worth remembering: **waiting can never clear a machine-wide block**, because a release leaves the row behind. `structuralCapacityBlock` therefore treats it as structural unless something is evictable or transient — the old code explicitly assumed the opposite ("another stack will release") and burned the full window (#47). `tests/pool-machine-capacity.test.ts` covers all of it.

There is a **third ceiling**: `poolMaxDataOnly` for data-only environments, which are charged against neither application cap ([decision 0025](docs/decisions/0025-data-only-environments-are-priced-separately.md)) — the app caps measure cores and memory, and a data lease runs nothing. So `poolMax`/`poolMaxTotal` now mean *application* environments (`appEnvs()`), and every capacity decision buckets by shape, eviction included. The sharp edge: because reuse is never capacity-checked, **changing an environment's shape is a capacity event** — `convertShape` moves the row between buckets only if the destination has room, and writes it at claim time so a concurrent claim sees the new bucket. Unmetered, that conversion turns the cheap ceiling into application capacity. A conversion to data-only retains its application charge while the row is hot or records service pids: upkeep may fail before stopping the old app. The bind's stop phase (`stopForBind`) journals `warm` and the unreaped survivors the moment the services are gone, so a failure after that point releases the slot rather than holding it until the next sweep. Shape changes wait for an in-flight environment operation — `tryClaim` answers `deferred` rather than `null`, so the wait neither evicts nor consults the capacity checks and its timeout names the operation, not a cap — and a claim reserves the bind (`pendingBinds`) until it holds the environment lock, since `busy` is set several microtasks after the claim resolves. Returning to an already-charged app does not need a second slot (`tests/conversion-capacity.test.ts`). Pinning the shape instead is simpler and was rejected: it silently removes 0023's supported both-ways lease switching (`tests/data-only-lease.test.ts` catches this — heed it).

## Version skew is a first-class failure, and the daemon outlives the install

The CLI spawns the daemon from **its own `dist/`** (`ensureDaemon`), so installing a
new backlot never replaces a daemon that is already running — it serves old code for
the rest of its life, and an old daemon *ignores* arguments it does not know rather
than rejecting them. `ping` therefore carries the daemon's version, and a mismatch
**refuses** every verb except `update`, `doctor` and `daemon stop` with
`infra-error`. `backlot update` is the remedy: it restarts the daemon (shared code
path with `daemon stop`), and the next verb's autospawn is what makes the new daemon
the installed build. Leases survive; an in-flight (`busy`) operation and a downgrade
are the only refusals. **The MCP adapter enforces the same gate on its own** — the
CLI's lives in `main()`, so an MCP client would otherwise be unprotected — and there
is deliberately no MCP tool that restarts the daemon. See
[decision 0024](docs/decisions/0024-updating-the-running-daemon.md) and
`tests/daemon-update.test.ts`.

Two sharp edges. **`src/core/version.ts` is the only source of version truth** — a
second one already drifted (the MCP adapter shipped 0.4.0 while the package was
0.5.0); `BACKLOT_FAKE_VERSION` exists solely so a test can make a daemon claim a
different version than its CLI. **Any test that stands in for the daemon must answer
`ping` with `VERSION`**, or the CLI treats the stand-in as an old daemon and refuses
before the behaviour under test ever runs (this broke `cli-contract` and
`daemon-spawn` when the gate landed).

Skew reaches the **manifest** too, as of the `auth.logins` list form
([0026](docs/decisions/0026-a-stack-may-advertise-several-logins.md)): a stack using it
fails validation on a pre-0.10.0 backlot with `the backlot manifest is invalid`, which
reads as a broken manifest rather than an old install. Hence the singular
`{user, password}` form must keep validating indefinitely, and `ctx.logins` must stay a
single object (the primary, manifest entry 0) — `allLogins` is where the set lives.

`JOURNAL_SCHEMA_VERSION` (`src/core/journal.ts`) is stamped into `PRAGMA
user_version`; a daemon refuses to open a journal stamped newer than it understands.
Bump it only when a change makes an older daemon **misread** this journal — the
additive `ALTER TABLE` migrations are not bumps.

## Caller environment inputs

`services.*.env_from` allowlists caller variables (`required`/`optional`). Explicit
`up` and `run` refresh them; `sync`, watch, reset and ref binds preserve the lease's
memory-only inputs. A supplied value overrides a same-named `env` entry; an omitted
optional value keeps the service's explicit `env` default, and without one it masks
the same-named daemon variable. Only caller-supplied values are redacted from logs.
Never journal or expose input values/hashes in context or diagnostics. A daemon
restart needs a fresh `up` to resupply them. New holders must restart configured
services even on identical source: warm reuse must not inherit another lease's
inputs. Declaration changes also invalidate the process configuration. See
`src/core/caller-env.ts` and `tests/caller-env.test.ts`.
CLI/MCP autospawn must use the target stack's cwd and strip declared input names
from the daemon environment; otherwise the first caller contaminates every later
check/exec/unconfigured service despite correct per-lease service masking.

Supervisor probe matching uses a raw, memory-only buffer; logs and error excerpts
use the redacted buffer. Combining them breaks readiness when a declared value
also matches `ready.log`/`fatal_logs`. Redaction retains split-value prefixes per
output stream, so no raw prefix reaches disk before its remaining bytes arrive.

## Cutting a release

A merged fix does not reach consumers until this happens — `main` can sit ahead of
the newest npm version for a while (the multi-login work landed as #59 but shipped
in 0.10.0, several days later), and every consumer on the old version keeps hitting
the bug in the meantime. There is **no publish automation**: `ci.yml` has no publish
job (typecheck, test, the README Node-pin check and the `hello-web` smoke) and there
is no `release.yml`, so after the version-bump PR merges the owner does the rest by
hand — `npm publish`, the annotated `vX.Y.Z` tag on the merge commit (`v0.9.1` →
`cc2339d`), and the GitHub release notes. A release-prep commit only ever touches
`package.json` and `package-lock.json` (`"version"` in both places, e.g. `22469d7`,
`c46944e`), titled `chore: X.Y.Z — version bump for the release` with a body naming
what shipped since the last tag; follow semver off what actually changed
(additive/back-compat = minor, fix-only = patch) rather than defaulting to patch.

`dist/` is gitignored but **is** the published artifact (`files`, and both `bin`
entries point into it), so the tarball only ever contains whatever the owner's
working tree happened to hold. 0.11.0 shipped that way: published without a build,
so the whole preview-tunnel feature it was cut for (`dist/drivers/preview.js`, plus
the `engine`/`journal`/`cli`/`mcp` changes) was simply absent from npm, and 0.11.1
exists only to republish it. Nothing catches this after the fact —
`src/core/version.ts` reads `package.json`, so the stale install still *reports* the
new version and the skew gate sees a matched pair while `backlot preview` does not
exist. Hence `prepublishOnly` now builds; do not remove it, and do not read a green
`npm test` as a good tarball (`pretest` builds into the same `dist/`, which is why
local runs stayed green throughout). The tags are also behind — v0.10.0 and v0.11.0
were never pushed.

## Claude Code plugin

The repo doubles as its own Claude Code plugin marketplace (docs/config only — it
does not touch the CLI build). Layout:
- `.claude-plugin/marketplace.json` — marketplace manifest at repo root.
- `plugins/backlot/.claude-plugin/plugin.json` — the plugin manifest; **bump its
  `version` when the skill changes** (independent of `package.json`'s CLI version).
- `plugins/backlot/skills/backlot/SKILL.md` — the **upstream canonical** backlot
  skill. Keep it generic/stack-agnostic; never hardcode a consuming repo's
  services or presets. `README.md` is the source of truth for its content.

backlot is CLI-only: the plugin ships **only the skill — no `.mcp.json`.** Install
is `/plugin marketplace add ChristianKohlberg/backlot && /plugin install backlot`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.

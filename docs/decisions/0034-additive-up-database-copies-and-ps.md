# 0034. `up` is additive and `down` stops what it names; a preset reloads one datastore; a database alone is a `runly db` copy; `runly ps` shows both

- Status: Accepted — amended by [0035](0035-services-idle-on-their-own-clock-and-wake-on-demand.md): a holder is believed dead after a 1-minute grace and its death tears its environment down (copies are dropped as before); `ps` gains the `idle` state; amended by [0039](0039-teardown-keeps-templates-a-leased-environment-survives-a-crash-loop.md): `db with` stops its command with its copy; a datastore may be `copies_only`
- Date: 2026-10
- Supersedes: [0023](0023-data-only-leases.md) (`up --data-only`) and
  [0025](0025-data-only-environments-are-priced-separately.md) (the data-only
  ceiling and shape conversions)
- Amends: [0032](0032-environments-run-in-the-callers-worktree.md) — a different
  set of services and a different preset are no longer reasons for the full
  stop/data/build/start path; [0007](0007-hygiene-levels.md) — `pristine` keeps
  the preset each datastore is recreated with
- Context: since 0032 a worktree has exactly one environment. Three things
  were still built for a pool of interchangeable ones:

  - **`up <services>` replaced the running set.** `up api` on an environment
    running `api` and `web` stopped `web`; asking for one more service meant
    naming every service you wanted to keep. Because the set had changed, the
    bind took the full path — every service stopped and started again — to add
    one.
  - **A preset was lease intent.** A lease remembered the presets it had asked
    for, a fresh holder got the defaults, and changing one datastore's preset
    restarted the whole environment. On the founding consumer (the revamp
    monorepo) a fresh holder silently reseeded data its predecessor had
    prepared, and its integration lane carried a provenance check because it
    could not tell which preset a datastore actually held (backlot#56).
  - **A database without the application was an environment** (`up
    --data-only`, 0023), priced under its own ceiling (0025) with shape
    conversions as metered capacity events. With one environment per worktree
    it became a second meaning of that one environment: the consumer's
    `scripts/check integration` ran `up --data-only` in a worktree whose full
    environment was running, and so stopped the application it was not testing.
    And a test lane wants several databases at once, from one worktree, which
    one environment cannot give.

## Decision

The owner's calls, recorded as given (2026-10-05): *`up` is additive; `down`
stops one service.* *Only services are named — no datastore or appliance
prefixes (too fine).* *Datastores always all exist with the environment;
`--preset x=y` reloads only that datastore; no preset keeps the current data;
`ctx` reports each datastore's current preset.* *`--data-only` is removed; its
use moves to `runly db`.* *Copies are reaped exactly like environments — agent
gone or worktree returned — with no TTL and no load budget.* *One view, `runly
ps`, of my services and my copies.*

### `up` adds, `down` takes away

- `up <service…>` starts the named services and their transitive `depends_on`
  closure, **in addition to** what the environment already runs. It never stops
  a running service. `up` with no names adds the manifest's default set, which
  is every service (the manifest declares no other default set).
- `down <service…>` stops just those services. `down` with no names stops every
  service. Either way the lease, the data and the public ports (0033) stay: the
  proxy keeps listening, and refuses connections to a downed service until an
  `up` brings it back. Dependents of a downed service are **not** stopped —
  "just those" — and are named in the answer, because they now reach a port
  with nothing behind it.
- The environment row records the set the lease **wants** (`activeServices`):
  undefined is every declared service, `[]` is none. A quiesce or a daemon
  restart stops processes but keeps the wish, and the next `up` restores it. A
  fresh holder does not inherit the previous holder's wish — only what is still
  running, which an additive `up` must not stop.
- An `up` on a running, healthy environment builds every service it leaves
  running (0032), restarts the running ones whose declared outputs changed, and
  builds and starts the ones it adds next to them. `bindDiagnostics.started`
  names the added services.

### Datastores live with the environment; a preset reloads one

- Every datastore the manifest declares exists for the environment's whole
  life. Only services are ever named on the CLI.
- **No `--preset` keeps whatever each datastore holds** — on every `up`, for a
  fresh holder, after a daemon restart, and when the preset it holds has left
  the manifest's catalog. A datastore is never silently reset to its default.
- `--preset <datastore>=<preset>` (or `--preset <preset>` for a stack with one
  datastore) **reloads only that datastore** from its template — even when it
  already holds that preset, which is how one store is reset — and restarts the
  running services that use it. Every other datastore and service is
  untouched.
- **"Uses it" is read from the manifest:** a service uses datastore `x` when its
  `run:`, `build:` or `env:` templates `{{datastores.x.…}}`, which is how a
  service is handed a connection string. When **no** service references the
  datastore, runly cannot tell who reads it (a connection string in a config
  file, a hard-coded path), so it restarts **every** running service.
  Dependents of a restarted service are not restarted (as in 0032).
- A reset (`--reset-data`, `--pristine`, two failures escalating) still
  restores every datastore, each with the preset it holds — or the default,
  once the catalog no longer offers it. `pristine` keeps the presets on the
  row for that reason; it still deletes the environment's private data.
- A preset request is a one-off, not lease intent. If its bind fails, nothing
  remembers it; the store keeps (or is recreated with) what it held.
- `ctx --json` reports `datastores.<name>.preset` — the preset the datastore
  holds now, null before its first restore — and `ctx --env` exports it as
  `RUNLY_DATASTORE_<NAME>_PRESET`. `ctx.services` reports each service as
  `running`, `stopped` (wanted, not running) or `down` (not wanted); `urls`
  lists the wanted services, and a downed one keeps its port in `ports`.
  `bindDiagnostics.reloaded` names the datastores a bind reloaded.

### What still takes the full path

The full stop/data/build/start path remains for what a restart of single
services cannot carry, re-checked one by one:

| Reason | Kept? | Why |
| --- | --- | --- |
| `upkeep-required` | kept | an upkeep rule changed the worktree under every service |
| `environment-not-running` | kept | nothing runs, so there is nothing to keep |
| `service-process-unhealthy` | kept | the environment is in an unknown state |
| `environment-inputs-changed` | kept | caller inputs reach every configured service's start |
| `manifest-changed` | kept | any service's command, env or dependency may have changed |
| `hygiene-reset-data`, `hygiene-pristine` | kept | the data under every service is replaced |
| `public-port-moved` | kept | services that template another one's address must restart |
| `service-shape-changed` | **removed** | existed only because `up` replaced the set; now services are added next to the running ones, and `down` stops |
| `datastore-preset-changed` | **removed** | a preset now reloads one datastore and restarts only its users |

### `runly db`: database copies outside any environment

- `runly db new <datastore> [--preset p] [--json]` makes a fresh copy of the
  datastore from the **same template the environments use** — through the
  datastore's `template_restore` hook (or the sqlite template copy), baking the
  template first if it is missing — and prints its name, url (connection
  string) and preset. No lease, no ports, no services. Copies are independent;
  any number may exist at once, and making one never waits for a bind's builds
  (the trigger-hash cache it reads for the template key is written atomically).
  It ensures the stack's appliances like a bind. It does not run upkeep: a
  template that needs an install first wants `runly warm`.
- `runly db with <datastore> [--preset p] -- <cmd…>` makes a copy, runs the
  command with `RUNLY_DB_URL` and `RUNLY_DB_NAME` set, drops the copy when the
  command exits (also on failure, and after SIGINT/SIGTERM, which it passes on)
  and exits with the command's exit code.
- `runly db ls [--all]` lists this worktree's copies (`--all`: every one);
  `runly db drop <name>` drops one now.
- **Every copy is journalled** (`db_copies`) before its restore starts, with its
  holder — the caller's worktree, and the agent tether (`--holder-pid`,
  `BACKLOT_HOLDER_PID`) when one is given; `db with` tethers the copy to its
  own CLI process — and with **everything needed to drop it**: the
  already-templated drop command and where to run it, or the copy's private
  directory under the state root (sqlite). Reaping needs neither the manifest
  nor the worktree; the drop runs in the worktree while it exists and in the
  state root after.
- **Reaped exactly like environments:** in every sweep and right after a daemon
  restart, a copy is dropped when its holder process is gone (the same check,
  and so the same grace, as a lease's holder), when its worktree is removed or
  no longer resolves to the stack, or when its creation never finished. A drop
  that fails keeps the row (`dropping`) and is retried with a backoff — a
  database nothing can name again is the leak this record exists to prevent.
- **No TTL and no load budget** for copies (the owner: not needed). A copy
  made without a tether lives until its worktree goes or it is dropped. A
  command-family datastore without a `drop:` command cannot be copied — runly
  could never remove the copy.

### `runly ps`

One table for the caller (default: the caller's worktree; `--all`: the whole
server), `--json` too:

- **services** — environment, service, state (`running`, `starting`,
  `stopped`, `down`), public port, internal port, pid, the proxy's
  `lastActivityAt` and idle time, and resident memory summed over the
  service's tagged processes (Linux; null elsewhere);
- **database copies** — name, datastore, preset, state, holder (and whether its
  tether is alive), created.

### `--data-only` is removed

`up --data-only` is a usage error (exit 64) naming this decision and `runly
db`, answered before the daemon is contacted; an RPC client that still sends it
gets a work-error. The data-only ceiling (`BACKLOT_POOL_MAX_DATA_ONLY`,
`poolMaxDataOnly`) and the data-only environment kind are gone; a leftover
setting is ignored. The first recovery of a 0.15 daemon migrates every
data-only environment an older journal holds: a **leased** one becomes an
environment whose lease wants no services (its holder keeps the lease and the
data), an **unleased** one is recycled. The journal schema is 4: an older
daemon would read `activeServices: []` as "the whole app" and would never reap
a copy, so it refuses this journal.

## Consequences

- Adding a service costs that service's build and start, not a restart of
  everything. Taking one away is `down`.
- A worktree's environment and its test lanes no longer compete: the
  application keeps running while `runly db with` gives each lane its own
  database, as many at once as the lane wants. The integration lane of the
  founding consumer moves from `up --data-only` to `runly db with`, and its
  provenance check has nothing left to guard against: a copy holds the preset
  it was made from, and `ctx` says which preset each environment datastore
  holds.
- Reloading one datastore restarts its users only as far as the manifest says
  who they are. A service that reads a connection string some other way keeps
  running across the reload; the remedy is to template `{{datastores.x.url}}`
  (or not reference any datastore at all, which restarts everything).
- A fresh holder sees the data its predecessor left. A lane that needs known
  data says so with `--preset` (one store) or `--reset-data` (all).
- Copies cost disk on the datastore's server and nothing else. Without a tether
  they live as long as their worktree; `runly ps` and `db ls` show them.
- `ctx.dataOnly` and `status.envs[].dataOnly` are gone; `ctx.services` says
  what runs.

## Alternatives considered

- **Name datastores and appliances on `up`/`down` with kind prefixes**
  (`up db:main`). Rejected by the owner as too fine: datastores live with the
  environment, appliances are shared and never stopped implicitly (0018).
- **Keep `--data-only` next to `runly db`.** Rejected: it is one worktree's one
  environment in a second meaning, and the conflict with a running application
  is what broke the consumer's integration lane.
- **A TTL or a load budget for copies.** Rejected by the owner: a copy costs a
  catalog, and the holder/worktree reaping that environments use bounds it.
- **Restart every service on any preset change** (the old full path). Rejected:
  the manifest says who uses a datastore in almost every stack, and the full
  path is what made a one-store reset slow.

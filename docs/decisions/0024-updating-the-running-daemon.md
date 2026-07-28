# 0024. `backlot update` reconciles the running daemon to the installed build — skew is refused, and backlot never installs itself

- Status: Accepted
- Date: 2026-07
- Context: the CLI spawns the daemon from its own `dist/` (decision 0009), so
  upgrading backlot replaces the files on disk but never the daemon already in
  memory — and the socket carried no version at all, so nothing on either side
  could notice. A `backlot --version` did not exist either. The daemon can live
  for days, which is exactly how long the skew could last.
- Relates to: [0009](0009-local-daemon-no-central-service.md) (autospawn and the
  crash-recovery contract), [0010](0010-error-taxonomy.md) (the
  machine contract skew has to report through),
  [0018](0018-appliances-ensured-not-owned.md) (ensured, not owned),
  [0021](0021-quiesce-is-not-a-teardown.md) (a restart's state transition)

## Decision

Three separate things travel under the word "update", and backlot owns exactly
one of them:

| | Owner |
|---|---|
| Get a newer backlot onto the box | the package manager |
| Make the **running daemon** be the **installed** build | **backlot** |
| Update an environment to new code | `sync` |

1. **The daemon reports its version on `ping`**, which the CLI already issues on
   every invocation, so skew detection costs no extra round trip. `backlot
   --version` answers without touching the socket.

2. **Skew is refused, not warned about.** Any verb other than `update`, `doctor`
   and `daemon stop` fails with `infra-error` (exit 3) when the daemon's version
   differs from the CLI's. A daemon that reports no version is treated as old,
   because at the protocol level that is indistinguishable from agreement.

3. **`backlot update` restarts the daemon**; the next verb's autospawn brings up
   the installed build. It refuses an in-flight operation and refuses a
   downgrade, both overridable with `--force`. `--check` reports and does nothing.

4. **backlot never installs itself.** `update` prints the upgrade command for the
   detected install (npm-global, pnpm, project-local, git checkout) and leaves it
   to the caller.

5. **The journal stamps `PRAGMA user_version`.** A daemon refuses to open a state
   root stamped newer than it understands.

## Rationale

**Skew is silent, and silence is the expensive part.** An old daemon does not
reject arguments it has never heard of — it ignores them. A 0.8.0 daemon asked
for `up --data-only` boots the whole application into what the caller believes is
a datastore-only lease, and reports success. That is the shape of issue #41,
where a lease that was wrong on arrival was read as a broken seed preset by ~30
agents over 14 hours: the cost is not the failure, it is that the failure names
the wrong subsystem. A warning would not have helped, because it does not reach a
`--json` consumer at all. So the only honest response is to stop, and to stop in
the class an agent branches on correctly — `infra-error`, never `env-error`,
since recycling an environment cannot fix a daemon running the wrong code
(decision 0010).

**A restart was already a supported transition, so `update` needed no new
machinery.** `shutdown()` stops services, flips `hot → warm`, and records what
outlived the reap; `recover()` reaps recorded pids and leaves leases alone. The
lease survives; the holder's next verb rebinds. This is precisely what the idle
quiesce already does to a leased environment (decision 0021), and what
`assertUsable` already tells the holder to do. `update` is therefore a stop plus
the autospawn that decision 0009 already specifies — one code path, shared with
`daemon stop`.

**A live lease is not consent worth asking for; an in-flight operation is.** A
restart costs a holder one rebind — seconds, under bind-by-sync. Refusing on any
live lease would mean every update on a shared box needs `--force`, and a flag
you always pass stops meaning anything; that habituation is what made issue #40
destructive. A `busy` environment is different in kind: the check itself is
detached and survives, but the caller is blocked on the socket waiting for a
verdict, and a restart hands it a dead connection and no result. Every other
reclaim path already treats `busy` as inviolable, so this one does too. Holders
are named in the plan rather than asked.

**Downgrade is the direction that strands state.** Additive column migrations are
tolerant in one direction only: `data_only` defaults to 0, so an older daemon
re-binding a newer data-only environment reads "not data-only" and boots the
whole stack into a test lane's database. Nothing on disk said which build wrote
it — the same gap that let the sha256 env-id migration strand rows that then held
ports and counted against `POOL_MAX_TOTAL` forever. Disk is truth, so the truth
now says what wrote it, and a build that meets a journal from the future refuses
it before modifying anything.

**backlot does not own what it did not install.** A self-updater shelling out to
`npm i -g` is wrong for a pnpm install, wrong for `npx`, and destructive in a git
checkout, where `dist/` is tsc output. This is decision 0018's rule — ensured, not
owned — applied to backlot's own binary, and 0012's for the same reason: the
thing that knows how to install this package is the thing that installed it.

## Consequences

- Every verb pays one version comparison against a ping it was already making.
- An upgrade now has a required second step (`backlot update`), and skipping it
  produces a refusal naming the remedy rather than a wrong answer.
- The schema stamp must be bumped when a change makes an older daemon *misread*
  this journal — not for additive columns, which are read correctly by a build
  that selects a known subset.
- `BACKLOT_FAKE_VERSION` exists only so tests can provoke skew from a single
  build; a real install must never set it.

## Alternatives considered

- **Warn on skew and continue.** Rejected: stderr does not reach a `--json`
  consumer, and the failure it permits is a wrong result attributed elsewhere.
- **Version the RPC protocol per verb and negotiate.** Rejected for v1: it makes
  every verb carry compatibility logic to avoid one restart that costs seconds.
- **Have `update` install the package.** Rejected — see above.
- **Refuse a restart while any lease is live.** Rejected: force-habituation, and
  the transition is one the quiesce already performs unasked.
- **Drain leases before restarting (wait for holders to release).** Rejected: a
  lease can legitimately live for hours, so draining converts a
  seconds-long restart into an unbounded wait for no gain — the rebind is cheap.

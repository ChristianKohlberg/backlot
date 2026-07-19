# 0016. Data states, not seeds: three baselines, scenarios in tests, snapshots for the expensive middle

- Status: Accepted — doctrine in force; mechanisms deferred by [0022](0022-data-state-mechanisms-deferred.md)

## Context

"Seeding" was overloaded and under-baked. It lived as a single `create:` command
string on a datastore, and real repos (the founding .NET+MSSQL monorepo) kept growing
per-scenario presets — `admin-allbranches`, `leerpackung-erfasser`, `leerpackung-locked`
— a preset per test situation. That path leads to a large, fragile, silently-rotting
shared blob and a recurring "which preset do I use?" question. We need a principled
answer to: does backlot own seeding, what is a seed, how many variations exist, which
one a test uses, and where scenario-specific data belongs.

## Decision

### 1. A "seed" is a named, restorable data STATE — backlot owns the lifecycle, not the content

The *production* of data (SQL, seed scripts) belongs to the repo and backlot never reads
or understands it (the anti-scope: never a data framework, decision 0001). What backlot
owns is the **state lifecycle**: naming, selecting, restoring, and jumping between states
— because it already owns `reset-data`, hygiene levels, and template restore. A seed, in
backlot's model, is the entry point to a named state, not the insertion logic.

The two axes, and where each belongs:

- **Content axis** (what the data means, schema, layers) → the repo. Not backlot.
- **Lifecycle axis** (when/whether a state is built, cached, selected, restored) → backlot.

### 2. Three baselines, roughly constant forever

A stack should declare a small, stable set of base states — not a growing library:

| State | What it is | Consumers |
| --- | --- | --- |
| `empty` | schema only, no data | integration tests (bring their own data), schema work |
| `dev` | schema + realistic data + **deterministic** fixtures + role logins | humans inspecting, agents developing, **and most e2e** |
| `scaled` | `dev` + bulk volume | perf work only |

The load-bearing insight: **`dev` and "e2e fixtures" are the same state** when the demo
data is deterministic — the rich state a human clicks is the one an e2e test asserts on.
So one preset serves human + agent + e2e; `empty` and `scaled` are the two genuine
exceptions. The number stays ~3 and roughly constant.

### 3. Presets are for what is STABLE and SHARED; test setup is for what is SPECIFIC and CHANGING

The dividing line for any piece of required data: **do more than a couple of tests need
this exact data?**

- Yes → it belongs in a preset (a stable baseline).
- No → it belongs **in the test** (created in the test's own setup: API calls or inserts,
  asserted, torn down).

Test-local setup is preferred for the specific stuff because it is a maintenance *asset*,
not a liability: co-located with its assertion (self-documenting), owned by the test, and
it cannot silently rot — a schema change breaks that test's setup loudly instead of
serving stale data everywhere. Per-scenario baked presets are the failure mode
(proliferation, staleness, "which one?"); resist them. Push scenarios into tests.

### 4. The check declares its state — it is not a per-run guess

Which state an e2e/integration/perf suite needs is a property of the suite, versioned
with the code, expressed in the manifest per check:

```yaml
checks:
  e2e:         { run: pnpm e2e,    state: dev }
  perf:        { run: pnpm perf,   state: scaled }
  integration: { run: dotnet test, state: empty }
```

A datastore declares its states with a delegated `build` command and declared `inputs`
(globs backlot hashes) so template invalidation is automatic and states are selectable:

```yaml
datastores:
  main:
    driver: mssql
    states:
      empty:      { build: "scripts/db seed apply empty --db {{ns}}",      inputs: [.../schema/**] }
      dev:        { build: "scripts/db seed apply dev-schema --db {{ns}}", inputs: [.../seed/**] }
      scaled:     { build: "scripts/db seed apply analysis-s --db {{ns}}", inputs: [.../seed/**, .../perf/**] }
    default: { session: dev, run: dev }
```

`inputs`-hash keying replaces the command-string keying of decision 0008 for states
(editing a seed auto-rebakes; no manual `@rebake-template`). Runtime selection:
`backlot up --state <name>`.

### 5. Snapshots serve the expensive middle: test-local state that is costly to build

`reset-data` rewinds to the *declared* baseline. A **snapshot** rewinds to *a point you
chose at runtime* — for the debugging loop where reproducing a bug requires multi-step
setup the seed doesn't capture (build the case by hand → `snapshot repro` → try a fix →
`restore repro` → try another). Mechanically it is the datastore's native fast
clone/backup (sqlite file copy, postgres template, MSSQL BACKUP/RESTORE) pointed at a
user-named key instead of a state-hash key — seconds where a full re-seed is minutes.

Honest limits: a snapshot's value is proportional to how much per-session state you build
*beyond* the seed (nil if a preset already captures it); restore is not transparent to a
running app (MSSQL restore kicks connections — the app reconnects or the service bounces);
and it only accelerates stores with a clone primitive.

### 6. A migration is an INPUT to a state, not a separate concept

A schema migration changes how a state is *produced*, so it is an input to every state
that shares the schema (`empty`/`dev`/`scaled` move together). Two paths, routed to the
two mechanisms backlot already has — backlot decides *when*, the repo's migrate command
does the work, backlot never reads the migration:

- **Fresh / `reset-data` / `pristine` (rebuild).** The migration is part of the state's
  `build`, so its files are in the state's `inputs`. Adding a migration changes the input
  hash → the template rebakes → new and reset environments get the migrated schema for
  free (mechanism: S2 inputs-hash keying). For the founding monorepo this is already true:
  migrations run inside `scripts/db seed apply` (the net-new `NNNN_*.sql` scripts), so a
  new migration script is a changed seed input.

- **Live environment you want to keep (advance in place).** On a `reuse` bind the
  datastore already exists (no reseed), and an `upkeep` rule keyed on the migrations
  directory applies the delta to the existing DB, preserving data. The per-env,
  direction-agnostic fingerprint ledger (decision 0008) runs *all* migrations on a fresh
  env and only the *new* one on a live env:

  ```yaml
  upkeep:
    - { when: "glob(sherlock/database/migrations/**)", run: "scripts/db migrate --db {{ns}}" }
  ```

The elegance: the same migration change is handled correctly by whichever bind comes
next — `reuse` migrates in place, `reset`/`pristine` rebuilds from the rebaked template —
and both converge on the same schema. You pick a hygiene level, not a "migration mode".

**Snapshots are schema-version-bound (the sharp consequence).** A snapshot taken at the
old schema, restored after a migration, brings the OLD schema back under NEW code — an
inconsistent state that fails confusingly. Therefore a snapshot MUST carry the current
schema/migration fingerprint, and `restore` MUST refuse-or-warn when it does not match
the environment's current fingerprint. This is a hard requirement the migration case adds
to S3, not an optional nicety.

Further honest edges: a *destructive* migration makes the in-place path (preserves rows
minus the dropped column) and the from-scratch path (reseeds) diverge on data — not
byte-identical after a lossy migration; and migrating a live DB carries the same
connection/lock caveat as restore (transparent for additive/EF migrations, may need a
service bounce for a heavy one).

## Consequences

- Positive: the "how many presets?" question has a stable answer (three); test data has a
  clear home (baseline → preset, specific → test); "which preset for this run?" is
  answered by the check, not a human; editing a seed no longer silently serves stale data;
  the debugging loop gets fast time-travel without re-seeding.
- Negative / trade-offs: `dev` must be *disciplined* to stay a baseline rather than grow
  into a dumping ground; `inputs` must be declared (backlot won't discover a command's
  file reads); snapshot/restore adds a per-datastore-driver capability and the
  connection-blip caveat.
- Doctrine held: backlot never produces or understands data — it names, selects, caches,
  restores. Every mechanism here is lifecycle, not content.

## Follow-ups (deferred by [0022](0022-data-state-mechanisms-deferred.md) until their forcing conditions occur)

1. `--state` selection + per-check `state:` (exposes the presets already declared).
2. `states:` with declared `inputs` → content-hash template keying (kills silent-stale).
3. `snapshot` / `restore` verbs over the datastore clone primitive.
4. (Later) composable/layered states consuming the repo's existing per-layer hashes;
   shared/"golden" states across machines (coupled to the remote substrate, 0.3).

## Alternatives considered

- **Keep seeding a single opaque `create:` command (status quo).** Rejected: no runtime
  selection, command-string template keying serves stale seeds silently, no introspection.
- **A rich library of per-scenario baked presets.** Rejected: proliferation, staleness,
  and "which one?" — the exact mess this ADR routes around by pushing scenarios into tests.
- **backlot understands seed structure (layers, schemas).** Rejected: violates the
  anti-scope; a worse copy of the repo's own seed spine.

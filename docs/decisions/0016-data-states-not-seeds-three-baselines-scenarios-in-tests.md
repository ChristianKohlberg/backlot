# 0016. Data states, not seeds: three baselines, scenarios in tests, snapshots for the expensive middle

- Status: Accepted

## Context

"Seeding" was overloaded and under-baked. It lived as a single `create:` command
string on a datastore, and real repos (the founding .NET+MSSQL monorepo) kept growing
per-scenario presets — `admin-allbranches`, `leerpackung-erfasser`, `leerpackung-locked`
— a preset per test situation. That path leads to a large, fragile, silently-rotting
shared blob and a recurring "which preset do I use?" question. We need a principled
answer to: does infront own seeding, what is a seed, how many variations exist, which
one a test uses, and where scenario-specific data belongs.

## Decision

### 1. A "seed" is a named, restorable data STATE — infront owns the lifecycle, not the content

The *production* of data (SQL, seed scripts) belongs to the repo and infront never reads
or understands it (the anti-scope: never a data framework, decision 0001). What infront
owns is the **state lifecycle**: naming, selecting, restoring, and jumping between states
— because it already owns `reset-data`, hygiene levels, and template restore. A seed, in
infront's model, is the entry point to a named state, not the insertion logic.

The two axes, and where each belongs:

- **Content axis** (what the data means, schema, layers) → the repo. Not infront.
- **Lifecycle axis** (when/whether a state is built, cached, selected, restored) → infront.

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
(globs infront hashes) so template invalidation is automatic and states are selectable:

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
`infront up --state <name>`.

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

## Consequences

- Positive: the "how many presets?" question has a stable answer (three); test data has a
  clear home (baseline → preset, specific → test); "which preset for this run?" is
  answered by the check, not a human; editing a seed no longer silently serves stale data;
  the debugging loop gets fast time-travel without re-seeding.
- Negative / trade-offs: `dev` must be *disciplined* to stay a baseline rather than grow
  into a dumping ground; `inputs` must be declared (infront won't discover a command's
  file reads); snapshot/restore adds a per-datastore-driver capability and the
  connection-blip caveat.
- Doctrine held: infront never produces or understands data — it names, selects, caches,
  restores. Every mechanism here is lifecycle, not content.

## Follow-ups (sequenced)

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
- **infront understands seed structure (layers, schemas).** Rejected: violates the
  anti-scope; a worse copy of the repo's own seed spine.

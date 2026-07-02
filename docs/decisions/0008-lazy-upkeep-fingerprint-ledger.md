# 0008. Lazy upkeep via a per-environment fingerprint ledger

- Status: Accepted

## Decision

Dependency/generation/toolchain drift is handled by a **closed list** of
`(fingerprint → action)` rules in the manifest, run at bind time (after sync, before
build/start). Each environment keeps a ledger of trigger hashes *as last applied in
that environment*; the incoming binding's hashes are compared against that ledger —
**direction-agnostic**, so binding older work also converges. Idle environments are
never touched; pool divergence is normal, bounded by one upkeep pass at next use.

**No background mutation of environments.** The one sanctioned proactive act is
**background template baking**: data templates are machine-global and immutable-keyed
(`preset@seed-hash`), so a new key bakes alongside the old with no races.

Failed upkeep defaults to `work-error` (the binding changed the trigger). Toolchain
bumps (global.json, .nvmrc) are env-recycle events unless the repo declares its own
toolchain rule (mise/asdf); infront never installs SDKs on its own initiative.

## Rationale

Lazy is predictable, and predictability is what agents need. Machine-global package
stores (pnpm, NuGet) make Nth-environment installs mostly hard-linking, so eager
pool-wide updates would buy seconds at the cost of a scheduler and races.

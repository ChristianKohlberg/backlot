# Landscape scout — 2026-07-20

Web-verified competitive map (primary sources in the scout transcript; funding
and acquisition facts checked against press). Scored against backlot's four
differentiators: D1 dirty-worktree bind in seconds, D2 leases + warm pool +
free abandonment, D3 named data states with reset-to-baseline, D4 machine
verdicts with the work/env/infra taxonomy.

## Verdict: no direct equivalent exists (searched, not assumed)

No tool in six categories combines even two differentiators. Nearest
structural hits, one differentiator each: kubernetes-sigs/agent-sandbox
(literal SandboxWarmPool/SandboxClaim CRDs — cluster-side, nothing else),
LocalStack Cloud Pods (named restorable state, AWS-emulation only), Okteto
(dirty-code sync into enterprise K8s). **The verdict taxonomy (D4) is
productized nowhere.**

## Closest rivals

- **Okteto** — closest narrative ("agents need runtime feedback"; Agent
  Fleets; `okteto sync` is real D1). Delta: enterprise K8s platform sale; no
  pool/lease economics, no data states, logs not verdicts.
- **Dagger container-use** — closest shape (local, per-agent env, MCP). Delta:
  answers only "agents must not trample each other"; no services, data, or
  verdicts; fresh-per-agent, not leased-warm.
- **Fly Sprites / Morph Infinibranch** — closest philosophy (durable envs,
  free idling, sub-second checkpoint/branch). Delta: substrates — a computer,
  not a working instance of your app. Future remote drivers, not rivals.

## Strategic notes

- **Database branching validates D3 at scale**: Neon acquired by Databricks
  (~$1B, 2025); 80% of its databases agent-created; Xata sells agent/CI
  clones. Read as a DRIVER TARGET (`driver: neon` mapping presets to
  branches), not a rival — but if an app's whole state lives in branchable
  cloud Postgres, D3 alone won't sell backlot; the bundle must.
- **Positioning risk ranking**: Docker by distribution (Compose +
  Testcontainers + Sandboxes is an assembly job; their post-acquisition track
  record buys time), Dagger by codepath, Okteto by narrative, and the agent
  vendors (Cursor, Codex post-Ona-acquisition-by-OpenAI) by bundling. Moat
  per the evidence: seconds-fast local dirty-bind + the verdict contract —
  nobody does either well, nobody does both.
- Market events folded into §14: Gitpod→Ona→OpenAI (2026-06); Daytona pivoted
  and closed-sourced; hyperscaler sandbox primitives everywhere (2025-26).

## Treehouse (same-day adjacent investigation)

kunchenguid/treehouse (Go OSS, 988★) pools reusable git worktrees — the
consumer-side step backlot deliberately does not own. Absorbing was declined:
it would violate decisions 0001/0002 (never own the consumer's side) and 0020
(no Go), it is not ours to absorb, and the seam is already whole (the worktree
path is the entire contract; deletion-under-lease is handled by the stale-root
reap and soak-tested). Actions filed instead: pairing docs, `up --shell`,
and the per-repo pool opt-in (see BACKLOG 2026-07-20).

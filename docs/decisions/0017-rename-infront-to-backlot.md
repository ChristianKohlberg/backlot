# 0017. Rename: infront → backlot

- Status: Accepted

## Decision

The project is named **backlot** (was: infront). CLI `backlot`, MCP adapter
`backlot-mcp`, npm package `backlot`, state under `~/.local/state/backlot`, per-repo
runtime dir `.backlot`, env vars `BACKLOT_*`. Renamed before the npm publish and with
one real consumer (Revamp), while the cost was a mechanical sweep rather than a
deprecation trail.

## Rationale

- **The metaphor is the model.** A studio backlot is a lot of standing sets —
  permanent, expensive to build, cheap to revisit — and *productions visit them*.
  That is exactly the core trick (0003 durable environments, 0006 convergence over
  checkpointing): environments are pooled, durable, warm; work visits them and
  leaves; the set stays standing. "infront" named the effect (put an instance in
  front of a consumer); "backlot" names the thing itself.
- **Collision and findability.** "Infront" is an established brand twice over
  (Infront ASA, financial software; Infront Sports & Media) — poor SEO forever, and
  a same-industry trademark neighbor. "backlot" has no dev-tooling squatter and the
  npm name was free at decision time.
- **Spelling.** "infront" is a misspelling of "in front"; "backlot" is a real word.

The thesis sentence survives intact — backlot still "puts a working instance of your
web application in front of a coding agent" — it just no longer has to be the name.

## Consequences

- 0001's thesis wording and all docs updated in the same sweep; historic decision
  titles keep their meaning (they describe the same project).
- No compatibility shims: pre-publish, pre-second-consumer, so old names simply die.
  The one known consumer (Revamp's `stack.yaml` + skill + ADR) is updated alongside.
- The old `~/.local/state/infront` dir is abandoned (daemon stopped, pool recycled
  before the rename); the new state root is created lazily on first use.

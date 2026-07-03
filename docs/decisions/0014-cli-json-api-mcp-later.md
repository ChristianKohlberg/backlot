# 0014. The CLI with --json is the v1 agent API; MCP is a v1.1 wrapper

- Status: Accepted

## Decision

Every verb supports `--json`; stdout is data, stderr is human narration; exit codes are
contractual. `backlot ctx --json` returns the complete consumer context in one blob:
service URLs, logins, token-mint hook, connection strings, artifact dir, hygiene state,
recent service events. An MCP server ships after the verbs stabilize, as a thin adapter
over the same daemon socket — never a second implementation.

## Rationale

Agents shell out today; a machine-readable CLI is immediately usable by every harness.
Freezing MCP tool shapes before the verbs survive a second consumer would lock the
wrong things early. The division of labor stays: backlot is where code *runs*, the
worktree is where the agent *works* — fast unit tests never pay the broker tax.

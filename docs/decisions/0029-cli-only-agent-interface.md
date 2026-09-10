# 0029. Agents use the CLI; remove the MCP adapter

- Status: Accepted

## Decision

Remove the MCP stdio adapter and the `backlot-mcp` executable. Agents use
`backlot --json` through their existing shell tools; the daemon RPC, CLI and
Claude Code skill remain supported. This intentionally breaks existing MCP
launch configurations: remove those entries and use the CLI instead.

This supersedes the MCP portion of decision 0014 and the MCP executable name
in decision 0017. Historical reviews and milestone records describe the product
at their original date, not a currently supported adapter.

Builds clean `dist` before compilation, and `prepack` builds before npm creates
a tarball, so outputs left by older checkouts cannot ship the removed adapter.
`prepublishOnly` retains its independent build guarantee. No release version is
changed by this removal; release preparation must account for the breaking API.

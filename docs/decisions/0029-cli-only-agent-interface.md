# 0029. Agents use the CLI; remove the MCP adapter

- Status: Accepted

## Decision

Remove the MCP stdio adapter and the `backlot-mcp` executable. This is an
intentional breaking removal; see the
[README migration guidance](../../README.md#quickstart) for the supported interface
and migration steps.

This supersedes the MCP portions of decisions 0014, 0017, 0020 and 0024.
Historical reviews and milestone records describe the product at their original
date, not a currently supported adapter.

Builds clean `dist` before compilation, and `prepack` builds before npm creates
a tarball, so outputs left by older checkouts cannot ship the removed adapter.
`prepublishOnly` retains its independent build guarantee. No release version is
changed by this removal; release preparation must account for the breaking API.

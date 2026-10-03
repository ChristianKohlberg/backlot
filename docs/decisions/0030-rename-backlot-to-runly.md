# 0030. Rename: Backlot → Runly

- Status: Accepted
- Supersedes the naming decision in [0017](0017-rename-infront-to-backlot.md).

The product is now **Runly**; the npm package and CLI are `runly`. The name was chosen by the owner for its short, action-oriented CLI.
`runly.yml` is the canonical manifest. The bundled Claude plugin and skill use
`runly`; the existing GitHub repository URL remains valid and unchanged.

Unlike the pre-publication rename in 0017, this rename has installed consumers.
Keep the `backlot` binary alias and discover manifests in order: `runly.yml`, `backlot.yml`, `stack.yaml`.
Keep `BACKLOT_*` settings and process tags, the state root, `.backlot` runtime
files, and database namespaces stable: the rename must not strand live services,
leases or databases. The old schema filename remains available too.

Version 0.12.0 lets the existing version-skew gate detect an older daemon.
Users explicitly run `runly update` after installing; installation itself never
restarts a shared daemon. Historical decisions retain their original names.

The MCP adapter remains removed under [0029](0029-cli-only-agent-interface.md);
this rename does not restore its binaries or protocol.

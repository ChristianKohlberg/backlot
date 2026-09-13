# runly — Claude Code plugin

Teach [Claude Code](https://claude.com/claude-code) to drive
[runly](https://github.com/ChristianKohlberg/backlot) — the repo-aware
environment broker — against any repo that has a `runly.yml`. This plugin
bundles:

- **The `runly` skill** — a stack-agnostic guide to the lease model (warm pool,
  bind-by-sync, session vs run leases) and the verb table (`up` incl. the
  partial/per-service form, `run`, `ctx`, `release`, `sync`, `exec`, `logs`,
  `reset-data`, `token`, `preview`, `status`), so the agent leases a running, seeded,
  authenticated env correctly instead of hand-rolling dev servers.

runly is a **CLI-only** tool, so this plugin ships **only the skill — there is
no MCP server and no `.mcp.json`.** The one prerequisite is the `runly` CLI on
your `PATH` (`npm i -g runly`) and a `runly.yml` at the consuming repo's root.

## Install (two lines)

This repository doubles as the plugin marketplace. From inside Claude Code:

```
/plugin marketplace add ChristianKohlberg/backlot
/plugin install runly
```

## Canonical skill

The skill in `skills/runly/SKILL.md` is the **upstream canonical** runly
skill — deliberately generic to any runly project. Keep it stack-agnostic; do
not hardcode any single consuming repo's services or presets here.

## Existing Backlot installations

The plugin identity changed from `backlot@backlot` to `runly@runly`.
An existing installation does not become Runly just by updating the CLI.
After the renamed plugin is available in the upstream repository, migrate a
user-scoped installation from a terminal:

```bash
claude plugin uninstall backlot@backlot --scope user
claude plugin marketplace remove backlot --scope user
claude plugin marketplace add ChristianKohlberg/backlot
claude plugin install runly@runly --scope user
```

For a project- or local-scoped installation, use that same scope for removal and
installation, and update its marketplace declaration in that scope. Do not leave
both skills enabled. Start a new Claude Code session after the migration.
The CLI migration is separate; follow the
[Backlot-to-Runly installation instructions](../../README.md#moving-from-backlot-to-runly).

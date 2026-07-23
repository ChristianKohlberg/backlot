# backlot — Claude Code plugin

Teach [Claude Code](https://claude.com/claude-code) to drive
[backlot](https://github.com/ChristianKohlberg/backlot) — the repo-aware
environment broker — against any repo that has a `backlot.yml`. This plugin
bundles:

- **The `backlot` skill** — a stack-agnostic guide to the lease model (warm pool,
  bind-by-sync, session vs run leases) and the verb table (`up` incl. the
  partial/per-service form, `run`, `ctx`, `release`, `sync`, `exec`, `logs`,
  `reset-data`, `token`, `status`), so the agent leases a running, seeded,
  authenticated env correctly instead of hand-rolling dev servers.

backlot is a **CLI-only** tool, so this plugin ships **only the skill — there is
no MCP server and no `.mcp.json`.** The one prerequisite is the `backlot` CLI on
your `PATH` (`npm i -g backlot`) and a `backlot.yml` at the consuming repo's root.

## Install (two lines)

This repository doubles as the plugin marketplace. From inside Claude Code:

```
/plugin marketplace add ChristianKohlberg/backlot
/plugin install backlot
```

## Canonical skill

The skill in `skills/backlot/SKILL.md` is the **upstream canonical** backlot
skill — deliberately generic to any backlot project. Keep it stack-agnostic; do
not hardcode any single consuming repo's services or presets here.

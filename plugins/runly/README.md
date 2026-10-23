# runly — Claude Code plugin

Two stack-agnostic skills for runly:

- **runly** operates an existing stack: services, tests, database copies, logs,
  idle and wake, previews, recovery and cleanup.
- **runly-setup** creates or edits runly.yml or runly.yaml: services, ports,
  readiness, builds, upkeep, seeded data, caller inputs and validation. It also
  recommends datastore/container topology, audits hidden cache costs, and provides
  an initial monitoring plan to tune the setup from real usage.

The plugin ships skills only, with no MCP server.
Install the CLI with npm i -g @theford/runly, then run runly update after upgrades.

## Install

This repository is also the plugin marketplace. In Claude Code:

~~~text
/plugin marketplace add ChristianKohlberg/runly
/plugin install runly
~~~

## Canonical skills

[runly](skills/runly/SKILL.md) and [runly-setup](skills/runly-setup/SKILL.md)
are the upstream skills. Keep both generic: never hardcode a consuming repo's
services or presets. Bump version in .claude-plugin/plugin.json whenever either
skill changes.

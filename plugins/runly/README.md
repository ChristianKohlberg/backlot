# runly — Claude Code plugin

Teaches [Claude Code](https://claude.com/claude-code) to drive
[runly](https://github.com/ChristianKohlberg/backlot) against any repo that has a
`runly.yml`. It bundles one thing: the **`runly` skill**, a short, stack-agnostic
guide to starting the app in your worktree (`up`/`down`), running your own tests
against it (`ctx --env`), database copies (`db with`), `ps`, `plan`, `logs`, idle
and wake, the session tether and `destroy`.

runly is CLI-only, so the plugin ships only the skill: no MCP server and no
`.mcp.json`. It needs the `runly` CLI on your `PATH` (`npm i -g runly`) and a
`runly.yml` at the repo root.

## Install

This repository is also the plugin marketplace. In Claude Code:

```
/plugin marketplace add ChristianKohlberg/backlot
/plugin install runly
```

## The canonical skill

`skills/runly/SKILL.md` is the upstream runly skill. Keep it generic: never
hardcode a consuming repo's services or presets. Bump `version` in
`.claude-plugin/plugin.json` whenever the skill changes.

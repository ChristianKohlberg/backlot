# runly

[![npm](https://img.shields.io/npm/v/@theford/runly)](https://www.npmjs.com/package/@theford/runly) [![ci](https://github.com/ChristianKohlberg/runly/actions/workflows/ci.yml/badge.svg)](https://github.com/ChristianKohlberg/runly/actions/workflows/ci.yml) [![release](https://img.shields.io/github/v/release/ChristianKohlberg/runly)](https://github.com/ChristianKohlberg/runly/releases)

**Let your agents verify their work without getting in each other's way.**

One agent restarts the app. Another resets the database. A third tests the wrong
version—and starts fixing a problem it didn't create.

Git worktrees separate your code. Runly extends that separation to the running
application and its data. Each worktree gets its own app, data and URLs, so agents
can build, test and demonstrate their changes independently.

Idle services stop and wake when needed, while temporary public previews expire.
More parallel work. Less interference. Less cleanup.

## Quickstart

Requires Node ≥ 22.13 and git, on Linux or macOS. Install from npm:

```sh
npm i -g @theford/runly
mkdir runly-demo && cd runly-demo
git init -q
```

This tiny demo needs no dependencies. For an existing app, use its normal start
command in the manifest—you do not need an extra server file.

Save the demo as `server.mjs`:

```js
import { createServer } from 'node:http';

createServer((_req, res) => res.end('Hello from Runly!\n'))
  .listen(Number(process.env.PORT), '127.0.0.1');
```

Save this as `runly.yaml` (`runly.yml` also works):

```yaml
name: runly-demo
services:
  web:
    build: node --check server.mjs
    run: node server.mjs
    port: web
    env:
      PORT: "{{ports.web}}"
    ready:
      http: /
```

Start the app:

```sh
runly up
```

Open the URL printed in your terminal. Edit `server.mjs`, then run `runly up`
again to see your change.

For your own app, see the [everyday guide](docs/overview.md) and
[manifest reference](docs/manifest.md).

`runly down` stops services and keeps data. `runly destroy` removes this worktree's
Runly environment, including its databases; it never deletes your source files.
Removing or renaming the worktree also triggers environment cleanup.

## Upgrade

```sh
npm i -g @theford/runly
runly update
```

The second command restarts an older running daemon onto the installed version.

## Agent skills

Use **runly-setup** to get started and **runly** to operate an existing setup.
Install both in Claude Code:

```text
/plugin marketplace add ChristianKohlberg/runly
/plugin install runly
```

Then ask your agent: “Use the runly-setup skill to configure this repository for
parallel worktrees and verify the setup.” For everyday work, ask it to use the
runly skill to start services, run tests or investigate failures.

Runly needs a `runly.yaml` (or `runly.yml`) that matches your app and how you want
to work. The setup skill guides your agent through the repository to recommend
services and containers, isolated datastores and seed data, build/cache rules,
and readiness checks—then test those choices. You can write the manifest yourself;
the skill helps with the investigation and verification, beyond YAML syntax.

**Review the setup with your agent.** Double-check which services you need, what
data may be reset, what stays shared across worktrees, and whether the tests cover
your workflow. Ask what was verified and what remains untested. Monitor the first
few sessions to tune resource limits, caching and idle/wake behavior.

## Documentation

- [Everyday guide](docs/overview.md): lifecycle, data, testing and failures.
- [Operations and tuning](docs/operations.md): monitoring, previews, load budgets and daemon setup.
- [CLI reference](docs/cli.md) and [manifest reference](docs/manifest.md).
- [Architecture and settings](docs/architecture.md), [driver contracts](docs/driver-spec.md) and [decision history](docs/decisions/).
- [Examples](examples/): Node, Python and multi-service stacks with seeded databases.

## License

Apache-2.0.

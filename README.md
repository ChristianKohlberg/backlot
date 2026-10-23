# runly

[![npm](https://img.shields.io/npm/v/@theford/runly)](https://www.npmjs.com/package/@theford/runly) [![ci](https://github.com/ChristianKohlberg/runly/actions/workflows/ci.yml/badge.svg)](https://github.com/ChristianKohlberg/runly/actions/workflows/ci.yml) [![release](https://img.shields.io/github/v/release/ChristianKohlberg/runly)](https://github.com/ChristianKohlberg/runly/releases)

Run your app's services with seeded databases and stable local URLs, one environment
per worktree. Runly uses your existing commands and build tools. Idle services stop
after five minutes and wake on traffic; their data stays.

## Quickstart

Requires Node ≥ 22.13 and git, on Linux or macOS. Install from npm:

```sh
npm i -g @theford/runly
mkdir runly-demo && cd runly-demo
git init -q
```

Save this as `server.mjs`:

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

Start it and request its assigned URL:

```sh
runly up
eval "$(runly ctx --env)"
curl "$RUNLY_URL_WEB"
runly logs web
```

Edit `server.mjs`, then run `runly up` again. This example's build has no declared
outputs, so it restarts the service on each `up`. For a real app, use its dev server
or configure [build outputs](docs/manifest.md) to control restarts.

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

The plugin includes **runly** for CLI operation and **runly-setup** for manifest
setup, datastore choices and initial tuning. In Claude Code:

```text
/plugin marketplace add ChristianKohlberg/runly
/plugin install runly
```

## Documentation

- [Everyday guide](docs/overview.md): lifecycle, data, testing and failures.
- [Operations and tuning](docs/operations.md): monitoring, previews, load budgets and daemon setup.
- [CLI reference](docs/cli.md) and [manifest reference](docs/manifest.md).
- [Architecture and settings](docs/architecture.md), [driver contracts](docs/driver-spec.md) and [decision history](docs/decisions/).
- [Examples](examples/): Node, Python and multi-service stacks with seeded databases.

## License

Apache-2.0.

# Manifest reference

`runly.yml` or `runly.yaml` at the repo root ([JSON Schema](../schema/runly.schema.json)). Commands
run under `sh` in the worktree; write POSIX sh.

| Field | Meaning |
| --- | --- |
| `name` | Stack name (`a-z0-9-`). Required. |
| `services.<svc>.run` | The supervised command. Required. |
| `services.<svc>.build` | Command run before the service starts, on every `up`. `{ run, when: [globs], serial }`: `when` skips it while the matched files are unchanged since the last successful build and its `outputs:` are still what that build left; `serial: true` runs it alone. |
| `services.<svc>.outputs` | Globs the build produces; a running service restarts only when they changed. `{ paths, compare: stat \| content }`. None declared = restart after every build. |
| `services.<svc>.port` | Symbolic port name. Omit for a portless worker. |
| `services.<svc>.env` | Environment variables; values may use templates (below). |
| `services.<svc>.env_from` | Caller variables to pass in: `NAME: required \| optional`. Not `BACKLOT_*`. |
| `services.<svc>.cwd` | Working directory, relative to the repo root. |
| `services.<svc>.ready` | Readiness: `http` (path answering 200), `log` (regex), or `cmd` (exit 0); `timeout` seconds (120). |
| `services.<svc>.fatal_logs` | Regex that fails the start at once when it appears in the log. |
| `services.<svc>.depends_on` | Services that must be ready first. |
| `services.<svc>.idle` | Idle time before the service is stopped (`90s`, `30m`, `2h`, seconds, or `never`). Default 5 minutes. |
| `services.<svc>.resources` | Cost for the load budget: `{ memory, cpu, build: { memory, cpu } }`. Default 512M / 0.5 cpu running, 1G / 1 cpu building. |
| `datastores.<ds>.driver` | `sqlite`, `postgres`, `mssql`, `mysql` or `redis`. Required. |
| `datastores.<ds>.create` | Creates and seeds a namespace; `{{ns}}`, `{{preset}}`. |
| `datastores.<ds>.drop` | Drops a namespace; `{{ns}}`. Needed for `runly db` copies of a server datastore. |
| `datastores.<ds>.template_restore` | Restores a baked template into a namespace; `{{template}}`, `{{ns}}`. Server drivers. |
| `datastores.<ds>.template` | `true`: bake a template file and restore by copy. sqlite only. |
| `datastores.<ds>.url` | Connection string handed to services; `{{ns}}`. Required for server drivers. |
| `datastores.<ds>.probe` | `host:port` checked before anything starts (unreachable = infra-error). |
| `datastores.<ds>.server` | `external` (the only value): runly never runs a database server. |
| `datastores.<ds>.presets` | Named seed states. |
| `datastores.<ds>.default_preset` | The preset a new datastore is created with (else the first preset). A name, or `{ session, run }` read as one value. |
| `datastores.<ds>.ephemeral` | `true`: no presets or templates; a reset runs `drop:` as a flush (Redis-class). |
| `datastores.<ds>.share_templates` | `false`: keep this datastore's templates per worktree. Default: a template keyed by an `@rebake-template` rule is baked once and shared by every worktree of the same stack name on this machine; `--pristine` bakes a private one for its worktree. |
| `datastores.<ds>.copies_only` | `true`: never provisioned for an environment; only the source of `runly db new\|with` copies (template baked on the first copy). No service may template it; `ctx` does not list it. |
| `datastores.<ds>.list` | Command printing the namespaces on the server, one per line; read only by `runly pool doctor`. |
| `appliances.<name>` | A shared backing server: `probe` (required), `start` (run once when the probe fails), `stop` (only for `runly appliance stop`), `ready`, `timeout` (60), `resources`. |
| `upkeep[]` | `{ when: <path or glob>, run: <cmd>, timeout: <s>, outputs: <path or list> }`: runs when the matched files' content changed since it last ran in this worktree, or when a declared `outputs` path is missing (a `git clean` removed it). `runly destroy` forgets the rules that declare no `outputs`, so they run again on the next `up`. `run: "@rebake-template <ds>"` makes the matched files part of that datastore's template key: changed content gets a new template (baked once, then reused) and reloads the store; `--pristine` rebakes. Timeout 300 s. |
| `builds` | `parallel` (default): builds run in `depends_on` waves, each wave at once. `serial`: one at a time, in manifest order. |
| `caches` | Build and install output in the worktree (`node_modules`, `**/obj`); never an upkeep trigger. |
| `sync.include` | Git-ignored files an upkeep `when:` may still match (`.env.local`). |
| `auth.logins` | One `{ user, password, role, description }` or a list; the first is the primary login. |
| `auth.token` | Command printing a token on stdout; `{{role}}`. |
| `preview.publisher` | `cloudflare-quick` (default), `cloudflare-named` or `tailscale`. |
| `preview.domain`, `preview.prefix` | `cloudflare-named`: the zone, and the hostname suffix (default: the environment id). |
| `preview.https_port` | `tailscale`: the tailnet HTTPS port (default: derived per environment and service). |
| `preview.forbidden` | `true`: `runly preview` is refused. |

Templates: `{{ports.<port>}}`, `{{public_ports.<port>}}`, `{{services.<svc>.url}}`,
`{{datastores.<ds>.url}}`, `{{datastores.<ds>.ns}}`. In a service's own `run:` and
`env:`, its own `{{ports.<port>}}` is the internal port it must listen on;
everywhere else ports and URLs are the stable public ones. Top-level `outputs`,
`checks` (with a warning), `sync.keep`, `watch_run` and `hot_reload` are accepted
and ignored.

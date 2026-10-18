---
name: runly-setup
description: Create or edit a repository's runly.yml or runly.yaml manifest, including datastore/container topology, service orchestration, hidden build/cache costs, and initial monitoring and tuning. Use runly for operating an already configured stack.
---

# Set up runly

Build a manifest around the repository's existing commands. Inspect its package
scripts, build outputs, dev-server options, seed commands and tests first.
Preserve existing configuration when editing it.

Setup includes a recommendation and a measured first iteration, not just valid
YAML. Read [topology](references/topology.md) before choosing datastore, container
and service boundaries. Read [tuning](references/tuning.md) for the cache audit,
verification matrix and initial monitoring plan.

Trace scripts, Compose/Docker entrypoints, migration/seed paths and test fixtures.
Explain the proposed ownership/isolation boundaries and why they fit this repo.
Find redundant work and missing invalidation inputs before enabling skips.
Validate correctness first; measure cost before claiming an optimization.
Initial real-world use needs monitoring to fine-tune resource declarations,
build/seed caching, readiness and idle/wake behavior.

## Format and discovery

Use runly.yml or runly.yaml at the stack root. Discovery searches upward;
runly.yml wins when both exist. Maintain one manifest. backlot.yml and stack.yaml
are no longer accepted.

Use schema/runly.schema.json and README.md from the installed runly package for
exact fields. A global npm install places them under the npm root -g directory,
inside @theford/runly. The source repository also has docs/overview.md and examples.
There is no init, validate or check verb. runly plan --json loads and validates
the manifest and reports load admission; it does not prove the app boots.

## Services and readiness

Adapt this example to a command and health route that exist in the repo:

~~~yaml
name: my-app
services:
  web:
    run: npm run dev -- --port "$PORT"
    port: web
    env:
      PORT: "{{ports.web}}"
    ready: { http: /health, timeout: 60 }
~~~

Commands run under POSIX sh in the actual worktree; cwd changes a service's
working directory. port is a symbolic key, not a fixed number.
A service's own {{ports.web}} is its internal listening port. Peers use
{{services.web.url}} or {{ports.web}} to reach its stable public proxy.
{{public_ports.web}} always means public. Tests must use the public URL so
their traffic counts as activity.

depends_on names services that must be ready first, including dependencies
needed by readiness probes; otherwise wake can wait on an idle peer.
ready.http needs HTTP 200, ready.log an actual startup marker, or ready.cmd an
exit-zero check. Readiness timeout is seconds. Portless workers omit port and
use log or command readiness. fatal_logs should match real failures, not warnings.

Default idle is five minutes of environment-wide inactivity; idle: 90s overrides
it per service. Use idle: never for workers whose useful work produces no proxy
traffic. WebSocket heartbeats and server push count; silent sockets do not.
resources describes running/build memory and CPU costs:
{memory: 512M, cpu: 0.5, build: {memory: 1G, cpu: 1}}.
Adjust from measurements instead of disabling the load budget.

## Upkeep and builds

Use upkeep for dependency installation and generated prerequisites, for example:
{when: package-lock.json, run: npm ci, outputs: node_modules}.
It runs on trigger-content changes or missing declared outputs. Include every
influencing file (such as workspace manifests); never trigger a rule on its own
output. caches excludes build/install output from upkeep triggers. sync.include
allows selected git-ignored trigger inputs. There is no source projection.

Plain build commands run each applicable up or warm. Opt into skipping with
{run: npm run build, when: ["src/**", "package-lock.json"]} only when those inputs
fully describe the build; include relevant config. Missing/changed outputs
invalidate a successful build. Declare actual outputs globs, optionally
{paths: ["dist/**"], compare: content} to avoid restarting for identical bytes.
Without outputs, a built service always restarts; a dev server with no build
stays running. Dependents do not restart merely because one service restarts.
Builds run in dependency waves; builds: serial or a build's serial: true handles
commands that would race.

Do not add ignored legacy checks, watch_run, hot_reload, sync.keep or top-level
outputs. Tests stay the repo's own commands, run with ctx --env.

## Seeded data and backing servers

A SQLite datastore example (requires the repo's seed script to accept path/preset):

~~~yaml
datastores:
  main:
    driver: sqlite
    create: node seed.mjs "{{ns}}" "{{preset}}"
    presets: [dev, empty]
    default_preset: dev
    template: true
upkeep:
  - { when: seed.mjs, run: "@rebake-template main" }
~~~

Pass {{datastores.main.url}} to the app's database setting. Verify seeds create
realistic test data and advertised users.

For postgres, mysql, mssql or redis, use an existing backing server with probe,
url, namespace-aware create/drop, and template_restore where required. Commands
receive {{ns}}: never hardcode a shared database that reset or cleanup could drop.
Server copies need a working drop recipe. runly does not provide database servers;
appliances can explicitly manage a shared server through probe/start/stop, and
remain running when services idle.

An @rebake-template rule adds its matched seed/migration content to the template
key. Include every input affecting data. Unchanged keys reuse a template, shared
across worktrees of the same stack name by default. Set share_templates: false
if seeds depend on worktree-specific paths or other untracked state.
--pristine bakes a private replacement. A requested preset reloads only that
datastore; ordinary up retains data.

copies_only: true provisions a datastore only through db new/with; services
cannot reference it and ctx omits it. ephemeral: true is for stores without
presets/templates whose reset uses drop as a flush.

## Caller inputs, authentication and previews

env supplies explicit configuration; env_from: {API_KEY: required} imports a
caller value at up time. Optional inputs preserve an explicit env default or stay
unset. Values reach services/probes, not builds, upkeep or exec. They are kept in
memory and must be resupplied after release or daemon restart. Do not put secrets
in the manifest or daemon unit.

auth.logins advertises one login or a list of {user, password, role, description};
it does not create accounts. The seed must create them. auth.token runs the repo's
token command with {{role}} and expects the token on stdout. Verify login against
the running app.

Previews are opt-in. cloudflare-quick needs cloudflared; cloudflare-named also
needs a domain and origin login for that zone; tailscale uses the operator's
foreground Serve. preview.forbidden: true disables publication. Do not publish
merely to validate setup unless publication is requested. Public TTL is a CLI
option (preview --ttl), not a manifest field.

## Verify the setup

Run runly plan --json, then runly up --json with required caller inputs.
Request a returned URL and run the repo's smoke test with:

~~~sh
eval "$(runly ctx --env)" && <test command>
~~~

Use runly logs --build for upkeep/build failures and runly logs <service> for
startup failures. Repeat plain up to verify reuse/restart behavior.
Exercise preset/reset or copy workflows when part of the setup, on data created
for that verification. Do not destroy an existing environment just to test config.

Report the manifest path, recommended topology, verified commands/tests and
measured cold/warm behavior. Leave the initial monitoring checklist from the
tuning reference: what remains provisional, what to observe during the first
development sessions, and which findings should trigger changes. Record external
prerequisites and concurrency/isolation cases still unverified. Do not describe
the setup as optimized merely because it starts successfully.

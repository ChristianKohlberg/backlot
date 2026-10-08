# 0043. The daemon unit carries an allowlisted environment, and says what it left out

- Status: Accepted
- Date: 2026-10
- Amends: [0039](0039-teardown-keeps-templates-a-leased-environment-survives-a-crash-loop.md)
  — `runly daemon install`
- Context: the unit from 0.18 carried `PATH` and `BACKLOT_*`. Every repo
  command — builds, upkeep, datastore hooks — runs with the daemon's
  environment, and a .NET stack's template bake failed under the unit for
  want of `DOTNET_ROOT`; the failure read as a code error. A unit for a state
  root with spaces quoted its paths, which systemd refuses.

## Decision

`runly daemon install` captures from the installing shell: `PATH`, an
allowlist (`LANG`, `LC_*`, `DOTNET_*`, `NODE_*`, `NVM_*`, `JAVA_HOME`,
`DOCKER_HOST`, `DOCKER_CONTEXT`, the proxy variables, `SSL_CERT_*`), every
`BACKLOT_*` setting, the variables the manifest's commands reference (`$NAME`,
when installed from a stack) and each `--env NAME`. Never an `env_from` input
(each `up` brings it) and never runly's per-process tags. Before writing, it
prints what it captured, what the manifest referenced that the shell does not
set, and how many variables it left out (`--json`: `environment`). The unit
sets `RUNLY_SUPERVISOR`, which `status` reports.

A repo command whose output says a tool or runtime is missing (`command not
found`, `ENOENT`, no .NET SDK) fails as an env-error with a hint: under a
unit, reinstall from a shell that has it or add `--env NAME`; autospawned, stop
the daemon so the next verb starts it from the caller's shell.

`WorkingDirectory=` and `append:` paths are written unquoted, `%` escaped.

## Consequences

- Variables a stack needs and the allowlist misses are added with `--env`.

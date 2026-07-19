# Objections, taken seriously

Three questions every skeptical engineer asks, in the order they ask them. Each
gets the honest version: where the objection is *right*, and where it stops
being right. backlot was extracted from a hand-rolled harness that lived
through every failure below — this page is that experience, not advocacy.

## "Why copy the source at all? Repo, worktree, *and* an env tree?"

Yes: three materializations — and only one of them is heavy.

```
repo (.git object store)              history; shared by all worktrees
 └─ git worktree   /work/agent-1/app  SOURCE files; the agent edits here (truth)
     └─ env tree   ~/.cache/backlot/… SOURCE files again (projected copy)
                                      + env-OWNED state: node_modules,
                                        build output, the seeded database
```

The projection copies only the source file set (`git ls-files` + declared
includes) — megabytes, stat-gated, copy-on-write where the filesystem supports
it. The heavy things (dependencies, build caches, data) are never copied from
the worktree: the environment grows and keeps its own.

What that one extra copy of the source buys:

- **Uncontaminated verdicts.** A check runs against the snapshot synced at
  start. This is [hermetic testing](https://testing.googleblog.com/2012/10/hermetic-servers.html)
  applied to the agent loop: a test is only meaningful against fixed inputs,
  and an agent — which does not pause while tests run — is a machine for
  changing the inputs. The copy is what makes the inputs fixed.
- **Two environments from one worktree.** The core loop is a session env (you
  are clicking in it) plus a run env (the e2e proving your change), from the
  same directory, simultaneously. There is no way to host both in the worktree.
- **Free abandonment.** An environment never holds the only copy of anything,
  so reclaiming one — lease lapsed, agent crashed, machine full — needs no
  deliberation. This single property is what keeps a pooled fleet from
  accumulating zombie stacks.
- **Clean worktrees.** Services and checks write droppings (artifacts, tmp
  files, generated output). Env-side they are swept on clean-slate binds;
  worktree-side they would pollute the agent's `git status` and its commits.

If none of those matter to you — one human, one checkout, pausing while tests
run — you don't need the copy, or backlot.

## "My agent just runs `dotnet run` and `ng serve` itself — just as good."

For one agent, one task, one machine: it genuinely is. No manifest, no daemon,
nothing new to trust. The claim fails at exactly the point of scale it is
usually made to defend. What arrives, in order:

1. **The second agent.** `EADDRINUSE`. The documented agent responses are
   editing the port config (harness noise in the diff), starting duplicate
   servers on new ports, or killing the process that holds the port — which
   belonged to the first agent. (See the receipts below: these are filed bugs,
   not hypotheticals.)
2. **The shared dev database.** Two agents seeding and mutating one database
   produce each other's test failures — nondeterministic, non-local, blamed on
   the code.
3. **The crash.** An agent dies; its `dotnet` and `node` processes don't.
   Nothing owns them, nothing records them, and a fleet manufactures orphans
   daily. (backlot spends real machinery here: process-group kills, pid
   identity pinning, tag-based reclaim — because even *with* supervision this
   is hard.)
4. **The cold start, every task.** Restore, build, seed — minutes per task,
   because nothing durable outlives the task. The warm pool's entire economy
   is that environments do.
5. **The raw error.** "Connection refused": my bug, stale deps, or the DB
   server being down? A DIY agent burns its context debugging the environment.
   backlot's error taxonomy (work / env / infra) exists because each of those
   demands a *different next action*.
6. **The knowledge in prompts.** Ports, seeding, when migrations rerun —
   re-taught per agent, drifting per agent. `backlot.yml` is that knowledge as
   one reviewed file, and the agent's protocol shrinks to "run verbs from your
   worktree."

The rhetorical key: open the manifest — `dotnet run` and `ng serve` are
*literally in it*. backlot is those commands plus the machinery every DIY
setup grows anyway, grown once and tested, instead of half-grown per repo.

The question that decides it: **how many agents, how many tasks a day, and who
reaps the processes when one dies?**

## "Docker Compose does the same thing."

Compose genuinely covers a piece of it: declarative topology, per-project
isolation (`compose -p agent1` / `-p agent2`), networks, and file-sync into
containers (`develop.watch`). For a fully containerized stack that is real
overlap. The structural gaps:

1. **Uncommitted code has no good path into a container.** Rebuild the image
   per edit — minutes per iteration, no inner loop. Or bind-mount the worktree
   in — which is worktree-hosting again (mid-run edits contaminate verdicts;
   one worktree cannot back two differently-bound stacks), plus the
   well-documented macOS bind-mount I/O tax on exactly the watcher-heavy dev
   loops agents hammer, plus the `node_modules` inside-vs-outside volume
   dance. backlot's projection is neither: a real copy, cheap, with snapshot
   semantics.
2. **`up`/`down` is not a pool.** No leases, no reclaim, no warm reuse:
   nothing distinguishes an abandoned stack from a used one, and every fresh
   `up` pays start + seed again. Containers restart from the *image* — the
   incremental state that makes rebinds fast (compiler caches, `obj/`,
   `.angular`) is exactly what an image does not carry, so it becomes
   hand-managed volumes.
3. **No data or verdict layer.** Presets, template restore, `reset-data`
   mid-lease, hygiene escalation, machine verdicts, artifact collection —
   compose has no concept of any of it (v2.30 added generic
   `post_start`/`pre_stop` hooks; still no named data states, no
   reset-to-baseline), so teams script it around compose.
   That script *is* the hand-rolled harness, with compose as one ingredient.
4. **Real dev loops are often host-native.** Debugger attachment, watch
   performance, toolchain reality: the founding monorepo's loop is host
   `dotnet` + `ng serve`, by choice. backlot is process-first by decision —
   services are commands, not containers.

And they compose, literally: a service's `run:` may start a container, and
appliances routinely `docker run` the database (backlot's own mssql test
does). Compose answers *how do my containers run*. backlot answers *who gets
which running, seeded instance, in what data state, with what proof — and who
cleans up when they vanish.* Building the second thing on top of the first is
exactly the half-finished harness this project was extracted from.

Honest concession: a fully containerized shop with disciplined `-p` projects,
`develop.watch`, and seed/reset scripts covers perhaps half of this — for
their one repo, permanently.

---

## Receipts

Every load-bearing claim above was verified against primary sources
(2026-07-20) rather than asserted:

- macOS bind-mount I/O: [docker/for-mac#1592](https://github.com/docker/for-mac/issues/1592)
  (the multi-year tracking issue); Docker's own
  [VirtioFS announcement](https://www.docker.com/blog/speed-boost-achievement-unlocked-on-docker-desktop-4-6-for-mac/)
  claims the improvement and its docs still steer I/O-heavy paths to volumes.
- The `node_modules` volume dance: the
  [canonical StackOverflow thread](https://stackoverflow.com/questions/30043872/docker-compose-node-modules-not-present-in-a-volume-after-npm-install-succeeds)
  and a decade of tutorials teaching the anonymous-volume exclude trick.
- Compose capabilities: [project-name isolation](https://docs.docker.com/compose/how-tos/project-name/)
  and [`develop.watch`](https://docs.docker.com/compose/how-tos/file-watch/)
  (GA in v2.22) are real — the overlap above is stated at full strength.
- Seeding as scripting, not a primitive: Docker's own
  [pre-seeding guide](https://docs.docker.com/guides/pre-seeding/) routes it
  through image entrypoint conventions.
- Rebuild-per-edit as the anti-pattern: Docker's
  [watch-mode announcement](https://www.docker.com/blog/docker-compose-experiment-sync-files-and-automatically-rebuild-services-with-watch-mode/)
  names slow rebuilds as the adoption barrier its sync feature exists to fix.
- Caches lost on container recreation:
  [VS Code devcontainer performance guidance](https://code.visualstudio.com/remote/advancedcontainers/improve-performance)
  prescribes the named-volume workaround.
- Agents fighting over ports and leaking processes: filed against the agents
  themselves — [claude-code#16198](https://github.com/anthropics/claude-code/issues/16198)
  (orphaned dev server, days of runtime),
  [claude-code#9780](https://github.com/anthropics/claude-code/issues/9780)
  (duplicate servers on port conflicts), and
  [Cursor forum reports](https://forum.cursor.com/t/1-7-11-canceling-or-killing-the-agent-console-leaves-zombie-processes/135168)
  of zombie processes.
- Hermeticity: [Google Testing Blog](https://testing.googleblog.com/2012/10/hermetic-servers.html)
  and [Bazel's definition](https://bazel.build/basics/hermeticity). The
  agent-specific mid-run-edit framing is our inference from that principle,
  and is labeled as such above.
- Per-worker database isolation as standard practice:
  [Rails parallel testing](https://blog.appsignal.com/2022/03/16/the-perils-of-parallel-testing-in-ruby-on-rails.html)
  creates `test-db-N` per worker for exactly this reason.

The 2024–26 wave of agent-sandbox infrastructure (E2B, Daytona, Modal, Fly
Sprites, Morph, Dagger's container-use) is the industry conceding the premise:
agents need isolated, persistent, provable environments. Those products sell
the *substrate*. backlot is the repo-aware layer above it — see
[architecture §14](architecture.md) for the landscape.

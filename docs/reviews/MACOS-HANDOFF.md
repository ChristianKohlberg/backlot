# Handoff prompt — diagnose backlot's two macOS-only CI failures

Paste everything below the line into a fresh Claude Code session **on a Mac**.

---

You are working on **backlot**, a repo-aware environment broker: a local daemon + CLI
(TypeScript on Node ≥ 22.13, `node:sqlite` journal) that puts a running, seeded instance of
a web app in front of coding agents. Concepts: a warm **pool** of environments, **leases**,
**bind-by-sync** of a worktree into an env tree, supervised **services**, **checks** that
produce verdicts, **datastores** and **appliances**.

```bash
gh repo clone ChristianKohlberg/backlot && cd backlot
npm install && npm run build && npm test
```

Read `docs/architecture.md` first — it is short and it is the product. `CONTRIBUTING.md`
matters: decisions are recorded in `docs/decisions/`, and a recorded decision outranks code
that disagrees with it.

## Your job

Two test failures reproduce **only on macOS**. Nobody has been able to diagnose them because
no one working on this repo has had a Mac. You do. That is the entire reason this session
exists — so bias hard toward **observing the real machine** over reasoning about the code.

CI has been red for weeks; a recent review pass took ubuntu from 1 failure to 0 and macOS
from 4 to 1. These are what is left.

### Failure 1 — `hello-python` never passes readiness (deterministic on macOS)

`tests/milestones.test.ts` → *"a stdlib-Python stack gets the identical broker loop"*

```
{"ok":false,"error":{"class":"env-error","message":"service 'web' not ready after 30s",
 "source":"web","logExcerpt":"hello-python listening on :49364 (db: …/data/main.db)"}}
```

The service **starts and logs its port**. The readiness probe (`ready: { http: /health }`)
never succeeds. `examples/hello-python/server.py` binds `("127.0.0.1", PORT)`.

**Already ruled out — do not redo this:** the obvious dual-stack explanation (Node's `fetch`
resolving `localhost` to `::1` while the server binds IPv4-only). `waitReady` in
`src/daemon/supervisor.ts` now probes `127.0.0.1` as well as the advertised host, via
`probeUrls()`. It did **not** fix this. So the cause is something else.

### Failure 2 — `hello-multi` smoke is flaky (both legs, never locally)

Two sibling tests fail intermittently — `tests/hello-multi.test.ts` *"boots the full topology
and passes the smoke check"* and `tests/cli.test.ts` *"run smoke uses the run preset"*. One of
them was ubuntu's only failure before the review, so this predates that work. It has never
failed locally: 5/5 clean on that file, plus 3 clean full-suite runs.

Best capture so far:

```
TypeError: fetch failed … SocketError: other side closed
  localAddress: '::1', localPort: 55926, remoteAddress: '::1', remotePort: 39251,
  remoteFamily: 'IPv6', bytesWritten: 535, bytesRead: 500
```

Two earlier checks in the same smoke script had already succeeded. The verdict is classified
`env-error` with *"while a service was not running"*, which means a supervised service had
**exited** by the time the check failed. So the question is **which service dies, and why** —
not whether the check logic is wrong.

## How to actually diagnose these

The daemon keeps evidence that no CI log has yet captured. Get it:

```bash
# Run one test with an isolated, inspectable state dir
BACKLOT_STATE_DIR=/tmp/bl-debug npx vitest run tests/milestones.test.ts -t "stdlib-Python"

# Then, before anything cleans up:
cat /tmp/bl-debug/daemon.log
ls /tmp/bl-debug/envs/*/logs/            # per-service stdout+stderr
cat /tmp/bl-debug/envs/*/logs/web.log
node dist/cli/index.js pool ls --json    # includes the daemon's recent event log
```

For failure 1, the decisive question is simply **whether the port is reachable at all** from
the daemon's perspective at the moment it probes. `curl -v http://127.0.0.1:<port>/health`
and `curl -v http://localhost:<port>/health` from the Mac, plus `lsof -iTCP -sTCP:LISTEN -P`
to see what the Python process actually bound, will settle in one minute what code reading
has not settled in a day. Consider macOS specifics the Linux devs could not see: the local
firewall prompting or silently dropping, `python3` being the Xcode CLT stub, sandboxing of
processes spawned from a detached daemon, or `/var/folders/...` temp-path length interacting
with the AF_UNIX socket path limit (there is an open backlog item about `sun_path`).

For failure 2, run the file in a loop (`for i in $(seq 20); do …; done`) until it fails, then
read `logs/api.log`, `logs/web.log`, `logs/worker.log` and the daemon events for that run. The
supervisor records service starts, exits, restarts and degradation as events — that is where
"which service died" is written down.

## Rules for this work

- **Verify before you fix.** Every claim in this prompt was written by someone without a Mac.
  If the evidence contradicts it, trust the evidence and say so.
- **Every fix needs a test that fails without it.** Revert your change, watch the test go red,
  restore. That check has caught several fixes in this repo that only looked correct.
- **Do not quarantine with `it.skipIf`.** Several tests here used a bare `return` to skip on
  non-Linux, so the macOS leg reported them green while running none of them. Hiding a
  platform failure is the specific antipattern this repo just finished removing. If a test
  genuinely cannot run on a platform, skip it *visibly* and say why.
- **Watch for vacuous assertions.** Asserting on an `sh -c` wrapper's pid rather than the real
  server, or on prose rather than the process table, has bitten this codebase repeatedly.
- If a fix turns out to need a product decision (a visible contract change, a behaviour
  tradeoff), **stop and ask** rather than choosing for the owner.

## Landing it

Branch, commit with a message that explains *why* rather than what, open a PR, and let CI run
both legs. Do not merge red without saying plainly what is still failing and why you judged it
safe — `main` is currently green on ubuntu and carries exactly these macOS failures, so any
regression is yours and will be visible.

Context worth reading if you want it: `docs/reviews/2026-07-18-fleet-review.md` (96 findings,
all closed), `BACKLOG.md` (both failures are tracked there with evidence), and
`docs/decisions/0019` and `0020`.

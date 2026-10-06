#!/usr/bin/env node
/**
 * runly CLI. Contract: every verb accepts --json (stdout = data, stderr =
 * human); exit codes are contractual — 0 ok, 1 work-error, 2 env-error,
 * 3 infra-error, 64 usage. See docs/architecture.md §11.
 */
import { ensureDaemon, daemonInfo, rpc, classifyClientError, awaitDaemonGone, daemonStopTimeoutMs, type RpcError, type RpcResponse } from './client.js';
import { isAlive } from '../core/procscan.js';
import { join } from 'node:path';
import { stateRoot } from '../core/paths.js';
import { BUILD, VERSION, rebuiltSince, versionSkew } from '../core/version.js';
import { installKind } from './install.js';
import { collectCallerEnv } from '../core/caller-env.js';
import { loadStack, manifestDeprecations } from '../core/manifest.js';
import { parsePresetArgs } from '../core/presets.js';
import { BrokerError } from '../core/util.js';
import { parseSince, showLogs, type LogsSpec } from './logs.js';
import { autoTether } from './tether.js';
import { formatDuration, formatSize, parseDuration } from '../core/units.js';
import { exportLines, shellValue } from '../core/env-vars.js';

const USAGE = `runly — puts a working instance of a web application in front of you.

Usage:
  runly up [service...] [--preset [DATASTORE=]NAME]... [--reset-data|--pristine]
           [--rebuild] [--ttl <minutes>] [--holder-pid <pid>] [--env]
                          session lease on THIS worktree's one environment.
                          ADDITIVE: starts the named services plus their
                          depends_on closure (none named = every service) and
                          never stops one that is already running. Every up
                          applies the worktree as it is now: the due upkeep
                          rules, then every build: of the services it runs —
                          except a build: {run, when: [globs]} whose matched
                          files are unchanged since its last successful build
                          ('build <svc>: skipped (when: unchanged)'); --rebuild
                          runs every build regardless.
                          A running service whose build OUTPUT changed (its
                          outputs: globs; none declared = always) is restarted;
                          one whose output is unchanged, or that has no build:,
                          keeps running. Dependents are not restarted.
                          Every datastore exists for the environment's life and
                          keeps its data; --preset reloads ONLY that datastore
                          from its template and restarts the running services
                          that use it.
                          A service idle for 10 minutes (no runly verb on the
                          environment, no bytes through its port; idle: per
                          service) is stopped, its port kept; the next
                          connection starts it again and is held until it is up.
                          Waits in the server-wide load budget's queue when the
                          box is full ('runly plan' says whether it would).
                          Prints a short summary (--json: the context blob);
                          --env prints the 'ctx --env' lines instead.
  runly plan [service...] [--rebuild]
                          what an up would build and start, what that costs
                          (resources:, or the default — said so), and whether
                          it starts now or would wait (and for what)
  runly destroy           tear down everything runly holds for this worktree
                          now: services, data, copies, ports, lease, records.
                          For a worktree pool taking a worktree back
  runly down [service...] stop just these services (none named = all of them).
                          The lease, the data and the public ports stay.
  runly ctx [--env]     the consumer context blob (URLs, services, logins,
                          conn strings and the preset each datastore holds).
                          --env prints 'export KEY=value' lines instead:
                          RUNLY_ENV_ID, RUNLY_PORT_<PORT>, RUNLY_URL_<SERVICE>,
                          RUNLY_DATASTORE_<NAME>_URL, RUNLY_DATASTORE_<NAME>_PRESET,
                          RUNLY_LOGIN_USER and RUNLY_LOGIN_PASSWORD (names
                          uppercased, any other character as _). Run your checks
                          with them: eval "$(runly ctx --env)" && npm test
  runly ps [--all]      what runs for this worktree: each service (state, public
                          and internal port, pid, idle time, memory) and each
                          database copy. --all for the whole server
  runly db new <datastore> [--preset NAME] [--holder-pid <pid>]
                          a fresh copy of a datastore from the same template the
                          environments use — no lease, no ports, no services.
                          Prints its name, url and preset. It is dropped when
                          the holder process (--holder-pid / BACKLOT_HOLDER_PID)
                          exits or this worktree goes away, or by 'db drop'
  runly db with <datastore> [--preset NAME] -- <cmd...>
                          run a command against a fresh copy (RUNLY_DB_URL,
                          RUNLY_DB_NAME), drop the copy when it exits, and exit
                          with its exit code
  runly db ls [--all]   this worktree's database copies (--all: every one)
  runly db drop <name>  drop one copy now
  runly warm            run this worktree's due upkeep rules and its service
                          builds now — no lease, no services. For an idle worktree
                          just moved to a new commit
  runly exec <cmd...>   run a command in the worktree with the lease's ports,
                          URLs and connection strings in its environment
  runly logs [service...] [--lines N] [--since up|<duration>] [--grep <re>]
             [-f|--follow [--until <re>] [--timeout <s>]] [--build]
                          the services' output, interleaved by time with a
                          'service | ' prefix when there are several (none
                          named = all). --since up: only the current process
                          of each; --since 10m: the last ten minutes. -f keeps
                          following; --until exits 0 at the first matching line
                          and 124 when --timeout runs out. --build: the output
                          of each service's last build (and of upkeep)
  runly reset-data      restore the data template on the current lease
  runly token --role <r> [--raw]
                          mint an auth token via the stack's auth.token hook.
                          Default output is JSON ({token, role}); --raw prints the
                          bare token, which is what an Authorization header wants
  runly release         release the current lease (environment stays warm)
  runly preview <service> [--ttl ...] [--https-port N]
                          publish a service from your lease on a public quick
                          tunnel (Cloudflare by default). The URL is unauthenticated
                          — anyone with the link reaches the service. Requires
                          cloudflared on PATH (or BACKLOT_CLOUDFLARED).
                          With preview.publisher: tailscale it is served on this
                          machine's tailnet name instead (tailnet only);
                          --https-port pins that port for this publish.
  runly preview stop    stop the preview tunnel on your lease
  runly status          daemon, pool, and lease overview
  runly appliance ls|start|stop [name]
                          shared backing servers: probe, ensure up, explicit stop
  runly pool ls|recycle [<env-id>] [--force]|reconcile|gc|doctor [--fix]
                          recycle with an env-id recycles exactly that one; with
                          none, the whole pool. A LEASED environment is never
                          taken without --force (--all is the old spelling).
                          gc reclaims service processes orphaned by an ungraceful
                          exit; doctor lists what runly left behind (databases,
                          templates, copies, processes, listeners, state dirs)
                          and --fix removes it — only runly's own
  runly doctor          daemon health and drift, without acting on it
  runly daemon stop     stop the daemon (environments are recovered on next use)
  runly update [--check] [--force]
                          make the RUNNING daemon be the INSTALLED build. An
                          upgrade replaces the files on disk but not the daemon
                          already in memory, and the socket carries no version —
                          so a new CLI would keep being served by the old code.
                          This restarts it. Leases SURVIVE; services stop and
                          each holder's next verb rebinds. --check reports the
                          versions and who would rebind, and changes nothing.
                          runly never installs itself: it prints the command
                          for your install and leaves it to you.
  runly --version       the version of this CLI

Holding an environment — two forms, and the right one depends on who you are:

  --ttl <minutes>          THE FORM FOR AGENTS AND SCRIPTS. The lease lives for the
                           stated time no matter what process asked for it.
  --holder-pid <pid>       For an interactive shell, or any caller that OUTLIVES the
  (BACKLOT_HOLDER_PID)     command. Ties the lease to that process: a minute after it
                           exits, the environment is torn down (services, data,
                           ports, lease) rather than waiting out the TTL.

Under Claude Code, up and db new tether to the agent automatically (CLAUDE_PID,
when it is a live ancestor of the CLI); BACKLOT_TETHER=off opts out.

'BACKLOT_HOLDER_PID=$$ runly up' works at a shell prompt and CANNOT work from an
agent harness: each command runs in a fresh shell, so '$$' names a process that has
already exited. Such a lease would be reclaimable the instant it was created — the
environment would be handed to the next caller while you were still using it — so
runly refuses the bind instead. Use --ttl.

up and reset-data accept --preset NAME (one datastore), or repeatable
--preset DATASTORE=NAME; a named datastore is reloaded from its template, every
other one keeps its data. ctx reports the preset each datastore holds. db new and
db with take --preset NAME for their one datastore.

Every verb accepts --json. Long verbs (up/warm/reset-data) show live progress
on a terminal (stderr); force with --progress, silence with --quiet. stdout stays clean.
Exit codes: 0 ok · 1 work-error · 2 env-error · 3 infra-error · 64 usage.

Removed in 0.13 (decision 0032; each now exits 64 naming its replacement):
sync, bind, pull, run, job, --watch, --detach, --pull, --ref.
Removed in 0.15 (decision 0034): up --data-only — use 'runly db new|with'.`;

const rawArgv = process.argv.slice(2);
const verb = rawArgv[0];

// Known flags and whether each takes a value. A proper single-pass parser so a
// flag's value is never mis-bound as a positional (and an inner command's own
// flags survive) — the F1 class of argv bugs. Everything after a lone `--`, and
// EVERYTHING for `exec`, is treated as a raw passthrough command.
const VALUE_FLAGS = new Set(['--holder', '--holder-pid', '--ttl', '--role', '--lines', '--ref', '--spec', '--preset', '--https-port', '--since', '--grep', '--until', '--timeout']);
const BOOL_FLAGS = new Set(['--json', '--env', '--watch', '--reset-data', '--pristine', '--pull', '--detach', '--all', '--force', '--raw', '--data-only', '--progress', '--quiet', '--check', '--rebuild', '--follow', '--build', '--fix']);

const flagVals = new Map<string, string>();
const presetArgs: string[] = [];
const flags = new Set<string>();
const positional: string[] = [];
let passthrough: string[] | null = null; // for `exec` / after `--`

{
  const body = rawArgv.slice(1);
  for (let i = 0; i < body.length; i++) {
    // `-f` is the one short flag: `logs -f`, as tail(1) has it.
    const a = body[i] === '-f' && verb === 'logs' && passthrough === null ? '--follow' : body[i]!;
    // `exec` consumes the entire remainder verbatim (its own flags included),
    // except a leading `--json` which is ours; `--` also opens passthrough.
    if (verb === 'exec' && passthrough === null && a !== '--json' && !a.startsWith('--')) {
      passthrough = body.slice(i);
      break;
    }
    if (a === '--') {
      passthrough = body.slice(i + 1);
      break;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = body[i + 1];
      if (v === undefined) {
        console.error(`runly: ${a} needs a value`);
        process.exit(64);
      }
      flagVals.set(a, v);
      if (a === '--preset') presetArgs.push(v);
      i++;
    } else if (BOOL_FLAGS.has(a)) {
      flags.add(a);
    } else if (a.startsWith('--')) {
      console.error(`runly: unknown flag '${a}'`);
      process.exit(64);
    } else {
      positional.push(a);
    }
  }
}

const json = flags.has('--json');
const flagValue = (name: string): string | undefined => flagVals.get(name);

const out = (data: unknown) => console.log(json ? JSON.stringify(data, null, json ? 0 : 2) : humanize(data));
const errExit = (e: RpcError): never => {
  const code = e.class === 'work-error' ? 1 : e.class === 'infra-error' ? 3 : 2;
  if (json) console.log(JSON.stringify({ ok: false, error: e }));
  else {
    console.error(`runly: [${e.class ?? e.code ?? 'error'}] ${e.message}${e.source ? ` (${e.source})` : ''}`);
    if (e.logExcerpt) console.error(`--- log excerpt ---\n${e.logExcerpt}`);
  }
  process.exit(code);
};

/** POSIX single-quote quoting: safe for anything, including embedded quotes. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function humanize(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// Progress -> stderr, shown for humans (a TTY) or on --progress; --quiet forces
// off. Never touches stdout, so the --json payload stays clean for agents.
const showProgress = flags.has('--progress') || (process.stderr.isTTY === true && !flags.has('--quiet') && !flags.has('--json'));
let lastProgressLen = 0;
const progress = showProgress
  ? (phase: string) => {
      const line = `  ⋯ ${phase}`;
      // Redraw in place on a TTY so the phase log stays a single moving line.
      if (process.stderr.isTTY) {
        process.stderr.write(`\r${line}${' '.repeat(Math.max(0, lastProgressLen - line.length))}`);
        lastProgressLen = line.length;
      } else {
        process.stderr.write(line + '\n');
      }
    }
  : undefined;
const endProgress = () => {
  if (showProgress && process.stderr.isTTY && lastProgressLen) process.stderr.write('\r' + ' '.repeat(lastProgressLen) + '\r');
};

/** --ttl is in MINUTES; accepts a bare number or an explicit `<n>m`. Returns ms or undefined if invalid. */
function parseTtlMinutes(v: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)m?$/.exec(v.trim());
  if (!m) return undefined;
  const mins = Number(m[1]);
  if (!Number.isFinite(mins) || mins <= 0) return undefined;
  return mins * 60_000;
}

function hygiene(): string | undefined {
  if (flags.has('--pristine')) return 'pristine';
  if (flags.has('--reset-data')) return 'reset-data';
  return undefined;
}

async function main(): Promise<void> {
  if (presetArgs.length > 0 && !['up', 'reset-data', 'db'].includes(verb ?? '')) {
    console.error('runly: --preset is supported by up, reset-data and db');
    process.exit(64);
  }
  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
    console.log(USAGE);
    return;
  }

  // Answered without touching the socket: "what version am I" must work when
  // the daemon is down, wedged, or refusing to start — those are exactly the
  // moments someone asks.
  if (verb === '--version' || verb === '-v' || verb === 'version') {
    // Bare string on stdout for a human and for `$(runly --version)`; out()
    // would JSON-quote it. --json keeps the object shape every other verb has.
    if (json) out({ version: VERSION });
    else console.log(VERSION);
    return;
  }

  // Removed by decision 0032. Named, not merely unknown, so a script that used
  // them learns what replaced them. Answered before the daemon is contacted.
  const D = '(decision 0032)';
  const removed: Record<string, string> = {
    pull: `'runly pull' was removed ${D}: environments run in your worktree, so outputs are written in place`,
    sync: `'runly sync' was removed ${D}: 'runly up' runs the due upkeep and every build, and restarts the services whose build output changed`,
    bind: `'runly bind' was removed ${D}: use 'runly up', which applies the worktree as it is now; a ref is bound by checking it out ('git checkout <ref>', or a separate worktree)`,
    run: `'runly run' was removed ${D}: run your checks yourself against the environment — 'runly ctx --env' prints its ports, URLs, connection strings and login as KEY=value lines`,
    job: `'runly job' was removed with 'runly run' ${D}`,
  };
  if (removed[verb]) {
    console.error(`runly: ${removed[verb]}`);
    process.exit(64);
  }
  const removedFlags: Record<string, string> = {
    '--pull': `--pull was removed ${D}: outputs are written in place`,
    '--detach': `--detach was removed with 'runly run' ${D}`,
    '--watch': `--watch was removed ${D}: re-run 'runly up' after a change; it runs the due upkeep and the builds, and restarts what changed`,
    '--ref': `--ref was removed ${D}: environments run in your worktree; check the ref out ('git checkout <ref>', or a separate worktree) and run 'runly up'`,
  };
  // Removed by decision 0034: datastores are no longer leased through an
  // environment of their own.
  removedFlags['--data-only'] =
    `--data-only was removed (decision 0034): a database without an environment is 'runly db new <datastore>' ` +
    `(prints its url; dropped when its holder or worktree goes, or by 'runly db drop'), or 'runly db with <datastore> -- <cmd>', ` +
    `which drops it when the command exits. To keep the environment but stop its services: 'runly down'`;
  for (const [flag, msg] of Object.entries(removedFlags)) {
    if (flags.has(flag)) {
      console.error(`runly: ${msg}`);
      process.exit(64);
    }
  }

  const known = ['up', 'down', 'ctx', 'ps', 'plan', 'db', 'warm', 'exec', 'logs', 'token', 'reset-data', 'release', 'destroy', 'preview', 'status', 'doctor', 'appliance', 'pool', 'daemon', 'update'];
  if (!known.includes(verb)) {
    console.error(`runly: unknown verb '${verb}'\n\n${USAGE}`);
    process.exit(64);
  }
  if (flags.has('--env')) {
    if (verb !== 'ctx' && verb !== 'up') {
      console.error(`runly ${verb}: --env is for 'ctx' and 'up'`);
      process.exit(64);
    }
    if (json) {
      console.error(`runly ${verb}: --env and --json are alternatives — pick one`);
      process.exit(64);
    }
  }

  // Collect before autospawn: a malformed binding manifest must not start a
  // shared daemon with input values in its inherited environment.
  const callerEnv = verb === 'up' ? collectCallerEnv(process.cwd()) : undefined;
  // A manifest section runly accepts but no longer acts on (`checks:`) loads
  // with a one-line warning on stderr; stdout stays clean for --json.
  if (!['status', 'doctor', 'daemon', 'update', 'pool'].includes(verb)) {
    try {
      // Not validated here: the daemon validates the manifest it acts on, and the
      // schema compile cost every CLI call ~100 ms (ctx, ps, logs are hot paths).
      for (const w of ((st) => manifestDeprecations(st.manifest, st.file))(loadStack(process.cwd(), { validate: false }))) console.error(`runly: warning: ${w}`);
    } catch {
      /* no manifest here, or an invalid one — the verb itself reports that */
    }
  }
  // `db` names its one datastore positionally, so its --preset is a bare name.
  let dbPreset: string | undefined;
  if (verb === 'db') {
    if (presetArgs.length > 1) {
      console.error('runly db: --preset is given once — a copy is of one datastore');
      process.exit(64);
    }
    const raw = presetArgs[0];
    if (raw !== undefined) {
      const at = raw.indexOf('=');
      if (at >= 0 && raw.slice(0, at) !== positional[1]) {
        console.error(`runly db: --preset ${raw} names another datastore than '${positional[1] ?? ''}'`);
        process.exit(64);
      }
      dbPreset = at >= 0 ? raw.slice(at + 1) : raw;
    }
    const sub = positional[0];
    if (!['new', 'with', 'ls', 'drop'].includes(sub ?? '')) {
      console.error(`runly db: ${sub ? `unknown subcommand '${sub}'` : 'which subcommand?'} (new <datastore> | with <datastore> -- <cmd...> | ls | drop <name>)`);
      process.exit(64);
    }
    if ((sub === 'new' || sub === 'with') && !positional[1]) {
      console.error(`runly db ${sub}: which datastore? (runly db ${sub} <datastore>${sub === 'with' ? ' -- <cmd...>' : ''})`);
      process.exit(64);
    }
    if (sub === 'with' && (passthrough === null || passthrough.length === 0)) {
      console.error('runly db with: no command given (runly db with <datastore> -- <cmd...>)');
      process.exit(64);
    }
    if (sub === 'drop' && !positional[1]) {
      console.error('runly db drop: which copy? (the name from db new or db ls)');
      process.exit(64);
    }
  }
  let presets: Record<string, string> | undefined;
  if (presetArgs.length > 0 && verb !== 'db') {
    const manifest = loadStack(process.cwd()).manifest;
    presets = parsePresetArgs(manifest, presetArgs);
  }
  const stopping = verb === 'daemon' && positional[0] === 'stop';
  const daemon = stopping ? await daemonInfo() : await ensureDaemon(process.cwd());
  if (!daemon) {
    out({ stopping: true, stopped: true });
    return;
  }

  // Version skew is REFUSED, not warned about.
  //
  // An old daemon does not reject arguments it has never heard of — it ignores
  // them. A 0.8.0 daemon asked for `up --data-only` boots the whole application
  // into what the caller believes is a datastore-only lease, and says nothing.
  // That is the shape of issue #41: a wrong result that reads as a bug in
  // another subsystem, and there it cost ~30 agents 14 hours. A warning on
  // stderr does not reach a --json consumer at all, so the only honest answer
  // is to stop.
  //
  // infra-error (exit 3), never env-error: an agent branches on the class
  // MECHANICALLY (decision 0010) and env-error tells it to recycle an
  // environment, which cannot fix a daemon running the wrong code.
  //
  // The three verbs that can REMEDY skew are exempt, or there would be no way
  // out of it from a script.
  const SKEW_EXEMPT = new Set(['update', 'doctor', 'daemon']);
  const skew = versionSkew(VERSION, daemon.version);
  if (skew && !SKEW_EXEMPT.has(verb)) {
    errExit({ class: 'infra-error', message: skew.message, source: 'daemon' });
  }
  const cwd = process.cwd();
  const holder = flagValue('--holder');
  // The CLI exits per invocation, so ITS pid is useless as a liveness signal.
  // This must be the long-lived caller — the agent process, or a supervising
  // shell. Given one, the daemon releases the lease the moment it dies instead
  // of holding the environment for the rest of the TTL.
  const holderPidSource = flagValue('--holder-pid') !== undefined ? '--holder-pid' : 'BACKLOT_HOLDER_PID';
  const holderPidRaw = flagValue('--holder-pid') ?? process.env.BACKLOT_HOLDER_PID;
  let holderPid: number | undefined;
  if (holderPidRaw !== undefined && holderPidRaw !== '') {
    holderPid = Number(holderPidRaw);
    if (!Number.isInteger(holderPid) || holderPid <= 0) {
      console.error(`runly: ${holderPidSource} expects a process id, got '${holderPidRaw}'`);
      process.exit(64);
    }
    // A holder that is ALREADY dead is worse than no holder at all: the daemon
    // releases such a lease on its very next sweep, so the environment goes
    // back in the pool while the caller is still using it — and the next bind
    // hands that caller's database to somebody else, silently. The pattern
    // that produces this is `BACKLOT_HOLDER_PID=$$ runly up` from an agent
    // harness, which runs every command in a fresh shell: `$$` is a shell that
    // has already exited. Refuse, and name the form that works.
    if (!isAlive(holderPid)) {
      console.error(
        `runly: ${holderPidSource} ${holderPid} is not a live process — the lease would be reclaimable the moment it is created.\n` +
          `  If this came from '$$': each agent command runs in a fresh shell, so that shell is already gone.\n` +
          `  Under Claude Code, drop ${holderPidSource}: runly tethers the lease to the agent by itself (CLAUDE_PID, when it is a live ancestor).\n` +
          `  Elsewhere use 'runly ${verb} --ttl <minutes>'; ${holderPidSource} is for interactive shells that outlive the command.`,
      );
      process.exit(64);
    }
  }
  // No explicit holder process: tether to the agent this CLI runs under, when
  // it can be found (decision 0035) — Claude Code's CLAUDE_PID, if it is a
  // live ancestor. BACKLOT_TETHER=off opts out.
  if (holderPid === undefined && (verb === 'up' || (verb === 'db' && positional[0] === 'new'))) holderPid = autoTether();

  let res: RpcResponse | undefined;
  switch (verb) {
    case 'up': {
      const ttl = flagValue('--ttl');
      let ttlMs: number | undefined;
      if (ttl !== undefined) {
        ttlMs = parseTtlMinutes(ttl);
        if (ttlMs === undefined) {
          console.error(`runly: --ttl expects minutes (a positive number), got '${ttl}'`);
          process.exit(64);
        }
      }
      res = await rpc(
        'up',
        { cwd, holder, holderPid, hygiene: hygiene(), ttlMs, services: positional, callerEnv, presets, rebuild: flags.has('--rebuild') },
        progress,
      );
      endProgress();
      // The skipped builds are named even without a progress stream (decision 0038).
      if (res.ok && !json && !showProgress) {
        const builds = (res.data as { bindDiagnostics?: { builds?: Array<{ service: string; reason: string }> } }).bindDiagnostics?.builds ?? [];
        for (const b of builds) if (b.reason === 'when-unchanged') console.error(`build ${b.service}: skipped (when: unchanged)`);
      }
      if (res.ok && !json) {
        const c = res.data as CtxView;
        if (c.previewNotice) console.error(`runly: ${c.previewNotice}`);
        // `up --env`: the environment as shell exports, ready for eval.
        for (const line of flags.has('--env') ? exportLines(c) : ctxSummary(c, 'up')) console.log(line);
        return;
      }
      break;
    }
    case 'down':
      res = await rpc('down', { cwd, holder, services: positional }, progress);
      endProgress();
      if (res.ok && !json) {
        const d = res.data as { down: string[]; stopped: string[]; dependentsStillRunning: string[]; previewNotice?: string };
        console.log(d.stopped.length ? `stopped ${d.stopped.join(', ')}` : 'nothing was running');
        if (d.dependentsStillRunning.length) {
          console.error(`runly: note: ${d.dependentsStillRunning.join(', ')} still run${d.dependentsStillRunning.length === 1 ? 's' : ''} and depend${d.dependentsStillRunning.length === 1 ? 's' : ''} on what is now down`);
        }
        if (d.previewNotice) console.error(`runly: ${d.previewNotice}`);
        return;
      }
      break;
    case 'plan':
      res = await rpc('plan', { cwd, holder, services: positional, rebuild: flags.has('--rebuild') });
      if (res.ok && !json) {
        for (const line of planLines(res.data as PlanData)) console.log(line);
        return;
      }
      break;
    case 'destroy':
      res = await rpc('destroy', { cwd }, progress);
      endProgress();
      break;
    case 'ps':
      res = await rpc('ps', { cwd, all: flags.has('--all') });
      if (res.ok && !json) {
        for (const line of psLines(res.data as PsData, flags.has('--all'))) console.log(line);
        return;
      }
      break;
    case 'db': {
      const sub = positional[0]!;
      if (sub === 'new') {
        res = await rpc('db-new', { cwd, holder, holderPid, datastore: positional[1], preset: dbPreset }, progress);
        endProgress();
        if (res.ok && !json) {
          const d = res.data as DbCopy;
          console.log(`name=${shellValue(d.name)}\nurl=${shellValue(d.url)}\npreset=${shellValue(d.preset)}`);
          return;
        }
        break;
      }
      if (sub === 'with') {
        // The copy is tethered to THIS process: the CLI outlives the command,
        // so if it is killed the daemon's reaper drops the copy.
        const created = await rpc('db-new', { cwd, holder, holderPid: process.pid, datastore: positional[1], preset: dbPreset }, progress);
        endProgress();
        if (!created.ok) {
          errExit(created.error);
          return;
        }
        const copy = created.data as DbCopy;
        const code = await runWithCopy(passthrough!, copy);
        const dropped = await rpc('db-drop', { name: copy.name });
        if (!dropped.ok) console.error(`runly db with: dropping ${copy.name} failed (${dropped.error.message}) — the sweeper retries it`);
        process.exit(code);
      }
      if (sub === 'ls') {
        res = await rpc('db-ls', { cwd, all: flags.has('--all') });
        if (res.ok && !json) {
          for (const line of dbLines((res.data as { copies: DbCopy[] }).copies)) console.log(line);
          return;
        }
        break;
      }
      res = await rpc('db-drop', { name: positional[1] });
      break;
    }
    case 'ctx':
      res = await rpc('ctx', { cwd, holder });
      if (res.ok && flags.has('--env')) {
        // `export KEY=value` lines — the interface a repo's own scripts (its
        // tests, its smoke checks) read: eval "$(runly ctx --env)" && npm test.
        for (const line of exportLines(res.data as CtxView)) console.log(line);
        return;
      }
      if (res.ok && !json) {
        for (const line of ctxSummary(res.data as CtxView, 'ctx')) console.log(line);
        return;
      }
      break;
    case 'warm': {
      res = await rpc('warm', { cwd }, progress);
      endProgress();
      if (!res.ok) break;
      const w = res.data as {
        ok: boolean;
        root: string;
        durationMs: number;
        steps: Array<{ kind: string; index?: number; when?: string; service?: string; status: string; durationMs: number; reason?: string }>;
        failure: RpcError | null;
      };
      if (json) console.log(JSON.stringify(w));
      else {
        // One line per step: what it was, what happened, how long it took. The
        // upkeep COMMAND is never printed — commands may carry credentials —
        // only the rule's position and its trigger glob.
        const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
        console.log(`warming ${w.root}`);
        for (const st of w.steps) {
          const what = st.kind === 'upkeep' ? `upkeep rule ${st.index} (${st.when})` : `build '${st.service}'`;
          console.log(`  ${what}: ${st.status}${st.status === 'ran' || st.status === 'failed' ? ` in ${secs(st.durationMs)}` : ''}${st.reason ? ` — ${st.reason}` : ''}`);
        }
        console.log(`${w.ok ? 'warm' : 'failed'} after ${secs(w.durationMs)}`);
        if (w.failure) {
          console.error(`runly: [${w.failure.class}] ${w.failure.message}${w.failure.source ? ` (${w.failure.source})` : ''}`);
          if (w.failure.logExcerpt) console.error(`--- log excerpt ---\n${w.failure.logExcerpt}`);
        }
      }
      process.exitCode = w.ok ? 0 : 1;
      return;
    }
    case 'exec': {
      // The whole passthrough is the command, verbatim — its own --flags intact.
      //
      // One token is a SHELL STRING: `exec 'echo hi > out.txt'` must keep its
      // redirection and operators. Several tokens mean the caller's own shell
      // already split them, so their boundaries are real and must survive —
      // joining on spaces turned `exec cat "my file.txt"` into two arguments.
      const parts = passthrough ?? positional;
      const cmd = parts.length === 1 ? parts[0]! : parts.map(shellQuote).join(' ');
      if (!cmd) {
        console.error('runly exec: no command given');
        process.exit(64);
      }
      res = await rpc('exec', { cwd, holder, cmd });
      if (res.ok) {
        const d = res.data as { exitCode: number; stdout: string; stderr: string };
        if (json) console.log(JSON.stringify({ ok: d.exitCode === 0, ...d }));
        else {
          if (d.stdout) process.stdout.write(d.stdout);
          if (d.stderr) process.stderr.write(d.stderr);
        }
        process.exit(d.exitCode === 0 ? 0 : 1);
      }
      break;
    }
    case 'logs': {
      const rawLines = flagValue('--lines');
      const lines = rawLines === undefined ? undefined : Number(rawLines);
      // NaN reached the daemon as slice(-NaN) and quietly returned the WHOLE
      // log — the opposite of what a bounded --lines asks for.
      if (lines !== undefined && (!Number.isInteger(lines) || lines <= 0)) {
        console.error(`runly logs: --lines expects a positive integer, got '${rawLines}'`);
        process.exit(64);
      }
      const since = flagValue('--since');
      if (since !== undefined && !parseSince(since)) {
        console.error(`runly logs: --since expects 'up' or a duration (90s, 10m, 2h), got '${since}'`);
        process.exit(64);
      }
      const regex = (flag: string): RegExp | undefined => {
        const v = flagValue(flag);
        if (v === undefined) return undefined;
        try {
          return new RegExp(v);
        } catch (e) {
          console.error(`runly logs: ${flag} is not a valid regular expression: ${(e as Error).message}`);
          return process.exit(64);
        }
      };
      const grep = regex('--grep');
      const until = regex('--until');
      const rawTimeout = flagValue('--timeout');
      const timeoutMs = rawTimeout === undefined ? undefined : parseDuration(rawTimeout);
      if (rawTimeout !== undefined && (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        console.error(`runly logs: --timeout expects seconds or a duration (30, 90s, 5m), got '${rawTimeout}'`);
        process.exit(64);
      }
      const follow = flags.has('--follow') || until !== undefined;
      if (timeoutMs !== undefined && !follow) {
        console.error('runly logs: --timeout bounds -f/--until; without them there is nothing to wait for');
        process.exit(64);
      }
      res = await rpc('logs-spec', { cwd, holder, services: positional, build: flags.has('--build') });
      if (!res.ok) break;
      const spec = res.data as LogsSpec;
      const code = await showLogs(spec, { lines, since, grep, follow, until, timeoutMs, json, prefix: spec.files.length !== 1 });
      const within = `${rawTimeout ?? ''}${/^\d+$/.test(rawTimeout ?? '') ? 's' : ''}`;
      if (code === 124) console.error(until ? `runly logs: --until /${until.source}/ did not match within ${within}` : `runly logs: --timeout ${within} ran out (exit 124, decision 0038)`);
      process.exit(code);
      break;
    }
    case 'reset-data':
      res = await rpc('reset-data', { cwd, holder, presets }, progress);
      endProgress();
      break;
    case 'token': {
      res = await rpc('token', { cwd, holder, role: flagValue('--role') ?? 'admin' });
      // --raw prints the bare token and nothing else. The wrapper's default is a
      // JSON object, but a manifest's own auth.token script prints the bare
      // string — so the documented "prints the plaintext token on stdout"
      // described the script, not this command, and callers piped
      // `{"token":"tk_…","role":"human"}` straight into an Authorization header
      // and read the resulting 401 as a permissions problem.
      if (res?.ok && flags.has('--raw')) {
        console.log(String((res.data as { token: string }).token));
        process.exit(0);
      }
      break;
    }
    case 'release':
      res = await rpc('release', { cwd, holder });
      break;
    case 'preview': {
      const sub = positional[0];
      if (sub === 'stop') {
        res = await rpc('preview-stop', { cwd, holder });
      } else if (!sub) {
        console.error('runly preview: which service? (usage: runly preview <service> | runly preview stop)');
        process.exit(64);
      } else {
        const ttl = flagValue('--ttl');
        let ttlMs: number | undefined;
        if (ttl !== undefined) {
          ttlMs = parseTtlMinutes(ttl);
          if (ttlMs === undefined) {
            console.error(`runly: --ttl expects minutes (a positive number), got '${ttl}'`);
            process.exit(64);
          }
        }
        // --https-port pins the tailnet port for THIS publish only (tailscale
        // publisher), so one long-lived environment can keep a remembered
        // address without pinning it in the shared manifest — where every other
        // environment of the stack would then collide on it.
        const portFlag = flagValue('--https-port');
        let httpsPort: number | undefined;
        if (portFlag !== undefined) {
          httpsPort = Number(portFlag);
          if (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) {
            console.error(`runly: --https-port expects a port number (1-65535), got '${portFlag}'`);
            process.exit(64);
          }
        }
        res = await rpc('preview', {
          cwd,
          holder,
          service: sub,
          ...(ttlMs !== undefined ? { ttlMs } : {}),
          ...(httpsPort !== undefined ? { httpsPort } : {}),
        });
      }
      break;
    }
    case 'status':
      res = await rpc('status', {});
      break;
    case 'doctor':
      res = await rpc('doctor', { cliVersion: VERSION });
      break;
    case 'appliance': {
      const sub = positional[0] ?? 'ls';
      const name = positional[1];
      if (sub === 'ls') res = await rpc('appliance-ls', { cwd });
      else if (sub === 'start') res = await rpc('appliance-start', { cwd, name });
      else if (sub === 'stop') {
        if (!name) {
          console.error('runly appliance stop: a name is required (stopping everything is never implicit)');
          process.exit(64);
        }
        res = await rpc('appliance-stop', { cwd, name });
      } else {
        console.error(`runly appliance: unknown subcommand '${sub}' (ls | start | stop)`);
        process.exit(64);
      }
      break;
    }
    case 'pool': {
      const sub = positional[0] ?? 'ls';
      if (sub === 'ls') res = await rpc('status', {});
      else if (sub === 'recycle') {
        // The env id used to be parsed and then dropped, so `recycle <env-id>`
        // recycled the WHOLE pool — the opposite of what naming one asks for.
        res = await rpc('pool-recycle', { envId: positional[1], force: flags.has('--force') || flags.has('--all') });
      }
      else if (sub === 'reconcile') res = await rpc('pool-reconcile', {});
      else if (sub === 'gc') res = await rpc('pool-gc', {});
      else if (sub === 'doctor') {
        res = await rpc('pool-doctor', { cwd, fix: flags.has('--fix') });
        if (res.ok && !json) {
          for (const line of doctorLines(res.data as PoolDoctorData)) console.log(line);
          return;
        }
      } else {
        console.error(`runly pool: unknown subcommand '${sub}' (ls | recycle | reconcile | gc | doctor [--fix])`);
        process.exit(64);
      }
      break;
    }
    case 'daemon': {
      if (positional[0] !== 'stop') {
        console.error('runly daemon: only `stop` is supported');
        process.exit(64);
      }
      res = await rpc('shutdown', {});
      if (!res.ok) break;
      if (!(await awaitDaemonGone(daemon.pid, daemonStopTimeoutMs()))) {
        errExit({
          class: 'infra-error',
          message:
            `the daemon accepted shutdown and is still shutting down after ${Math.round(daemonStopTimeoutMs() / 1000)}s — ` +
            `service teardown may still be in progress. Do not issue another stop; wait for ${daemon.pid !== undefined ? `pid ${daemon.pid}` : 'the daemon'} to exit, ` +
            `and check ${join(stateRoot(), 'daemon.log')} if it never does.`,
          source: 'daemon',
        });
        return;
      }
      res = { ok: true, data: { stopping: true, stopped: true } };
      break;
    }
    case 'update': {
      const install = installKind();
      // THE case this verb exists for is an old daemon — and an old daemon has
      // never heard of `update-plan`. Calling it unconditionally made `update`
      // fail with "daemon does not know verb 'update-plan'" against every
      // pre-0.9.0 daemon, which is every daemon anyone was running when 0.9.0
      // shipped: the one situation it was built to fix was the one it could not.
      //
      // (The tests missed it because BACKLOT_FAKE_VERSION runs THIS code while
      // claiming an old version, so the stand-in always knew the new verbs — the
      // same "a stand-in must model the thing it stands in for" lesson as the
      // ping stand-ins, not applied here. tests/daemon-update.test.ts now drives
      // a stub that answers the way an old daemon really does.)
      const legacyVerb = (e: RpcError) => /does not know verb/i.test(e.message);
      const planRes = await rpc('update-plan', { cliVersion: VERSION });
      if (!planRes.ok && !legacyVerb(planRes.error)) {
        errExit(planRes.error);
        return;
      }
      const legacy = !planRes.ok;
      // An old daemon cannot describe its own state, but `status` is a verb every
      // version has — enough to name the holders who will have to rebind, and to
      // learn the pid to wait on.
      let plan: {
        daemon: string;
        daemonBuild?: string;
        daemonPid?: number;
        journalSchema?: number;
        busy: string[];
        leases: Array<{ envId: string; holder: string; kind: string }>;
      };
      if (legacy) {
        const st = await rpc('status', {});
        const s = (st.ok ? st.data : {}) as {
          pid?: number;
          envs?: Array<{ id?: string; lease?: { holder?: string; kind?: string } | null }>;
        };
        plan = {
          daemon: 'pre-0.9.0',
          daemonPid: s.pid,
          busy: [], // unknowable: no old daemon can be asked what is in flight
          leases: (s.envs ?? [])
            .filter((e) => e.lease)
            .map((e) => ({ envId: String(e.id), holder: String(e.lease?.holder), kind: String(e.lease?.kind) })),
        };
      } else {
        plan = planRes.data as typeof plan;
      }
      // Same version, different build: a checkout rebuilt (or a package
      // reinstalled) since the daemon started. Not skew — nothing refuses on it —
      // but exactly what `update` is for.
      const rebuilt = !skew && rebuiltSince(BUILD, plan.daemonBuild);
      const report = {
        cli: VERSION,
        daemon: plan.daemon,
        build: { cli: BUILD, daemon: plan.daemonBuild ?? null, rebuilt },
        journalSchema: plan.journalSchema,
        install: install.kind,
        installRoot: install.root,
        skew: skew ? { direction: skew.direction, message: skew.message } : null,
        busy: plan.busy,
        // Named, not refused: a restart keeps every lease and costs its holder
        // one rebind. See Engine.assertRestartable for why that is not consent
        // worth asking for — and why an in-flight operation is.
        holdersWhoMustRebind: plan.leases,
        upgradeHint: install.upgradeHint,
        ...(legacy
          ? {
              note:
                `the running daemon predates 'update-plan', so it cannot report what is in flight — ` +
                `the in-flight refusal cannot apply here, and the restart proceeds as 'daemon stop' always has`,
            }
          : {}),
      };

      // --check is the diagnose half, and it never restarts anything. `doctor`
      // reports skew too; this reports what a restart would DO.
      if (flags.has('--check')) {
        out({ ...report, restarted: false });
        process.exit(0);
      }

      // Already the installed build: say so and stop. An update that restarts
      // unconditionally would make `runly update` in a script a recurring
      // outage for every lease holder on the box, for no gain.
      if (!skew && !rebuilt) {
        out({
          ...report,
          restarted: false,
          note: `the running daemon is already runly ${plan.daemon} — nothing to do. If you have not upgraded yet: ${install.upgradeHint}`,
        });
        process.exit(0);
      }

      // `daemon-restart` carries the refusals (in-flight, downgrade). An old
      // daemon has neither the verb nor anything to refuse WITH, so fall back to
      // `shutdown` — which every version has, and which is exactly what
      // `daemon stop` has always done. Without this fallback there is no way out
      // of skew for the daemon that most needs one.
      let stopRes = await rpc('daemon-restart', { cliVersion: VERSION, force: flags.has('--force') });
      if (!stopRes.ok && legacyVerb(stopRes.error)) stopRes = await rpc('shutdown', {});
      if (!stopRes.ok) {
        errExit(stopRes.error);
        return;
      }
      // The result frame arrives ~50ms BEFORE the process exits, so a respawn
      // that pings immediately would be answered by the dying daemon, conclude
      // one is already up, and leave the old build serving — an update that
      // reports success and changes nothing.
      if (!(await awaitDaemonGone(plan.daemonPid))) {
        errExit({
          class: 'infra-error',
          message: `the daemon accepted the restart but is still answering — it may be wedged mid-shutdown; check the log and retry`,
          source: 'daemon',
        });
      }
      // Spawned from THIS CLI's dist, which is what makes the new daemon the
      // installed build.
      const now = await ensureDaemon(cwd);
      const remaining = versionSkew(VERSION, now.version);
      if (remaining) {
        errExit({
          class: 'infra-error',
          message:
            `restarted, but the daemon now answering is ${now.version ?? 'unversioned'} rather than ${VERSION} — ` +
            `another runly install owns this state root (${install.root} is this one). Check which one is on your PATH.`,
          source: 'daemon',
        });
      }
      out({ ...report, restarted: true, from: plan.daemon, to: now.version, daemonPid: now.pid, ...(rebuilt ? { reason: 'rebuilt' } : {}) });
      break;
    }
    default:
      process.exit(64);
  }

  if (!res) process.exit(0);
  if (!res.ok) {
    errExit(res.error);
    return;
  }
  out(res.data);
}

interface DbCopy {
  name: string;
  datastore: string;
  preset: string;
  url: string;
  state: string;
  worktree: string;
  holder: string;
  holderPid: number | null;
  holderAlive: boolean | null;
  createdAt: number;
}

interface PsData {
  scope: string;
  services: Array<{ env: string; worktree?: string; service: string; state: string; publicPort: number | null; internalPort: number | null; pid: number | null; idleMs: number | null; idleStopInMs?: number | null; rssBytes: number | null }>;
  databases: DbCopy[];
  budget?: { enabled: boolean; memoryBytes: number; cpu: number; committedMemoryBytes: number; committedCpu: number; waiting: number };
}

interface PlanData {
  stack: string;
  envId: string | null;
  items: Array<{ kind: string; name: string; memoryBytes: number; cpu: number; declared: boolean; skipped: string | null }>;
  need: { memoryBytes: number; cpu: number };
  machine: { totalBytes: number; availableBytes: number | null; load1: number; cores: number };
  budget: { enabled: boolean; memoryBytes: number; cpu: number; reserveBytes: number; loadPerCore: number; waitMs: number };
  committed: { memoryBytes: number; cpu: number; items: Array<{ what: string; memoryBytes: number; cpu: number }> };
  queue: number;
  startsNow: boolean;
  verdict: string;
  defaultsAssumed: string[];
}

interface PoolDoctorData {
  fix: boolean;
  clean: boolean;
  findings: Array<{ kind: string; what: string; detail: string; fixed?: boolean; error?: string }>;
}

function planLines(p: PlanData): string[] {
  const out: string[] = [];
  out.push(`${p.stack}: ${p.verdict}`);
  if (p.items.length === 0) out.push('  nothing to build or start — everything named already runs');
  for (const it of p.items) {
    const cost = it.skipped ? `skipped (${it.skipped})` : `${formatSize(it.memoryBytes)}, ${it.cpu} cpu${it.declared ? '' : ' (default — not declared in resources:)'}`;
    out.push(`  ${it.kind.padEnd(9)} ${it.name.padEnd(20)} ${cost}`);
  }
  out.push(`  needs ${formatSize(p.need.memoryBytes)}, ${Math.round(p.need.cpu * 10) / 10} cpu (starts summed, the largest build on top)`);
  if (p.budget.enabled) {
    out.push(`  budget ${formatSize(p.budget.memoryBytes)}, ${p.budget.cpu} cpu — runly has committed ${formatSize(p.committed.memoryBytes)}, ${Math.round(p.committed.cpu * 10) / 10} cpu; ${p.queue} waiting`);
  } else out.push('  budget off (BACKLOT_BUDGET=off)');
  out.push(`  box: ${p.machine.availableBytes === null ? '' : `${formatSize(p.machine.availableBytes)} of `}${formatSize(p.machine.totalBytes)} available, load ${p.machine.load1.toFixed(1)} on ${p.machine.cores} cores; a wait gives up after ${formatDuration(p.budget.waitMs)}`);
  if (p.defaultsAssumed.length) out.push(`  note: ${p.defaultsAssumed.length} cost(s) are the conservative default — declare resources: in the manifest for an exact plan`);
  return out;
}

function doctorLines(d: PoolDoctorData): string[] {
  if (d.findings.length === 0) return ['pool doctor: nothing left behind'];
  const out = d.findings.map((f) => `${f.fixed ? 'removed' : f.error ? 'FAILED ' : d.fix && f.kind !== 'foreign-namespace' ? 'kept   ' : 'found  '} ${f.kind.padEnd(17)} ${f.what} — ${f.detail}${f.error ? ` (${f.error})` : ''}`);
  if (!d.fix && !d.clean) out.push(`dry run — 'runly pool doctor --fix' removes what is listed (never foreign-namespace)`);
  return out;
}

/**
 * Run `db with`'s command against the copy, its exit code as ours. One token
 * is a shell string (as for exec); several keep the caller's own word splits.
 * SIGINT/SIGTERM are passed on, so the copy is dropped after the command stops.
 */
async function runWithCopy(parts: string[], copy: DbCopy): Promise<number> {
  const { spawn } = await import('node:child_process');
  const { constants } = await import('node:os');
  const env = { ...process.env, RUNLY_DB_URL: copy.url, RUNLY_DB_NAME: copy.name };
  const child = parts.length === 1
    ? spawn(parts[0]!, { stdio: 'inherit', env, shell: true })
    : spawn(parts[0]!, parts.slice(1), { stdio: 'inherit', env });
  const forward = (sig: NodeJS.Signals) => () => {
    try { child.kill(sig); } catch { /* already gone */ }
  };
  // Ctrl-C at a terminal signals the whole foreground process group, and the
  // child is in ours: it already has its SIGINT. Forwarding sent it a second
  // one, which makes many tools (npm, a test runner) abort their own cleanup.
  // Only a SIGINT sent to this process alone (no terminal) is passed on.
  const fromTerminal = process.stdin.isTTY === true || process.stderr.isTTY === true;
  const onInt = fromTerminal ? () => undefined : forward('SIGINT');
  const onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return new Promise((resolve) => {
    child.on('error', (err) => {
      console.error(`runly db with: could not start '${parts[0]}': ${err.message}`);
      resolve(127);
    });
    child.on('exit', (code, signal) => {
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
    });
  });
}

/** A plain, aligned table; `-` for an empty cell. */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => (c || '-').padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(header), ...rows.map(line)];
}

const ago = (ms: number | null): string => (ms === null ? '' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);
const mb = (bytes: number | null): string => (bytes === null ? '' : `${Math.round(bytes / (1024 * 1024))}M`);

function dbLines(copies: DbCopy[]): string[] {
  if (copies.length === 0) return ['no database copies'];
  return table(['NAME', 'DATASTORE', 'PRESET', 'STATE', 'HOLDER', 'CREATED'], copies.map((c) => [
    c.name, c.datastore, c.preset, c.state,
    `${c.holder}${c.holderPid !== null ? ` (pid ${c.holderPid}${c.holderAlive === false ? ', gone' : ''})` : ''}`,
    `${ago(Date.now() - c.createdAt)} ago`,
  ]));
}

function psLines(d: PsData, all: boolean): string[] {
  const out: string[] = [];
  if (d.services.length === 0) {
    out.push(all ? 'no environments on this server — nothing runs' : `no environment for this worktree — 'runly up' starts one`);
  } else {
    // --all spans worktrees, so each row says which one it is.
    const header = ['ENV', ...(all ? ['WORKTREE'] : []), 'SERVICE', 'STATE', 'PORT', 'INTERNAL', 'PID', 'IDLE', 'STOPS IN', 'RSS'];
    out.push(...table(header, d.services.map((s) => [
      s.env, ...(all ? [s.worktree ?? ''] : []), s.service, s.state, s.publicPort === null ? '' : String(s.publicPort), s.internalPort === null ? '' : String(s.internalPort),
      s.pid === null ? '' : String(s.pid), ago(s.idleMs), s.idleStopInMs === null || s.idleStopInMs === undefined ? '' : ago(s.idleStopInMs), mb(s.rssBytes),
    ])));
    const running = d.services.filter((s) => s.state === 'running' || s.state === 'starting').length;
    if (running === 0) out.push(`nothing is running — ${d.services.length} service(s) idle, stopped or down; the next 'runly up' or connection starts what is wanted`);
  }
  if (d.budget?.enabled) {
    out.push('');
    out.push(`budget: ${formatSize(d.budget.committedMemoryBytes)} of ${formatSize(d.budget.memoryBytes)}, ${Math.round(d.budget.committedCpu * 10) / 10} of ${d.budget.cpu} cpu committed${d.budget.waiting ? `; ${d.budget.waiting} waiting` : ''}`);
  }
  out.push('');
  out.push(...dbLines(d.databases));
  return out;
}

/** What `up` and `ctx` return, as far as the plain summary and `--env` read it. */
interface CtxView {
  stack: string;
  envId: string;
  state: string;
  lease: { id: string; expiresAt: number } | null;
  urls?: Record<string, string>;
  ports?: Record<string, number>;
  services?: Record<string, 'running' | 'stopped' | 'down'>;
  datastores?: Record<string, { url: string; preset?: string | null }>;
  logins?: { user: string; password: string } | null;
  previewUrls?: Record<string, string>;
  previewNotice?: string;
  bindDiagnostics?: { durationMs?: number; reuse?: string; started?: string[]; restarted?: string[] };
}

/**
 * The plain (non-`--json`) `up` and `ctx`: a few lines a person or an agent
 * reads at a glance — where each service is, what each datastore holds, how
 * to log in. `--json` is the full blob, unchanged; `--env` the shell exports.
 */
function ctxSummary(c: CtxView, verb: 'up' | 'ctx'): string[] {
  const out: string[] = [];
  const until = c.lease ? ` — lease until ${new Date(c.lease.expiresAt).toLocaleTimeString()}` : ' — no lease';
  const d = c.bindDiagnostics;
  const how = verb === 'up' && d
    ? ` (${d.reuse === 'rebound' || !d.reuse ? 'bound' : d.reuse}${d.durationMs !== undefined ? ` in ${formatDuration(d.durationMs)}` : ''}${d.started?.length ? `; started ${d.started.join(', ')}` : ''}${d.restarted?.length ? `; restarted ${d.restarted.join(', ')}` : ''})`
    : '';
  out.push(`${c.stack} ${c.envId} ${c.state}${how}${until}`);
  const names = Object.keys(c.services ?? c.urls ?? {});
  const width = Math.max(0, ...names.map((n) => n.length));
  for (const n of names) {
    const state = c.services?.[n] ?? 'running';
    const url = c.urls?.[n] ?? '';
    out.push(`  ${n.padEnd(width)}  ${state.padEnd(7)}  ${url}${c.previewUrls?.[n] ? `  (preview ${c.previewUrls[n]})` : ''}`.trimEnd());
  }
  for (const [n, ds] of Object.entries(c.datastores ?? {})) out.push(`  datastore ${n}: ${ds.url}${ds.preset ? ` (${ds.preset})` : ''}`);
  if (c.logins) out.push(`  login: ${c.logins.user} / ${c.logins.password}`);
  out.push(`  'runly ctx --env' for shell exports, --json for everything`);
  return out;
}

main().catch((err) => {
  if (err instanceof BrokerError) {
    errExit(err.toJSON());
    return;
  }
  const msg = String((err as Error).message ?? err);
  // Agents branch on the error class MECHANICALLY (decision 0010), so a
  // client-side failure must not masquerade as env-error: that tells the agent
  // to recycle an environment, which cannot fix an unreachable or wedged
  // daemon. Anything that is not a classified daemon response is infra.
  const cls = classifyClientError(err);
  if (json) console.log(JSON.stringify({ ok: false, error: { class: cls, message: msg } }));
  else console.error(`runly: [${cls}] ${msg}`);
  process.exit(cls === 'infra-error' ? 3 : 2);
});

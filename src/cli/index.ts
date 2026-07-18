#!/usr/bin/env node
/**
 * backlot CLI. Contract: every verb accepts --json (stdout = data, stderr =
 * human); exit codes are contractual — 0 ok, 1 work-error, 2 env-error,
 * 3 infra-error, 64 usage. See docs/architecture.md §11.
 */
import { ensureDaemon, rpc, classifyClientError, type RpcError } from './client.js';

const USAGE = `backlot — puts a working instance of a web application in front of you.

Usage:
  backlot up [--watch] [--reset-data|--pristine] [--ttl <minutes>]
                          session lease: sync, upkeep, start services, print context
  backlot run <check> [--pristine] [--pull] [--detach]
                          run lease: bind -> execute the check -> verdict -> release
                          --detach: submit-and-poll — returns a jobId immediately
  backlot job <jobId>     poll a detached run (pending|running|done + verdict)
  backlot ctx             the consumer context blob (URLs, logins, conn strings)
  backlot sync            project the worktree state into the current lease
  backlot exec <cmd...>   run a command inside the leased environment
  backlot logs <service> [--lines N]
  backlot reset-data      restore the data template on the current lease
  backlot token --role <r>  mint an auth token via the stack's auth.token hook
  backlot pull            copy declared outputs back into the worktree
  backlot release         release the current lease (environment stays warm)
  backlot status          daemon, pool, and lease overview
  backlot appliance ls|start|stop [name]
                          shared backing servers: probe, ensure up, explicit stop
  backlot pool ls|recycle [--all]|reconcile|gc|doctor
                          gc reclaims service processes orphaned by an ungraceful
                          exit; doctor reports drift without acting on it
  backlot daemon stop     stop the daemon (environments are recovered on next use)

Every verb accepts --json. Long verbs (up/run/sync/bind/reset-data) show live progress
on a terminal (stderr); force with --progress, silence with --quiet. stdout stays clean.
Exit codes: 0 ok · 1 work-error · 2 env-error · 3 infra-error · 64 usage.`;

const rawArgv = process.argv.slice(2);
const verb = rawArgv[0];

// Known flags and whether each takes a value. A proper single-pass parser so a
// flag's value is never mis-bound as a positional (and an inner command's own
// flags survive) — the F1 class of argv bugs. Everything after a lone `--`, and
// EVERYTHING for `exec`, is treated as a raw passthrough command.
const VALUE_FLAGS = new Set(['--holder', '--ttl', '--role', '--lines', '--ref', '--spec', '--preset']);
const BOOL_FLAGS = new Set(['--json', '--watch', '--reset-data', '--pristine', '--pull', '--detach', '--all', '--raw', '--progress', '--quiet']);

const flagVals = new Map<string, string>();
const flags = new Set<string>();
const positional: string[] = [];
let passthrough: string[] | null = null; // for `exec` / after `--`

{
  const body = rawArgv.slice(1);
  for (let i = 0; i < body.length; i++) {
    const a = body[i]!;
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
        console.error(`backlot: ${a} needs a value`);
        process.exit(64);
      }
      flagVals.set(a, v);
      i++;
    } else if (BOOL_FLAGS.has(a)) {
      flags.add(a);
    } else if (a.startsWith('--')) {
      console.error(`backlot: unknown flag '${a}'`);
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
    console.error(`backlot: [${e.class ?? e.code ?? 'error'}] ${e.message}${e.source ? ` (${e.source})` : ''}`);
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
  if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
    console.log(USAGE);
    return;
  }

  const known = ['up', 'run', 'job', 'ctx', 'sync', 'bind', 'exec', 'logs', 'token', 'reset-data', 'pull', 'release', 'status', 'doctor', 'appliance', 'pool', 'daemon'];
  if (!known.includes(verb)) {
    console.error(`backlot: unknown verb '${verb}'\n\n${USAGE}`);
    process.exit(64);
  }

  await ensureDaemon();
  const cwd = process.cwd();
  const holder = flagValue('--holder');

  let res;
  switch (verb) {
    case 'up': {
      const ttl = flagValue('--ttl');
      let ttlMs: number | undefined;
      if (ttl !== undefined) {
        ttlMs = parseTtlMinutes(ttl);
        if (ttlMs === undefined) {
          console.error(`backlot: --ttl expects minutes (a positive number), got '${ttl}'`);
          process.exit(64);
        }
      }
      res = await rpc('up', { cwd, holder, hygiene: hygiene(), watch: flags.has('--watch'), ttlMs }, progress);
      endProgress();
      break;
    }
    case 'run': {
      const check = positional[0];
      if (!check) {
        console.error(`backlot run: which check? (usage: backlot run <check>)`);
        process.exit(64);
      }
      if (flags.has('--detach')) {
        res = await rpc('run-detach', { cwd, holder, check, hygiene: hygiene() });
        if (res.ok) {
          out(res.data);
          return;
        }
      } else {
        res = await rpc('run', { cwd, holder, check, hygiene: hygiene(), pull: flags.has('--pull') }, progress);
        endProgress();

      }
      break;
    }
    case 'job': {
      const jobId = positional[0];
      if (!jobId) {
        console.error('backlot job: which job? (usage: backlot job <jobId> | backlot job ls)');
        process.exit(64);
      }
      res = jobId === 'ls' ? await rpc('job-ls', {}) : await rpc('job', { jobId });
      // Symmetry with synchronous `run`: a finished job with a failed verdict
      // exits 1. Without this an agent polling a detached run could not branch
      // on the exit code at all, only by parsing the body.
      if (jobId !== 'ls' && res.ok) {
        const job = res.data as { state?: string; verdict?: { ok?: boolean } | null };
        if (job.state === 'done' && job.verdict && job.verdict.ok === false) {
          out(res.data);
          process.exit(1);
        }
      }
      break;
    }
    case 'ctx':
      res = await rpc('ctx', { cwd, holder });
      break;
    case 'sync':
      res = await rpc('sync', { cwd, holder }, progress);
      endProgress();
      break;
    case 'bind': {
      const ref = flagValue('--ref');
      res = ref ? await rpc('bind-ref', { cwd, holder, ref }, progress) : await rpc('sync', { cwd, holder }, progress);
      endProgress();
      break;
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
        console.error('backlot exec: no command given');
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
      const service = positional[0];
      if (!service) {
        console.error('backlot logs: which service?');
        process.exit(64);
      }
      const rawLines = flagValue('--lines');
      const lines = rawLines === undefined ? 40 : Number(rawLines);
      // NaN reached the daemon as slice(-NaN) and quietly returned the WHOLE
      // log — the opposite of what a bounded --lines asks for.
      if (!Number.isInteger(lines) || lines <= 0) {
        console.error(`backlot logs: --lines expects a positive integer, got '${rawLines}'`);
        process.exit(64);
      }
      res = await rpc('logs', { cwd, holder, service, lines });
      if (res.ok && !json) {
        console.log((res.data as { lines: string }).lines);
        return;
      }
      break;
    }
    case 'reset-data':
      res = await rpc('reset-data', { cwd, holder }, progress);
      endProgress();
      break;
    case 'token':
      res = await rpc('token', { cwd, holder, role: flagValue('--role') ?? 'admin' });
      break;
    case 'pull':
      res = await rpc('pull', { cwd, holder });
      break;
    case 'release':
      res = await rpc('release', { cwd, holder });
      break;
    case 'status':
      res = await rpc('status', {});
      break;
    case 'doctor':
      res = await rpc('doctor', {});
      break;
    case 'appliance': {
      const sub = positional[0] ?? 'ls';
      const name = positional[1];
      if (sub === 'ls') res = await rpc('appliance-ls', { cwd });
      else if (sub === 'start') res = await rpc('appliance-start', { cwd, name });
      else if (sub === 'stop') {
        if (!name) {
          console.error('backlot appliance stop: a name is required (stopping everything is never implicit)');
          process.exit(64);
        }
        res = await rpc('appliance-stop', { cwd, name });
      } else {
        console.error(`backlot appliance: unknown subcommand '${sub}' (ls | start | stop)`);
        process.exit(64);
      }
      break;
    }
    case 'pool': {
      const sub = positional[0] ?? 'ls';
      if (sub === 'ls') res = await rpc('status', {});
      else if (sub === 'recycle') res = await rpc('pool-recycle', { all: flags.has('--all') });
      else if (sub === 'reconcile') res = await rpc('pool-reconcile', {});
      else if (sub === 'gc') res = await rpc('pool-gc', {});
      else if (sub === 'doctor') res = await rpc('doctor', {});
      else {
        console.error(`backlot pool: unknown subcommand '${sub}' (ls | recycle | reconcile | gc | doctor)`);
        process.exit(64);
      }
      break;
    }
    case 'daemon': {
      if (positional[0] !== 'stop') {
        console.error('backlot daemon: only `stop` is supported');
        process.exit(64);
      }
      res = await rpc('shutdown', {});
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
  if (verb === 'run') {
    const v = res.data as { ok: boolean; exitCode: number };
    out(res.data);
    process.exit(v.ok ? 0 : 1);
  }
  out(res.data);
}

main().catch((err) => {
  const msg = String((err as Error).message ?? err);
  // Agents branch on the error class MECHANICALLY (decision 0010), so a
  // client-side failure must not masquerade as env-error: that tells the agent
  // to recycle an environment, which cannot fix an unreachable or wedged
  // daemon. Anything that is not a classified daemon response is infra.
  const cls = classifyClientError(err);
  if (json) console.log(JSON.stringify({ ok: false, error: { class: cls, message: msg } }));
  else console.error(`backlot: [${cls}] ${msg}`);
  process.exit(cls === 'infra-error' ? 3 : 2);
});

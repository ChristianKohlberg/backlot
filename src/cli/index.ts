#!/usr/bin/env node
/**
 * infront CLI. Contract: every verb accepts --json (stdout = data, stderr =
 * human); exit codes are contractual — 0 ok, 1 work-error, 2 env-error,
 * 3 infra-error, 64 usage. See docs/architecture.md §11.
 */
import { ensureDaemon, rpc, type RpcError } from './client.js';

const USAGE = `infront — puts a working instance of a web application in front of you.

Usage:
  infront up [--watch] [--reset-data|--pristine] [--ttl <minutes>]
                          session lease: sync, upkeep, start services, print context
  infront run <check> [--pristine] [--pull]
                          run lease: bind -> execute the check -> verdict -> release
  infront ctx             the consumer context blob (URLs, logins, conn strings)
  infront sync            project the worktree state into the current lease
  infront exec <cmd...>   run a command inside the leased environment
  infront logs <service> [--lines N]
  infront reset-data      restore the data template on the current lease
  infront pull            copy declared outputs back into the worktree
  infront release         release the current lease (environment stays warm)
  infront status          daemon, pool, and lease overview
  infront pool ls|recycle [--all]
  infront daemon stop     stop the daemon (environments are recovered on next use)

Every verb accepts --json. Exit codes: 0 ok · 1 work-error · 2 env-error · 3 infra-error · 64 usage.`;

const argv = process.argv.slice(2);
const verb = argv[0];
const json = argv.includes('--json');
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.slice(1).filter((a) => !a.startsWith('--'));

const flagValue = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined;
};

const out = (data: unknown) => console.log(json ? JSON.stringify(data, null, json ? 0 : 2) : humanize(data));
const errExit = (e: RpcError): never => {
  const code = e.class === 'work-error' ? 1 : e.class === 'infra-error' ? 3 : 2;
  if (json) console.log(JSON.stringify({ ok: false, error: e }));
  else {
    console.error(`infront: [${e.class ?? e.code ?? 'error'}] ${e.message}${e.source ? ` (${e.source})` : ''}`);
    if (e.logExcerpt) console.error(`--- log excerpt ---\n${e.logExcerpt}`);
  }
  process.exit(code);
};

function humanize(data: unknown): string {
  return JSON.stringify(data, null, 2);
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

  const known = ['up', 'run', 'ctx', 'sync', 'bind', 'exec', 'logs', 'reset-data', 'pull', 'release', 'status', 'pool', 'daemon'];
  if (!known.includes(verb)) {
    console.error(`infront: unknown verb '${verb}'\n\n${USAGE}`);
    process.exit(64);
  }

  await ensureDaemon();
  const cwd = process.cwd();
  const holder = flagValue('--holder');

  let res;
  switch (verb) {
    case 'up': {
      const ttl = flagValue('--ttl');
      res = await rpc('up', { cwd, holder, hygiene: hygiene(), watch: flags.has('--watch'), ttlMs: ttl ? Number(ttl) * 60_000 : undefined });
      break;
    }
    case 'run': {
      const check = positional[0];
      if (!check) {
        console.error(`infront run: which check? (usage: infront run <check>)`);
        process.exit(64);
      }
      res = await rpc('run', { cwd, holder, check, hygiene: hygiene() });
      if (res.ok && flags.has('--pull')) await rpc('pull', { cwd, holder });
      break;
    }
    case 'ctx':
      res = await rpc('ctx', { cwd, holder });
      break;
    case 'sync':
    case 'bind':
      res = await rpc('sync', { cwd, holder });
      break;
    case 'exec': {
      const cmd = positional.join(' ');
      if (!cmd) {
        console.error('infront exec: no command given');
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
        console.error('infront logs: which service?');
        process.exit(64);
      }
      res = await rpc('logs', { cwd, holder, service, lines: Number(flagValue('--lines') ?? 40) });
      if (res.ok && !json) {
        console.log((res.data as { lines: string }).lines);
        return;
      }
      break;
    }
    case 'reset-data':
      res = await rpc('reset-data', { cwd, holder });
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
    case 'pool': {
      const sub = positional[0] ?? 'ls';
      if (sub === 'ls') res = await rpc('status', {});
      else if (sub === 'recycle') res = await rpc('pool-recycle', { all: flags.has('--all') });
      else {
        console.error(`infront pool: unknown subcommand '${sub}' (ls | recycle)`);
        process.exit(64);
      }
      break;
    }
    case 'daemon': {
      if (positional[0] !== 'stop') {
        console.error('infront daemon: only `stop` is supported');
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
  if (json) console.log(JSON.stringify({ ok: false, error: { class: 'env-error', message: msg } }));
  else console.error(`infront: ${msg}`);
  process.exit(2);
});

#!/usr/bin/env node
/**
 * infront CLI — thin client over the per-machine daemon (auto-spawned on demand,
 * HTTP over a unix socket). Every verb supports --json: stdout is data, stderr is
 * human narration, exit codes are contractual.
 *
 * Status: milestone 0.1 skeleton. Verbs are declared (the frozen surface from
 * docs/architecture.md §11); implementations land behind them.
 */

const VERBS: Record<string, string> = {
  up: 'session lease: sync, upkeep, start services, print context',
  run: 'run lease: bind -> execute a named check -> verdict -> release',
  ctx: 'the consumer context blob (URLs, logins, conn strings, artifacts dir)',
  sync: 'project the worktree state into the current lease',
  bind: 'rebind the current lease to a ref/worktree state',
  exec: 'run a command inside the leased environment',
  logs: 'supervised service logs',
  'reset-data': 'restore the data template on the current lease',
  pull: 'copy declared outputs_changed back into the worktree',
  release: 'release the current lease (environment returns to the pool warm)',
  status: 'daemon, pool, and lease overview',
  pool: 'pool ls | recycle | reconcile | doctor',
};

function usage(): string {
  const lines = Object.entries(VERBS).map(([v, d]) => `  infront ${v.padEnd(11)} ${d}`);
  return [
    'infront — puts a working instance of a web application in front of you.',
    '',
    'Usage:',
    ...lines,
    '',
    'Every verb accepts --json. See docs/architecture.md for the model.',
  ].join('\n');
}

const verb = process.argv[2];

if (!verb || verb === 'help' || verb === '--help' || verb === '-h') {
  console.log(usage());
  process.exit(0);
}

if (!(verb in VERBS)) {
  console.error(`infront: unknown verb '${verb}'\n`);
  console.error(usage());
  process.exit(64);
}

const json = process.argv.includes('--json');
// NB: no taxonomy `class` here — work/env/infra classes describe failures of a
// binding, and an agent branching on env-error would wrongly conclude a recycle
// helps. Broker-level conditions carry a `code` instead.
const payload = {
  ok: false,
  error: { code: 'NOT_IMPLEMENTED', message: `verb '${verb}' is not implemented yet (milestone 0.1 in progress)` },
};
if (json) {
  console.log(JSON.stringify(payload));
} else {
  console.error(`infront ${verb}: not implemented yet — milestone 0.1 in progress (see docs/architecture.md §15)`);
}
process.exit(69);

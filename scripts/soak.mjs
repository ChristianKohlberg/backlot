#!/usr/bin/env node
/**
 * Soak harness — the test the fixtures can't be.
 *
 * The vitest suite proves invariants in seconds-long runs: every property it
 * checks is real, and every run is over before the daemon has drawn breath.
 * What no fixture run can prove is LONGEVITY — a daemon that stays correct
 * after an hour of editor-realistic watch traffic, pool churn, capacity
 * pressure, quiesce/rebind cycles, and the occasional SIGKILL. Leaks, drift,
 * and unbounded growth are properties of duration, so duration is what this
 * script buys, with everything else held to the same standards as the suite:
 *
 *   - it drives the REAL CLI (dist/cli/index.js) against generated fixture
 *     stacks in a dedicated temp state dir — no engine imports, no mocks;
 *   - every verb's JSON must parse and its exit code must match its body
 *     (the decision-0010 contract), on every single call;
 *   - timing is randomized but SEEDED (SOAK_SEED), so a failure reproduces;
 *   - it ends by proving CONVERGENCE: daemon down, no process left carrying
 *     BACKLOT_STATE_ROOT for the soak state dir, no orphaned env dirs, every
 *     lease in the journal pointing at an env that exists, RSS never having
 *     grown past a generous bound.
 *
 * Phases, cycled until the clock runs out (SOAK_MINUTES, default 10):
 *   (a) session loop — up --watch, sync with real file churn, exec, logs, release
 *   (b) watch traffic — plain saves, atomic-rename saves (tmp+mv), deletions,
 *       burst storms, and an upkeep-trigger touch that MUST produce the
 *       documented fallback restart (new service pid + upkeep marker)
 *   (c) run loop — checks with verdict assertions (pass, fail, detach, unknown)
 *   (d) capacity churn — a second stack at POOL_MAX with extra holders
 *       queueing, short-TTL lease expiries, and a quiesce/rebind cycle under a
 *       short BACKLOT_LEASED_IDLE_TTL_MS — the sweeper must keep reclaiming
 *   (e) chaos ticks every ~2 min — SIGKILL the daemon (next verb must
 *       recover), SIGSTOP/SIGCONT (starvation-shaped; a true lid-close sleep
 *       pardon needs a human — see docs/soak.md), and a worktree deleted
 *       mid-lease (the stale-root reap).
 *
 * Exit 0 on a clean soak (stats table), 1 with a ranked failure summary
 * otherwise, 2 if the harness itself had to abort. Not wired into PR CI —
 * see .github/workflows/soak.yml for the nightly.
 */
import { spawn, execFile, execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync,
  rmSync, renameSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- config

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(repoRoot, 'dist', 'cli', 'index.js');
const MINUTES = Number(process.env.SOAK_MINUTES ?? 10);
// `||`, not `??`: CI passes SOAK_SEED='' for "fresh randomness", and an empty
// string must mean unset, not a constant seed shared by every nightly.
const SEED = process.env.SOAK_SEED || String(Math.floor(Math.random() * 2 ** 31));
const LOG_FILE = process.env.SOAK_LOG ?? join(repoRoot, 'soak.log');
const KEEP = process.env.SOAK_KEEP === '1';

if (!existsSync(CLI)) {
  console.error(`soak: ${CLI} does not exist — run 'npm run build' first`);
  process.exit(2);
}
if (!Number.isFinite(MINUTES) || MINUTES <= 0) {
  console.error(`soak: SOAK_MINUTES must be a positive number, got '${process.env.SOAK_MINUTES}'`);
  process.exit(2);
}

// Seeded PRNG (mulberry32) so "randomized" never means "unreproducible".
function seedOf(str) {
  let h = 2166136261 >>> 0;
  for (const c of str) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
let rngState = seedOf(SEED);
function rand() {
  rngState |= 0;
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- layout

// The soak owns a whole world under one temp dir: state (BACKLOT_STATE_DIR,
// so nothing touches the user's real pool) and the generated fixture stacks.
// SOAK_DIR pins it — useful for reproducing, and for fault injection.
const baseDir = process.env.SOAK_DIR
  ? (mkdirSync(process.env.SOAK_DIR, { recursive: true }), resolve(process.env.SOAK_DIR))
  : mkdtempSync(join(tmpdir(), 'backlot-soak-'));
const stateDir = join(baseDir, 'state');
const stacksDir = join(baseDir, 'stacks');
mkdirSync(stateDir, { recursive: true });
mkdirSync(stacksDir, { recursive: true });

// One env for every CLI call. The daemon inherits the env of whichever CLI
// invocation spawns it (including a chaos respawn), so this must be identical
// on every call — and must shed any BACKLOT_* the caller's shell carries.
const daemonEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BACKLOT_')));
Object.assign(daemonEnv, {
  BACKLOT_STATE_DIR: stateDir,
  BACKLOT_POOL_MAX: '2', // per stack: session + run, the documented core loop
  BACKLOT_POOL_MAX_TOTAL: '6', // A(2) + B(2) + one chaos stack, with headroom
  BACKLOT_SWEEP_MS: '1000', // expiries/quiesces/reaps within seconds, not minutes
  BACKLOT_GC_MS: '15000',
  BACKLOT_IDLE_TTL_MS: '45000',
  BACKLOT_LEASED_IDLE_TTL_MS: '12000', // leased quiesce cycles inside one phase
  BACKLOT_WAIT_MS: '30000',
  BACKLOT_RPC_TIMEOUT_MS: '120000',
});

// ---------------------------------------------------------------- log + ledger

const startedAt = Date.now();
const deadline = startedAt + MINUTES * 60_000;
const timeLeft = () => deadline - Date.now();
writeFileSync(LOG_FILE, '');
function log(line) {
  const stamp = `[${new Date().toISOString()} +${Math.round((Date.now() - startedAt) / 1000)}s]`;
  process.stderr.write(`${stamp} ${line}\n`);
  try {
    appendFileSync(LOG_FILE, `${stamp} ${line}\n`);
  } catch {
    /* the log is evidence, never a failure source */
  }
}

/** The failure ledger: everything is recorded, ranked at the end. */
const failures = []; // { sev: 'fatal'|'error'|'warn', phase, what, evidence }
let cycle = 0;
class SoakAbort extends Error {}
function fail(sev, phase, what, evidence = '') {
  failures.push({ sev, phase, what, evidence: String(evidence).slice(0, 600), cycle });
  log(`${sev.toUpperCase()} [${phase}] ${what}${evidence ? ` :: ${String(evidence).slice(0, 200).replace(/\n/g, ' | ')}` : ''}`);
  if (sev === 'fatal') throw new SoakAbort(what);
}
/** Record an error unless the condition holds; returns the condition. */
function must(cond, phase, what, evidence) {
  if (!cond) fail('error', phase, what, evidence);
  return Boolean(cond);
}

const stats = {
  verbs: new Map(), // verb -> { n, failed }
  binds: 0,
  watchProjections: 0,
  fallbackRestarts: 0,
  runsPass: 0,
  runsFail: 0,
  jobsPolled: 0,
  queuedAcquires: 0,
  leaseExpiries: 0,
  quiesceRebinds: 0,
  staleReaps: 0,
  chaosKills: 0,
  chaosStops: 0,
  recoveries: 0,
  maxRssKb: 0,
  rssSamples: 0,
};

// ---------------------------------------------------------------- the CLI

/**
 * One CLI invocation, with the JSON/exit-code contract asserted on EVERY call.
 * The soak never trusts a verb: stdout must be one parseable object and the
 * exit code must be derivable from that body (decision 0010). A verb that
 * "worked" but broke the contract is a failure even if the soak could carry on.
 */
function expectedExit(args, body) {
  if (body && body.ok === false && body.error) {
    const c = body.error.class;
    return c === 'work-error' ? 1 : c === 'infra-error' ? 3 : 2;
  }
  const verb = args[0];
  if (verb === 'run') {
    if (args.includes('--detach')) return 0; // detach returns { jobId } immediately
    return body.ok ? 0 : 1;
  }
  if (verb === 'exec') return body.exitCode === 0 ? 0 : 1;
  if (verb === 'job' && args[1] !== 'ls') {
    return body.state === 'done' && body.verdict && body.verdict.ok === false ? 1 : 0;
  }
  return 0;
}

function cli(args, { cwd, timeoutMs = 180_000, quiet = false } = {}) {
  const verb = args[0];
  // --json goes right AFTER the verb: `exec` treats everything from its first
  // non-flag token as the passthrough command, so a trailing --json would be
  // handed to the executed command instead of to backlot.
  const argv = args.includes('--json') ? args : [args[0], '--json', ...args.slice(1)];
  const rec = stats.verbs.get(verb) ?? { n: 0, failed: 0 };
  rec.n++;
  stats.verbs.set(verb, rec);
  return new Promise((resolveP) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [CLI, ...argv], {
      cwd,
      env: daemonEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      rec.failed++;
      fail('error', 'contract', `'${verb}' hung past ${timeoutMs / 1000}s — killed`, `args: ${args.join(' ')}`);
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const ms = Date.now() - t0;
      let body;
      if (signal) {
        resolveP({ code: null, body: undefined, stdout, stderr, ms });
        return;
      }
      try {
        body = JSON.parse(stdout.trim());
      } catch {
        rec.failed++;
        fail('error', 'contract', `'${verb}' stdout is not one JSON object`, `exit ${code}\nstdout: ${stdout.slice(0, 300)}\nstderr: ${stderr.slice(-300)}`);
        resolveP({ code, body: undefined, stdout, stderr, ms });
        return;
      }
      const want = expectedExit(argv, body);
      if (code !== want) {
        rec.failed++;
        fail('error', 'contract', `'${verb}' exit code ${code} contradicts its body (expected ${want})`, `args: ${args.join(' ')}\nbody: ${stdout.slice(0, 400)}`);
      }
      if (!quiet) log(`  ${verb}${args.length > 1 ? ' ' + args.slice(1).join(' ') : ''} -> ${code} (${ms}ms)`);
      resolveP({ code, body, stdout, stderr, ms });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      rec.failed++;
      fail('fatal', 'harness', `could not spawn the CLI: ${err.message}`);
    });
  });
}

/** Poll until fn() is truthy; false on timeout. Never throws out of fn. */
async function until(timeoutMs, intervalMs, fn) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() > end) return false;
    await sleep(intervalMs);
  }
}

async function fetchJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status !== 200) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- fixtures

/**
 * Stack A: the editor-realistic stack — an HTTP service over sqlite (the same
 * shape as examples/hello-web), a tree of source files to churn, an upkeep rule
 * on deps.lock so a watch save can be forced down the fallback-restart path,
 * and one passing + one failing check for verdict assertions. /health reports
 * the service PID so a restart is observable from outside.
 */
function writeStackA(dir) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'backlot.yml'), `name: soak-a

services:
  web:
    run: node server.mjs
    port: web
    env:
      PORT: "{{ports.web}}"
      DB_PATH: "{{datastores.main.url}}"
    ready: { http: /health, timeout: 30 }
    fatal_logs: "SOAK-FATAL:"

datastores:
  main:
    driver: sqlite
    create: node seed.mjs {{ns}} {{preset}}
    presets: [dev, empty]
    default_preset: { run: dev, session: dev }
    template: true

upkeep:
  - { when: deps.lock, run: node upkeep-mark.mjs }

checks:
  pass:
    run: node check-pass.mjs
    env: { BASE_URL: "{{services.web.url}}" }
    timeout: 60
  fail:
    run: node check-fail.mjs
    timeout: 30
`);
  writeFileSync(join(dir, 'server.mjs'), `import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
const PORT = Number(process.env.PORT);
const db = new DatabaseSync(process.env.DB_PATH);
createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: process.pid }));
    return;
  }
  if (req.url === '/api/items') {
    const rows = db.prepare('SELECT id, label FROM items ORDER BY id').all();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rows));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('soak-a');
}).listen(PORT, () => console.log('soak-a listening on :' + PORT));
`);
  writeFileSync(join(dir, 'seed.mjs'), `import { DatabaseSync } from 'node:sqlite';
const [dbPath, preset = 'dev'] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);
db.exec('DROP TABLE IF EXISTS items');
db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
const seeds = { dev: ['alpha', 'beta', 'gamma'], empty: [] };
const rows = seeds[preset];
if (!rows) { console.error('unknown preset ' + preset); process.exit(1); }
const ins = db.prepare('INSERT INTO items (label) VALUES (?)');
for (const l of rows) ins.run(l);
console.log('seeded ' + dbPath + ' (' + preset + ', ' + rows.length + ' rows)');
`);
  writeFileSync(join(dir, 'check-pass.mjs'), `const base = process.env.BASE_URL;
for (let i = 0; ; i++) {
  try {
    const h = await (await fetch(base + '/health')).json();
    if (!h.ok) throw new Error('health not ok');
    const rows = await (await fetch(base + '/api/items')).json();
    if (!Array.isArray(rows) || rows.length < 1) throw new Error('no seeded rows');
    console.log('ok: ' + rows.length + ' rows via ' + base);
    process.exit(0);
  } catch (e) {
    if (i >= 2) { console.error(String(e)); process.exit(1); }
    await new Promise((r) => setTimeout(r, 500));
  }
}
`);
  writeFileSync(join(dir, 'check-fail.mjs'), `console.error('deliberately failing — the soak asserts this exact verdict');
process.exit(1);
`);
  writeFileSync(join(dir, 'upkeep-mark.mjs'), `import { appendFileSync } from 'node:fs';
appendFileSync('.upkeep-ran', Date.now() + '\\n');
console.log('upkeep ran');
`);
  writeFileSync(join(dir, 'deps.lock'), 'v1\n');
  for (let i = 0; i < 24; i++) {
    writeFileSync(join(dir, 'src', `mod_${String(i).padStart(2, '0')}.txt`), `module ${i}\nrevision 0\n`);
  }
}

/** Stack B/C: the smallest bindable stack — capacity churn needs cheap binds. */
function writeStackMin(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'backlot.yml'), `name: ${name}
services:
  web:
    run: node srv.mjs
    port: web
    env: { PORT: "{{ports.web}}" }
    ready: { http: /health, timeout: 20 }
checks:
  ok: { run: "true" }
`);
  writeFileSync(join(dir, 'srv.mjs'), `import { createServer } from 'node:http';
createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  res.end('${name}');
}).listen(Number(process.env.PORT), () => console.log('${name} up'));
`);
}

function gitInit(dir) {
  // Sync enumerates via git ls-files when a repo exists (untracked included),
  // which is the realistic path; without git the walk-all fallback still works.
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  } catch {
    /* no git on PATH — sync's walkAll path takes over */
  }
}

const stackA = join(stacksDir, 'a');
const stackB = join(stacksDir, 'b');
writeStackA(stackA);
writeStackMin(stackB, 'soak-b');
gitInit(stackA);
gitInit(stackB);

const envTreeOf = (envId) => join(stateDir, 'envs', envId, 'tree');
let srcRev = 0;
function churnFiles(n) {
  // Keyed by path — the same file can be drawn twice in one batch, and any
  // assertion must hold the LAST content written, not the first.
  const changed = new Map();
  for (let i = 0; i < n; i++) {
    const f = `src/mod_${String(randInt(0, 23)).padStart(2, '0')}.txt`;
    const content = `module ${f}\nrevision ${++srcRev}\nseeded-tag ${Math.floor(rand() * 1e9)}\n`;
    writeFileSync(join(stackA, f), content);
    changed.set(f, { rel: f, content });
  }
  return [...changed.values()];
}

// ---------------------------------------------------------------- phases

let upFailStreak = 0;
/** `up` with the semantic assertions every session bind must satisfy. */
async function upA(extra = []) {
  const r = await cli(['up', ...extra], { cwd: stackA });
  const ok =
    must(r.body?.envId && r.body?.state === 'hot', 'session', `up did not yield a hot environment`, r.stdout) &&
    must(typeof r.body?.urls?.web === 'string', 'session', 'up context has no web url', r.stdout);
  if (!ok) {
    // Three consecutive dead ups means the soak cannot exercise anything —
    // abort with what we have rather than logging the same corpse for an hour.
    if (++upFailStreak >= 3) fail('fatal', 'session', 'three consecutive `up` failures on stack A — aborting the soak');
    return null;
  }
  upFailStreak = 0;
  stats.binds++;
  return r.body;
}

async function healthPid(url) {
  const h = await fetchJson(url + '/health');
  return h.pid;
}

/** (a) The session loop: the documented human/agent workflow, end to end. */
async function phaseSession() {
  log(`phase session (cycle ${cycle})`);
  const ctx = await upA(['--watch']);
  if (!ctx) return;
  const alive = await until(5000, 300, () => fetchJson(ctx.urls.web + '/health'));
  must(alive && alive.ok === true, 'session', 'service url does not answer /health after up', ctx.urls.web);
  const iterations = randInt(2, 4);
  for (let i = 0; i < iterations && timeLeft() > 20_000; i++) {
    const changed = churnFiles(randInt(1, 5));
    await sleep(randInt(100, 500));
    const s = await cli(['sync'], { cwd: stackA });
    must(s.body?.state === 'hot', 'session', 'sync did not return a hot context', s.stdout);
    // The projection must be REAL: read a changed file back from inside the env.
    const probe = pick(changed);
    const ex = await cli(['exec', `cat ${probe.rel}`], { cwd: stackA });
    must(ex.body?.exitCode === 0 && ex.body?.stdout === probe.content, 'session',
      'exec read back different content than sync projected', `wanted:\n${probe.content}\ngot:\n${ex.body?.stdout}`);
    const lg = await cli(['logs', 'web', '--lines', '20'], { cwd: stackA });
    must(typeof lg.body?.lines === 'string', 'session', 'logs returned no lines field', lg.stdout);
    await sleep(randInt(100, 600));
  }
  const cx = await cli(['ctx'], { cwd: stackA });
  must(cx.body?.envId === ctx.envId, 'session', 'ctx switched environments mid-session', `${cx.body?.envId} != ${ctx.envId}`);
  const rel = await cli(['release'], { cwd: stackA });
  must(rel.body?.released === true, 'session', 'release reported nothing released', rel.stdout);
}

/** Wait for one file's env-tree copy to converge to `content` (null = deleted). */
function converged(envId, rel, content) {
  return until(12_000, 200, () => {
    const p = join(envTreeOf(envId), rel);
    if (content === null) return !existsSync(p);
    try {
      return readFileSync(p, 'utf8') === content;
    } catch {
      return false;
    }
  });
}

/** (b) Watch traffic: what a human with an editor actually generates. */
async function phaseWatch() {
  log(`phase watch (cycle ${cycle})`);
  const ctx = await upA(['--watch']);
  if (!ctx) return;
  const envId = ctx.envId;

  // Plain saves.
  for (const c of churnFiles(randInt(1, 3))) {
    if (must(await converged(envId, c.rel, c.content), 'watch', `plain save never projected (${c.rel})`)) stats.watchProjections++;
  }

  // Atomic-rename save — how VS Code, vim, and every safe-write editor saves.
  {
    const rel = `src/mod_${String(randInt(0, 23)).padStart(2, '0')}.txt`;
    const content = `atomic save ${++srcRev} tag ${Math.floor(rand() * 1e9)}\n`;
    const tmp = join(stackA, `${rel}.tmp-${srcRev}`);
    writeFileSync(tmp, content);
    renameSync(tmp, join(stackA, rel));
    if (must(await converged(envId, rel, content), 'watch', `atomic-rename save never projected (${rel})`)) stats.watchProjections++;
  }

  // Deletion: create, converge, delete, converge-to-absent.
  {
    const rel = `src/ephemeral_${cycle}.txt`;
    const content = `short-lived ${srcRev}\n`;
    writeFileSync(join(stackA, rel), content);
    await converged(envId, rel, content);
    rmSync(join(stackA, rel));
    if (must(await converged(envId, rel, null), 'watch', `deletion never mirrored (${rel})`)) stats.watchProjections++;
  }

  // Burst storm: a rebase / branch switch / format-on-save-all. Many writes
  // inside the debounce window; the only honest assertion is convergence of a
  // sentinel written LAST, plus spot-checked storm files.
  if (timeLeft() > 40_000) {
    const n = randInt(30, 80);
    mkdirSync(join(stackA, 'src', 'storm'), { recursive: true });
    let lastRel = '';
    let lastContent = '';
    for (let i = 0; i < n; i++) {
      lastRel = `src/storm/f_${i % randInt(8, 20)}.txt`;
      lastContent = `storm ${cycle}:${i} tag ${Math.floor(rand() * 1e9)}\n`;
      writeFileSync(join(stackA, lastRel), lastContent);
      if (rand() < 0.2) await sleep(randInt(5, 40));
    }
    const sentinelRel = 'src/storm/sentinel.txt';
    const sentinel = `storm-sentinel ${cycle} ${Math.floor(rand() * 1e9)}\n`;
    writeFileSync(join(stackA, sentinelRel), sentinel);
    const okStorm =
      (await converged(envId, sentinelRel, sentinel)) && (await converged(envId, lastRel, lastContent));
    if (must(okStorm, 'watch', `burst storm (${n} writes) never converged`)) stats.watchProjections++;
  }

  // The upkeep-trigger touch. A save that changes what an upkeep rule
  // fingerprints CANNOT be served by projection — the engine documents a
  // deliberate fallback to the full bind path: rule runs, services restart.
  // Observe both halves from outside: the marker the rule writes, and a new
  // service pid on the same (stable) URL.
  {
    const pidBefore = await until(5000, 250, () => healthPid(ctx.urls.web));
    const markerPath = join(envTreeOf(envId), '.upkeep-ran');
    const markerBefore = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : '';
    appendFileSync(join(stackA, 'deps.lock'), `bump ${cycle} ${Math.floor(rand() * 1e9)}\n`);
    const restarted = await until(45_000, 500, async () => {
      const marker = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : '';
      if (marker.length <= markerBefore.length) return false;
      const pid = await healthPid(ctx.urls.web);
      return pid !== pidBefore ? pid : false;
    });
    if (must(restarted, 'watch', 'upkeep-trigger touch never produced the fallback restart',
      `pid before: ${pidBefore}; marker before: ${markerBefore.split('\n').length - 1} line(s)`)) {
      stats.fallbackRestarts++;
      log(`  fallback restart observed: pid ${pidBefore} -> ${restarted}`);
    }
  }
  // The lease stays up: phase (c) runs against a pool that also holds a session.
}

/** (c) The run loop: verdicts an agent would branch on, asserted exactly. */
async function phaseRuns() {
  log(`phase runs (cycle ${cycle})`);
  const r1 = await cli(['run', 'pass'], { cwd: stackA });
  if (must(r1.body?.ok === true && r1.body?.exitCode === 0 && r1.body?.failure === null, 'run',
    "run pass did not yield { ok: true, exitCode: 0, failure: null }", r1.stdout.slice(0, 400))) stats.runsPass++;

  const r2 = await cli(['run', 'fail'], { cwd: stackA });
  if (must(r2.body?.ok === false && r2.body?.failure?.class === 'work-error', 'run',
    'run fail must verdict work-error (env-error here would be the silently-wrong-verdict bug)', r2.stdout.slice(0, 400))) stats.runsFail++;

  if (rand() < 0.5 && timeLeft() > 60_000) {
    const d = await cli(['run', 'pass', '--detach'], { cwd: stackA });
    if (must(typeof d.body?.jobId === 'string', 'run', 'run --detach returned no jobId', d.stdout)) {
      const done = await until(90_000, 1000, async () => {
        const j = await cli(['job', d.body.jobId], { cwd: stackA, quiet: true });
        stats.jobsPolled++;
        return j.body?.state === 'done' ? j.body : false;
      });
      must(done && done.verdict?.ok === true, 'run', 'detached run never reached a passing verdict', JSON.stringify(done).slice(0, 400));
    }
  }

  if (rand() < 0.4) {
    const r3 = await cli(['run', 'no-such-check'], { cwd: stackA });
    must(r3.body?.ok === false && r3.body?.error?.class === 'work-error', 'run',
      'unknown check must be a work-error naming the checks that exist', r3.stdout);
  }
}

async function statusEnvs() {
  const s = await cli(['status'], { cwd: stackA, quiet: true });
  return s.body?.envs ?? [];
}

/** (d) Capacity churn on stack B: queueing, expiries, quiesce — the sweeper's beat. */
async function phaseCapacity() {
  log(`phase capacity (cycle ${cycle})`);
  // Two short-TTL holders occupy POOL_MAX=2; a third queues on the expiry.
  const h1 = await cli(['up', '--holder', 'soak-h1', '--ttl', '0.12'], { cwd: stackB }); // ~7s
  const h2 = await cli(['up', '--holder', 'soak-h2', '--ttl', '0.07'], { cwd: stackB }); // ~4s
  must(h1.body?.state === 'hot' && h2.body?.state === 'hot', 'capacity', 'stack B holders failed to bind', `${h1.stdout.slice(0, 200)} ${h2.stdout.slice(0, 200)}`);
  const t0 = Date.now();
  const h3 = await cli(['up', '--holder', 'soak-h3'], { cwd: stackB, timeoutMs: 90_000 });
  if (must(h3.body?.state === 'hot', 'capacity', 'queued holder never acquired at POOL_MAX (waited past the expiry window)', h3.stdout.slice(0, 300))) {
    stats.queuedAcquires++;
    log(`  queued acquire served after ${Date.now() - t0}ms`);
  }
  await cli(['release', '--holder', 'soak-h3'], { cwd: stackB });

  // The sweeper must drop the expired leases on its own.
  const cleared = await until(20_000, 1000, async () => {
    const envs = await statusEnvs();
    return envs.filter((e) => e.stack.startsWith('soak-b') && e.lease).length === 0;
  });
  if (must(cleared, 'capacity', 'expired stack-B leases were never swept')) stats.leaseExpiries += 2;

  // Quiesce cycle: a leased-but-idle env must lose its heat (services stop,
  // lease kept), refuse exec with a rebind hint, and come back hot on `up`.
  if (timeLeft() > 60_000) {
    const q = await cli(['up', '--holder', 'soak-hq'], { cwd: stackB });
    if (must(q.body?.state === 'hot', 'capacity', 'quiesce-probe holder failed to bind', q.stdout.slice(0, 200))) {
      const envId = q.body.envId;
      const wentWarm = await until(30_000, 1000, async () => {
        const e = (await statusEnvs()).find((x) => x.id === envId);
        return e && e.state === 'warm' && e.lease ? e : false;
      });
      must(wentWarm, 'capacity', `leased idle env never quiesced (BACKLOT_LEASED_IDLE_TTL_MS=${daemonEnv.BACKLOT_LEASED_IDLE_TTL_MS})`);
      if (wentWarm) {
        const ex = await cli(['exec', '--holder', 'soak-hq', 'pwd'], { cwd: stackB });
        must(ex.body?.ok === false && ex.body?.error?.class === 'env-error', 'capacity',
          'exec against a quiesced env must be env-error with a rebind hint', ex.stdout);
        const re = await cli(['up', '--holder', 'soak-hq'], { cwd: stackB });
        if (must(re.body?.state === 'hot' && re.body?.envId === envId, 'capacity',
          'rebind after quiesce did not return the same env hot', re.stdout.slice(0, 300))) stats.quiesceRebinds++;
      }
      await cli(['release', '--holder', 'soak-hq'], { cwd: stackB });
    }
  }
}

// ---------------------------------------------------------------- chaos

const daemonPid = () => {
  try {
    const pid = Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

let chaosN = randInt(0, 2); // seeded rotation offset
let nextChaosAt = startedAt + randInt(100, 140) * 1000;
let cSeq = 0;

async function chaosKill() {
  const pid = daemonPid();
  if (!pid) return fail('warn', 'chaos', 'no daemon.pid to SIGKILL — skipping this tick');
  log(`chaos: SIGKILL daemon (pid ${pid})`);
  try {
    process.kill(pid, 'SIGKILL');
  } catch (e) {
    return fail('warn', 'chaos', `SIGKILL failed: ${e.message}`);
  }
  stats.chaosKills++;
  // The contract: the NEXT verb auto-respawns and recovers. No manual help.
  const st = await cli(['status'], { cwd: stackA });
  must(st.body && Array.isArray(st.body.envs), 'chaos', 'status did not recover after daemon SIGKILL', st.stdout.slice(0, 300));
  const ctx = await upA([]);
  if (ctx) {
    const alive = await until(8000, 300, () => fetchJson(ctx.urls.web + '/health'));
    if (must(alive && alive.ok, 'chaos', 'post-SIGKILL rebind did not yield a serving environment', ctx.urls.web)) {
      stats.recoveries++;
      log(`  recovered: new daemon pid ${daemonPid()}, env ${ctx.envId} serving`);
    }
    await cli(['release'], { cwd: stackA });
  }
}

async function chaosStop() {
  const pid = daemonPid();
  if (!pid) return fail('warn', 'chaos', 'no daemon.pid to SIGSTOP — skipping this tick');
  // 60–90s per the brief; on short validation runs that would eat the whole
  // soak, so under 8 minutes the window shrinks (documented in docs/soak.md).
  let windowS = MINUTES >= 8 ? randInt(60, 90) : randInt(18, 28);
  windowS = Math.min(windowS, Math.max(15, Math.floor(timeLeft() / 1000) - 45));
  log(`chaos: SIGSTOP daemon (pid ${pid}) for ${windowS}s`);
  try {
    process.kill(pid, 'SIGSTOP');
  } catch (e) {
    return fail('warn', 'chaos', `SIGSTOP failed: ${e.message}`);
  }
  stats.chaosStops++;
  await sleep(windowS * 1000);
  try {
    process.kill(pid, 'SIGCONT');
  } catch (e) {
    return fail('error', 'chaos', `SIGCONT failed — daemon may be stopped forever: ${e.message}`);
  }
  // Same daemon, same pid — it must simply pick up where it left off.
  const st = await cli(['status'], { cwd: stackA });
  if (must(st.body && st.body.pid === pid, 'chaos', 'daemon did not answer as the SAME process after SIGCONT', st.stdout.slice(0, 300))) {
    stats.recoveries++;
    log(`  resumed after ${windowS}s stop`);
  }
}

async function chaosStaleRoot() {
  const dir = join(stacksDir, `c-${++cSeq}`);
  writeStackMin(dir, 'soak-c');
  gitInit(dir);
  const up = await cli(['up', '--ttl', '0.1'], { cwd: dir }); // ~6s lease
  if (!must(up.body?.state === 'hot', 'chaos', 'stale-root probe stack failed to bind', up.stdout.slice(0, 300))) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  const envId = up.body.envId;
  log(`chaos: deleting worktree ${dir} mid-lease (env ${envId})`);
  rmSync(dir, { recursive: true, force: true });
  // Lease lapses in seconds; the sweeper must then see the missing stack root
  // and reap the env — row AND directory — with no help from anyone.
  const reaped = await until(40_000, 1000, async () => {
    const gone = !(await statusEnvs()).some((e) => e.id === envId);
    return gone && !existsSync(join(stateDir, 'envs', envId));
  });
  if (must(reaped, 'chaos', `stale-root env ${envId} was never reaped after its worktree vanished`)) {
    stats.staleReaps++;
    log(`  stale-root reap confirmed for ${envId}`);
  }
}

async function maybeChaos() {
  if (Date.now() < nextChaosAt || timeLeft() < 60_000) return;
  nextChaosAt = Date.now() + randInt(100, 140) * 1000;
  const kind = ['kill', 'stop', 'stale-root'][chaosN++ % 3];
  if (kind === 'kill') await chaosKill();
  else if (kind === 'stop') await chaosStop();
  else await chaosStaleRoot();
}

// ---------------------------------------------------------------- RSS watch

const rssSamples = []; // { t, pid, kb }
let rssTimer;
function sampleRss() {
  const pid = daemonPid();
  if (!pid) return;
  execFile('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 3000 }, (err, out) => {
    if (err) return; // daemon between lives (chaos) — skip the sample
    const kb = Number(String(out).trim());
    if (!Number.isFinite(kb) || kb <= 0) return;
    rssSamples.push({ t: Date.now(), pid, kb });
    stats.rssSamples++;
    if (kb > stats.maxRssKb) stats.maxRssKb = kb;
  });
}

/**
 * Growth check: baseline = max RSS over the first 5 minutes (or the first half
 * of a shorter soak); any later sample past 3x the baseline is unbounded
 * growth. Generous by design — daemons restart under chaos, caches warm up —
 * so anything that trips this is worth a human's attention.
 */
function analyzeRss() {
  const windowMs = Math.min(5 * 60_000, (MINUTES * 60_000) / 2);
  const base = rssSamples.filter((s) => s.t - startedAt <= windowMs);
  const later = rssSamples.filter((s) => s.t - startedAt > windowMs);
  if (base.length < 3 || later.length === 0) {
    log(`rss: too few samples to judge growth (${base.length} baseline, ${later.length} later) — skipping`);
    return;
  }
  const baseline = Math.max(...base.map((s) => s.kb));
  const worst = later.reduce((a, b) => (a.kb > b.kb ? a : b));
  log(`rss: baseline ${baseline} KB (first ${Math.round(windowMs / 60_000)}m), later peak ${worst.kb} KB`);
  must(worst.kb <= 3 * baseline, 'rss',
    `daemon RSS grew past 3x its baseline (${worst.kb} KB vs ${baseline} KB baseline)`,
    `worst sample at +${Math.round((worst.t - startedAt) / 1000)}s, pid ${worst.pid}`);
}

// ---------------------------------------------------------------- convergence

function scanLeakedProcs() {
  // The authoritative leak question: does ANY process still carry
  // BACKLOT_STATE_ROOT=<our state dir>? Only supervised services, execs, and
  // checks are tagged with it (procscan.ts), so a hit is a leak by definition.
  const needle = `BACKLOT_STATE_ROOT=${stateDir}`;
  const hits = [];
  if (process.platform === 'linux') {
    for (const entry of readdirSync('/proc')) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      try {
        const env = readFileSync(`/proc/${pid}/environ`, 'utf8');
        if (env.split('\0').includes(needle)) {
          hits.push(`${pid}: ${readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()}`);
        }
      } catch {
        /* exited mid-scan, or not ours to read */
      }
    }
  } else {
    // macOS: `ps -E` appends each (owned) process's environment to its command.
    try {
      const out = execFileSync('ps', ['-axE', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      for (const line of out.split('\n')) {
        if (line.includes(needle)) hits.push(line.trim().slice(0, 200));
      }
    } catch {
      log('leak scan: ps -E unavailable — falling back to recorded-pid checks only');
    }
  }
  return hits;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

async function convergence() {
  log('convergence: releasing, stopping the daemon, and auditing what remains');
  for (const [args, cwd] of [
    [['release'], stackA],
    [['release', '--holder', 'soak-h1'], stackB],
    [['release', '--holder', 'soak-h2'], stackB],
    [['release', '--holder', 'soak-hq'], stackB],
  ]) {
    try {
      await cli(args, { cwd, quiet: true, timeoutMs: 30_000 });
    } catch {
      /* best-effort — an unreleasable lease shows up in the audit below */
    }
  }

  const pid = daemonPid();
  try {
    await cli(['daemon', 'stop'], { cwd: stackA, timeoutMs: 30_000 });
  } catch {
    /* audited below */
  }
  if (pid) {
    const dead = await until(15_000, 300, () => !pidAlive(pid));
    if (!dead) {
      fail('error', 'convergence', `daemon (pid ${pid}) still alive 15s after 'daemon stop'`);
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* raced its exit */
      }
    }
  }
  await sleep(1000);

  // Journal consistency — read the same sqlite file the daemon wrote. The
  // journal's own comment blesses concurrent external readers; here the daemon
  // is down, so this is simply disk-is-truth, read back.
  let envRows = [];
  try {
    const { DatabaseSync } = await import('node:sqlite');
    // Not readOnly: a daemon that died hard leaves a WAL needing recovery,
    // which a read-only handle refuses to perform. We only SELECT.
    const db = new DatabaseSync(join(stateDir, 'journal.db'));
    envRows = db.prepare('SELECT id, state, root, service_pids FROM envs').all();
    const leaseRows = db.prepare('SELECT id, env_id, holder FROM leases').all();
    const envIds = new Set(envRows.map((e) => e.id));
    for (const l of leaseRows) {
      must(envIds.has(l.env_id), 'convergence',
        `journal lease ${l.id} (holder '${l.holder}') points at env ${l.env_id}, which does not exist`);
    }
    for (const e of envRows) {
      if (e.state === 'recycling') fail('warn', 'convergence', `env ${e.id} left stuck in 'recycling' after shutdown`);
      if (!existsSync(e.root)) fail('warn', 'convergence', `journal env ${e.id} has no directory at ${e.root} (journal/disk drift)`);
      for (const [svc, rec] of Object.entries(JSON.parse(e.service_pids || '{}'))) {
        const p = typeof rec === 'number' ? rec : rec.pid;
        if (p && pidAlive(p)) {
          // On Linux the environ scan below confirms identity; a bare liveness
          // hit here could be pid reuse, so it rates error only where provable.
          fail(process.platform === 'linux' ? 'error' : 'warn', 'convergence',
            `service '${svc}' of env ${e.id} recorded as pid ${p}, which is still alive after shutdown`);
        }
      }
    }
    db.close?.();
  } catch (e) {
    fail('error', 'convergence', `could not audit the journal: ${e.message}`);
  }

  // Orphaned env dirs: every directory under envs/ must be a journal row.
  try {
    const envIds = new Set(envRows.map((e) => e.id));
    const onDisk = existsSync(join(stateDir, 'envs')) ? readdirSync(join(stateDir, 'envs')) : [];
    for (const d of onDisk) {
      must(envIds.has(d), 'convergence', `env dir '${d}' exists on disk with no journal row (orphaned)`);
    }
  } catch (e) {
    fail('error', 'convergence', `could not audit env dirs: ${e.message}`);
  }

  const leaked = scanLeakedProcs();
  must(leaked.length === 0, 'convergence',
    `${leaked.length} process(es) still carry BACKLOT_STATE_ROOT for the soak state dir`, leaked.join('\n'));
}

// ---------------------------------------------------------------- reporting

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function printStats() {
  const lines = [];
  lines.push('');
  lines.push('── soak stats ─────────────────────────────────────────────');
  lines.push(`  seed ${SEED} · ${MINUTES} min asked, ${Math.round((Date.now() - startedAt) / 60_000)} min run · ${cycle} cycle(s)`);
  lines.push('');
  lines.push(`  ${pad('verb', 12)}${pad('calls', 8)}contract failures`);
  for (const [verb, r] of [...stats.verbs.entries()].sort((a, b) => b[1].n - a[1].n)) {
    lines.push(`  ${pad(verb, 12)}${pad(r.n, 8)}${r.failed}`);
  }
  lines.push('');
  lines.push(`  binds (hot ups)        ${stats.binds}`);
  lines.push(`  watch projections      ${stats.watchProjections}`);
  lines.push(`  fallback restarts      ${stats.fallbackRestarts}`);
  lines.push(`  runs pass / fail       ${stats.runsPass} / ${stats.runsFail}`);
  lines.push(`  detached polls         ${stats.jobsPolled}`);
  lines.push(`  queued acquires        ${stats.queuedAcquires}`);
  lines.push(`  lease expiries swept   ${stats.leaseExpiries}`);
  lines.push(`  quiesce -> rebind      ${stats.quiesceRebinds}`);
  lines.push(`  stale-root reaps       ${stats.staleReaps}`);
  lines.push(`  chaos kills / stops    ${stats.chaosKills} / ${stats.chaosStops} (${stats.recoveries} recoveries)`);
  lines.push(`  daemon max RSS         ${stats.maxRssKb} KB over ${stats.rssSamples} samples`);
  lines.push('───────────────────────────────────────────────────────────');
  const out = lines.join('\n');
  console.log(out);
  try {
    appendFileSync(LOG_FILE, out + '\n');
  } catch { /* ignore */ }
}

function printFailures() {
  const rank = { fatal: 0, error: 1, warn: 2 };
  const groups = new Map();
  for (const f of failures) {
    const key = `${f.sev}|${f.phase}|${f.what}`;
    const g = groups.get(key) ?? { ...f, count: 0, cycles: new Set() };
    g.count++;
    g.cycles.add(f.cycle);
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => rank[a.sev] - rank[b.sev] || b.count - a.count);
  const lines = ['', `── soak failures (${failures.length} raw, ${ordered.length} distinct, seed ${SEED}) ──`];
  for (const g of ordered) {
    lines.push(`  [${g.sev}] x${g.count} (${g.phase}, cycle ${[...g.cycles].join(',')}) ${g.what}`);
    if (g.evidence) lines.push(`         ${g.evidence.split('\n').join('\n         ')}`);
  }
  lines.push('');
  lines.push(`  reproduce: SOAK_SEED=${SEED} SOAK_MINUTES=${MINUTES} node scripts/soak.mjs`);
  lines.push(`  evidence kept in ${baseDir} (daemon.log, events.jsonl, journal.db)`);
  const out = lines.join('\n');
  console.log(out);
  try {
    appendFileSync(LOG_FILE, out + '\n');
  } catch { /* ignore */ }
}

/** On failure, pull the daemon's own account into the soak log. */
function attachDaemonEvidence() {
  for (const f of ['daemon.log', 'events.jsonl']) {
    try {
      const tail = readFileSync(join(stateDir, f), 'utf8').split('\n').slice(-120).join('\n');
      appendFileSync(LOG_FILE, `\n── tail of ${f} ──\n${tail}\n`);
    } catch {
      /* absent is fine */
    }
  }
}

// ---------------------------------------------------------------- main

async function main() {
  log(`soak: ${MINUTES} min, seed ${SEED}, node ${process.version}, ${process.platform}`);
  log(`soak: state dir ${stateDir}`);
  log(`soak: log ${LOG_FILE}`);
  rssTimer = setInterval(sampleRss, 10_000);
  rssTimer.unref();

  try {
    while (timeLeft() > 30_000) {
      cycle++;
      await phaseSession();
      await maybeChaos();
      if (timeLeft() < 30_000) break;
      await phaseWatch(); // leaves the session lease up, deliberately
      await maybeChaos();
      if (timeLeft() < 30_000) break;
      await phaseRuns(); // a run next to a live session needs the 2nd env
      if (timeLeft() < 45_000) break;
      await phaseCapacity();
      await cli(['release'], { cwd: stackA, quiet: true });
      await maybeChaos();
    }
  } catch (e) {
    if (!(e instanceof SoakAbort)) {
      failures.push({ sev: 'fatal', phase: 'harness', what: `harness crashed: ${e.message}`, evidence: String(e.stack).slice(0, 600), cycle });
      log(`FATAL harness crash: ${e.stack}`);
    }
  }
  clearInterval(rssTimer);

  try {
    await convergence();
  } catch (e) {
    if (!(e instanceof SoakAbort)) fail('error', 'convergence', `convergence audit crashed: ${e.message}`);
  }
  analyzeRss();
  printStats();

  const worst = failures.some((f) => f.sev === 'fatal') ? 2 : failures.some((f) => f.sev === 'error') ? 1 : 0;
  if (worst > 0) {
    printFailures();
    attachDaemonEvidence();
    process.exit(worst);
  }
  if (failures.length > 0) printFailures(); // warns only — visible, not fatal
  log(`soak: clean. ${KEEP ? `state kept at ${baseDir}` : 'removing the soak dir'}`);
  if (!KEEP) rmSync(baseDir, { recursive: true, force: true });
  process.exit(0);
}

main();

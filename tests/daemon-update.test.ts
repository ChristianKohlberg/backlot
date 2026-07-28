/**
 * `backlot update`: make the RUNNING daemon be the INSTALLED build.
 *
 * The gap this closes is silent. `ensureDaemon` spawns the daemon from the CLI's
 * own `dist/`, so upgrading backlot replaces the files on disk but never the
 * daemon already in memory — and the socket carries no version, so a new CLI
 * goes on being served by old code for as long as that process lives. An old
 * daemon does not reject arguments it has never heard of; it IGNORES them. A
 * 0.8.0 daemon asked for `up --data-only` boots the whole application into what
 * the caller believes is a datastore-only lease and says nothing about it.
 *
 * That is the failure shape of issue #41 — a wrong result that reads as a bug in
 * another subsystem, which there cost ~30 agents 14 hours — so skew is REFUSED
 * rather than warned about, and a warning would not reach a --json consumer at
 * all.
 *
 * The restart itself is cheap BECAUSE of the crash-recovery contract (decision
 * 0009): shutdown stops services, keeps leases, and records survivors; recover
 * reaps them and leaves the lease alone. So an update costs each holder one
 * rebind — exactly what the idle quiesce already does to a leased environment
 * without asking anyone. The tests below pin both halves: that a lease survives,
 * and that an in-flight operation is never interrupted.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal, JOURNAL_SCHEMA_VERSION } from '../src/core/journal.js';
import { Engine } from '../src/daemon/engine.js';
import { compareVersions, versionSkew } from '../src/core/version.js';
import { scanTagged } from '../src/core/procscan.js';

const repo = join(import.meta.dirname, '..');
const CLI = join(repo, 'dist', 'cli', 'index.js');
const PKG_VERSION = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }).version;

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const c of cleanups) c();
});

/**
 * A state root plus a CLI runner whose reported version can be FAKED.
 *
 * Skew cannot be provoked any other way from a single build: the CLI spawns the
 * daemon from its own dist, so the two sides always agree. BACKLOT_FAKE_VERSION
 * lets a daemon claim a different version than the CLI driving it.
 */
function ctx(opts: { service?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'backlot-update-'));
  const wt = mkdtempSync(join(tmpdir(), 'backlot-update-wt-'));
  if (opts.service) {
    writeFileSync(
      join(wt, 'srv.mjs'),
      `import{createServer}from'node:http';console.log('ready');createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT));\n`,
    );
    writeFileSync(
      join(wt, 'stack.yaml'),
      `name: upd\n` +
        `services:\n  web: { run: node srv.mjs, port: web, env: { PORT: "{{ports.web}}" }, ready: { log: ready, timeout: 20 } }\n` +
        `checks:\n  ok: { run: "true" }\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: wt });
  }
  /** `fakeVersion` makes THIS invocation (and any daemon it spawns) claim that version. */
  const cli = (args: string[], o: { fakeVersion?: string } = {}) =>
    new Promise<{ code: number; json?: Record<string, unknown>; stdout: string; stderr: string }>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env, BACKLOT_STATE_DIR: stateDir, BACKLOT_SWEEP_MS: '400' };
      if (o.fakeVersion) env.BACKLOT_FAKE_VERSION = o.fakeVersion;
      else delete env.BACKLOT_FAKE_VERSION;
      execFile(process.execPath, [CLI, ...args], { cwd: wt, env, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let json: Record<string, unknown> | undefined;
        try {
          json = JSON.parse(String(stdout));
        } catch {
          /* non-json output */
        }
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, json, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  cleanups.push(() => {
    try {
      process.kill(Number(readFileSync(join(stateDir, 'daemon.pid'), 'utf8')), 'SIGKILL');
    } catch {
      /* already gone */
    }
    for (const p of scanTagged(stateDir)) {
      try {
        process.kill(-p.pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
  });
  return { stateDir, wt, cli };
}

describe('version reporting', () => {
  it('reports the package version, without needing a daemon', async () => {
    const { cli } = ctx();
    // No daemon has been started in this state root, and none should be: "what
    // version am I" is asked precisely when the daemon is down or wedged.
    const plain = await cli(['--version']);
    expect(plain.code).toBe(0);
    expect(plain.stdout.trim()).toBe(PKG_VERSION); // bare, so $(backlot --version) works
    const asJson = await cli(['--version', '--json']);
    expect(asJson.json).toEqual({ version: PKG_VERSION });
  });

  it('orders releases, and refuses to order builds it cannot compare', () => {
    expect(compareVersions('0.8.0', '0.9.0')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.8.0', '0.8.0')).toBe(0);
    // A prerelease against its release is UNORDERED on purpose: guessing
    // precedence wrong would let `update` silently downgrade a daemon.
    expect(compareVersions('0.9.0-rc.1', '0.9.0')).toBeUndefined();
    expect(compareVersions('unknown', '0.9.0')).toBeUndefined();
  });

  it('treats a daemon with no version as skewed, not as a match', () => {
    // <= 0.8.0 answers ping with {pid} alone. Reading that as "same version"
    // is the whole bug: it is indistinguishable from agreement at the protocol
    // level, so it has to be treated as proof of an older daemon.
    const skew = versionSkew('0.9.0', undefined);
    expect(skew?.direction).toBe('daemon-unversioned');
    expect(skew?.message).toContain('backlot update');
    expect(versionSkew('0.9.0', '0.9.0')).toBeNull();
    expect(versionSkew('0.9.0', '0.8.0')?.direction).toBe('daemon-older');
    expect(versionSkew('0.8.0', '0.9.0')?.direction).toBe('daemon-newer');
  });
});

describe('skew is refused, not warned about', () => {
  it('fails an ordinary verb with infra-error, and exempts the verbs that can fix it', async () => {
    const { cli } = ctx();
    // A daemon that claims to be 0.7.0, started by a CLI that also claims it.
    const boot = await cli(['status', '--json'], { fakeVersion: '0.7.0' });
    expect(boot.code).toBe(0);

    // Now the real CLI (this build) meets that daemon.
    const ctxRes = await cli(['ctx', '--json']);
    // infra-error (3), NEVER env-error (2): an agent branches on the class
    // mechanically (decision 0010), and env-error tells it to recycle an
    // environment — which cannot fix a daemon running the wrong code.
    expect(ctxRes.code).toBe(3);
    expect((ctxRes.json as { error: { class: string; message: string } }).error.class).toBe('infra-error');
    expect((ctxRes.json as { error: { message: string } }).error.message).toMatch(/0\.7\.0.*but this CLI is/);

    // doctor must work under skew, or there is no way to diagnose it, and it
    // reports the skew itself so every RPC client sees it — not just the CLI.
    const doc = await cli(['doctor', '--json']);
    expect(doc.code).toBe(0);
    const issues = (doc.json as { issues: Array<{ issue: string }> }).issues;
    expect(issues.some((i) => /running daemon is backlot 0\.7\.0/.test(i.issue))).toBe(true);
  });
});

describe('backlot update', () => {
  it('--check reports the versions and changes nothing', async () => {
    const { cli } = ctx();
    await cli(['status', '--json'], { fakeVersion: '0.7.0' });
    const before = (await cli(['update', '--check', '--json'])).json as Record<string, unknown>;
    expect(before.daemon).toBe('0.7.0');
    expect(before.cli).toBe(PKG_VERSION);
    expect(before.restarted).toBe(false);
    expect((before.skew as { direction: string }).direction).toBe('daemon-older');
    // Names the command for THIS install rather than running one: backlot does
    // not own what it did not install (decision 0018's rule, applied to itself).
    expect(String(before.upgradeHint)).toMatch(/git pull|npm install|pnpm add/);

    // Still the old daemon: --check is the diagnose half.
    const after = (await cli(['update', '--check', '--json'])).json as Record<string, unknown>;
    expect(after.daemon).toBe('0.7.0');
  });

  it('restarts the daemon onto the installed build, and is a no-op once there', async () => {
    const { cli } = ctx();
    await cli(['status', '--json'], { fakeVersion: '0.7.0' });
    const first = await cli(['update', '--json']);
    expect(first.code).toBe(0);
    const r = first.json as Record<string, unknown>;
    expect(r.restarted).toBe(true);
    expect(r.from).toBe('0.7.0');
    expect(r.to).toBe(PKG_VERSION);

    // The verb that was refused before now works — proof the skew is gone
    // rather than merely unreported. (work-error for a manifest-less worktree is
    // the correct answer here; what matters is that it is not infra-error 3.)
    const ctxRes = await cli(['ctx', '--json']);
    expect(ctxRes.code).not.toBe(3);

    // Idempotent: a second update must NOT restart. `backlot update` in a
    // script would otherwise be a recurring outage for every lease holder.
    const second = await cli(['update', '--json']);
    expect(second.code).toBe(0);
    const s = second.json as Record<string, unknown>;
    expect(s.restarted).toBe(false);
    expect(String(s.note)).toContain('already');
  });

  it('refuses to downgrade the daemon unless forced', async () => {
    const { cli } = ctx();
    // A current daemon, met by an OLDER CLI — the direction that strands state.
    await cli(['status', '--json']);
    const refused = await cli(['update', '--json'], { fakeVersion: '0.6.0' });
    expect(refused.code).toBe(1); // work-error: the caller asked for something refusable
    expect((refused.json as { error: { message: string } }).error.message).toMatch(/DOWNGRADE/);

    // --force is the override, exactly as it is for taking a leased env in
    // `pool recycle` — the same word for the same kind of decision.
    const forced = await cli(['update', '--force', '--json'], { fakeVersion: '0.6.0' });
    expect(forced.code).toBe(0);
    expect((forced.json as Record<string, unknown>).restarted).toBe(true);
  });

  it('keeps a live lease across the restart, and names who must rebind', async () => {
    const { cli, stateDir } = ctx({ service: true });
    // Lease created by a 0.7.0-claiming CLI against a 0.7.0-claiming daemon, so
    // the bind itself is not blocked by the skew gate.
    const up = await cli(['up', '--ttl', '10', '--json'], { fakeVersion: '0.7.0' });
    expect(up.code).toBe(0);
    const envId = String((up.json as { envId?: string }).envId ?? '');
    expect(envId).not.toBe('');

    const journal = new Journal(join(stateDir, 'journal.db'));
    expect(journal.leaseForEnv(envId)).toBeTruthy();

    // The plan names the holder BEFORE acting: a restart on a shared box makes
    // other people's environments rebind, and a caller is entitled to know.
    const plan = (await cli(['update', '--check', '--json'])).json as Record<string, unknown>;
    const holders = plan.holdersWhoMustRebind as Array<{ envId: string }>;
    expect(holders.map((h) => h.envId)).toContain(envId);

    const res = await cli(['update', '--json']);
    expect(res.code).toBe(0);
    expect((res.json as Record<string, unknown>).restarted).toBe(true);

    // THE contract: the lease survives. Services stop and the env drops to
    // warm; the holder's next verb rebinds. That is the same transition the
    // idle quiesce already performs on a leased environment.
    const after = new Journal(join(stateDir, 'journal.db'));
    expect(after.leaseForEnv(envId)).toBeTruthy();
    expect(after.getEnv(envId)?.state).toBe('warm');

    // And rebinding is all it takes to be usable again.
    const again = await cli(['up', '--json']);
    expect(again.code).toBe(0);
    expect(String((again.json as { envId?: string }).envId)).toBe(envId);
  });
});

describe('the MCP adapter refuses skew too', () => {
  /** Drive the adapter over stdio against a state root we control. */
  function talk(stateDir: string, messages: unknown[], deadlineMs = 30_000): Promise<Record<string, unknown>[]> {
    const MCP = join(repo, 'dist', 'mcp', 'index.js');
    const wanted = new Set(messages.map((m) => (m as { id?: number }).id).filter((id) => id !== undefined));
    return new Promise((resolve) => {
      const env = { ...process.env, BACKLOT_STATE_DIR: stateDir };
      delete env.BACKLOT_FAKE_VERSION; // the ADAPTER is this build; only the daemon is faked
      const p = spawn(process.execPath, [MCP], { stdio: ['pipe', 'pipe', 'ignore'], env });
      const responses: Record<string, unknown>[] = [];
      const finish = () => {
        clearTimeout(backstop);
        p.kill('SIGKILL');
        resolve(responses);
      };
      const backstop = setTimeout(finish, deadlineMs);
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += String(d);
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.trim()) responses.push(JSON.parse(line) as Record<string, unknown>);
        }
        if ([...wanted].every((id) => responses.some((r) => r.id === id))) finish();
      });
      for (const m of messages) p.stdin.write(JSON.stringify(m) + '\n');
    });
  }

  it('errors on a tool call under skew, and still answers doctor', async () => {
    // This is the surface that matters most: the caller is an agent, it never
    // sees stderr, and the CLI's gate lives in the CLI's own main() — so relying
    // on that would leave every MCP client unprotected.
    const { cli, stateDir } = ctx();
    await cli(['status', '--json'], { fakeVersion: '0.7.0' });

    const out = await talk(stateDir, [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'backlot_status', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'backlot_doctor', arguments: {} } },
    ]);

    const status = out.find((m) => m.id === 1)?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(status.isError).toBe(true);
    const err = JSON.parse(status.content[0]!.text) as { error: { class: string; message: string } };
    expect(err.error.class).toBe('infra-error');
    expect(err.error.message).toMatch(/0\.7\.0/);

    // doctor is exempt — it is how you diagnose this — and reports the skew.
    const doc = out.find((m) => m.id === 2)?.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(doc.isError).toBeFalsy();
    const issues = (JSON.parse(doc.content[0]!.text) as { issues: Array<{ issue: string }> }).issues;
    expect(issues.some((i) => /0\.7\.0/.test(i.issue))).toBe(true);
  }, 60_000);
});

describe('an in-flight operation is never interrupted', () => {
  it('refuses a restart while an environment is busy, and allows it with --force', () => {
    // Driven at the engine, because provoking a real mid-check restart through
    // the CLI would race the check's own duration. `busy` is the same set every
    // other reclaim path consults (claimForTeardown, both sweeper branches,
    // pool gc, and shutdown's reap since 0.8.0).
    const dir = mkdtempSync(join(tmpdir(), 'backlot-busy-'));
    mkdirSync(dir, { recursive: true });
    const prev = process.env.BACKLOT_STATE_DIR;
    process.env.BACKLOT_STATE_DIR = dir;
    try {
      const engine = new Engine();
      expect(() => engine.assertRestartable({ force: false })).not.toThrow();

      engine.busy.add('upd-1');
      // A `run` is spawned detached so the CHECK survives the daemon, but the
      // caller is blocked on this socket waiting for a verdict: restarting hands
      // it a dead connection and no result.
      expect(() => engine.assertRestartable({ force: false })).toThrow(/in flight/);
      expect(() => engine.assertRestartable({ force: true })).not.toThrow();
      expect(engine.updatePlan(PKG_VERSION).busy).toEqual(['upd-1']);
    } finally {
      if (prev === undefined) delete process.env.BACKLOT_STATE_DIR;
      else process.env.BACKLOT_STATE_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('journal schema stamping', () => {
  it('stamps the schema it wrote', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backlot-schema-'));
    try {
      const path = join(dir, 'journal.db');
      new Journal(path);
      const db = new DatabaseSync(path);
      try {
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
          JOURNAL_SCHEMA_VERSION,
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a journal written by a newer backlot, without touching it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backlot-schema-future-'));
    try {
      const path = join(dir, 'journal.db');
      new Journal(path);
      const db = new DatabaseSync(path);
      db.exec(`PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION + 5}`);
      db.close();
      // Refusing beats reading a default where the newer build stored meaning
      // and then writing that misreading back as truth — disk is truth
      // (decision 0009), so the truth must say what wrote it. The sha256 env-id
      // migration stranded rows for exactly this reason.
      expect(() => new Journal(path)).toThrow(/newer backlot/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('adopts a pre-stamp journal rather than refusing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'backlot-schema-old-'));
    try {
      const path = join(dir, 'journal.db');
      new Journal(path);
      const db = new DatabaseSync(path);
      db.exec('PRAGMA user_version = 0'); // as every journal written before 0.9.0 is
      db.close();
      expect(() => new Journal(path)).not.toThrow();
      const check = new DatabaseSync(path);
      try {
        expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
          JOURNAL_SCHEMA_VERSION,
        );
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

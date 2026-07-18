/**
 * Appliances: singular, machine-shared backing services (a Postgres server, a
 * Redis, a MinIO) that environments point at but never own.
 *
 * The contract is ENSURE, NOT OWN (decision 0018). An appliance's identity is
 * its probe address: whoever answers `host:port` IS the appliance, no matter
 * who started it — a compose file yesterday, a teammate's shell, or backlot a
 * minute ago. backlot never supervises the process (the `start:` command is
 * expected to daemonize, e.g. `docker run -d`), never stops one automatically,
 * and blames nobody's code when one is missing: every failure here is an
 * infra-error by construction.
 */
import { runBounded, DEFAULT_CMD_TIMEOUT_S } from '../core/exec.js';
import { connect } from 'node:net';
import { mkdirSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stateRoot } from '../core/paths.js';
import { BrokerError, now, sha256 } from '../core/util.js';
import type { ApplianceSpec } from '../core/manifest.js';

const PROBE_TIMEOUT_MS = 3000;
const START_POLL_MS = 500;
/** A start lock older than this is a crashed starter, not a live one. */
/**
 * A start lock is stale once nobody could still be legitimately holding it.
 * A fixed 5 minutes was WRONG for an appliance declaring a longer timeout: a
 * second caller stole the lock mid-start and raced the first one's container.
 */
const LOCK_STALE_MS = 5 * 60 * 1000;
const lockStaleMs = (timeoutS?: number): number => Math.max(LOCK_STALE_MS, (timeoutS ?? 0) * 1000 + 60_000);

export function probeTcp(target: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const [host, portStr] = target.split(':');
  const port = Number(portStr);
  return new Promise((resolve) => {
    const sock = connect({ host: host || 'localhost', port, timeout: timeoutMs });
    sock.once('connect', () => {
      sock.end();
      resolve(true);
    });
    const fail = () => {
      sock.destroy();
      resolve(false);
    };
    sock.once('error', fail);
    sock.once('timeout', fail);
  });
}

/**
 * Appliance commands are the likeliest to hang: `start: docker run ...` without
 * `-d` never returns, and an unbounded wait there wedges the bind AND leaves
 * the environment permanently busy (so its lease never expires and teardown
 * refuses it). Bounded, in its own process group.
 */
const sh = async (cmd: string, cwd: string): Promise<{ code: number; output: string }> => {
  const r = await runBounded(cmd, cwd);
  return {
    code: r.code,
    output: r.timedOut ? `${r.output}\n[killed: exceeded ${DEFAULT_CMD_TIMEOUT_S}s]` : r.output,
  };
};

/**
 * One start attempt per probe target machine-wide, whatever stack asked.
 * Two stacks declaring "the postgres on 5433" race to the same lock, and the
 * loser adopts what the winner started.
 */
function lockDir(target: string): string {
  const dir = join(stateRoot(), 'appliances');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${target.replace(/[^A-Za-z0-9._-]/g, '_')}-${sha256(target).slice(0, 8)}.lock`);
}

function acquireLock(target: string, timeoutS?: number): boolean {
  const lock = lockDir(target);
  try {
    mkdirSync(lock);
    return true;
  } catch {
    try {
      if (now() - statSync(lock).mtimeMs > lockStaleMs(timeoutS)) {
        rmdirSync(lock);
        mkdirSync(lock);
        return true;
      }
    } catch {
      /* raced — treat as not acquired */
    }
    return false;
  }
}

function releaseLock(target: string): void {
  try {
    rmdirSync(lockDir(target));
  } catch {
    /* already gone */
  }
}

async function awaitUp(name: string, spec: ApplianceSpec, root: string, deadline: number): Promise<boolean> {
  while (now() < deadline) {
    if (await probeTcp(spec.probe)) {
      if (!spec.ready) return true;
      const r = await sh(spec.ready, root);
      if (r.code === 0) return true;
    }
    await new Promise((r) => setTimeout(r, START_POLL_MS));
  }
  return false;
}

export type ApplianceResult = 'up' | 'started' | 'adopted';

/**
 * Probe; if down and a `start:` is declared, start it (once, machine-wide) and
 * wait for the probe (and optional `ready:` gate) to accept. Throws infra-error
 * when the appliance stays unreachable — with the start output when we tried.
 */
export async function ensureAppliance(
  name: string,
  spec: ApplianceSpec,
  root: string,
  say: (msg: string) => void,
): Promise<ApplianceResult> {
  const timeoutMsEarly = (spec.timeout ?? 60) * 1000;
  if (await probeTcp(spec.probe)) {
    // An open TCP port is NOT readiness. Postgres accepts connections while
    // still recovering; a container forwards the port before the server is
    // listening. Returning 'up' here skipped the declared ready: gate entirely,
    // so the bind proceeded against a half-started appliance and the failure
    // surfaced later as an unrelated work-error.
    if (!spec.ready) return 'up';
    const first = await sh(spec.ready, root);
    if (first.code === 0) return 'up';
    say(`appliance '${name}' answers at ${spec.probe} but is not ready yet — waiting`);
    if (await awaitUp(name, spec, root, now() + timeoutMsEarly)) return 'adopted';
    throw new BrokerError(
      'infra-error',
      `appliance '${name}' answers at ${spec.probe} but its ready: gate never passed within ${spec.timeout ?? 60}s`,
      'appliance',
      first.output.slice(0, 800),
    );
  }
  if (!spec.start) {
    throw new BrokerError(
      'infra-error',
      `appliance '${name}' unreachable at ${spec.probe} and declares no start: — bring it up yourself`,
      'appliance',
    );
  }
  const timeoutMs = (spec.timeout ?? 60) * 1000;
  const deadline = now() + timeoutMs;
  if (!acquireLock(spec.probe, spec.timeout)) {
    // Someone else is starting it right now; wait for their result.
    say(`appliance '${name}' is being started by another consumer — waiting`);
    if (await awaitUp(name, spec, root, deadline)) return 'adopted';
    throw new BrokerError(
      'infra-error',
      `appliance '${name}' still unreachable at ${spec.probe} after waiting ${spec.timeout ?? 60}s for a concurrent start`,
      'appliance',
    );
  }
  try {
    // Locked. Re-probe: it may have come up between our probe and the lock.
    // Same rule as above — the ready: gate decides, not the open port.
    if (await probeTcp(spec.probe) && (await awaitUp(name, spec, root, now() + 1000))) return 'up';
    say(`starting appliance '${name}'`);
    const r = await sh(spec.start, root);
    if (r.code !== 0) {
      throw new BrokerError(
        'infra-error',
        `appliance '${name}' start command failed`,
        'appliance',
        r.output.slice(0, 800),
      );
    }
    if (!(await awaitUp(name, spec, root, deadline))) {
      throw new BrokerError(
        'infra-error',
        `appliance '${name}' started but never answered at ${spec.probe} within ${spec.timeout ?? 60}s`,
        'appliance',
        r.output.slice(0, 800),
      );
    }
    return 'started';
  } finally {
    releaseLock(spec.probe);
  }
}

/** Explicit stop verb only — backlot never stops an appliance on its own. */
export async function stopAppliance(name: string, spec: ApplianceSpec, root: string): Promise<void> {
  if (!spec.stop) {
    throw new BrokerError('work-error', `appliance '${name}' declares no stop: command`, 'appliance');
  }
  const r = await sh(spec.stop, root);
  if (r.code !== 0) {
    throw new BrokerError('infra-error', `appliance '${name}' stop command failed`, 'appliance', r.output.slice(0, 800));
  }
}

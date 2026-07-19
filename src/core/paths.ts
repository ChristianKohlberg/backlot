import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, chmodSync } from 'node:fs';

/**
 * Per-machine state root (decision 0009). BACKLOT_STATE_DIR overrides — the
 * isolation knob every integration test uses.
 *
 * Created 0700 and chmod-enforced every call: the daemon socket lives here and
 * has NO application-level auth (README "Security model" — filesystem
 * permissions ARE the auth), so no other local user may traverse in. We chmod
 * even when the dir already exists, to repair a too-open pre-existing dir
 * (e.g. one made before this hardening, or via a loose umask).
 */
export function stateRoot(): string {
  const root =
    process.env.BACKLOT_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'backlot');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    chmodSync(root, 0o700);
  } catch {
    /* not the owner — leave it; the socket chmod below is the real gate */
  }
  return root;
}

/**
 * AF_UNIX `sun_path` is 104 bytes on macOS and 108 on Linux (including the
 * NUL); we enforce the tighter leg. Over the limit the OS does NOT error — it
 * silently truncates (verified on macOS), and because client and daemon
 * truncate identically everything appears to work while actually binding a
 * socket that collides with any other state dir sharing the 103-byte prefix.
 */
const SUN_PATH_MAX = 103;

export const socketPath = (): string => {
  const sock = join(stateRoot(), 'daemon.sock');
  const bytes = Buffer.byteLength(sock);
  if (bytes > SUN_PATH_MAX) {
    // "socket" in the message keeps classifyClientError reading this as
    // infra-error — a bad state dir is never fixed by recycling an environment.
    throw new Error(
      `unix socket path '${sock}' is ${bytes} bytes — over the ${SUN_PATH_MAX}-byte AF_UNIX sun_path limit ` +
        `(104 on macOS incl. NUL), where the OS silently truncates and state dirs collide. ` +
        `Point BACKLOT_STATE_DIR at a shorter path.`,
    );
  }
  return sock;
};
export const pidPath = (): string => join(stateRoot(), 'daemon.pid');
/**
 * The singleton-election lock. Separate from daemon.pid, which stays a bare
 * number for anything that reads it; this one carries the identity needed to
 * tell a live holder from a crashed one.
 */
export const lockPath = (): string => join(stateRoot(), 'daemon.lock');
export const journalPath = (): string => join(stateRoot(), 'journal.db');
export const envsRoot = (): string => join(stateRoot(), 'envs');
export const templatesRoot = (): string => join(stateRoot(), 'templates');
export const artifactsRoot = (): string => join(stateRoot(), 'artifacts');

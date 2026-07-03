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

export const socketPath = (): string => join(stateRoot(), 'daemon.sock');
export const pidPath = (): string => join(stateRoot(), 'daemon.pid');
export const journalPath = (): string => join(stateRoot(), 'journal.db');
export const envsRoot = (): string => join(stateRoot(), 'envs');
export const templatesRoot = (): string => join(stateRoot(), 'templates');
export const artifactsRoot = (): string => join(stateRoot(), 'artifacts');

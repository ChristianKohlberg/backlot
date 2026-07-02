import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/**
 * Per-machine state root (decision 0009). INFRONT_STATE_DIR overrides — the
 * isolation knob every integration test uses.
 */
export function stateRoot(): string {
  const root =
    process.env.INFRONT_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'infront');
  mkdirSync(root, { recursive: true });
  return root;
}

export const socketPath = (): string => join(stateRoot(), 'daemon.sock');
export const pidPath = (): string => join(stateRoot(), 'daemon.pid');
export const journalPath = (): string => join(stateRoot(), 'journal.db');
export const envsRoot = (): string => join(stateRoot(), 'envs');
export const templatesRoot = (): string => join(stateRoot(), 'templates');
export const artifactsRoot = (): string => join(stateRoot(), 'artifacts');

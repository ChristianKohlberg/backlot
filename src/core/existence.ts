import { statSync } from 'node:fs';

/** A failed read is not proof of deletion (permissions, I/O errors, offline storage). */
export function confirmedMissing(path: string, stat: typeof statSync = statSync): boolean {
  try {
    stat(path);
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

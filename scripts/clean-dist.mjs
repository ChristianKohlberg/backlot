import { rmSync } from 'node:fs';
import { URL } from 'node:url';

// TypeScript does not remove outputs for deleted source files.
rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });

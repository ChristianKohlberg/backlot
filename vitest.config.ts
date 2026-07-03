import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the repo's own suite — the examples' smoke.test.mjs files are CHECKS
    // (run by `backlot run smoke` / the integration tests), not vitest files.
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

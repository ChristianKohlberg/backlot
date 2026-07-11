import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the repo's own suite — the examples' smoke.test.mjs files are CHECKS
    // (run by `backlot run smoke` / the integration tests), not vitest files.
    include: ['tests/**/*.test.ts'],
    // Shared CI runners (macOS especially) are 3-4x slower than a dev
    // machine; the env-baking integration tests legitimately exceed 30s
    // there. Locally the tight timeout stays — it catches real hangs fast.
    testTimeout: process.env.CI ? 120_000 : 30_000,
    hookTimeout: process.env.CI ? 120_000 : 30_000,
  },
});

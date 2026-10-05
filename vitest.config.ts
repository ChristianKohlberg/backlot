import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the repo's own suite — the examples' smoke.test.mjs files are the
    // examples' own tests (run against `runly ctx --env`), not vitest files.
    include: ['tests/**/*.test.ts'],
    // One private TMPDIR for the run and a leak check at its end; no CLAUDE_PID
    // auto-tether inside tests (decisions 0035 and 0037).
    globalSetup: ['tests/support/global-setup.ts'],
    setupFiles: ['tests/support/setup-env.ts'],
    // Shared CI runners (macOS especially) are 3-4x slower than a dev
    // machine; the env-baking integration tests legitimately exceed 30s
    // there. Locally the tight timeout stays — it catches real hangs fast.
    testTimeout: process.env.CI ? 120_000 : 30_000,
    hookTimeout: process.env.CI ? 120_000 : 30_000,
  },
});

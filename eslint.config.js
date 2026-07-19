/**
 * Correctness rules only — no style war. The recommended presets stay because
 * they are what catches real defects (unused symbols, unsafe truthiness); the
 * one deliberate addition is banning non-null `!` in the two files where the
 * fleet review found `!` suppressing contract violations the type system had
 * correctly flagged (sync.ts, engine.ts — the getEnv(...)! cluster).
 */
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // `_`-prefixed parameters are this codebase's convention for "required by
      // the interface, deliberately unused" (e.g. SqliteDs.rebake(_cwd)).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/core/sync.ts', 'src/daemon/engine.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
);

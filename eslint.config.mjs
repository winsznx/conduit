import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Type-aware linting is mandatory: PRD 15.5 lists "static TypeScript analysis"
 * as a CI gate, and CLAUDE.md forbids `any`, error suppression, and swallowed
 * errors. Those rules are only enforceable with type information, so the
 * project service is enabled for every linted TypeScript file.
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      // Wrangler's local build cache; regenerated on every dev run.
      '**/.wrangler/**',
      '.tsbuild/**',
      'coverage/**',
      'out/**',
      'cache/**',
      'contracts/lib/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      // CLAUDE.md: no type-error suppression, ever.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': false,
          'ts-ignore': false,
          'ts-nocheck': false,
          'ts-check': false,
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',

      // CLAUDE.md: no swallowed errors.
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // CLAUDE.md: comments explain why, never what; dead code is deleted.
      'no-console': ['error', { allow: ['error'] }],
      'no-debugger': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
    },
  },

  // Repository scripts are plain ESM run by node before install completes, so
  // they are linted without type information and may write to stdout.
  {
    files: ['scripts/**/*.mjs', 'packages/*/scripts/**/*.mjs', 'eslint.config.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: {
      'no-console': 'off',
    },
  },

  // The repository-hygiene suite reads the filesystem and reports findings.
  {
    files: ['tests/**/*.ts', 'e2e/**/*.ts', 'apps/web/qa/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  prettier,
);

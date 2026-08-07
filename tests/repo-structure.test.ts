import { describe, expect, it } from 'vitest';

import { exists, isDirectory, readText } from './helpers/repo.js';

/**
 * PRD 11.1 fixes the monorepo layout, and CLAUDE.md ranks the PRD above code.
 * A directory quietly moving or disappearing would change where later phases
 * write protocol code, so the layout is asserted rather than assumed.
 */
describe('monorepo layout (PRD 11.1)', () => {
  const REQUIRED_DIRECTORIES = [
    'apps/web',
    'apps/api',
    'apps/worker',
    'apps/indexer',
    'contracts/src',
    'contracts/test',
    'contracts/script',
    'contracts/deployments',
    'packages/domain',
    'packages/sdk',
    'packages/cleanverse',
    'packages/wormhole',
    'packages/verifier',
    'packages/db',
    'packages/config',
    'packages/observability',
    'packages/ui',
    'docs/adr',
    'docs/threat-model',
    'docs/runbooks',
    'docs/evidence',
    'infra/docker',
    'infra/terraform',
    'scripts',
  ];

  it.each(REQUIRED_DIRECTORIES)('%s exists', (dir) => {
    expect(isDirectory(dir), `PRD 11.1 requires ${dir}`).toBe(true);
  });

  const REQUIRED_ROOT_FILES = [
    'CLAUDE.md',
    'CLAUDE_ONESHOT_CONDUIT.md',
    'CONDUIT_PRD_v1.0.md',
    'CONDUIT_PRD_v1.1_OVERRIDE.md',
    'docs/implementation-status.md',
    'docs/assumptions.md',
    'toolchain.json',
    'foundry.toml',
    'remappings.txt',
    'foundry.lock',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'eslint.config.mjs',
    '.prettierrc.json',
    'vitest.config.ts',
    'playwright.config.ts',
    'slither.config.json',
    '.node-version',
    '.npmrc',
    '.env.example',
  ];

  it.each(REQUIRED_ROOT_FILES)('%s exists', (file) => {
    expect(exists(file), `${file} is required by the phase 00 deliverable list`).toBe(true);
  });

  it('keeps every ranked source of truth at the repository root', () => {
    expect(readText('CONDUIT_PRD_v1.0.md')).toContain('# Conduit Product Requirements Document');
    expect(readText('CONDUIT_PRD_v1.1_OVERRIDE.md')).toContain('**Status:** REQUIRED OVERRIDE');
    expect(readText('CLAUDE.md')).toContain('## Source-of-truth order');
  });

  // A formatter rewriting a document that outranks this repository's code is a
  // silent mutation of a higher source. It happened once during phase 00, before
  // the override files were known to exist; ADR-0004 records it.
  it.each([
    'CONDUIT_PRD_v1.0.md',
    'CONDUIT_PRD_v1.1_OVERRIDE.md',
    'CLAUDE.md',
    'CLAUDE_ONESHOT_CONDUIT.md',
    'design.md',
  ])('excludes %s from formatters', (document) => {
    expect(readText('.prettierignore')).toContain(document);
  });

  it('never commits an environment file that could carry a real secret', () => {
    const gitignore = readText('.gitignore');
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('!.env.example');
  });

  // ADR-0003: a step that skips when its tool is unavailable produces the same
  // green output as a step that ran and found nothing.
  it('offers the gate no way to skip a step', () => {
    const gate = readText('scripts/verify.mjs');
    expect(gate).not.toMatch(/\bSKIP\b/);
    expect(gate).toContain('mountUnreadable');
  });

  // The template drifted once already: `conduit doctor` read two RPC variables
  // that .env.example never mentioned, so the only way to discover them was to
  // run the doctor and read the failure.
  it('documents every environment variable that packages/config reads', () => {
    const schemaKeys = [
      ...readText('packages/config/src/env.ts').matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm),
    ]
      .map((match) => match[1] ?? '')
      .filter((name) => name.length > 0);

    expect(schemaKeys.length).toBeGreaterThan(0);

    const documented = new Set(
      [...readText('.env.example').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
    );

    for (const key of schemaKeys) {
      expect(documented.has(key), `.env.example is missing ${key}`).toBe(true);
    }
  });

  it('documents every environment variable by name only, with no values', () => {
    const example = readText('.env.example');
    const assignments = example
      .split('\n')
      .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'));

    expect(assignments.length).toBeGreaterThan(0);
    for (const line of assignments) {
      const value = line.slice(line.indexOf('=') + 1).trim();
      expect(value, `.env.example must not carry a value: ${line}`).toBe('');
    }
  });
});

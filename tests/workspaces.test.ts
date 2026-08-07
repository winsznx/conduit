import { describe, expect, it } from 'vitest';

import { exists, readJson, readPackageJson, readText, workspaceDirs } from './helpers/repo.js';

/**
 * Phase 00 ships thirteen empty workspaces. Their only job right now is to be
 * correctly wired, so this suite proves exactly that: consistent naming, strict
 * TypeScript inherited from one base, and a package that actually resolves and
 * loads by its published name after `tsc --build`.
 *
 * That last check is why these tests run after typecheck in scripts/verify.mjs.
 */
const dirs = workspaceDirs();

interface WorkspaceModule {
  PACKAGE_ID?: unknown;
  IMPLEMENTATION_PHASE?: unknown;
}

describe('workspace wiring', () => {
  it('pnpm-workspace.yaml covers both workspace groups', () => {
    const workspace = readText('pnpm-workspace.yaml');
    expect(workspace).toContain('apps/*');
    expect(workspace).toContain('packages/*');
  });

  it('declares every workspace defined by PRD 11.1', () => {
    expect(dirs).toEqual([
      'apps/api',
      'apps/indexer',
      'apps/web',
      'apps/worker',
      'packages/cleanverse',
      'packages/config',
      'packages/db',
      'packages/domain',
      'packages/observability',
      'packages/sdk',
      'packages/ui',
      'packages/verifier',
      'packages/wormhole',
    ]);
  });

  it.each(dirs)('%s follows the workspace package conventions', (dir) => {
    const pkg = readPackageJson(`${dir}/package.json`);

    expect(pkg.name).toMatch(/^@conduit-protocol\//);
    expect(pkg.private, `${dir} must stay private until its publish phase`).toBe(true);
    expect(pkg.type, `${dir} must be ESM`).toBe('module');
    expect(pkg.description?.length ?? 0).toBeGreaterThan(0);
    expect(pkg.exports?.['.']).toBeDefined();
    expect(exists(`${dir}/src/index.ts`)).toBe(true);
    expect(exists(`${dir}/README.md`)).toBe(true);
  });

  it.each(dirs)('%s inherits the single strict TypeScript base', (dir) => {
    const tsconfig = readJson(`${dir}/tsconfig.json`) as {
      extends?: string;
      compilerOptions?: Record<string, unknown>;
    };

    expect(tsconfig.extends).toBe('../../tsconfig.base.json');
    expect(tsconfig.compilerOptions?.['rootDir']).toBe('src');
    expect(tsconfig.compilerOptions?.['outDir']).toBe('dist');
  });

  it('the root solution references every workspace so one typecheck covers all', () => {
    const solution = readJson('tsconfig.json') as { references: { path: string }[] };
    const referenced = solution.references.map((r) => r.path.replace(/^\.\//, ''));

    for (const dir of dirs) {
      expect(referenced, `tsconfig.json must reference ${dir}`).toContain(dir);
    }
    expect(referenced).toContain('tsconfig.tests.json');
  });
});

describe('workspace resolution', () => {
  const built = dirs.every((dir) => exists(`${dir}/dist/index.js`));

  it('is built before this suite runs', () => {
    expect(
      built,
      'workspaces are not built — run `pnpm typecheck` (scripts/verify.mjs does this first)',
    ).toBe(true);
  });

  it.each(dirs)('%s resolves and loads by its published name', async (dir) => {
    const pkg = readPackageJson(`${dir}/package.json`);
    const loaded = (await import(pkg.name)) as WorkspaceModule;

    expect(loaded.PACKAGE_ID, `${pkg.name} must export its own identity`).toBe(pkg.name);
    expect(loaded.IMPLEMENTATION_PHASE).toMatch(/^\d{2}$/);
  });
});

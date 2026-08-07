import { describe, expect, it } from 'vitest';

import { exists, readPackageJson, rootPackageJson, workspaceDirs } from './helpers/repo.js';

/**
 * PRD 11.1: "All versions are exact-pinned in the lockfile and toolchain
 * manifest. No floating Solidity compiler, npm dependency, Docker tag, GitHub
 * Action, or Terraform provider."
 *
 * A caret is the easiest way for that guarantee to erode, so it is a test
 * rather than a review convention.
 */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const WORKSPACE_PROTOCOL = 'workspace:*';

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

const manifests = ['package.json', ...workspaceDirs().map((dir) => `${dir}/package.json`)];

describe('npm dependency pins', () => {
  it.each(manifests)('%s pins every dependency exactly', (manifestPath) => {
    const pkg = readPackageJson(manifestPath);

    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (range === WORKSPACE_PROTOCOL) continue;
        expect(
          EXACT_SEMVER.test(range),
          `${manifestPath} → ${field}.${name} = "${range}" is not an exact version`,
        ).toBe(true);
      }
    }
  });

  it('commits the pnpm lockfile so a fresh clone resolves identical trees', () => {
    expect(exists('pnpm-lock.yaml')).toBe(true);
  });

  it('links internal packages through the workspace protocol, never a registry range', () => {
    const root = rootPackageJson();
    const internal = Object.entries(root.devDependencies ?? {}).filter(([name]) =>
      name.startsWith('@conduit-protocol/'),
    );

    expect(internal.length).toBe(workspaceDirs().length);
    for (const [name, range] of internal) {
      expect(range, `${name} must use ${WORKSPACE_PROTOCOL}`).toBe(WORKSPACE_PROTOCOL);
    }
  });
});

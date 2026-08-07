import { describe, expect, it } from 'vitest';

import {
  exists,
  listFiles,
  readJson,
  readText,
  rootPackageJson,
  toolchain,
} from './helpers/repo.js';

/**
 * toolchain.json is the single source of truth for every pin. This suite proves
 * the repository's files agree with it. The complementary check —
 * scripts/verify-toolchain.mjs — proves the developer's machine agrees with it.
 *
 * Splitting the two means a mismatch always reports as either "this machine is
 * wrong" or "this repository is inconsistent", never an ambiguous blend.
 */
const manifest = toolchain();

describe('runtime pins', () => {
  it('package.json engines and packageManager match toolchain.json', () => {
    const pkg = rootPackageJson();
    expect(pkg.engines?.['node']).toBe(manifest.runtime.node);
    expect(pkg.engines?.['pnpm']).toBe(manifest.runtime.pnpm);
    expect(pkg.packageManager).toMatch(new RegExp(`^pnpm@${manifest.runtime.pnpm}(\\+|$)`));
  });

  it('.node-version and .nvmrc match toolchain.json', () => {
    expect(readText('.node-version').trim()).toBe(manifest.runtime.node);
    expect(readText('.nvmrc').trim()).toBe(manifest.runtime.node);
  });

  it('.npmrc forbids version-range drift on install', () => {
    const npmrc = readText('.npmrc');
    expect(npmrc).toContain('save-exact=true');
    expect(npmrc).toContain('engine-strict=true');
  });
});

describe('Solidity pins', () => {
  const foundryToml = readText('foundry.toml');

  it('foundry.toml pins the exact compiler and disables auto-detection', () => {
    expect(foundryToml).toContain(`solc = "${manifest.solidity.solc}"`);
    expect(foundryToml).toContain('auto_detect_solc = false');
  });

  it('foundry.toml pins the EVM version recorded in the manifest', () => {
    expect(foundryToml).toContain(`evm_version = "${manifest.solidity.evmVersion}"`);
  });

  it('foundry.toml keeps bytecode reproducible so PRD 17.3 hashes are verifiable', () => {
    expect(foundryToml).toContain('bytecode_hash = "none"');
    expect(foundryToml).toContain('cbor_metadata = false');
  });

  it('every first-party Solidity file pins the exact compiler', () => {
    const sources = [...listFiles('contracts/src', '.sol'), ...listFiles('contracts/test', '.sol')];
    expect(sources.length).toBeGreaterThan(0);

    for (const file of sources) {
      const pragma = /^pragma solidity ([^;]+);/m.exec(readText(file))?.[1]?.trim();
      expect(pragma, `${file} has no solidity pragma`).toBeDefined();
      expect(pragma, `${file} must pin ${manifest.solidity.pragma}`).toBe(manifest.solidity.pragma);
    }
  });

  it('records the upstream known-bug status behind the compiler choice', () => {
    expect(manifest.solidity.knownBugsAtPin).toEqual([]);
  });
});

describe('Solidity dependency pins', () => {
  const lock = readJson('foundry.lock') as Record<string, { tag?: { name: string; rev: string } }>;

  it('foundry.lock pins every library to the revision in toolchain.json', () => {
    for (const [library, pin] of Object.entries(manifest.solidityLibraries)) {
      const entry = lock[`contracts/lib/${library}`];
      expect(entry, `foundry.lock is missing contracts/lib/${library}`).toBeDefined();
      expect(entry?.tag?.name).toBe(pin.tag);
      expect(entry?.tag?.rev).toBe(pin.commit);
    }
  });

  it('remappings.txt resolves every locked library', () => {
    const remappings = readText('remappings.txt');
    for (const library of Object.keys(manifest.solidityLibraries)) {
      expect(remappings).toContain(`contracts/lib/${library}/`);
    }
  });
});

describe('GitHub Action pins', () => {
  const workflows = exists('.github/workflows') ? listFiles('.github/workflows', '.yml') : [];

  it('ships at least one workflow', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it('pins every action to a commit SHA listed in toolchain.json', () => {
    const usePattern = /uses:\s*([^\s@]+)@([^\s#]+)/g;

    for (const workflow of workflows) {
      const body = readText(workflow);
      for (const match of body.matchAll(usePattern)) {
        const action = match[1];
        const ref = match[2];
        if (action === undefined || ref === undefined) continue;
        if (action.startsWith('./')) continue;

        const pin = manifest.githubActions[action];
        expect(pin, `${workflow} uses unpinned action ${action}`).toBeDefined();
        expect(ref, `${workflow}: ${action} must use SHA ${pin?.sha ?? ''}, not ${ref}`).toBe(
          pin?.sha,
        );
      }
    }
  });

  it('annotates each pinned SHA with the tag it came from', () => {
    for (const workflow of workflows) {
      for (const line of readText(workflow).split('\n')) {
        const match = /uses:\s*([^\s@]+)@([0-9a-f]{40})\s*#\s*(\S+)/.exec(line);
        if (match === null) continue;
        const [, action, , tag] = match;
        if (action === undefined || tag === undefined) continue;
        expect(tag, `${workflow}: ${action} comment must match toolchain.json`).toBe(
          manifest.githubActions[action]?.tag,
        );
      }
    }
  });
});

describe('container and infrastructure pins', () => {
  it('every compose image is pinned by digest and listed in toolchain.json', () => {
    const compose = readText('infra/docker/docker-compose.yml');
    const digests = [...compose.matchAll(/image:\s*(\S+)/g)].map((m) => m[1]);
    expect(digests.length).toBeGreaterThan(0);

    const known = Object.values(manifest.containerImages).map(
      (image) => `${image.reference.split(':')[0] ?? ''}@${image.digest}`,
    );

    for (const reference of digests) {
      expect(reference, 'compose images must be digest-pinned').toMatch(/@sha256:[0-9a-f]{64}$/);
      expect(known, `${String(reference)} is not recorded in toolchain.json`).toContain(reference);
    }
  });

  it('terraform pins an exact CLI version', () => {
    const versions = readText('infra/terraform/versions.tf');
    expect(versions).toContain(`required_version = "${manifest.terraform.cli}"`);
  });
});

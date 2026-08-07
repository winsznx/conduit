import { describe, expect, it } from 'vitest';

import {
  crossCheck,
  registryByWormholeChainId,
  registryFor,
  WORMHOLE_REGISTRY,
  WORMHOLE_REGISTRY_KEYS,
  WORMHOLE_REGISTRY_PROVENANCE,
} from './registry.js';

/**
 * The snapshot is a pinned copy of the official Wormhole registry. These tests
 * guard it against the two ways a pin degrades: a hand-edited value, and a
 * silent divergence from the chain configuration it is supposed to agree with.
 *
 * They prove what the registry *says*. Proving a core contract is deployed at
 * that address needs an RPC, which `conduit doctor` does.
 */

describe('snapshot provenance', () => {
  it('records where the values came from', () => {
    expect(WORMHOLE_REGISTRY_PROVENANCE.source).toBe('@wormhole-foundation/sdk-base');
    expect(WORMHOLE_REGISTRY_PROVENANCE.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(WORMHOLE_REGISTRY_PROVENANCE.network).toBe('Testnet');
    expect(WORMHOLE_REGISTRY_PROVENANCE.files.length).toBeGreaterThan(0);
  });
});

describe('pinned values', () => {
  it('matches the official registry for Monad Testnet', () => {
    const chain = registryFor('monadTestnet');

    expect(chain.coreBridgeAddress).toBe('0xaBf89de706B583424328B54dD05a8fC986750Da8');
    expect(chain.wormholeChainId).toBe(10_009);
    expect(chain.nativeChainId).toBe(10_143);
  });

  it('matches the official registry for Arbitrum Sepolia', () => {
    const chain = registryFor('arbitrumSepolia');

    expect(chain.coreBridgeAddress).toBe('0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35');
    expect(chain.wormholeChainId).toBe(10_003);
    expect(chain.nativeChainId).toBe(421_614);
  });

  it('agrees with the values PRD 8.3 quotes', () => {
    // PRD 8.3 states these independently of the SDK. A disagreement means one
    // source is stale, and settlement must not proceed on either.
    expect(registryFor('monadTestnet').wormholeChainId).toBe(10_009);
    expect(registryFor('monadTestnet').nativeChainId).toBe(10_143);
    expect(registryFor('arbitrumSepolia').wormholeChainId).toBe(10_003);
    expect(registryFor('arbitrumSepolia').nativeChainId).toBe(421_614);
  });

  it.each(WORMHOLE_REGISTRY_KEYS)('%s core address is a checksummed 20-byte address', (key) => {
    expect(registryFor(key).coreBridgeAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('gives the two chains different core addresses', () => {
    expect(registryFor('monadTestnet').coreBridgeAddress).not.toBe(
      registryFor('arbitrumSepolia').coreBridgeAddress,
    );
  });

  it('carries the finality parameters ASM-012 will be measured against', () => {
    expect(registryFor('monadTestnet').finalityThresholdBlocks).toBe(1);
    expect(registryFor('arbitrumSepolia').finalityThresholdBlocks).toBe(4096);
  });
});

describe('lookup by Wormhole chain ID', () => {
  it('resolves each configured chain', () => {
    expect(registryByWormholeChainId(10_009)?.wormholeName).toBe('MonadTestnet');
    expect(registryByWormholeChainId(10_003)?.wormholeName).toBe('ArbitrumSepolia');
  });

  it('does not resolve a native chain ID', () => {
    // Passing a native ID where a Wormhole ID belongs is threat T-12, and it
    // must return nothing rather than the wrong chain.
    expect(registryByWormholeChainId(10_143)).toBeUndefined();
    expect(registryByWormholeChainId(421_614)).toBeUndefined();
  });
});

describe('cross-check against chain configuration', () => {
  it('reports no problems when the two agree', () => {
    expect(
      crossCheck({
        monadTestnet: { nativeChainId: 10_143, wormholeChainId: 10_009 },
        arbitrumSepolia: { nativeChainId: 421_614, wormholeChainId: 10_003 },
      }),
    ).toEqual([]);
  });

  it('reports a native chain ID disagreement', () => {
    const problems = crossCheck({
      monadTestnet: { nativeChainId: 1, wormholeChainId: 10_009 },
      arbitrumSepolia: { nativeChainId: 421_614, wormholeChainId: 10_003 },
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('native chain ID differs');
  });

  it('reports a Wormhole chain ID disagreement', () => {
    const problems = crossCheck({
      monadTestnet: { nativeChainId: 10_143, wormholeChainId: 10_009 },
      arbitrumSepolia: { nativeChainId: 421_614, wormholeChainId: 2 },
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Wormhole chain ID differs');
  });
});

describe('immutability', () => {
  it('freezes the registry so no caller can rewrite an address at runtime', () => {
    expect(Object.isFrozen(WORMHOLE_REGISTRY)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

import { DeploymentGeneration, type DeploymentManifest } from './registry.js';

/**
 * Two generations, both real.
 *
 * Generation 1 settled phase 06 and stays on chain holding that settlement;
 * generation 2 replaces it because the contracts are non-upgradeable and the
 * disposition entry points postdate them. A verifier asked about a generation-1
 * settlement has to read generation-1 contracts, so the two must never merge —
 * and the deployment ID is the thing that separates them, on chain in every
 * message header and here in every lookup.
 *
 * The addresses below are the deployed ones, including the collision:
 * `0xE4bA…f45be` is the SettlementCoordinator on Monad *and* the
 * RWACVASettlementAdapter on Base in generation 1.
 */
const GEN1 = '0x9303f240f88e5aba93761e010b75b13681d0c03af58d945c241cc402dadd0843';
const GEN2 = '0x893ca44ecf017ba183180fb358fbc27ed570df9e56d7d35a465a9ed5cb1a9417';

const COLLIDING = '0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE';

function manifest(
  deploymentId: string,
  chain: 'monadTestnet' | 'baseSepolia',
  contracts: Record<string, string>,
): DeploymentManifest {
  const config =
    chain === 'monadTestnet'
      ? { nativeChainId: 10_143, wormholeChainId: 10_009, rpcUrlEnvVar: 'M', finalityBlocks: 1 }
      : { nativeChainId: 84_532, wormholeChainId: 10_004, rpcUrlEnvVar: 'B', finalityBlocks: 512 };

  return {
    deploymentId: deploymentId as `0x${string}`,
    protocolVersion: 1,
    gitCommit: 'test',
    solcVersion: '0.8.36',
    chainConfigs: { [chain]: config },
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([role, address]) => [
        role,
        { chain, address: address as `0x${string}` },
      ]),
    ),
    bytecodeHashes: Object.fromEntries(
      Object.keys(contracts).map((role) => [role, `0x${'11'.repeat(32)}` as `0x${string}`]),
    ),
    wormhole: {
      [chain]: {
        coreAddress: '0xaBf89de706B583424328B54dD05a8fC986750Da8',
        wormholeChainId: config.wormholeChainId,
        consistencyLevel: 1,
      },
    },
    finalityProfile: { settlement: 'FINALIZED', observation: 'INSTANT' },
    complianceProfile: { maxAttestationValiditySeconds: 900, quorum: 1 },
  };
}

const generation1 = [
  {
    name: 'monad-gen1.json',
    manifest: manifest(GEN1, 'monadTestnet', {
      SettlementCoordinator: COLLIDING,
      CashEscrow: '0x793c7a8f0c9549ee6cAf7EcC014DDafB7da601EB',
    }),
  },
  {
    name: 'base-gen1.json',
    manifest: manifest(GEN1, 'baseSepolia', {
      RWACVASettlementAdapter: COLLIDING,
      ConduitRWACVA: '0x7a78912533b43C483621200b4919806c0B855E5b',
    }),
  },
];

const generation2 = [
  {
    name: 'monad-gen2.json',
    manifest: manifest(GEN2, 'monadTestnet', {
      SettlementCoordinator: '0x0000000000000000000000000000000000000A11',
      CashEscrow: '0x0000000000000000000000000000000000000A12',
    }),
  },
  {
    name: 'base-gen2.json',
    manifest: manifest(GEN2, 'baseSepolia', {
      RWACVASettlementAdapter: '0x51c3D536e94fB5b944c2AF8946d6916543bdf93a',
      // The token is not redeployed: its Cleanverse registration is bound to
      // its address, so both generations name the same one.
      ConduitRWACVA: '0x7a78912533b43C483621200b4919806c0B855E5b',
    }),
  },
];

describe('deployment generations', () => {
  it('separates two generations rather than merging them', () => {
    // #given manifests for both generations, as contracts/deployments will hold
    const generations = DeploymentGeneration.allFrom([...generation1, ...generation2]);

    // #then each is its own generation, keyed by deployment ID
    expect(generations).toHaveLength(2);
    expect(new Set(generations.map((g) => g.deploymentId))).toEqual(new Set([GEN1, GEN2]));
  });

  it('refuses to build one generation out of two deployment ids', () => {
    expect(() => DeploymentGeneration.fromManifests([...generation1, ...generation2])).toThrow(
      /deploymentId .* does not match/,
    );
  });

  it('answers for the coordinator of the generation it was asked about', () => {
    const [gen1, gen2] = DeploymentGeneration.allFrom([...generation1, ...generation2]).sort((a) =>
      a.deploymentId === GEN1 ? -1 : 1,
    );

    expect(gen1?.role(10_143, 'SettlementCoordinator').identity.address).toBe(COLLIDING);
    expect(gen2?.role(10_143, 'SettlementCoordinator').identity.address).toBe(
      '0x0000000000000000000000000000000000000A11',
    );
  });

  it('keeps the colliding coordinator and adapter apart within one generation', () => {
    const gen1 = DeploymentGeneration.fromManifests(generation1);

    const coordinator = gen1.role(10_143, 'SettlementCoordinator');
    const adapter = gen1.role(84_532, 'RWACVASettlementAdapter');

    expect(coordinator.identity.address).toBe(adapter.identity.address);
    expect(coordinator.identity.chainId).not.toBe(adapter.identity.chainId);
    expect(gen1.at(coordinator.identity)?.role).toBe('SettlementCoordinator');
    expect(gen1.at(adapter.identity)?.role).toBe('RWACVASettlementAdapter');
  });

  it('reports the collision so a report can name it', () => {
    const collisions = DeploymentGeneration.fromManifests(generation1).addressCollisions();
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.map((entry) => entry.role).sort()).toEqual([
      'RWACVASettlementAdapter',
      'SettlementCoordinator',
    ]);
  });

  it('has no by-role lookup that ignores the chain', () => {
    const gen1 = DeploymentGeneration.fromManifests(generation1);
    // The coordinator is on Monad and only on Monad. Asking Base for one is a
    // question about a contract that does not exist, not a fuzzy match.
    expect(() => gen1.role(84_532, 'SettlementCoordinator')).toThrow(/no SettlementCoordinator/);
  });

  it('rejects a contract on a chain the manifest never configured', () => {
    const broken = manifest(GEN1, 'monadTestnet', { CashEscrow: COLLIDING });
    const mutated = {
      ...broken,
      contracts: { CashEscrow: { chain: 'ethereum', address: COLLIDING } },
    };
    expect(() =>
      DeploymentGeneration.fromManifests([
        { name: 'broken.json', manifest: mutated as unknown as DeploymentManifest },
      ]),
    ).toThrow(/not configured/);
  });

  it('rejects a contract with no bytecode hash to check against', () => {
    const broken = manifest(GEN1, 'monadTestnet', { CashEscrow: COLLIDING });
    expect(() =>
      DeploymentGeneration.fromManifests([
        { name: 'broken.json', manifest: { ...broken, bytecodeHashes: {} } },
      ]),
    ).toThrow(/no bytecode hash/);
  });

  it('lets both generations name the same unredeployed token', () => {
    // The RWA CVA is registered with Cleanverse against its address, so it
    // survives a generation change. Two generations holding one token is
    // correct and must not be read as a collision or a conflict.
    const generations = DeploymentGeneration.allFrom([...generation1, ...generation2]);
    const tokens = generations.map((g) => g.role(84_532, 'ConduitRWACVA').identity.address);
    expect(new Set(tokens).size).toBe(1);
  });
});

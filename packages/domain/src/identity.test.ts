import { describe, expect, it } from 'vitest';

import {
  addressToEmitter,
  contractKey,
  ContractRegistry,
  emitterKey,
  emitterToAddress,
  explorerAddressUrl,
  parseContractKey,
  sameContract,
  sameEmitter,
  type ChainScopedAddress,
} from './identity.js';

/**
 * The collision is real and it is deployed.
 *
 * These are not invented addresses. `0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE`
 * is the SettlementCoordinator on Monad Testnet *and* the
 * RWACVASettlementAdapter on Base Sepolia, because the deployer's nonce lined up
 * across two chains. Every test below uses that exact pair, so a change that
 * reintroduces address-only identity fails against the deployment rather than
 * against a hypothetical.
 */
const MONAD = 10_143;
const BASE = 84_532;
const MONAD_WH = 10_009;
const BASE_WH = 10_004;

const COLLIDING = '0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE';

const coordinator: ChainScopedAddress = { chainId: MONAD, address: COLLIDING };
const adapter: ChainScopedAddress = { chainId: BASE, address: COLLIDING };

describe('the deployed cross-chain address collision', () => {
  it('is genuinely the same twenty bytes', () => {
    // #given the two live deployments
    // #then their bare addresses are indistinguishable, which is the hazard
    expect(coordinator.address).toBe(adapter.address);
    expect(coordinator.address.toLowerCase()).toBe(adapter.address.toLowerCase());
  });

  it('produces different keys', () => {
    expect(contractKey(coordinator)).toBe(`eip155:10143:${COLLIDING.toLowerCase()}`);
    expect(contractKey(adapter)).toBe(`eip155:84532:${COLLIDING.toLowerCase()}`);
    expect(contractKey(coordinator)).not.toBe(contractKey(adapter));
  });

  it('is not the same contract', () => {
    expect(sameContract(coordinator, adapter)).toBe(false);
    expect(sameContract(coordinator, { ...coordinator })).toBe(true);
  });

  it('keys by case-insensitive address, so one contract is never two rows', () => {
    expect(contractKey({ chainId: MONAD, address: COLLIDING.toLowerCase() as `0x${string}` })).toBe(
      contractKey(coordinator),
    );
  });

  it('round-trips through its key', () => {
    expect(parseContractKey(contractKey(adapter))).toEqual({
      chainId: BASE,
      address: COLLIDING.toLowerCase(),
    });
  });
});

describe('a registry that will not answer without a chain', () => {
  it('holds both colliding contracts as distinct entries', () => {
    // #given a registry carrying the live deployment
    const registry = new ContractRegistry<string>()
      .add(coordinator, 'SettlementCoordinator')
      .add(adapter, 'RWACVASettlementAdapter');

    // #when each is looked up with its chain
    // #then each answers with itself and never with the other
    expect(registry.size()).toBe(2);
    expect(registry.get(coordinator)).toBe('SettlementCoordinator');
    expect(registry.get(adapter)).toBe('RWACVASettlementAdapter');
  });

  it('reports the collision rather than hiding it', () => {
    const registry = new ContractRegistry<string>()
      .add(coordinator, 'SettlementCoordinator')
      .add(adapter, 'RWACVASettlementAdapter')
      .add(
        { chainId: BASE, address: '0x7a78912533b43C483621200b4919806c0B855E5b' },
        'ConduitRWACVA',
      );

    const collisions = registry.collisions();
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toHaveLength(2);
    expect(new Set(collisions[0]?.map((entry) => entry.chainId))).toEqual(new Set([MONAD, BASE]));
  });

  it('refuses a duplicate registration of the same chain and address', () => {
    const registry = new ContractRegistry<string>().add(coordinator, 'SettlementCoordinator');
    expect(() => registry.add(coordinator, 'something else')).toThrow(/already registered/);
  });

  it('has no lookup that takes an address alone', () => {
    const registry = new ContractRegistry<string>().add(coordinator, 'SettlementCoordinator');
    // The type system is the real guard; this pins the runtime behaviour so a
    // loosened signature cannot quietly start accepting a bare address.
    expect(() => registry.get({ chainId: 0, address: COLLIDING })).toThrow(/not a chain ID/);
    expect(() =>
      registry.get({ chainId: MONAD, address: 'SettlementCoordinator' as `0x${string}` }),
    ).toThrow(/not an EVM address/);
  });
});

describe('Wormhole emitters are their own namespace', () => {
  const monadEmitter = { wormholeChainId: MONAD_WH, emitter: addressToEmitter(COLLIDING) };
  const baseEmitter = { wormholeChainId: BASE_WH, emitter: addressToEmitter(COLLIDING) };

  it('separates the same emitter bytes on two chains', () => {
    expect(monadEmitter.emitter).toBe(baseEmitter.emitter);
    expect(emitterKey(monadEmitter)).not.toBe(emitterKey(baseEmitter));
    expect(sameEmitter(monadEmitter, baseEmitter)).toBe(false);
  });

  it('does not collide with a contract key', () => {
    // A Wormhole chain ID is not an EVM chain ID: Monad Testnet is EVM 10143 and
    // Wormhole 10009. Sharing a key format would let one be read as the other.
    expect(emitterKey(monadEmitter)).not.toBe(contractKey(coordinator));
    expect(emitterKey(monadEmitter).startsWith('wormhole:')).toBe(true);
  });

  it('unpads to the address it wraps, and refuses anything that is not padding', () => {
    expect(emitterToAddress(addressToEmitter(COLLIDING)).toLowerCase()).toBe(
      COLLIDING.toLowerCase(),
    );
    expect(() => emitterToAddress(`0x${'11'.repeat(32)}`)).toThrow(/left-padded/);
  });

  it('will not convert a Wormhole chain into an EVM chain on its own', () => {
    // `emitterToAddress` returns a bare address deliberately. Producing a
    // ChainScopedAddress here would mean guessing the EVM chain from the
    // Wormhole one, and a wrong guess is exactly this collision.
    const unwrapped = emitterToAddress(monadEmitter.emitter);
    expect(typeof unwrapped).toBe('string');
    expect(unwrapped).not.toHaveProperty('chainId');
  });
});

describe('explorer links', () => {
  const explorers = {
    [MONAD]: 'https://testnet.monadexplorer.com',
    [BASE]: 'https://sepolia.basescan.org',
  };

  it('send a reader to the right chain', () => {
    expect(explorerAddressUrl(coordinator, explorers)).toBe(
      `https://testnet.monadexplorer.com/address/${COLLIDING}`,
    );
    expect(explorerAddressUrl(adapter, explorers)).toBe(
      `https://sepolia.basescan.org/address/${COLLIDING}`,
    );
    expect(explorerAddressUrl(coordinator, explorers)).not.toBe(
      explorerAddressUrl(adapter, explorers),
    );
  });

  it('refuse to guess a chain they were not given', () => {
    expect(() => explorerAddressUrl({ chainId: 1, address: COLLIDING }, explorers)).toThrow(
      /no explorer configured/,
    );
  });
});

import { ChainMismatchError } from './errors.js';

/**
 * Chain identity.
 *
 * Two numbering systems are in play and confusing them is threat T-12. The
 * native EVM chain ID is what `eth_chainId` returns and what EIP-712 binds. The
 * Wormhole chain ID is what a VAA header carries. They are unrelated integers
 * for the same network, so they never share a type here.
 *
 * The values below are quoted from PRD 8.3. They have not yet been checked
 * against a pinned official Wormhole registry snapshot in this repository, which
 * is ASM-016 and is closed in phase 02. Nothing consumes the Wormhole IDs before
 * then.
 */

export type ChainKey = 'monadTestnet' | 'arbitrumSepolia';

export interface ChainDefinition {
  readonly key: ChainKey;
  /** Wormhole's own registry name, used when reading a pinned snapshot. */
  readonly wormholeName: string;
  /** What `eth_chainId` returns. Bound into every EIP-712 domain. */
  readonly nativeChainId: number;
  /** What a VAA emitter header carries. Never interchangeable with the above. */
  readonly wormholeChainId: number;
  readonly rpcUrlEnvVar: string;
  readonly role: 'cash' | 'asset';
}

export const CHAINS: Readonly<Record<ChainKey, ChainDefinition>> = Object.freeze({
  monadTestnet: Object.freeze({
    key: 'monadTestnet',
    wormholeName: 'MonadTestnet',
    nativeChainId: 10_143,
    wormholeChainId: 10_009,
    rpcUrlEnvVar: 'MONAD_TESTNET_RPC_URL',
    role: 'cash',
  }),
  arbitrumSepolia: Object.freeze({
    key: 'arbitrumSepolia',
    wormholeName: 'ArbitrumSepolia',
    nativeChainId: 421_614,
    wormholeChainId: 10_003,
    rpcUrlEnvVar: 'ARBITRUM_SEPOLIA_RPC_URL',
    role: 'asset',
  }),
});

export const CHAIN_KEYS: readonly ChainKey[] = Object.freeze(Object.keys(CHAINS) as ChainKey[]);

export function chainByNativeId(nativeChainId: number): ChainDefinition | undefined {
  return CHAIN_KEYS.map((key) => CHAINS[key]).find((c) => c.nativeChainId === nativeChainId);
}

export function chainByWormholeId(wormholeChainId: number): ChainDefinition | undefined {
  return CHAIN_KEYS.map((key) => CHAINS[key]).find((c) => c.wormholeChainId === wormholeChainId);
}

/**
 * Minimal shape of an `eth_chainId` caller, so this module needs no RPC client
 * dependency and stays trivially testable.
 */
export type ChainIdReader = (rpcUrl: string) => Promise<number>;

/**
 * CLAUDE.md: "Chain IDs must be checked against RPC at startup."
 *
 * An RPC pointed at the wrong network is not a configuration inconvenience. It
 * is a settlement signed against one chain and submitted to another, so this
 * throws rather than warning.
 */
export async function assertChainId(
  chain: ChainDefinition,
  rpcUrl: string,
  read: ChainIdReader,
): Promise<void> {
  const actual = await read(rpcUrl);
  if (actual !== chain.nativeChainId) {
    throw new ChainMismatchError(chain.key, chain.nativeChainId, actual);
  }
}

export async function assertAllChainIds(
  rpcUrls: Readonly<Record<ChainKey, string>>,
  read: ChainIdReader,
): Promise<void> {
  for (const key of CHAIN_KEYS) {
    await assertChainId(CHAINS[key], rpcUrls[key], read);
  }
}

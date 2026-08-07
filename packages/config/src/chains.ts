import { ChainMismatchError } from './errors.js';

/**
 * Chain identity.
 *
 * Three numbering systems are in play and confusing any two of them is threat
 * T-12. The native EVM chain ID is what `eth_chainId` returns and what EIP-712
 * binds. The Wormhole chain ID is what a VAA header carries. The Cleanverse
 * chain string is what its API expects in a request body. They are unrelated
 * identifiers for the same network, so they never share a type here.
 *
 * The asset leg is Base Sepolia, not the Arbitrum Sepolia named in PRD 8.3.
 * Cleanverse CCP has no deployment on Arbitrum Sepolia: `accesscore`, `apass`,
 * and the A-Tokens all return empty bytecode there, while the same addresses
 * are live on Base Sepolia. A CVA cannot be issued or policy-gated on a chain
 * where the policy contract does not exist. ADR-0009 records the evidence and
 * the owner decision.
 *
 * Wormhole values are cross-checked against the pinned registry snapshot by
 * `@conduit-protocol/wormhole`, and both chain IDs are verified against a live
 * RPC at startup.
 */

export type ChainKey = 'monadTestnet' | 'baseSepolia';

export interface ChainDefinition {
  readonly key: ChainKey;
  /** Wormhole's own registry name, used when reading a pinned snapshot. */
  readonly wormholeName: string;
  /** What `eth_chainId` returns. Bound into every EIP-712 domain. */
  readonly nativeChainId: number;
  /** What a VAA emitter header carries. Never interchangeable with the above. */
  readonly wormholeChainId: number;
  /**
   * The `chain` value Cleanverse expects in a request body. A third naming
   * system for the same network, unrelated to either chain ID.
   */
  readonly cleanverseChain: string;
  readonly rpcUrlEnvVar: string;
  readonly role: 'cash' | 'asset';
}

export const CHAINS: Readonly<Record<ChainKey, ChainDefinition>> = Object.freeze({
  monadTestnet: Object.freeze({
    key: 'monadTestnet',
    wormholeName: 'MonadTestnet',
    nativeChainId: 10_143,
    wormholeChainId: 10_009,
    cleanverseChain: 'monad',
    rpcUrlEnvVar: 'MONAD_TESTNET_RPC_URL',
    role: 'cash',
  }),
  baseSepolia: Object.freeze({
    key: 'baseSepolia',
    wormholeName: 'BaseSepolia',
    nativeChainId: 84_532,
    wormholeChainId: 10_004,
    cleanverseChain: 'base',
    rpcUrlEnvVar: 'BASE_SEPOLIA_RPC_URL',
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

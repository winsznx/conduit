import { z } from 'zod';

import snapshot from './registry.snapshot.json' with { type: 'json' };

/**
 * The pinned Wormhole registry. PRD 8.3, CLAUDE.md.
 *
 * Core contract addresses and chain IDs are read from a committed snapshot of
 * the official `@wormhole-foundation/sdk-base` registry, never from a live
 * lookup and never from a literal typed into application code. A moved address
 * is a supply-chain write into the settlement path, so the snapshot carries its
 * own provenance and is validated at import.
 *
 * The snapshot proves what the registry *says*. It does not prove a core
 * contract is deployed at that address on a live chain — that needs a bytecode
 * check against an RPC, which `conduit doctor` performs (PRD FR-001).
 */

const chainSchema = z.object({
  wormholeName: z.string().min(1),
  /** Wormhole's own chain ID, carried in a VAA emitter header. */
  wormholeChainId: z.number().int().positive(),
  /** What `eth_chainId` returns. Never interchangeable with the above. */
  nativeChainId: z.number().int().positive(),
  coreBridgeAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  finalityThresholdBlocks: z.number().int().nonnegative(),
  blockTimeMilliseconds: z.number().int().positive(),
});

const snapshotSchema = z.object({
  provenance: z.object({
    source: z.string(),
    version: z.string(),
    files: z.array(z.string()).min(1),
    network: z.string(),
    retrievedAt: z.string(),
  }),
  chains: z.object({
    monadTestnet: chainSchema,
    arbitrumSepolia: chainSchema,
  }),
});

export type WormholeChainRegistry = z.infer<typeof chainSchema>;
export type WormholeRegistryKey = 'monadTestnet' | 'arbitrumSepolia';

/**
 * Validated at module load. A malformed snapshot fails the process at import
 * rather than at the first VAA, which is the difference between a startup error
 * and a settlement stuck mid-flight.
 */
const parsed = snapshotSchema.parse(snapshot);

export const WORMHOLE_REGISTRY = Object.freeze(parsed.chains);
export const WORMHOLE_REGISTRY_PROVENANCE = Object.freeze(parsed.provenance);

export const WORMHOLE_REGISTRY_KEYS: readonly WormholeRegistryKey[] = Object.freeze([
  'monadTestnet',
  'arbitrumSepolia',
]);

export function registryFor(key: WormholeRegistryKey): WormholeChainRegistry {
  return WORMHOLE_REGISTRY[key];
}

export function registryByWormholeChainId(
  wormholeChainId: number,
): WormholeChainRegistry | undefined {
  return WORMHOLE_REGISTRY_KEYS.map((key) => WORMHOLE_REGISTRY[key]).find(
    (chain) => chain.wormholeChainId === wormholeChainId,
  );
}

/**
 * Cross-checks the snapshot against `@conduit-protocol/config`.
 *
 * The two describe the same networks from different sources — the config module
 * from PRD 8.3, the snapshot from the upstream registry — so a disagreement
 * means one of them is wrong and settlement must not proceed on either.
 */
export function crossCheck(
  configChains: Readonly<
    Record<WormholeRegistryKey, { nativeChainId: number; wormholeChainId: number }>
  >,
): string[] {
  const problems: string[] = [];

  for (const key of WORMHOLE_REGISTRY_KEYS) {
    const registry = WORMHOLE_REGISTRY[key];
    const configured = configChains[key];

    if (registry.nativeChainId !== configured.nativeChainId) {
      problems.push(
        `${key}: native chain ID differs — registry ${String(registry.nativeChainId)}, config ${String(configured.nativeChainId)}`,
      );
    }
    if (registry.wormholeChainId !== configured.wormholeChainId) {
      problems.push(
        `${key}: Wormhole chain ID differs — registry ${String(registry.wormholeChainId)}, config ${String(configured.wormholeChainId)}`,
      );
    }
  }

  return problems;
}

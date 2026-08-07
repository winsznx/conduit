/**
 * @conduit-protocol/wormhole
 *
 * Pinned Wormhole registry snapshot, VAA retrieval, and payload codec.
 *
 * PRD 8.3 and CLAUDE.md: core addresses come from a pinned official registry
 * snapshot, contracts verify guardian signatures on-chain, and off-chain VAA
 * parsing is never trusted on its own.
 */

export const PACKAGE_ID = '@conduit-protocol/wormhole';

export const IMPLEMENTATION_PHASE = '02';

export {
  crossCheck,
  registryByWormholeChainId,
  registryFor,
  WORMHOLE_REGISTRY,
  WORMHOLE_REGISTRY_KEYS,
  WORMHOLE_REGISTRY_PROVENANCE,
  type WormholeChainRegistry,
  type WormholeRegistryKey,
} from './registry.js';

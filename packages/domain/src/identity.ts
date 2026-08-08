import type { Address, Hex } from 'viem';

/**
 * Identity for anything that lives at an address.
 *
 * The live deployment contains the reason this module exists:
 *
 * ```text
 *   Monad Testnet   SettlementCoordinator    0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE
 *   Base Sepolia    RWACVASettlementAdapter  0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE
 * ```
 *
 * The same twenty bytes, two different contracts, two different chains, two
 * different roles. It happened because the deployer's nonce lined up across two
 * chains, which is ordinary rather than exotic — anyone deploying the same
 * sequence from one key gets it — and it is now a permanent adversarial test
 * vector rather than something to redeploy away from.
 *
 * Anything that keys a contract, a peer, a balance, an event, a cache entry, an
 * idempotency key, an explorer link, or a row by address alone conflates those
 * two. The failure is silent and it is the worst kind: a verifier reading the
 * coordinator's state under the adapter's identity would report a settlement
 * that never happened, and every check downstream of it would agree.
 *
 * So identity is a pair, everywhere:
 *
 * ```text
 *   a contract        (chainId, address)          CAIP-10, eip155:10143:0x…
 *   a Wormhole peer   (wormholeChainId, bytes32)  wormhole:10004:0x00…
 * ```
 *
 * Wormhole chain IDs are their own namespace and are not EVM chain IDs — Monad
 * Testnet is EVM 10143 and Wormhole 10009 — so the two key formats are
 * deliberately not interchangeable, and a function that wants one will not
 * silently accept the other.
 */

/** A contract or account, scoped to the chain it exists on. */
export interface ChainScopedAddress {
  /** EVM chain ID. Never a Wormhole chain ID, and never a network name. */
  readonly chainId: number;
  readonly address: Address;
}

/** A Wormhole message emitter, scoped to the chain that emits it. */
export interface WormholeEmitter {
  /** Wormhole chain ID. Monad Testnet is 10009, Base Sepolia 10004. */
  readonly wormholeChainId: number;
  /** Left-padded to 32 bytes, as Wormhole encodes it. */
  readonly emitter: Hex;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * The canonical key for a contract. CAIP-10, lowercased.
 *
 * Lowercased rather than checksummed because a key that differs by case is two
 * keys, and the same address arrives checksummed from one source and lowercased
 * from another all day long. Checksums are for display.
 */
export function contractKey(identity: ChainScopedAddress): string {
  if (!EVM_ADDRESS.test(identity.address)) {
    throw new Error(`not an EVM address: ${identity.address}`);
  }
  if (!Number.isInteger(identity.chainId) || identity.chainId <= 0) {
    throw new Error(`not a chain ID: ${String(identity.chainId)}`);
  }
  return `eip155:${String(identity.chainId)}:${identity.address.toLowerCase()}`;
}

/** The canonical key for a Wormhole emitter. */
export function emitterKey(identity: WormholeEmitter): string {
  if (!BYTES32.test(identity.emitter)) {
    throw new Error(`not a 32-byte emitter: ${identity.emitter}`);
  }
  if (!Number.isInteger(identity.wormholeChainId) || identity.wormholeChainId <= 0) {
    throw new Error(`not a Wormhole chain ID: ${String(identity.wormholeChainId)}`);
  }
  return `wormhole:${String(identity.wormholeChainId)}:${identity.emitter.toLowerCase()}`;
}

export function sameContract(a: ChainScopedAddress, b: ChainScopedAddress): boolean {
  return contractKey(a) === contractKey(b);
}

export function sameEmitter(a: WormholeEmitter, b: WormholeEmitter): boolean {
  return emitterKey(a) === emitterKey(b);
}

/** Parses a CAIP-10 key back into its parts, rejecting anything else. */
export function parseContractKey(key: string): ChainScopedAddress {
  const match = /^eip155:(\d+):(0x[0-9a-f]{40})$/.exec(key);
  if (match === null) throw new Error(`not a contract key: ${key}`);
  return { chainId: Number(match[1]), address: match[2] as Address };
}

/**
 * The 20-byte address a Wormhole emitter left-pads.
 *
 * Deliberately returns a bare address and not a `ChainScopedAddress`: the
 * Wormhole chain ID is not an EVM chain ID and cannot be converted into one
 * without a registry. A caller that needs a contract identity has to supply the
 * EVM chain ID itself, which is the point — the conversion is where a
 * cross-chain confusion would otherwise slip in unnoticed.
 */
export function emitterToAddress(emitter: Hex): Address {
  if (!BYTES32.test(emitter)) throw new Error(`not a 32-byte emitter: ${emitter}`);
  const head = emitter.slice(2, 26);
  if (!/^0+$/.test(head)) {
    throw new Error(`emitter ${emitter} is not a left-padded 20-byte address`);
  }
  return `0x${emitter.slice(26)}`;
}

export function addressToEmitter(address: Address): Hex {
  if (!EVM_ADDRESS.test(address)) throw new Error(`not an EVM address: ${address}`);
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

/**
 * A registry that refuses to answer without a chain.
 *
 * There is no `get(address)` overload and there will not be one. The whole
 * class of defect this guards against is a lookup that compiles, runs, returns
 * a plausible answer, and is about the wrong contract.
 */
export class ContractRegistry<T> {
  private readonly entries = new Map<string, { identity: ChainScopedAddress; value: T }>();

  add(identity: ChainScopedAddress, value: T): this {
    const key = contractKey(identity);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      throw new Error(`${key} is already registered`);
    }
    this.entries.set(key, { identity, value });
    return this;
  }

  get(identity: ChainScopedAddress): T | undefined {
    return this.entries.get(contractKey(identity))?.value;
  }

  has(identity: ChainScopedAddress): boolean {
    return this.entries.has(contractKey(identity));
  }

  /**
   * Every registered contract sharing a bare address with another.
   *
   * Not a warning: a collision is legitimate and the live deployment has one.
   * It exists so a report can name the collision explicitly rather than let a
   * reader assume two identical strings are the same contract.
   */
  collisions(): readonly (readonly ChainScopedAddress[])[] {
    const byBareAddress = new Map<string, ChainScopedAddress[]>();
    for (const { identity } of this.entries.values()) {
      const bare = identity.address.toLowerCase();
      const group = byBareAddress.get(bare) ?? [];
      group.push(identity);
      byBareAddress.set(bare, group);
    }
    return [...byBareAddress.values()].filter((group) => group.length > 1);
  }

  size(): number {
    return this.entries.size;
  }

  all(): readonly { identity: ChainScopedAddress; value: T }[] {
    return [...this.entries.values()];
  }
}

/**
 * A block explorer link, which cannot be built from an address alone either.
 *
 * The same twenty bytes resolve to two different contracts on two different
 * explorers, so a link built without a chain is a link to the wrong contract
 * half the time.
 */
export function explorerAddressUrl(
  identity: ChainScopedAddress,
  explorers: Readonly<Record<number, string>>,
): string {
  const base = explorers[identity.chainId];
  if (base === undefined) {
    throw new Error(`no explorer configured for chain ${String(identity.chainId)}`);
  }
  return `${base.replace(/\/$/, '')}/address/${identity.address}`;
}

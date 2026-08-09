import { hashTypedData, type Hex, type TypedDataDomain } from 'viem';

/**
 * Settlement intent hashing. PRD FR-002 and FR-003.
 *
 * PRD FR-002 defines `settlementId` as "the EIP-712 digest or a domain-separated
 * hash of the final intent", while also listing it as a *field* of the intent
 * struct. Taken literally that is circular: the digest cannot cover a field
 * derived from the digest.
 *
 * Conduit resolves it by hashing every field except `settlementId`, and calling
 * that digest the `settlementId`. Consequences, all of which PRD FR-002 requires
 * anyway:
 *
 *   - the ID is deterministic from the economic terms, so two parties who agree
 *     on terms independently derive the same ID;
 *   - both chain IDs and both escrow addresses are inside the preimage, so an
 *     intent cannot be replayed onto a different deployment;
 *   - `nonce` makes two economically identical trades distinct settlements.
 *
 * The EIP-712 domain binds `chainId` to the *cash* chain, where the coordinator
 * lives. The asset chain is covered as a struct field rather than a domain
 * field, so one signature commits to both legs without either party signing two
 * different domains.
 */

export const INTENT_VERSION = 1;

export const SETTLEMENT_INTENT_TYPE = {
  SettlementIntent: [
    { name: 'version', type: 'uint32' },
    { name: 'cashChainId', type: 'uint256' },
    { name: 'cashEscrow', type: 'address' },
    { name: 'cashAsset', type: 'address' },
    { name: 'cashAmount', type: 'uint256' },
    { name: 'cashPayer', type: 'address' },
    { name: 'cashReceiver', type: 'address' },
    { name: 'assetChainId', type: 'uint256' },
    { name: 'assetEscrow', type: 'address' },
    { name: 'assetToken', type: 'address' },
    { name: 'assetAmount', type: 'uint256' },
    { name: 'assetSeller', type: 'address' },
    { name: 'assetReceiver', type: 'address' },
    { name: 'cashPolicyHash', type: 'bytes32' },
    { name: 'assetPolicyHash', type: 'bytes32' },
    { name: 'prepareDeadline', type: 'uint64' },
    { name: 'commitDeadline', type: 'uint64' },
    { name: 'releaseDeadline', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

/**
 * The intent without its derived identifier.
 *
 * `assetEscrow` keeps the PRD FR-002 name. Under the v1.1 override it holds the
 * `ConduitRWACVA` address, because the token itself records the reservation
 * rather than moving units into a separate escrow. The binding is identical:
 * whichever contract governs the asset leg is committed to by the signature.
 */
export interface SettlementIntentTerms {
  readonly version: number;
  readonly cashChainId: bigint;
  readonly cashEscrow: Hex;
  readonly cashAsset: Hex;
  readonly cashAmount: bigint;
  readonly cashPayer: Hex;
  readonly cashReceiver: Hex;
  readonly assetChainId: bigint;
  readonly assetEscrow: Hex;
  readonly assetToken: Hex;
  readonly assetAmount: bigint;
  readonly assetSeller: Hex;
  readonly assetReceiver: Hex;
  readonly cashPolicyHash: Hex;
  readonly assetPolicyHash: Hex;
  readonly prepareDeadline: bigint;
  readonly commitDeadline: bigint;
  readonly releaseDeadline: bigint;
  readonly nonce: bigint;
}

export interface SettlementIntent extends SettlementIntentTerms {
  readonly settlementId: Hex;
}

export interface DeploymentDomain {
  readonly name: string;
  readonly version: string;
  /** The cash chain, where SettlementCoordinator lives. */
  readonly chainId: bigint;
  readonly verifyingContract: Hex;
}

export function domainOf(deployment: DeploymentDomain): TypedDataDomain {
  return {
    name: deployment.name,
    version: deployment.version,
    chainId: Number(deployment.chainId),
    verifyingContract: deployment.verifyingContract,
  };
}

/**
 * The name and version the deployed contracts were constructed with.
 *
 * Not a convention and not a guess: the coordinator computes its
 * `domainSeparator` from these at construction, and this pair reproduces the
 * value the deployed generation-3 coordinator returns. A signature built with
 * anything else is rejected on chain, so these are pinned here rather than
 * passed in by each caller.
 */
export const DOMAIN_NAME = 'Conduit';
export const DOMAIN_VERSION = '1';

/**
 * The intent domain for a deployment, from the two things that actually vary.
 *
 * `chainId` is the *cash* chain, because `SettlementCoordinator` lives there
 * and is the verifying contract. Signing against the asset chain produces a
 * digest the coordinator will not accept.
 */
export function settlementIntentDomain(chainId: bigint, coordinator: Hex): TypedDataDomain {
  return domainOf({
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId,
    verifyingContract: coordinator,
  });
}

/**
 * Derives the settlement ID, which is also the digest both parties sign.
 *
 * One digest for both purposes is deliberate. If the ID and the signing digest
 * were different values, a signature could be valid for an intent whose ID it
 * did not cover.
 */
export function hashSettlementIntent(
  terms: SettlementIntentTerms,
  deployment: DeploymentDomain,
): Hex {
  return hashTypedData({
    domain: domainOf(deployment),
    types: SETTLEMENT_INTENT_TYPE,
    primaryType: 'SettlementIntent',
    message: terms,
  });
}

export function createSettlementIntent(
  terms: SettlementIntentTerms,
  deployment: DeploymentDomain,
): SettlementIntent {
  return { ...terms, settlementId: hashSettlementIntent(terms, deployment) };
}

export const IntentProblem = {
  VERSION_MISMATCH: 'version does not match the protocol version',
  SAME_CHAIN: 'cash and asset legs are on the same chain',
  ZERO_CASH_AMOUNT: 'cash amount must be greater than zero',
  ZERO_ASSET_AMOUNT: 'asset amount must be greater than zero',
  ZERO_ADDRESS: 'address fields must be non-zero',
  DEADLINE_ORDER: 'deadlines must be strictly increasing: prepare < commit < release',
  DOMAIN_CHAIN_MISMATCH: 'EIP-712 domain chain must be the cash chain',
} as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Structural validation, before any signature or chain state is consulted.
 *
 * Returns problems rather than throwing on the first one: a party fixing a draft
 * intent should see everything wrong with it at once.
 */
export function validateIntentTerms(
  terms: SettlementIntentTerms,
  deployment: DeploymentDomain,
): string[] {
  const problems: string[] = [];

  if (terms.version !== INTENT_VERSION) problems.push(IntentProblem.VERSION_MISMATCH);

  // A same-chain settlement would make the Wormhole leg meaningless and the
  // emitter checks unenforceable.
  if (terms.cashChainId === terms.assetChainId) problems.push(IntentProblem.SAME_CHAIN);

  if (terms.cashAmount <= 0n) problems.push(IntentProblem.ZERO_CASH_AMOUNT);
  if (terms.assetAmount <= 0n) problems.push(IntentProblem.ZERO_ASSET_AMOUNT);

  const addresses = [
    terms.cashEscrow,
    terms.cashAsset,
    terms.cashPayer,
    terms.cashReceiver,
    terms.assetEscrow,
    terms.assetToken,
    terms.assetSeller,
    terms.assetReceiver,
  ];
  if (addresses.some((address) => address.toLowerCase() === ZERO_ADDRESS)) {
    problems.push(IntentProblem.ZERO_ADDRESS);
  }

  // Strictly increasing, not merely ordered: equal deadlines create a window of
  // zero in which a legitimate action is impossible but a race is not.
  if (!(
    terms.prepareDeadline < terms.commitDeadline && terms.commitDeadline < terms.releaseDeadline
  )) {
    problems.push(IntentProblem.DEADLINE_ORDER);
  }

  if (deployment.chainId !== terms.cashChainId) {
    problems.push(IntentProblem.DOMAIN_CHAIN_MISMATCH);
  }

  return problems;
}

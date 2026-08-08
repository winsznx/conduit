import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  type Hex,
  type TypedDataDomain,
} from 'viem';

/**
 * Disposition orders. PRD FR-012.
 *
 * This must produce byte-identical digests to
 * `contracts/src/libraries/DispositionOrderLib.sol`. The two are written
 * independently and cross-checked against fixed vectors in both languages,
 * because a silent divergence means an order the SDK signs and the controller
 * rejects — or worse, one the controller accepts for terms the authority never
 * saw.
 *
 * The field order is the type hash. Reordering anything here changes every
 * digest and invalidates every order in flight, so the list matches the Solidity
 * struct exactly, top to bottom.
 *
 * Enums are `uint8` on the wire, which is what EIP-712 does with a Solidity
 * enum. They are typed unions here rather than plain numbers so a caller cannot
 * pass `7` for an authority class that has seven members numbered zero to six.
 */

/** PRD FR-012's order types, in the PRD's order. Values are positional. */
export const DispositionType = {
  REVERIFY_AND_RESUME: 0,
  REBIND_RECEIVER: 1,
  RETURN_TO_ELIGIBLE_SENDER: 2,
  AUTHORIZED_SUBSTITUTION: 3,
  OPERATOR_ASSISTED_OFFRAMP: 4,
  RESTRICTED_HOLD: 5,
} as const;

export type DispositionTypeName = keyof typeof DispositionType;
export type DispositionTypeValue = (typeof DispositionType)[DispositionTypeName];

/** PRD FR-012's authority classes, in the PRD's order. */
export const AuthorityType = {
  SUBJECT: 0,
  COUNTERPARTY: 1,
  ISSUER: 2,
  TRANSFER_AGENT: 3,
  COMPLIANCE_OPERATOR: 4,
  GATEWAY_OPERATOR: 5,
  MULTISIG: 6,
} as const;

export type AuthorityTypeName = keyof typeof AuthorityType;
export type AuthorityTypeValue = (typeof AuthorityType)[AuthorityTypeName];

export const Leg = {
  CASH: 0,
  ASSET: 1,
} as const;

export type LegName = keyof typeof Leg;
export type LegValue = (typeof Leg)[LegName];

export const DISPOSITION_ORDER_TYPE = {
  DispositionOrder: [
    { name: 'caseId', type: 'bytes32' },
    { name: 'settlementId', type: 'bytes32' },
    { name: 'deploymentId', type: 'bytes32' },
    { name: 'leg', type: 'uint8' },
    { name: 'dispositionType', type: 'uint8' },
    { name: 'sourceEscrow', type: 'address' },
    { name: 'asset', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'currentReceiver', type: 'address' },
    { name: 'destination', type: 'address' },
    { name: 'destinationIdentityCommitment', type: 'bytes32' },
    { name: 'authority', type: 'address' },
    { name: 'authorityType', type: 'uint8' },
    { name: 'authorityPolicyId', type: 'bytes32' },
    { name: 'authorityPolicyHash', type: 'bytes32' },
    { name: 'evidenceCommitment', type: 'bytes32' },
    { name: 'complianceAttestationIds', type: 'bytes32' },
    { name: 'notBefore', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'hostStateVersion', type: 'uint64' },
  ],
} as const;

export const CONFLICT_RESOLUTION_TYPE = {
  ConflictResolution: [
    { name: 'caseId', type: 'bytes32' },
    { name: 'deploymentId', type: 'bytes32' },
    { name: 'winningOrderHash', type: 'bytes32' },
    { name: 'authority', type: 'address' },
    { name: 'authorityType', type: 'uint8' },
    { name: 'authorityPolicyId', type: 'bytes32' },
    { name: 'authorityPolicyHash', type: 'bytes32' },
    { name: 'evidenceCommitment', type: 'bytes32' },
    { name: 'notBefore', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

export interface DispositionOrder {
  readonly caseId: Hex;
  readonly settlementId: Hex;
  readonly deploymentId: Hex;
  readonly leg: LegValue;
  readonly dispositionType: DispositionTypeValue;
  readonly sourceEscrow: Hex;
  readonly asset: Hex;
  readonly amount: bigint;
  readonly currentReceiver: Hex;
  readonly destination: Hex;
  readonly destinationIdentityCommitment: Hex;
  readonly authority: Hex;
  readonly authorityType: AuthorityTypeValue;
  readonly authorityPolicyId: Hex;
  readonly authorityPolicyHash: Hex;
  readonly evidenceCommitment: Hex;
  readonly complianceAttestationIds: Hex;
  readonly notBefore: bigint;
  readonly expiry: bigint;
  readonly nonce: bigint;
  readonly hostStateVersion: bigint;
}

export interface ConflictResolution {
  readonly caseId: Hex;
  readonly deploymentId: Hex;
  readonly winningOrderHash: Hex;
  readonly authority: Hex;
  readonly authorityType: AuthorityTypeValue;
  readonly authorityPolicyId: Hex;
  readonly authorityPolicyHash: Hex;
  readonly evidenceCommitment: Hex;
  readonly notBefore: bigint;
  readonly expiry: bigint;
  readonly nonce: bigint;
}

/**
 * The case an order belongs to, derived rather than chosen.
 *
 * PRD FR-012 binds a case ID without saying where it comes from. Letting a
 * signer choose it would defeat the conflict rule outright: two authorities
 * wanting different outcomes would each file under their own case, both would be
 * uncontested, and both would execute. Deriving it means every order about one
 * piece of held value lands in one case by construction, and the controller
 * rejects any order whose `caseId` is not this value.
 */
export function caseIdFor(deploymentId: Hex, settlementId: Hex, leg: LegValue): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint8' }],
      [deploymentId, settlementId, leg],
    ),
  );
}

/**
 * The digest an authority signs.
 *
 * The domain binds `chainId` and `verifyingContract`, so an order for the Monad
 * controller is not a valid order for the Base controller even with the same
 * authority, the same settlement and the same bytes. That separation is not
 * decoration: both chains run a controller, both hold real settlements against
 * the same token, and the two deployments have already collided on an address
 * once (ADR-0018).
 */
export function dispositionOrderDigest(order: DispositionOrder, domain: TypedDataDomain): Hex {
  return hashTypedData({
    domain,
    types: DISPOSITION_ORDER_TYPE,
    primaryType: 'DispositionOrder',
    message: order,
  });
}

export function conflictResolutionDigest(
  resolution: ConflictResolution,
  domain: TypedDataDomain,
): Hex {
  return hashTypedData({
    domain,
    types: CONFLICT_RESOLUTION_TYPE,
    primaryType: 'ConflictResolution',
    message: resolution,
  });
}

/**
 * Whether an order type can send value somewhere the intent never named.
 *
 * The single most important predicate in the kernel, and the reason
 * `REVERIFY_AND_RESUME` needs the weakest authority: it has no destination
 * parameter at all and can only retry the delivery the settlement already agreed
 * to. Every other type is an authorization rather than a retry.
 */
export function redirectsValue(dispositionType: DispositionTypeValue): boolean {
  return dispositionType !== DispositionType.REVERIFY_AND_RESUME;
}

/**
 * Which registry list a destination must appear on, per order type.
 *
 * Mirrors `DispositionController._requireDestinationPermitted`. Kept here so a
 * client can tell a user why a destination will be refused before an authority
 * signs anything, and so the two descriptions of the rule can be compared rather
 * than assumed to agree.
 */
export const DESTINATION_RULE: Readonly<Record<DispositionTypeName, string>> = Object.freeze({
  REVERIFY_AND_RESUME: 'must equal the current intended receiver',
  REBIND_RECEIVER: 'must carry the same registered identity commitment as the current receiver',
  RETURN_TO_ELIGIBLE_SENDER: 'must equal the original sender, and only after a COMMIT',
  AUTHORIZED_SUBSTITUTION: 'must be an approved substitute for the current receiver',
  OPERATOR_ASSISTED_OFFRAMP: 'must be a registered gateway account',
  RESTRICTED_HOLD: 'must be a registered restricted custodian',
});

/**
 * The protocol's on-chain surface: the ABIs, the positional tuples they return,
 * and the names the enums carry.
 *
 * Shared by the Worker and the browser bundle on purpose. Both read the same
 * contracts, and two copies of a nineteen-field intent tuple or a ten-member
 * state enum will disagree eventually — the live run learned that once with
 * an attestation domain and it cost twenty-five minutes.
 *
 * This is the same vocabulary `scripts/lib/dvp.mjs` uses against the same
 * deployment. Where a name appears in both, it is the same name.
 */

import { parseAbi, type Address, type Hex } from 'viem';

export const MONAD_TESTNET = 10_143;
export const BASE_SEPOLIA = 84_532;

/** Wormhole's own chain ids, which are not the EVM ones. */
export const MONAD_WORMHOLE_CHAIN = 10_009;
export const BASE_WORMHOLE_CHAIN = 10_004;

export const WORMHOLE_CHAIN_OF: Readonly<Record<number, number>> = Object.freeze({
  [MONAD_TESTNET]: MONAD_WORMHOLE_CHAIN,
  [BASE_SEPOLIA]: BASE_WORMHOLE_CHAIN,
});

/** `SettlementCoordinator.SettlementState`. Positional, never renumbered. */
export const SETTLEMENT_STATE = [
  'NONE',
  'CASH_PREPARED',
  'ASSET_PREPARED',
  'READY',
  'COMMIT_ISSUED',
  'ABORT_ISSUED',
  'SETTLED',
  'ABORTED',
  'HELD',
  'CONTESTED',
] as const;

export const DECISION = ['NONE', 'COMMIT', 'ABORT'] as const;
export const LEG_OUTCOME = ['NONE', 'RELEASED', 'RETURNED', 'HELD'] as const;
export const CASH_LEG_STATE = [
  'NONE',
  'PREPARED',
  'COMMITTED',
  'RELEASED',
  'RETURNED',
  'HELD',
] as const;
export const CASE_STATE = ['NONE', 'OPEN', 'CONTESTED', 'ADJUDICATED', 'EXECUTED'] as const;

/** `MessageCodec.MessageType`. PRD 7.3. */
export const MESSAGE_TYPE = [
  'CASH_PREPARED',
  'ASSET_PREPARED',
  'COMMIT',
  'ABORT',
  'CASH_RELEASED',
  'ASSET_RELEASED',
  'CASH_HELD',
  'ASSET_HELD',
  'DISPOSITION_RESOLVED',
] as const;

export type MessageTypeName = (typeof MESSAGE_TYPE)[number];

/** Reads a positional enum without ever inventing a name for an unknown value. */
function nameOf<T extends string>(table: readonly T[], value: number): T | string {
  return table[value] ?? `unknown(${String(value)})`;
}

const COMPLIANCE_PROOF = '((bytes32,bytes32,address,bool,uint64,uint64,bytes32)[],bytes[])';
const INTENT_TUPLE =
  '(uint32,uint256,address,address,uint256,address,address,uint256,address,address,uint256,address,address,bytes32,bytes32,uint64,uint64,uint64,uint256)';
const DISPOSITION_ORDER_TUPLE =
  '(bytes32,bytes32,bytes32,uint8,uint8,address,address,uint256,address,address,bytes32,address,uint8,bytes32,bytes32,bytes32,bytes32,uint64,uint64,uint256,uint64)';

/**
 * Every custom error the deployment can revert with.
 *
 * Appended to every ABI rather than split per contract. A selector decodes the
 * same wherever it comes from, and a per-contract split is a chance to leave one
 * out — which turns a precise refusal into "reverted with signature 0x…" at the
 * exact moment a user needs to know why. Mirrors `scripts/lib/dvp.mjs`.
 */
const CONDUIT_ERRORS = [
  'error VaaInvalid(string reason)',
  'error UnexpectedEmitterChain(uint16 actual, uint16 expected)',
  'error UnexpectedEmitter(bytes32 actual, bytes32 expected)',
  'error UnexpectedDeployment(bytes32 actual, bytes32 expected)',
  'error UnexpectedDestinationChain(uint256 actual, uint256 expected)',
  'error VaaAlreadyConsumed(bytes32 vaaHash)',
  'error UnexpectedMessageType(uint8 actual, uint8 expected)',
  'error InsufficientMessageFee(uint256 provided, uint256 required)',
  'error RemotePeerAlreadyLocked()',
  'error RemotePeerNotSet()',
  'error RemotePeerCannotBeZero()',
  'error InsufficientFinality(uint8 messageType, uint8 actual, uint8 required)',
  'error NotAComplianceSigner(address account)',
  'error AlreadyAComplianceSigner(address account)',
  'error QuorumExceedsSignerCount(uint256 quorum, uint256 signerCount)',
  'error QuorumIsZero()',
  'error AttestationForWrongSettlement(bytes32 expected, bytes32 actual)',
  'error AttestationForWrongIntent(bytes32 expected, bytes32 actual)',
  'error AttestationExpired(uint64 expiresAt, uint256 nowTimestamp)',
  'error AttestationNotYetValid(uint64 issuedAt, uint256 nowTimestamp)',
  'error AttestationValidityTooLong(uint64 window, uint64 maximum)',
  'error AttestationSignerNotAuthorized(address recovered)',
  'error AttestationSignersNotDistinct(address repeated)',
  'error AttestationCountMismatch(uint256 attestations, uint256 signatures)',
  'error ComplianceQuorumNotMet(address subject, uint256 attesting, uint256 required)',
  'error ComplianceNotConfigured()',
  'error AlreadyDecided(bytes32 settlementId, uint8 decision)',
  'error NotReady(bytes32 settlementId, uint8 state)',
  'error LegAlreadyPrepared(bytes32 settlementId)',
  'error IntentHashMismatch(bytes32 actual, bytes32 expected)',
  'error IntentDoesNotMatchSettlementId(bytes32 computed, bytes32 provided)',
  'error DeadlinePassed(uint64 deadline, uint256 nowTimestamp)',
  'error PrepareDeadlinePassed(uint64 deadline, uint256 nowTimestamp)',
  'error InvalidBuyerSignature()',
  'error InvalidSellerSignature()',
  'error WrongChainForCashLeg(uint256 expected, uint256 actual)',
  'error AbortAfterCommitForbidden(bytes32 settlementId)',
  'error SettlementUnknown(bytes32 settlementId)',
  'error LegNotPrepared(bytes32 settlementId, bool cash)',
  'error LegAlreadyResolved(bytes32 settlementId, bool cash)',
  'error ReleaseRequiresCommit(bytes32 settlementId)',
  'error ReturnRequiresAbort(bytes32 settlementId)',
  'error AbortGroundNotProven(uint8 ground)',
  'error NotTheCashEscrow(address caller, address expected)',
  'error CashEscrowAlreadySet(address current)',
  'error InvalidCancellationSignature(address party)',
  'error OutcomeDoesNotMatchMessage(uint8 outcome, uint8 messageType)',
  'error AmountMustBePositive()',
  'error LegUnknown(bytes32 settlementId)',
  'error LegNotInState(bytes32 settlementId, uint8 actual, uint8 expected)',
  'error InexactBalanceDelta(uint256 expected, uint256 actual)',
  'error PreparationsArePaused()',
  'error ZeroAddress()',
  'error ReceiverNotRegistered(bytes32 settlementId)',
  'error ReceiverMismatch(address expected, address provided)',
  'error NotReservationOwner()',
  'error LegNotResolved(bytes32 settlementId)',
  'error LegNotHeld(bytes32 settlementId)',
  'error ReservationExists(bytes32 settlementId)',
  'error ReservationUnknown(bytes32 settlementId)',
  'error ReservationClosed(bytes32 settlementId)',
  'error ReservationNotCommitted(bytes32 settlementId)',
  'error ReservationAlreadyCommitted(bytes32 settlementId)',
  'error ReservationAlreadyAnnounced(bytes32 settlementId)',
  'error InsufficientAvailableBalance(uint256 available, uint256 requested)',
  'error PayloadTooShort(uint256 length)',
  'error UnknownMessageType(uint8 value)',
  'error UnsupportedProtocolVersion(uint32 version)',
  'error TransferNotAllowed()',
  'error NoAPass(address account)',
  'error ExecutorAlreadySet(uint8 leg)',
  'error NoExecutorForLeg(uint8 leg)',
  'error WrongDeployment(bytes32 provided, bytes32 expected)',
  'error CaseIdMismatch(bytes32 provided, bytes32 derived)',
  'error OrderNotYetValid(uint64 notBefore, uint256 nowTimestamp)',
  'error OrderExpired(uint64 expiry, uint256 nowTimestamp)',
  'error NonceAlreadyUsed(address authority, uint256 nonce)',
  'error InvalidAuthoritySignature(address authority)',
  'error PolicyHashMismatch(bytes32 provided, bytes32 actual)',
  'error AuthorityTypeNotPermitted(uint8 authorityType)',
  'error DispositionTypeNotPermitted(uint8 dispositionType)',
  'error HostStateVersionMismatch(uint64 provided, uint64 actual)',
  'error SourceEscrowMismatch(address provided, address expected)',
  'error AssetMismatch(address provided, address expected)',
  'error AmountMismatch(uint256 provided, uint256 expected)',
  'error CurrentReceiverMismatch(address provided, address expected)',
  'error IdentityCommitmentMismatch(bytes32 provided, bytes32 expected)',
  'error ReturnRequiresCommit(bytes32 settlementId)',
  'error AuthorityAlreadySigned(address authority)',
  'error CaseNotOpen(bytes32 caseId, uint8 state)',
  'error CaseIsTerminal(bytes32 caseId)',
  'error CaseNotContested(bytes32 caseId, uint8 state)',
  'error ContestWindowOpen(uint64 openUntil, uint256 nowTimestamp)',
  'error SignaturesBelowThreshold(uint256 have, uint8 required)',
  'error OrderNotFiled(bytes32 caseId, bytes32 orderHash)',
  'error NotAnAuthority(address account)',
  'error AuthorityTypeMismatch(address account, uint8 expected, uint8 actual)',
  'error PolicyUnknown(bytes32 policyId)',
] as const;

export const COORDINATOR_ABI = parseAbi([
  ...CONDUIT_ERRORS,
  'function attestationDomainSeparator() view returns (bytes32)',
  'function maxAttestationValidity() view returns (uint64)',
  'function complianceQuorum() view returns (uint256)',
  'function complianceSignerCount() view returns (uint256)',
  'function isComplianceSigner(address) view returns (bool)',
  `function verifyEligible(bytes32 settlementId, bytes32 intentHash, address subject, ${COMPLIANCE_PROOF} proof) view returns (bool)`,
  'function deploymentId() view returns (bytes32)',
  'function cashEscrow() view returns (address)',
  'function wormhole() view returns (address)',
  'function consumedVaa(bytes32) view returns (bool)',
  'function settlementOf(bytes32) view returns ((uint8,uint8,bool,bool,uint8,uint8,bytes32,uint64))',
  'function recordAssetPrepared(bytes preparedVaa)',
  'function recordLegResolved(bytes resolutionVaa, uint8 expectedType, uint8 outcome)',
  `function issueCommit(${INTENT_TUPLE} intent, bytes32 settlementId, bytes buyerSignature, bytes sellerSignature, ${COMPLIANCE_PROOF} compliance, uint8 consistencyLevel) payable returns (uint64)`,
]);

export const ESCROW_ABI = parseAbi([
  ...CONDUIT_ERRORS,
  'function attestationDomainSeparator() view returns (bytes32)',
  'function maxAttestationValidity() view returns (uint64)',
  'function complianceQuorum() view returns (uint256)',
  `function verifyEligible(bytes32 settlementId, bytes32 intentHash, address subject, ${COMPLIANCE_PROOF} proof) view returns (bool)`,
  'function coordinator() view returns (address)',
  'function cashAsset() view returns (address)',
  'function deploymentId() view returns (bytes32)',
  'function preparationsPaused() view returns (bool)',
  'function totalEscrowed() view returns (uint256)',
  'function legOf(bytes32) view returns ((address,address,uint256,bytes32,uint8))',
  'function prepareCash(bytes32 settlementId, bytes32 intentHash, address receiver, uint256 amount, uint256 destinationChainId, uint8 consistencyLevel) payable returns (uint64)',
  `function releaseCash(bytes32 settlementId, ${COMPLIANCE_PROOF} compliance)`,
]);

export const ADAPTER_ABI = parseAbi([
  ...CONDUIT_ERRORS,
  'function attestationDomainSeparator() view returns (bytes32)',
  'function maxAttestationValidity() view returns (uint64)',
  'function complianceQuorum() view returns (uint256)',
  `function verifyEligible(bytes32 settlementId, bytes32 intentHash, address subject, ${COMPLIANCE_PROOF} proof) view returns (bool)`,
  'function asset() view returns (address)',
  'function deploymentId() view returns (bytes32)',
  'function wormhole() view returns (address)',
  'function consumedVaa(bytes32) view returns (bool)',
  'function intendedReceiver(bytes32) view returns (address)',
  'function boundIntentHash(bytes32) view returns (bytes32)',
  'function prepareAsset(bytes32 settlementId, bytes32 intentHash, address receiver, uint256 destinationChainId, uint8 consistencyLevel) payable returns (uint64)',
  `function releaseAsset(bytes commitVaa, ${COMPLIANCE_PROOF} compliance)`,
  'function reportResolution(bytes32 settlementId, uint256 destinationChainId, uint8 consistencyLevel) payable returns (uint64)',
]);

export const RWA_ABI = parseAbi([
  ...CONDUIT_ERRORS,
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function reservedBalanceOf(address) view returns (uint256)',
  'function availableBalanceOf(address) view returns (uint256)',
  'function reservationOf(bytes32) view returns ((address,uint256,bytes32,uint64,bool,bool,bool,bool))',
  'function reserveForSettlement(bytes32 settlementId, uint256 amount)',
  'function policy() view returns (address)',
]);

export const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export const CORE_ABI = parseAbi([
  'function messageFee() view returns (uint256)',
  'function chainId() view returns (uint16)',
  'event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)',
]);

export const CONTROLLER_ABI = parseAbi([
  ...CONDUIT_ERRORS,
  'function registry() view returns (address)',
  'function deploymentId() view returns (bytes32)',
  'function domainSeparator() view returns (bytes32)',
  'function caseOf(bytes32) view returns ((uint8,uint8,bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint8,bytes32,uint8,address,uint256,bytes32))',
  'function orderIsFiled(bytes32 caseId, bytes32 orderHash) view returns (bool)',
  'function authoritiesOf(bytes32 caseId) view returns (address[])',
  'function nonceUsed(address authority, uint256 nonce) view returns (bool)',
  'function legIsClaimed(bytes32 settlementId, uint8 leg) view returns (bool)',
  `function fileOrder(${DISPOSITION_ORDER_TUPLE} order, bytes signature) returns (bytes32)`,
  `function executeOrder(bytes32 caseId, ${COMPLIANCE_PROOF} compliance)`,
]);

export const REGISTRY_ABI = parseAbi([
  ...CONDUIT_ERRORS,
  'function authorityOf(address) view returns ((uint8,bool,uint64))',
  'function identityCommitmentOf(address) view returns (bytes32)',
  'function isApprovedSubstitute(address original, address substitute) view returns (bool)',
  'function isRestrictedCustodian(address) view returns (bool)',
  'function isGatewayAccount(address) view returns (bool)',
  'function policyOf(bytes32) view returns ((bool,uint32,uint16,uint16,uint8,uint8[6]))',
  'function policyHash(bytes32) view returns (bytes32)',
]);

// ── Calldata tuples ─────────────────────────────────────────────────────────
//
// Fixed-length on purpose. viem infers a tuple type from the ABI, and a plain
// array will not satisfy it — which is the type system catching, at build time,
// the class of mistake that produces a call with nineteen fields in eighteen
// positions.

export type AttestationTuple = readonly [Hex, Hex, Address, boolean, bigint, bigint, Hex];

/** `ComplianceAuthority.ComplianceProof`: attestations, then their signatures. */
export type ComplianceProof = readonly [readonly AttestationTuple[], readonly Hex[]];

/** `SettlementIntentLib.SettlementIntent`, in declaration order. */
export type IntentTuple = readonly [
  number,
  bigint,
  Address,
  Address,
  bigint,
  Address,
  Address,
  bigint,
  Address,
  Address,
  bigint,
  Address,
  Address,
  Hex,
  Hex,
  bigint,
  bigint,
  bigint,
  bigint,
];

/** `DispositionOrderLib.DispositionOrder`, in declaration order. */
export type DispositionOrderTuple = readonly [
  Hex,
  Hex,
  Hex,
  number,
  number,
  Address,
  Address,
  bigint,
  Address,
  Address,
  Hex,
  Address,
  number,
  Hex,
  Hex,
  Hex,
  Hex,
  bigint,
  bigint,
  bigint,
  bigint,
];

// ── Positional tuples, named ────────────────────────────────────────────────

export interface SettlementRecord {
  readonly state: string;
  readonly decision: string;
  readonly cashPrepared: boolean;
  readonly assetPrepared: boolean;
  readonly cashOutcome: string;
  readonly assetOutcome: string;
  readonly intentHash: Hex;
  readonly stateVersion: bigint;
}

type SettlementTuple = readonly [
  number,
  number,
  boolean,
  boolean,
  number,
  number,
  Hex,
  bigint | number,
];

export function readSettlement(tuple: SettlementTuple): SettlementRecord {
  return {
    state: nameOf(SETTLEMENT_STATE, tuple[0]),
    decision: nameOf(DECISION, tuple[1]),
    cashPrepared: tuple[2],
    assetPrepared: tuple[3],
    cashOutcome: nameOf(LEG_OUTCOME, tuple[4]),
    assetOutcome: nameOf(LEG_OUTCOME, tuple[5]),
    intentHash: tuple[6],
    stateVersion: BigInt(tuple[7]),
  };
}

export interface CashLegRecord {
  readonly payer: Address;
  readonly receiver: Address;
  readonly amount: bigint;
  readonly intentHash: Hex;
  readonly state: string;
}

type CashLegTuple = readonly [Address, Address, bigint, Hex, number];

export function readCashLeg(tuple: CashLegTuple): CashLegRecord {
  return {
    payer: tuple[0],
    receiver: tuple[1],
    amount: tuple[2],
    intentHash: tuple[3],
    state: nameOf(CASH_LEG_STATE, tuple[4]),
  };
}

export interface ReservationRecord {
  readonly owner: Address;
  readonly amount: bigint;
  readonly settlementId: Hex;
  readonly createdAt: bigint;
  readonly announced: boolean;
  readonly committed: boolean;
  readonly released: boolean;
  readonly cancelled: boolean;
}

type ReservationTuple = readonly [
  Address,
  bigint,
  Hex,
  bigint | number,
  boolean,
  boolean,
  boolean,
  boolean,
];

export function readReservation(tuple: ReservationTuple): ReservationRecord {
  return {
    owner: tuple[0],
    amount: tuple[1],
    settlementId: tuple[2],
    createdAt: BigInt(tuple[3]),
    announced: tuple[4],
    committed: tuple[5],
    released: tuple[6],
    cancelled: tuple[7],
  };
}

export interface DispositionCaseRecord {
  readonly state: string;
  readonly leg: number;
  readonly settlementId: Hex;
  readonly policyId: Hex;
  readonly policyHash: Hex;
  readonly leadOrderHash: Hex;
  readonly filedAt: bigint;
  readonly signatures: number;
  readonly executedType: number;
  readonly executedDestination: Address;
  readonly executedAmount: bigint;
}

type CaseTuple = readonly [
  number,
  number,
  Hex,
  Hex,
  Hex,
  Hex,
  Hex,
  bigint | number,
  number,
  Hex,
  number,
  Address,
  bigint,
  Hex,
];

export function readDispositionCase(tuple: CaseTuple): DispositionCaseRecord {
  return {
    state: nameOf(CASE_STATE, tuple[0]),
    leg: tuple[1],
    settlementId: tuple[2],
    policyId: tuple[3],
    policyHash: tuple[4],
    leadOrderHash: tuple[6],
    filedAt: BigInt(tuple[7]),
    signatures: tuple[8],
    executedType: tuple[10],
    executedDestination: tuple[11],
    executedAmount: tuple[12],
  };
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** A Wormhole emitter is an address left-padded to 32 bytes. */
export function padEmitter(address: string): Hex {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

// ── Message header ──────────────────────────────────────────────────────────

export interface DecodedHeader {
  readonly protocolVersion: number;
  readonly messageType: string;
  readonly messageTypeValue: number;
  readonly deploymentId: Hex;
  readonly settlementId: Hex;
  readonly intentHash: Hex;
  readonly sourceChainId: bigint;
  readonly destinationChainId: bigint;
  readonly stateVersion: bigint;
}

/** `MessageCodec.HEADER_BYTES` — 4 + 1 + 32 + 32 + 32 + 32 + 32 + 8. */
export const HEADER_BYTES = 173;

function hexAt(bytes: Uint8Array, offset: number, length: number): Hex {
  let out = '';
  for (let index = offset; index < offset + length; index += 1) {
    out += (bytes[index] ?? 0).toString(16).padStart(2, '0');
  }
  return `0x${out}`;
}

function uintAt(bytes: Uint8Array, offset: number, length: number): bigint {
  return BigInt(hexAt(bytes, offset, length));
}

export function hexToBytes(value: string): Uint8Array {
  const clean = value.startsWith('0x') ? value.slice(2) : value;
  const out = new Uint8Array(clean.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/**
 * Decodes a Conduit message payload.
 *
 * Fixed width at fixed offsets, exactly as the Solidity does. A truncated
 * payload fails rather than shifting into something plausible — which is the
 * property that matters when the bytes came off a public relay.
 */
export function decodeMessageHeader(payload: string): DecodedHeader {
  const bytes = hexToBytes(payload);
  if (bytes.length < HEADER_BYTES) {
    throw new Error(
      `payload is ${String(bytes.length)} bytes, the header needs ${String(HEADER_BYTES)}`,
    );
  }
  const protocolVersion = Number(uintAt(bytes, 0, 4));
  const messageTypeValue = bytes[4] ?? 255;
  return {
    protocolVersion,
    messageType: nameOf(MESSAGE_TYPE, messageTypeValue),
    messageTypeValue,
    deploymentId: hexAt(bytes, 5, 32),
    settlementId: hexAt(bytes, 37, 32),
    intentHash: hexAt(bytes, 69, 32),
    sourceChainId: uintAt(bytes, 101, 32),
    destinationChainId: uintAt(bytes, 133, 32),
    stateVersion: uintAt(bytes, 165, 8),
  };
}

/** The header fields of a signed VAA, without trusting a parser for the rest. */
export function readVaaHeader(vaa: string): {
  emitterChainId: number;
  emitterAddress: Hex;
  sequence: bigint;
  consistencyLevel: number;
} {
  const bytes = hexToBytes(vaa);
  const guardianSignatures = bytes[5] ?? 0;
  const body = 6 + guardianSignatures * 66;
  return {
    emitterChainId: Number(uintAt(bytes, body + 8, 2)),
    emitterAddress: hexAt(bytes, body + 10, 32),
    sequence: uintAt(bytes, body + 42, 8),
    consistencyLevel: bytes[body + 50] ?? 0,
  };
}

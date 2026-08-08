/**
 * Everything the preflight and the live run must agree on.
 *
 * Both read the same environment, build the same intent, and derive the same
 * settlement ID through the same code. A preflight that proves a different
 * settlement than the one the run then executes proves nothing, and two copies
 * of a nineteen-field EIP-712 preimage will differ eventually.
 */
import { concatHex, encodeAbiParameters, keccak256, parseAbi, parseEventLogs, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { hashSettlementIntent, validateIntentTerms } from '../../packages/domain/dist/intent.js';

import { createChain, rpcUrlsFrom } from './chain.mjs';

export const MONAD_EVM_CHAIN_ID = 10_143;
export const BASE_EVM_CHAIN_ID = 84_532;
export const MONAD_WORMHOLE_CHAIN_ID = 10_009;
export const BASE_WORMHOLE_CHAIN_ID = 10_004;

export const DOMAIN_NAME = 'Conduit';
export const DOMAIN_VERSION = '1';

/** PRD 7.3, and `MessageCodec.MessageType` — positional, never renumbered. */
export const MessageType = {
  CASH_PREPARED: 0,
  ASSET_PREPARED: 1,
  COMMIT: 2,
  ABORT: 3,
  CASH_RELEASED: 4,
  ASSET_RELEASED: 5,
  CASH_HELD: 6,
  ASSET_HELD: 7,
  DISPOSITION_RESOLVED: 8,
};

/** `SettlementCoordinator.LegOutcome`. */
export const LegOutcome = { NONE: 0, RELEASED: 1, RETURNED: 2, HELD: 3 };

/** `SettlementCoordinator.SettlementState`, for reporting rather than logic. */
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
];

export const DECISION = ['NONE', 'COMMIT', 'ABORT'];
export const LEG_OUTCOME = ['NONE', 'RELEASED', 'RETURNED', 'HELD'];
export const CASH_LEG_STATE = ['NONE', 'PREPARED', 'COMMITTED', 'RELEASED', 'RETURNED', 'HELD'];
export const FINALITY = ['INSTANT', 'SAFE', 'FINALIZED'];

const COMPLIANCE_PROOF = '((bytes32,bytes32,address,bool,uint64,uint64,bytes32)[],bytes[])';
const INTENT_TUPLE =
  '(uint32,uint256,address,address,uint256,address,address,uint256,address,address,uint256,address,address,bytes32,bytes32,uint64,uint64,uint64,uint256)';

/**
 * Every custom error Conduit can revert with, in one list.
 *
 * Without these, viem reports a revert as "reverted with the following
 * signature: 0x…" and a run's diagnosis starts by looking up a selector by
 * hand. That is how attempt 3's `0xb786da5e` took a detour before it read
 * `AttestationSignerNotAuthorized`. The list is appended to every ABI rather
 * than split per contract, because a selector decodes the same wherever it
 * comes from and a per-contract split is a chance to leave one out.
 */
const CONDUIT_ERRORS = [
  // WormholeTransport
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
  // ComplianceAuthority
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
  // SettlementCoordinator
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
  // CashEscrow
  'error AmountMustBePositive()',
  'error LegUnknown(bytes32 settlementId)',
  'error LegNotInState(bytes32 settlementId, uint8 actual, uint8 expected)',
  'error InexactBalanceDelta(uint256 expected, uint256 actual)',
  'error PreparationsArePaused()',
  'error ZeroAddress()',
  // RWACVASettlementAdapter
  'error ReceiverNotRegistered(bytes32 settlementId)',
  'error ReceiverMismatch(address expected, address provided)',
  'error NotReservationOwner()',
  'error LegNotResolved(bytes32 settlementId)',
  'error LegNotHeld(bytes32 settlementId)',
  // ConduitRWACVA
  'error ReservationExists(bytes32 settlementId)',
  'error ReservationUnknown(bytes32 settlementId)',
  'error ReservationClosed(bytes32 settlementId)',
  'error ReservationNotCommitted(bytes32 settlementId)',
  'error ReservationAlreadyCommitted(bytes32 settlementId)',
  'error ReservationAlreadyAnnounced(bytes32 settlementId)',
  'error InsufficientAvailableBalance(uint256 available, uint256 requested)',
  // MessageCodec
  'error PayloadTooShort(uint256 length)',
  'error UnknownMessageType(uint8 value)',
  'error UnsupportedProtocolVersion(uint32 version)',
  // IATokenPolicy
  'error TransferNotAllowed()',
  'error NoAPass(address account)',
];

export const COORDINATOR_ABI = parseAbi([
  ...CONDUIT_ERRORS,
  'function domainSeparator() view returns (bytes32)',
  'function attestationDomainSeparator() view returns (bytes32)',
  'function maxAttestationValidity() view returns (uint64)',
  'function isComplianceSigner(address) view returns (bool)',
  'function complianceSignerCount() view returns (uint256)',
  'function complianceQuorum() view returns (uint256)',
  `function verifyEligible(bytes32 settlementId, bytes32 intentHash, address subject, ${COMPLIANCE_PROOF} proof) view returns (bool)`,
  `function verifyRefused(bytes32 settlementId, bytes32 intentHash, address subject, ${COMPLIANCE_PROOF} proof) view returns (bool)`,
  'function cashEscrow() view returns (address)',
  'function owner() view returns (address)',
  'function deploymentId() view returns (bytes32)',
  'function remoteEmitter() view returns (bytes32)',
  'function remotePeerLocked() view returns (bool)',
  'function localWormholeChainId() view returns (uint16)',
  'function remoteWormholeChainId() view returns (uint16)',
  'function settlementFinality() view returns (uint8)',
  'function observationFinality() view returns (uint8)',
  'function wormhole() view returns (address)',
  'function consumedVaa(bytes32) view returns (bool)',
  'function settlementOf(bytes32) view returns ((uint8,uint8,bool,bool,uint8,uint8,bytes32,uint64))',
  'function recordCashPrepared(bytes32 settlementId, bytes32 intentHash)',
  'function recordAssetPrepared(bytes preparedVaa)',
  'function recordLegResolved(bytes resolutionVaa, uint8 expectedType, uint8 outcome)',
  'function setRemotePeer(bytes32 emitter)',
  'function setCashEscrow(address escrow)',
  'function addComplianceSigner(address signer)',
  'function setComplianceQuorum(uint256 quorum)',
  `function issueCommit(${INTENT_TUPLE} intent, bytes32 settlementId, bytes buyerSignature, bytes sellerSignature, ${COMPLIANCE_PROOF} compliance, uint8 consistencyLevel) payable returns (uint64)`,
  `function issueAbort(${INTENT_TUPLE} intent, bytes32 settlementId, uint8 ground, (${COMPLIANCE_PROOF},bytes,bytes) cancellation, uint8 consistencyLevel) payable returns (uint64)`,
]);

export const ESCROW_ABI = parseAbi([
  ...CONDUIT_ERRORS,
  'function attestationDomainSeparator() view returns (bytes32)',
  'function maxAttestationValidity() view returns (uint64)',
  'function isComplianceSigner(address) view returns (bool)',
  'function complianceSignerCount() view returns (uint256)',
  'function complianceQuorum() view returns (uint256)',
  `function verifyEligible(bytes32 settlementId, bytes32 intentHash, address subject, ${COMPLIANCE_PROOF} proof) view returns (bool)`,
  `function verifyRefused(bytes32 settlementId, bytes32 intentHash, address subject, ${COMPLIANCE_PROOF} proof) view returns (bool)`,
  'function coordinator() view returns (address)',
  'function cashAsset() view returns (address)',
  'function owner() view returns (address)',
  'function deploymentId() view returns (bytes32)',
  'function remoteEmitter() view returns (bytes32)',
  'function remotePeerLocked() view returns (bool)',
  'function settlementFinality() view returns (uint8)',
  'function preparationsPaused() view returns (bool)',
  'function totalEscrowed() view returns (uint256)',
  'function legOf(bytes32) view returns ((address,address,uint256,bytes32,uint8))',
  'function prepareCash(bytes32 settlementId, bytes32 intentHash, address receiver, uint256 amount, uint256 destinationChainId, uint8 consistencyLevel) payable returns (uint64)',
  `function releaseCash(bytes32 settlementId, ${COMPLIANCE_PROOF} compliance)`,
  `function returnCash(bytes32 settlementId, ${COMPLIANCE_PROOF} compliance)`,
  'function setRemotePeer(bytes32 emitter)',
  'function addComplianceSigner(address signer)',
  'function setComplianceQuorum(uint256 quorum)',
]);

export const ADAPTER_ABI = parseAbi([
  ...CONDUIT_ERRORS,
  'function attestationDomainSeparator() view returns (bytes32)',
  'function maxAttestationValidity() view returns (uint64)',
  'function isComplianceSigner(address) view returns (bool)',
  'function complianceSignerCount() view returns (uint256)',
  'function complianceQuorum() view returns (uint256)',
  `function verifyEligible(bytes32 settlementId, bytes32 intentHash, address subject, ${COMPLIANCE_PROOF} proof) view returns (bool)`,
  `function verifyRefused(bytes32 settlementId, bytes32 intentHash, address subject, ${COMPLIANCE_PROOF} proof) view returns (bool)`,
  'function asset() view returns (address)',
  'function owner() view returns (address)',
  'function deploymentId() view returns (bytes32)',
  'function remoteEmitter() view returns (bytes32)',
  'function remotePeerLocked() view returns (bool)',
  'function localWormholeChainId() view returns (uint16)',
  'function remoteWormholeChainId() view returns (uint16)',
  'function settlementFinality() view returns (uint8)',
  'function wormhole() view returns (address)',
  'function consumedVaa(bytes32) view returns (bool)',
  'function intendedReceiver(bytes32) view returns (address)',
  'function boundIntentHash(bytes32) view returns (bytes32)',
  'function prepareAsset(bytes32 settlementId, bytes32 intentHash, address receiver, uint256 destinationChainId, uint8 consistencyLevel) payable returns (uint64)',
  `function releaseAsset(bytes commitVaa, ${COMPLIANCE_PROOF} compliance)`,
  'function returnAsset(bytes abortVaa)',
  'function reportResolution(bytes32 settlementId, uint256 destinationChainId, uint8 consistencyLevel) payable returns (uint64)',
  'function setRemotePeer(bytes32 emitter)',
  'function addComplianceSigner(address signer)',
  'function setComplianceQuorum(uint256 quorum)',
]);

export const RWA_ABI = parseAbi([
  ...CONDUIT_ERRORS,
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function reservedBalanceOf(address) view returns (uint256)',
  'function availableBalanceOf(address) view returns (uint256)',
  'function reservationOf(bytes32) view returns ((address,uint256,bytes32,uint64,bool,bool,bool,bool))',
  'function reserveForSettlement(bytes32 settlementId, uint256 amount)',
  'function cancelReservation(bytes32 settlementId)',
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function markCommitted(bytes32 settlementId)',
  'function markAnnounced(bytes32 settlementId)',
  'function releaseReservation(bytes32 settlementId, address receiver)',
  'function mint(address to, uint256 amount)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function SETTLEMENT_ROLE() view returns (bytes32)',
  'function MINTER_ROLE() view returns (bytes32)',
  'function policy() view returns (address)',
]);

export const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export const POLICY_ABI = parseAbi([
  'function canTransfer(address token, address from, address to, uint256 amount) view returns (bool)',
]);

export const CORE_ABI = parseAbi([
  'function messageFee() view returns (uint256)',
  'function chainId() view returns (uint16)',
  'event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)',
]);

/** `reservationOf` returns a positional tuple; naming it here keeps callers honest. */
export function reservation(tuple) {
  return {
    owner: tuple[0],
    amount: tuple[1],
    settlementId: tuple[2],
    createdAt: tuple[3],
    announced: tuple[4],
    committed: tuple[5],
    released: tuple[6],
    cancelled: tuple[7],
  };
}

export function settlement(tuple) {
  return {
    state: SETTLEMENT_STATE[tuple[0]] ?? String(tuple[0]),
    decision: DECISION[tuple[1]] ?? String(tuple[1]),
    cashPrepared: tuple[2],
    assetPrepared: tuple[3],
    cashOutcome: LEG_OUTCOME[tuple[4]] ?? String(tuple[4]),
    assetOutcome: LEG_OUTCOME[tuple[5]] ?? String(tuple[5]),
    intentHash: tuple[6],
    stateVersion: tuple[7],
  };
}

export function cashLeg(tuple) {
  return {
    payer: tuple[0],
    receiver: tuple[1],
    amount: tuple[2],
    intentHash: tuple[3],
    state: CASH_LEG_STATE[tuple[4]] ?? String(tuple[4]),
  };
}

function required(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`missing environment: ${name}`);
  }
  return value.trim();
}

/**
 * The whole live configuration, assembled once.
 *
 * Independent Base providers are opt-in through `BASE_SEPOLIA_RPC_URLS`. When
 * only one is configured that is recorded rather than silently accepted: the
 * stale-read question cannot be answered by a single node, and a report that
 * does not say so would be claiming a check it never ran.
 */
export function loadDvpConfig(env = process.env) {
  const deployer = privateKeyToAccount(required(env, 'DEPLOYER_PRIVATE_KEY'));
  const complianceSigner = privateKeyToAccount(required(env, 'COMPLIANCE_SIGNER_PRIVATE_KEY'));

  const monad = createChain({
    name: 'monadTestnet',
    chainId: MONAD_EVM_CHAIN_ID,
    rpcUrls: rpcUrlsFrom(env, 'MONAD_TESTNET_RPC_URL', 'MONAD_TESTNET_RPC_URLS'),
    account: deployer,
    explorer: 'https://testnet.monadexplorer.com',
  });
  const base = createChain({
    name: 'baseSepolia',
    chainId: BASE_EVM_CHAIN_ID,
    rpcUrls: rpcUrlsFrom(env, 'BASE_SEPOLIA_RPC_URL', 'BASE_SEPOLIA_RPC_URLS'),
    account: deployer,
    explorer: 'https://sepolia.basescan.org',
  });

  monad.wormholeChainId = MONAD_WORMHOLE_CHAIN_ID;
  base.wormholeChainId = BASE_WORMHOLE_CHAIN_ID;

  return {
    deployer,
    complianceSigner,
    monad,
    base,
    addresses: {
      coordinator: required(env, 'SETTLEMENT_COORDINATOR_ADDRESS'),
      escrow: required(env, 'CASH_ESCROW_ADDRESS'),
      cash: required(env, 'SETTLEMENT_CVA_ADDRESS'),
      rwa: required(env, 'RWA_CVA_ADDRESS'),
      adapter: required(env, 'RWA_CVA_ADAPTER_ADDRESS'),
      wormholeMonad: required(env, 'WORMHOLE_CORE_MONAD_TESTNET'),
      wormholeBase: required(env, 'WORMHOLE_CORE_BASE_SEPOLIA'),
      policyBase: required(env, 'CCP_POLICY_BASE_SEPOLIA'),
      policyMonad: required(env, 'CCP_POLICY_MONAD_TESTNET'),
    },
    deploymentId: required(env, 'CONDUIT_DEPLOYMENT_ID'),
    amounts: {
      cash: BigInt(env['DVP_CASH_AMOUNT'] ?? '25000000'),
      asset: BigInt(env['DVP_ASSET_AMOUNT'] ?? '500000'),
    },
    nonce: BigInt(env['DVP_NONCE'] ?? '1'),
    cleanverseChain: {
      cash: env['CLEANVERSE_CASH_CHAIN'] ?? 'monad',
      asset: env['CLEANVERSE_ASSET_CHAIN'] ?? 'base',
    },
  };
}

/**
 * The intent, and the ID both parties sign.
 *
 * Deadlines come from `now` so a rerun with the same nonce produces a different
 * settlement rather than colliding with the previous one's state. `nonce` is
 * what makes two economically identical trades distinct, and the deadlines make
 * a repeated nonce visible as a different ID rather than as a confusing
 * `LegAlreadyPrepared`.
 */
export function buildIntent(config, { buyer, seller, now = Math.floor(Date.now() / 1000) } = {}) {
  const payer = buyer ?? config.deployer.address;
  const holder = seller ?? config.deployer.address;

  const terms = {
    version: 1,
    cashChainId: BigInt(MONAD_EVM_CHAIN_ID),
    cashEscrow: config.addresses.escrow,
    cashAsset: config.addresses.cash,
    cashAmount: config.amounts.cash,
    cashPayer: payer,
    cashReceiver: holder,
    assetChainId: BigInt(BASE_EVM_CHAIN_ID),
    assetEscrow: config.addresses.rwa,
    assetToken: config.addresses.rwa,
    assetAmount: config.amounts.asset,
    assetSeller: holder,
    assetReceiver: payer,
    cashPolicyHash: keccak256(toHex(`cash-policy:${config.addresses.policyMonad}`)),
    assetPolicyHash: keccak256(toHex(`asset-policy:${config.addresses.policyBase}`)),
    prepareDeadline: BigInt(now + 3_600),
    commitDeadline: BigInt(now + 10_800),
    releaseDeadline: BigInt(now + 14_400),
    nonce: config.nonce,
  };

  const deployment = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: terms.cashChainId,
    verifyingContract: config.addresses.coordinator,
  };

  const problems = validateIntentTerms(terms, deployment);
  if (problems.length > 0) {
    throw new Error(`intent is not well formed: ${problems.join('; ')}`);
  }

  return { terms, deployment, settlementId: hashSettlementIntent(terms, deployment) };
}

/**
 * Rebuilds an intent from a previous run's evidence, and proves it is the same.
 *
 * The deadlines come from the clock at the start of a run, so a rerun derives a
 * different settlement ID and abandons the funded one. That is the correct
 * behaviour for a fresh run and the wrong behaviour after a transport outage
 * forty minutes in, with cash in escrow and a bond reserved.
 *
 * The reconstruction is checked against the recorded ID rather than trusted. A
 * field that round-tripped through JSON as the wrong type would otherwise
 * produce a plausible intent for a settlement that does not exist, and the first
 * symptom would be `IntentDoesNotMatchSettlementId` at the commit.
 */
export function resumeIntent(config, record) {
  const raw = record.intent;
  const terms = {
    version: Number(raw.version),
    cashChainId: BigInt(raw.cashChainId),
    cashEscrow: raw.cashEscrow,
    cashAsset: raw.cashAsset,
    cashAmount: BigInt(raw.cashAmount),
    cashPayer: raw.cashPayer,
    cashReceiver: raw.cashReceiver,
    assetChainId: BigInt(raw.assetChainId),
    assetEscrow: raw.assetEscrow,
    assetToken: raw.assetToken,
    assetAmount: BigInt(raw.assetAmount),
    assetSeller: raw.assetSeller,
    assetReceiver: raw.assetReceiver,
    cashPolicyHash: raw.cashPolicyHash,
    assetPolicyHash: raw.assetPolicyHash,
    prepareDeadline: BigInt(raw.prepareDeadline),
    commitDeadline: BigInt(raw.commitDeadline),
    releaseDeadline: BigInt(raw.releaseDeadline),
    nonce: BigInt(raw.nonce),
  };

  const deployment = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: terms.cashChainId,
    verifyingContract: config.addresses.coordinator,
  };
  const settlementId = hashSettlementIntent(terms, deployment);
  if (settlementId !== record.settlementId) {
    throw new Error(
      `resumed intent hashes to ${settlementId}, but the record says ${record.settlementId}`,
    );
  }

  return { terms, deployment, settlementId };
}

/** Ordered exactly as `SettlementIntentLib.SettlementIntent`. */
export function intentTuple(terms) {
  return [
    terms.version,
    terms.cashChainId,
    terms.cashEscrow,
    terms.cashAsset,
    terms.cashAmount,
    terms.cashPayer,
    terms.cashReceiver,
    terms.assetChainId,
    terms.assetEscrow,
    terms.assetToken,
    terms.assetAmount,
    terms.assetSeller,
    terms.assetReceiver,
    terms.cashPolicyHash,
    terms.assetPolicyHash,
    terms.prepareDeadline,
    terms.commitDeadline,
    terms.releaseDeadline,
    terms.nonce,
  ];
}

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
);

/**
 * Recomputes an EIP-712 domain separator the way both Solidity libraries do.
 *
 * Used to prove the value a contract reports is the value its constructor
 * arguments imply, rather than accepting whatever bytes come back.
 */
export function eip712DomainSeparator({ name, version, chainId, verifyingContract }) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toHex(name)),
        keccak256(toHex(version)),
        BigInt(chainId),
        verifyingContract,
      ],
    ),
  );
}

export function padEmitter(address) {
  return `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;
}

export function unpadEmitter(emitter) {
  return `0x${emitter.slice(-40)}`;
}

/** Pulls the Wormhole sequence out of a receipt the publishing call produced. */
export function sequenceFrom(receipt) {
  const [log] = parseEventLogs({
    abi: CORE_ABI,
    eventName: 'LogMessagePublished',
    logs: receipt.logs,
  });
  if (log === undefined) {
    throw new Error(`no LogMessagePublished in ${receipt.transactionHash}`);
  }
  return { sequence: log.args.sequence, consistencyLevel: log.args.consistencyLevel };
}

export const WORMHOLESCAN = 'https://api.testnet.wormholescan.io';

/**
 * Waits for a signed VAA, saying what it is waiting for while it waits.
 *
 * Both observations are reported: the fast one when guardians first sign at the
 * requested consistency, and the finalized one Conduit actually consumes. ADR-0013
 * publishes both numbers because showing only the fast one misrepresents
 * settlement and showing only the slow one understates the transport.
 */
export async function fetchVaa(
  emitterChainId,
  emitterAddress,
  sequence,
  { log, budgetMs = 2_700_000, label = 'VAA' } = {},
) {
  const url = `${WORMHOLESCAN}/v1/signed_vaa/${emitterChainId}/${emitterAddress.slice(2).toLowerCase()}/${sequence}`;
  const started = Date.now();
  let polls = 0;
  let failures = 0;
  let lastFailure;

  while (Date.now() - started < budgetMs) {
    polls += 1;
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      // `TypeError: fetch failed` on its own names no cause, and a forty-five
      // minute outage that prints only that is indistinguishable from a wrong
      // URL. The cause carries the DNS or socket code that says which.
      failures += 1;
      const cause = error?.cause;
      lastFailure = `${String(error)}${cause === undefined ? '' : ` (${cause.code ?? String(cause)})`}`;
      if (polls % 8 === 0) log?.step(`${label}: ${lastFailure} — ${failures} consecutive`);
      response = undefined;
    }

    if (response !== undefined && response.ok) {
      const body = await response.json();
      failures = 0;
      if (typeof body.vaaBytes === 'string') {
        const waited = Math.round((Date.now() - started) / 1000);
        log?.ok(`${label} available after ${waited}s`);
        return {
          vaa: `0x${Buffer.from(body.vaaBytes, 'base64').toString('hex')}`,
          waitSeconds: waited,
        };
      }
    }

    if (polls % 4 === 0) {
      log?.step(`${label}: waiting ${Math.round((Date.now() - started) / 1000)}s (${url})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }

  throw new Error(
    `${label} ${emitterChainId}/${sequence} never became available after ${polls} polls` +
      `${lastFailure === undefined ? '' : `; last transport failure ${lastFailure}`}` +
      `. The VAA may exist: check ${url} and resume with DVP_RESUME.`,
  );
}

/** Reads the consistency level out of a signed VAA's header. */
export function vaaConsistencyLevel(vaaHex) {
  const bytes = Buffer.from(vaaHex.slice(2), 'hex');
  const guardianSignatures = bytes[5];
  const bodyOffset = 6 + guardianSignatures * 66;
  // body: timestamp(4) nonce(4) emitterChain(2) emitterAddress(32) sequence(8) consistency(1)
  return bytes[bodyOffset + 50];
}

export function vaaEmitter(vaaHex) {
  const bytes = Buffer.from(vaaHex.slice(2), 'hex');
  const guardianSignatures = bytes[5];
  const bodyOffset = 6 + guardianSignatures * 66;
  return {
    emitterChainId: bytes.readUInt16BE(bodyOffset + 8),
    emitterAddress: `0x${bytes.subarray(bodyOffset + 10, bodyOffset + 42).toString('hex')}`,
    sequence: bytes.readBigUInt64BE(bodyOffset + 42),
    consistencyLevel: bytes[bodyOffset + 50],
  };
}

export { concatHex };

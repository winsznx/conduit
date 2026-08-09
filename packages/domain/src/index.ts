/**
 * @conduit-protocol/domain
 *
 * Protocol state machine, message codecs, EIP-712 intents, and the pure
 * reference model.
 *
 * Nothing here touches a chain, a clock, or the network. The phase 04 gate is
 * that this model and the contracts produce identical outcomes for generated
 * traces, which is only meaningful while the model is independent of them.
 */

export const PACKAGE_ID = '@conduit-protocol/domain';

export const IMPLEMENTATION_PHASE = '04';

export {
  AttestationProblem,
  checkAttestation,
  COMPLIANCE_ATTESTATION_TYPE,
  domainOf as attestationDomainOf,
  hashComplianceAttestation,
  type AttestationBinding,
  type AttestationDomain,
  type AttestationProblemValue,
  type ComplianceAttestation,
} from './attestation.js';

export {
  createSettlementIntent,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  domainOf,
  settlementIntentDomain,
  hashSettlementIntent,
  INTENT_VERSION,
  IntentProblem,
  SETTLEMENT_INTENT_TYPE,
  validateIntentTerms,
  type DeploymentDomain,
  type SettlementIntent,
  type SettlementIntentTerms,
} from './intent.js';

export {
  checkAll,
  checkAssetConservation,
  checkCashConservation,
  checkHeldValueDisposition,
  checkMonotonicTerminal,
  checkNoRefundAfterCommit,
  checkNoReleaseAfterAbort,
  checkSingleDecision,
  type InvariantViolation,
} from './invariants.js';

export {
  checkHeader,
  decodeHeader,
  encodeHeader,
  MESSAGE_HEADER_BYTES,
  MessageDecodeError,
  PROTOCOL_VERSION,
  type HeaderExpectation,
  type MessageHeader,
} from './messages.js';

export {
  apply,
  EMPTY_LEDGER,
  INITIAL_SETTLEMENT,
  SettlementEvent,
  type ApplyResult,
  type Command,
  type LedgerAmounts,
  type Settlement,
  type SettlementEventValue,
} from './model.js';

export {
  allowedFrom,
  canTransition,
  isTerminal,
  LegState,
  MESSAGE_TYPE_NAMES,
  MessageType,
  SettlementState,
  TERMINAL_STATES,
  wouldRefundAfterCommit,
  type LegStateValue,
  type MessageTypeValue,
  type SettlementStateValue,
} from './states.js';

export {
  AuthorityType,
  caseIdFor,
  conflictResolutionDigest,
  CONFLICT_RESOLUTION_TYPE,
  DESTINATION_RULE,
  DISPOSITION_ORDER_TYPE,
  dispositionOrderDigest,
  DispositionType,
  Leg,
  redirectsValue,
  type AuthorityTypeName,
  type AuthorityTypeValue,
  type ConflictResolution,
  type DispositionOrder,
  type DispositionTypeName,
  type DispositionTypeValue,
  type LegName,
  type LegValue,
} from './disposition.js';

export {
  isAwaitingFinality,
  isViewTerminal,
  NOTHING_OBSERVED,
  toViewState,
  ViewState,
  type FinalityObservation,
  type ViewProjection,
  type ViewStateValue,
} from './view-states.js';

export {
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
  type WormholeEmitter,
} from './identity.js';

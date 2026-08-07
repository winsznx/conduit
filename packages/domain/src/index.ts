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
  createSettlementIntent,
  domainOf,
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

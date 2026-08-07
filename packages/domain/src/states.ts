/**
 * The protocol state machine. PRD 7.
 *
 * States are monotonic and the transition table is closed: anything not listed
 * is forbidden, rather than merely undocumented. Two forbidden edges matter more
 * than the rest and are asserted separately, because they are the double-payout
 * class the whole design exists to close:
 *
 *   COMMIT_ISSUED -> ABORT_ISSUED   (invariant I4, no refund after COMMIT)
 *   release -> refund / refund -> release
 */

export const SettlementState = {
  NONE: 'NONE',
  CASH_PREPARED: 'CASH_PREPARED',
  ASSET_PREPARED: 'ASSET_PREPARED',
  READY: 'READY',
  COMMIT_ISSUED: 'COMMIT_ISSUED',
  ABORT_ISSUED: 'ABORT_ISSUED',
  SETTLED: 'SETTLED',
  ABORTED: 'ABORTED',
  HELD: 'HELD',
  CONTESTED: 'CONTESTED',
} as const;

export type SettlementStateValue = (typeof SettlementState)[keyof typeof SettlementState];

/**
 * PRD 7.2. The v1.1 override adds RESERVED and CANCELLED for the asset leg,
 * where the RWA CVA holds a reservation in the seller's wallet instead of moving
 * units into an escrow.
 */
export const LegState = {
  NONE: 'NONE',
  /** Cash leg: units are in escrow. Asset leg under v1.1: units are reserved in place. */
  PREPARED: 'PREPARED',
  COMMITTED: 'COMMITTED',
  RELEASED: 'RELEASED',
  RETURNED: 'RETURNED',
  HELD: 'HELD',
  DISPOSED: 'DISPOSED',
  /** v1.1 asset leg only: a pre-COMMIT reservation withdrawal. */
  CANCELLED: 'CANCELLED',
} as const;

export type LegStateValue = (typeof LegState)[keyof typeof LegState];

/** PRD 7.1. Every edge the protocol permits, and nothing else. */
const ALLOWED_TRANSITIONS: Readonly<Record<SettlementStateValue, readonly SettlementStateValue[]>> =
  Object.freeze({
    NONE: [SettlementState.CASH_PREPARED, SettlementState.ASSET_PREPARED],
    CASH_PREPARED: [SettlementState.READY, SettlementState.ABORT_ISSUED],
    ASSET_PREPARED: [SettlementState.READY, SettlementState.ABORT_ISSUED],
    READY: [SettlementState.COMMIT_ISSUED, SettlementState.ABORT_ISSUED],
    COMMIT_ISSUED: [SettlementState.SETTLED, SettlementState.HELD, SettlementState.CONTESTED],
    ABORT_ISSUED: [SettlementState.ABORTED, SettlementState.HELD, SettlementState.CONTESTED],
    HELD: [SettlementState.SETTLED, SettlementState.ABORTED, SettlementState.CONTESTED],
    CONTESTED: [SettlementState.SETTLED, SettlementState.ABORTED, SettlementState.HELD],
    // Terminal. PRD 7.1: "SETTLED -> any state" and "ABORTED -> any state" are
    // forbidden transitions.
    SETTLED: [],
    ABORTED: [],
  });

export const TERMINAL_STATES: ReadonlySet<SettlementStateValue> = new Set([
  SettlementState.SETTLED,
  SettlementState.ABORTED,
]);

export function isTerminal(state: SettlementStateValue): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: SettlementStateValue, to: SettlementStateValue): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function allowedFrom(state: SettlementStateValue): readonly SettlementStateValue[] {
  return ALLOWED_TRANSITIONS[state];
}

/**
 * Invariant I4, stated as its own predicate.
 *
 * `canTransition` already returns false for this edge, but a future change to
 * the table could silently open it. This is the single most important forbidden
 * transition in the protocol, so it gets a check that does not depend on the
 * table being right.
 */
export function wouldRefundAfterCommit(
  from: SettlementStateValue,
  to: SettlementStateValue,
): boolean {
  return from === SettlementState.COMMIT_ISSUED && to === SettlementState.ABORT_ISSUED;
}

/** PRD 7.3. */
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
} as const;

export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

export const MESSAGE_TYPE_NAMES: Readonly<Record<MessageTypeValue, string>> = Object.freeze({
  0: 'CASH_PREPARED',
  1: 'ASSET_PREPARED',
  2: 'COMMIT',
  3: 'ABORT',
  4: 'CASH_RELEASED',
  5: 'ASSET_RELEASED',
  6: 'CASH_HELD',
  7: 'ASSET_HELD',
  8: 'DISPOSITION_RESOLVED',
});

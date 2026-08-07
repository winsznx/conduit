import type { LedgerAmounts, Settlement } from './model.js';
import { isTerminal, LegState, SettlementState } from './states.js';

/**
 * The fundamental invariants. PRD 14.4.
 *
 * These are written as checks over a settlement rather than as prose, so the
 * property tests and the Foundry invariant suite assert the same thing. Each
 * returns a violation string or nothing, and the identifiers match the threat
 * register exactly.
 */

export interface InvariantViolation {
  readonly id: string;
  readonly detail: string;
}

/** I1: cash locked = released + returned + held + fee. */
export function checkCashConservation(settlement: Settlement): InvariantViolation | undefined {
  return conservation('I1', 'cash', settlement.cash, isTerminal(settlement.state));
}

/** I2: asset locked = released + returned + held. */
export function checkAssetConservation(settlement: Settlement): InvariantViolation | undefined {
  // PRD 14.4 gives the asset leg no fee term: PRD 8.6 charges the protocol fee
  // only from a successfully settled cash leg.
  if (settlement.asset.fee !== 0n) {
    return { id: 'I2', detail: 'asset leg carries a fee, which PRD 8.6 does not permit' };
  }
  return conservation('I2', 'asset', settlement.asset, isTerminal(settlement.state));
}

/**
 * PRD 14.4 states I1 and I2 as equations, and they are — but only once the
 * settlement is terminal.
 *
 * A property test caught the gap immediately: right after a leg is prepared,
 * value is locked and nothing is yet released, returned, held, or charged. That
 * is not a conservation failure, it is escrow doing its job. The missing term is
 * the balance still awaiting a decision.
 *
 * So the invariant holds in two parts, and both matter:
 *
 *   always     accounted <= locked        nothing is allocated twice
 *   terminal   accounted == locked        nothing is stranded
 *
 * Checking only the equation would reject every healthy in-flight settlement.
 * Checking only the inequality would let a terminal settlement silently lose
 * value.
 */
function conservation(
  id: string,
  label: string,
  ledger: LedgerAmounts,
  terminal: boolean,
): InvariantViolation | undefined {
  const accounted = ledger.released + ledger.returned + ledger.held + ledger.fee;
  const breakdown = `released ${String(ledger.released)}, returned ${String(ledger.returned)}, held ${String(ledger.held)}, fee ${String(ledger.fee)}`;

  if (accounted > ledger.locked) {
    return {
      id,
      detail: `${label}: allocated ${String(accounted)} against only ${String(ledger.locked)} locked (${breakdown})`,
    };
  }

  if (terminal && accounted !== ledger.locked) {
    return {
      id,
      detail: `${label}: terminal settlement leaves ${String(ledger.locked - accounted)} unaccounted (locked ${String(ledger.locked)}, ${breakdown})`,
    };
  }

  return undefined;
}

/** I3: at most one COMMIT or one ABORT. */
export function checkSingleDecision(settlement: Settlement): InvariantViolation | undefined {
  const decided =
    settlement.state === SettlementState.COMMIT_ISSUED ||
    settlement.state === SettlementState.ABORT_ISSUED ||
    isTerminal(settlement.state) ||
    settlement.state === SettlementState.HELD ||
    settlement.state === SettlementState.CONTESTED;

  if (decided && settlement.decision === 'NONE') {
    return { id: 'I3', detail: `state ${settlement.state} reached without a recorded decision` };
  }
  return undefined;
}

/**
 * I4: no refund after COMMIT.
 *
 * A returned leg on a settlement whose decision was COMMIT means value went back
 * to a payer after the point of no return. This is the double-payout window the
 * protocol exists to close.
 */
export function checkNoRefundAfterCommit(settlement: Settlement): InvariantViolation | undefined {
  const committed =
    settlement.cashLeg === LegState.COMMITTED ||
    settlement.cashLeg === LegState.RELEASED ||
    settlement.assetLeg === LegState.COMMITTED ||
    settlement.assetLeg === LegState.RELEASED;

  if (!committed) return undefined;

  if (settlement.cash.returned > 0n || settlement.asset.returned > 0n) {
    return {
      id: 'I4',
      detail: 'a leg was returned on a settlement that had already committed',
    };
  }
  return undefined;
}

/** I5: no release after a terminal abort. */
export function checkNoReleaseAfterAbort(settlement: Settlement): InvariantViolation | undefined {
  if (settlement.state !== SettlementState.ABORTED) return undefined;

  if (settlement.cash.released > 0n || settlement.asset.released > 0n) {
    return { id: 'I5', detail: 'value was released on an aborted settlement' };
  }
  return undefined;
}

/** I9: held value is claimable only through the Disposition Kernel. */
export function checkHeldValueDisposition(settlement: Settlement): InvariantViolation | undefined {
  const heldWithoutHoldState =
    (settlement.cash.held > 0n && settlement.cashLeg !== LegState.HELD) ||
    (settlement.asset.held > 0n && settlement.assetLeg !== LegState.HELD);

  if (heldWithoutHoldState) {
    return { id: 'I9', detail: 'a held balance exists on a leg that is not in HELD' };
  }
  return undefined;
}

/** I10: a terminal settlement has both legs finished. */
export function checkMonotonicTerminal(settlement: Settlement): InvariantViolation | undefined {
  if (!isTerminal(settlement.state)) return undefined;

  const unfinished = [settlement.cashLeg, settlement.assetLeg].filter(
    (leg) => leg === LegState.NONE || leg === LegState.PREPARED || leg === LegState.COMMITTED,
  );

  if (unfinished.length > 0) {
    return {
      id: 'I10',
      detail: `terminal state ${settlement.state} with an unfinished leg`,
    };
  }
  return undefined;
}

const CHECKS = [
  checkCashConservation,
  checkAssetConservation,
  checkSingleDecision,
  checkNoRefundAfterCommit,
  checkNoReleaseAfterAbort,
  checkHeldValueDisposition,
  checkMonotonicTerminal,
] as const;

/**
 * Runs every invariant. Used after each step of a generated trace, so a
 * violation is attributed to the command that caused it rather than discovered
 * at the end.
 */
export function checkAll(settlement: Settlement): InvariantViolation[] {
  return CHECKS.map((check) => check(settlement)).filter(
    (violation): violation is InvariantViolation => violation !== undefined,
  );
}

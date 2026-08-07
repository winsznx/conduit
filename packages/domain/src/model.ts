import {
  canTransition,
  LegState,
  type LegStateValue,
  SettlementState,
  type SettlementStateValue,
  wouldRefundAfterCommit,
} from './states.js';

/**
 * The pure reference model. PRD 19 phase 04.
 *
 * The phase 04 gate is "reference model and contracts produce identical outcomes
 * for generated traces". This is that model: a total, side-effect-free function
 * from state and event to state, with no chain, no clock, and no I/O.
 *
 * Two rules shape everything below, and both came out of property tests rather
 * than from reading the PRD carefully enough the first time.
 *
 * **The decision is a kind, not a flag.** An earlier version tracked only
 * "a decision was issued". That let a release run on an aborted settlement and a
 * return run on a committed one, because both look identical to a boolean. The
 * direction of the decision is what makes I4 and I5 different rules.
 *
 * **Transfers are all-or-nothing.** PRD FR-004 makes the prepared amount
 * immutable and PRD FR-007 requires exact amounts. Allowing a partial or
 * zero-amount move let a leg reach RELEASED or RETURNED while value was still
 * outstanding, which broke conservation and left held balances stranded on legs
 * that claimed to be finished.
 */

export const SettlementEvent = {
  PREPARE_CASH: 'PREPARE_CASH',
  PREPARE_ASSET: 'PREPARE_ASSET',
  ISSUE_COMMIT: 'ISSUE_COMMIT',
  ISSUE_ABORT: 'ISSUE_ABORT',
  RELEASE_CASH: 'RELEASE_CASH',
  RELEASE_ASSET: 'RELEASE_ASSET',
  HOLD_CASH: 'HOLD_CASH',
  HOLD_ASSET: 'HOLD_ASSET',
  RETURN_CASH: 'RETURN_CASH',
  RETURN_ASSET: 'RETURN_ASSET',
  DISPOSE_CASH: 'DISPOSE_CASH',
  DISPOSE_ASSET: 'DISPOSE_ASSET',
  RAISE_CONFLICT: 'RAISE_CONFLICT',
} as const;

export type SettlementEventValue = (typeof SettlementEvent)[keyof typeof SettlementEvent];

/** Which way the single canonical decision went. PRD FR-007, invariant I3. */
export const Decision = {
  NONE: 'NONE',
  COMMIT: 'COMMIT',
  ABORT: 'ABORT',
} as const;

export type DecisionValue = (typeof Decision)[keyof typeof Decision];

export interface LedgerAmounts {
  readonly locked: bigint;
  readonly released: bigint;
  readonly returned: bigint;
  readonly held: bigint;
  readonly fee: bigint;
}

export interface Settlement {
  readonly state: SettlementStateValue;
  readonly cashLeg: LegStateValue;
  readonly assetLeg: LegStateValue;
  readonly cash: LedgerAmounts;
  readonly asset: LedgerAmounts;
  readonly decision: DecisionValue;
}

export const EMPTY_LEDGER: LedgerAmounts = Object.freeze({
  locked: 0n,
  released: 0n,
  returned: 0n,
  held: 0n,
  fee: 0n,
});

export const INITIAL_SETTLEMENT: Settlement = Object.freeze({
  state: SettlementState.NONE,
  cashLeg: LegState.NONE,
  assetLeg: LegState.NONE,
  cash: EMPTY_LEDGER,
  asset: EMPTY_LEDGER,
  decision: Decision.NONE,
});

export interface Command {
  readonly event: SettlementEventValue;
  readonly amount?: bigint;
  readonly fee?: bigint;
}

export type ApplyResult =
  | { readonly ok: true; readonly settlement: Settlement }
  | { readonly ok: false; readonly reason: string };

function reject(reason: string): ApplyResult {
  return { ok: false, reason };
}

/** Value that has been locked but not yet released, returned, or charged. */
function outstanding(ledger: LedgerAmounts): bigint {
  return ledger.locked - ledger.released - ledger.returned - ledger.fee;
}

function isCashEvent(event: SettlementEventValue): boolean {
  return (
    event === SettlementEvent.RELEASE_CASH ||
    event === SettlementEvent.HOLD_CASH ||
    event === SettlementEvent.RETURN_CASH ||
    event === SettlementEvent.DISPOSE_CASH
  );
}

function withLeg(
  settlement: Settlement,
  cash: boolean,
  leg: LegStateValue,
  ledger: LedgerAmounts,
): Settlement {
  return cash
    ? { ...settlement, cashLeg: leg, cash: ledger }
    : { ...settlement, assetLeg: leg, asset: ledger };
}

/**
 * The whole model.
 *
 * Every rejection returns a reason rather than throwing, so a generated trace
 * can drive the model through thousands of invalid commands and compare the
 * refusals against the contract's reverts.
 */
export function apply(settlement: Settlement, command: Command): ApplyResult {
  const { event } = command;
  const amount = command.amount ?? 0n;

  switch (event) {
    case SettlementEvent.PREPARE_CASH:
    case SettlementEvent.PREPARE_ASSET: {
      const cash = event === SettlementEvent.PREPARE_CASH;
      const leg = cash ? settlement.cashLeg : settlement.assetLeg;

      if (settlement.decision !== Decision.NONE) {
        return reject('cannot prepare after a commit or abort');
      }
      if (leg !== LegState.NONE) return reject('leg already prepared');
      if (amount <= 0n) return reject('prepared amount must be positive');

      const other = cash ? settlement.assetLeg : settlement.cashLeg;
      const next =
        other === LegState.PREPARED
          ? SettlementState.READY
          : cash
            ? SettlementState.CASH_PREPARED
            : SettlementState.ASSET_PREPARED;

      const ledger = cash ? settlement.cash : settlement.asset;
      return {
        ok: true,
        settlement: {
          ...withLeg(settlement, cash, LegState.PREPARED, {
            ...ledger,
            locked: ledger.locked + amount,
          }),
          state: next,
        },
      };
    }

    case SettlementEvent.ISSUE_COMMIT: {
      if (settlement.decision !== Decision.NONE) {
        return reject('a commit or abort has already been issued');
      }
      if (settlement.state !== SettlementState.READY) return reject('both legs must be prepared');

      return {
        ok: true,
        settlement: {
          ...settlement,
          state: SettlementState.COMMIT_ISSUED,
          cashLeg: LegState.COMMITTED,
          assetLeg: LegState.COMMITTED,
          decision: Decision.COMMIT,
        },
      };
    }

    case SettlementEvent.ISSUE_ABORT: {
      // Invariant I4, checked before the transition table so the reason names
      // the actual rule rather than reporting a generic illegal edge.
      if (wouldRefundAfterCommit(settlement.state, SettlementState.ABORT_ISSUED)) {
        return reject('no refund after COMMIT');
      }
      if (settlement.decision !== Decision.NONE) {
        return reject('a commit or abort has already been issued');
      }
      if (!canTransition(settlement.state, SettlementState.ABORT_ISSUED)) {
        return reject(`cannot abort from ${settlement.state}`);
      }

      return {
        ok: true,
        settlement: {
          ...settlement,
          state: SettlementState.ABORT_ISSUED,
          decision: Decision.ABORT,
        },
      };
    }

    case SettlementEvent.RELEASE_CASH:
    case SettlementEvent.RELEASE_ASSET: {
      const cash = isCashEvent(event);
      const leg = cash ? settlement.cashLeg : settlement.assetLeg;
      const ledger = cash ? settlement.cash : settlement.asset;

      // Only a commit authorizes a release. On an abort path, held value moves
      // through the Disposition Kernel instead (invariant I9).
      if (settlement.decision !== Decision.COMMIT) {
        return reject('release requires a canonical commit');
      }
      if (leg !== LegState.COMMITTED && leg !== LegState.HELD) {
        return reject(`cannot release a leg in ${leg}`);
      }

      const fee = cash ? (command.fee ?? 0n) : 0n;
      const payable = outstanding(ledger);
      if (amount <= 0n) return reject('release amount must be positive');
      if (amount + fee !== payable) {
        return reject('release must move the exact outstanding balance');
      }

      const updated: LedgerAmounts = {
        ...ledger,
        released: ledger.released + amount,
        fee: ledger.fee + fee,
        held: 0n,
      };

      return {
        ok: true,
        settlement: settleIfComplete(withLeg(settlement, cash, LegState.RELEASED, updated)),
      };
    }

    case SettlementEvent.HOLD_CASH:
    case SettlementEvent.HOLD_ASSET: {
      const cash = isCashEvent(event);
      const leg = cash ? settlement.cashLeg : settlement.assetLeg;
      const ledger = cash ? settlement.cash : settlement.asset;

      // A hold is what happens when a decided settlement cannot move value to
      // its destination. Holding before any decision would let a leg reach HELD
      // from CASH_PREPARED, which PRD 7.1 does not permit.
      if (settlement.decision === Decision.NONE) {
        return reject('cannot hold before a commit or abort');
      }
      if (
        settlement.state !== SettlementState.HELD &&
        !canTransition(settlement.state, SettlementState.HELD)
      ) {
        return reject(`cannot hold from ${settlement.state}`);
      }
      if (leg !== LegState.COMMITTED && leg !== LegState.PREPARED) {
        return reject(`cannot hold a leg in ${leg}`);
      }
      if (amount <= 0n) return reject('held amount must be positive');
      if (amount !== outstanding(ledger)) {
        return reject('hold must cover the exact outstanding balance');
      }

      return {
        ok: true,
        settlement: {
          ...withLeg(settlement, cash, LegState.HELD, { ...ledger, held: amount }),
          state: SettlementState.HELD,
        },
      };
    }

    case SettlementEvent.RETURN_CASH:
    case SettlementEvent.RETURN_ASSET: {
      const cash = isCashEvent(event);
      const leg = cash ? settlement.cashLeg : settlement.assetLeg;
      const ledger = cash ? settlement.cash : settlement.asset;

      // Invariant I4 from the other direction: a return is a refund, and only an
      // abort authorizes one. A return before any decision is equally forbidden,
      // because nothing has established that the settlement is failing.
      if (settlement.decision !== Decision.ABORT) {
        return reject('no refund after COMMIT');
      }
      if (leg !== LegState.PREPARED && leg !== LegState.HELD) {
        return reject(`cannot return a leg in ${leg}`);
      }
      if (amount <= 0n) return reject('return amount must be positive');
      if (amount !== outstanding(ledger)) {
        return reject('return must move the exact outstanding balance');
      }

      const updated: LedgerAmounts = {
        ...ledger,
        returned: ledger.returned + amount,
        held: 0n,
      };

      return {
        ok: true,
        settlement: abortIfComplete(withLeg(settlement, cash, LegState.RETURNED, updated)),
      };
    }

    case SettlementEvent.DISPOSE_CASH:
    case SettlementEvent.DISPOSE_ASSET: {
      const cash = isCashEvent(event);
      const leg = cash ? settlement.cashLeg : settlement.assetLeg;
      const ledger = cash ? settlement.cash : settlement.asset;

      // Invariant I9: held value moves only through the Disposition Kernel, and
      // only out of HELD.
      if (leg !== LegState.HELD) return reject('only a held leg can be disposed');
      if (amount <= 0n) return reject('disposition amount must be positive');
      if (amount !== ledger.held) {
        return reject('disposition must move the exact held balance');
      }

      const updated: LedgerAmounts = {
        ...ledger,
        released: ledger.released + amount,
        held: 0n,
      };

      const disposed = withLeg(settlement, cash, LegState.DISPOSED, updated);
      return {
        ok: true,
        settlement:
          settlement.decision === Decision.ABORT
            ? abortIfComplete(disposed)
            : settleIfComplete(disposed),
      };
    }

    case SettlementEvent.RAISE_CONFLICT: {
      if (!canTransition(settlement.state, SettlementState.CONTESTED)) {
        return reject(`cannot contest from ${settlement.state}`);
      }
      return { ok: true, settlement: { ...settlement, state: SettlementState.CONTESTED } };
    }

    default:
      return reject(`unknown event ${String(event)}`);
  }
}

/** A leg that will never move again. */
const FINISHED_LEGS: ReadonlySet<LegStateValue> = new Set([
  LegState.RELEASED,
  LegState.RETURNED,
  LegState.DISPOSED,
]);

function bothFinished(settlement: Settlement): boolean {
  return FINISHED_LEGS.has(settlement.cashLeg) && FINISHED_LEGS.has(settlement.assetLeg);
}

/**
 * PRD FR-011: SETTLED only once both legs have reached a terminal disposition.
 *
 * This advances or does nothing. An earlier version forced the state back to
 * COMMIT_ISSUED whenever one leg finished without its partner, which a property
 * test caught fabricating a commit on a settlement that never had one — and a
 * fabricated commit is what makes a refund look permitted.
 */
function settleIfComplete(settlement: Settlement): Settlement {
  return bothFinished(settlement) ? { ...settlement, state: SettlementState.SETTLED } : settlement;
}

/**
 * PRD 5.2: ABORTED only when both legs are returned. If either leg had to be
 * held and then disposed, the settlement is not a clean abort, so it lands in
 * SETTLED — value moved to a destination rather than back to its origin.
 */
function abortIfComplete(settlement: Settlement): Settlement {
  if (!bothFinished(settlement)) return settlement;

  const bothReturned =
    settlement.cashLeg === LegState.RETURNED && settlement.assetLeg === LegState.RETURNED;

  return {
    ...settlement,
    state: bothReturned ? SettlementState.ABORTED : SettlementState.SETTLED,
  };
}

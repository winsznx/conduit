/**
 * View states. ADR-0013.
 *
 * Conduit requires FINALIZED for every message that authorizes value, and Base's
 * finalized path is roughly eighteen minutes. A user watching a settlement over
 * that window needs to see it progressing, and the canonical state machine has
 * nothing to say during the wait: it stays in `CASH_PREPARED` from the moment the
 * first leg prepares until the second leg's finalized VAA arrives.
 *
 * The fix is a projection, not more on-chain states. Adding `FINALITY_PENDING` to
 * the protocol machine would put a transport concern inside the transition table
 * and change what the invariants mean, because "no refund after COMMIT" is a
 * claim about the canonical state and would then also have to reason about the
 * observation status of every message.
 *
 * So: the canonical state is the truth, the view state is derived from it plus
 * what the observer has seen, and the derivation is one pure function that
 * authorizes nothing. Two properties make that safe, and both are tested:
 *
 *   - the mapping is total, so a canonical state can never render as blank;
 *   - `authorizes` is false for every view state, so no caller can mistake a
 *     projection for a decision. Only the chain decides.
 */

import { SettlementState, type SettlementStateValue } from './states.js';

export const ViewState = {
  /** Nothing observed. */
  AWAITING_PREPARE: 'AWAITING_PREPARE',
  /**
   * A PREPARED message has been seen below settlement finality. Real, signed,
   * and not yet usable: the source state behind it can still be reorganised.
   */
  PREPARED_FAST: 'PREPARED_FAST',
  /** Prepared and waiting for the source chain to finalize. This is the wait. */
  FINALITY_PENDING: 'FINALITY_PENDING',
  /** Both legs prepared at settlement finality. COMMIT may now be issued. */
  READY_FINAL: 'READY_FINAL',
  /** COMMIT consumed. Economically irreversible: no refund follows. */
  COMMITTED: 'COMMITTED',
  /** Releases in flight. */
  EXECUTING: 'EXECUTING',
  /** Both releases observed, at least one below settlement finality. */
  SETTLED_PENDING_FINALITY: 'SETTLED_PENDING_FINALITY',
  /** Terminal and final. */
  SETTLED_FINAL: 'SETTLED_FINAL',
  /** Terminal, no value moved. */
  ABORTED: 'ABORTED',
  /** Post-COMMIT compliance refusal. Value is held, awaiting disposition. */
  HELD: 'HELD',
  /** Conflicting evidence. Deliberately not terminal. */
  CONTESTED: 'CONTESTED',
} as const;

export type ViewStateValue = (typeof ViewState)[keyof typeof ViewState];

/**
 * What an observer has seen, separate from what the chain has decided.
 *
 * `bothLegsPreparedFinal` is not derivable from the canonical state: `READY`
 * means both legs prepared, and says nothing about the finality of the VAAs that
 * carried them. That is exactly the distinction this module exists to render.
 */
export interface FinalityObservation {
  /** A PREPARED message seen at any consistency level, final or not. */
  readonly anyLegPreparedFast: boolean;
  /** Every prepare needed for READY has been observed at settlement finality. */
  readonly bothLegsPreparedFinal: boolean;
  /** Every release has been observed at settlement finality. */
  readonly releasesFinal: boolean;
}

export const NOTHING_OBSERVED: FinalityObservation = Object.freeze({
  anyLegPreparedFast: false,
  bothLegsPreparedFinal: false,
  releasesFinal: false,
});

export interface ViewProjection {
  readonly view: ViewStateValue;
  /** One line, written for a person watching a settlement rather than for a log. */
  readonly explanation: string;
  /**
   * Always false. A view state is a rendering of what happened, never a reason
   * for anything to happen. The field exists so the guarantee is visible at the
   * call site instead of living only in a comment.
   */
  readonly authorizes: false;
}

const project = (view: ViewStateValue, explanation: string): ViewProjection =>
  Object.freeze({ view, explanation, authorizes: false as const });

/**
 * Total over `SettlementStateValue`. A canonical state with no case here is a
 * compile error, not a blank screen.
 */
export function toViewState(
  state: SettlementStateValue,
  observed: FinalityObservation = NOTHING_OBSERVED,
): ViewProjection {
  switch (state) {
    case SettlementState.NONE:
      return observed.anyLegPreparedFast
        ? project(
            ViewState.PREPARED_FAST,
            'A prepare has been observed but not yet finalized on its source chain.',
          )
        : project(ViewState.AWAITING_PREPARE, 'Waiting for the first leg to prepare.');

    case SettlementState.CASH_PREPARED:
      return project(ViewState.FINALITY_PENDING, 'Cash is locked. Waiting on the asset leg.');

    case SettlementState.ASSET_PREPARED:
      return project(ViewState.FINALITY_PENDING, 'The asset is reserved. Waiting on the cash leg.');

    case SettlementState.READY:
      return observed.bothLegsPreparedFinal
        ? project(ViewState.READY_FINAL, 'Both legs are prepared and final. Ready to commit.')
        : project(
            ViewState.FINALITY_PENDING,
            'Both legs are prepared. Waiting for source-chain finality before commit.',
          );

    case SettlementState.COMMIT_ISSUED:
      return project(
        ViewState.COMMITTED,
        'Committed. This settlement can no longer be refunded; both legs will release.',
      );

    case SettlementState.ABORT_ISSUED:
      return project(ViewState.EXECUTING, 'Aborting. Both legs are returning to their owners.');

    case SettlementState.SETTLED:
      return observed.releasesFinal
        ? project(ViewState.SETTLED_FINAL, 'Settled. Both releases are final on their chains.')
        : project(
            ViewState.SETTLED_PENDING_FINALITY,
            'Settled on chain. Waiting for the releases to finalize.',
          );

    case SettlementState.ABORTED:
      return project(ViewState.ABORTED, 'Aborted. No value moved.');

    case SettlementState.HELD:
      return project(
        ViewState.HELD,
        'Held after commit: a compliance check refused the transfer. Awaiting disposition.',
      );

    case SettlementState.CONTESTED:
      return project(ViewState.CONTESTED, 'Contested. Conflicting evidence is under review.');
  }
}

/**
 * Whether a view state means the user is waiting on a chain rather than on a
 * counterparty or an authority. Drives whether a progress indicator is honest.
 */
export function isAwaitingFinality(view: ViewStateValue): boolean {
  return (
    view === ViewState.PREPARED_FAST ||
    view === ViewState.FINALITY_PENDING ||
    view === ViewState.SETTLED_PENDING_FINALITY
  );
}

/** Terminal in the view sense: nothing further will happen without intervention. */
export function isViewTerminal(view: ViewStateValue): boolean {
  return view === ViewState.SETTLED_FINAL || view === ViewState.ABORTED;
}

import { describe, expect, it } from 'vitest';

import { SettlementState, type SettlementStateValue } from './states.js';
import {
  isAwaitingFinality,
  isViewTerminal,
  NOTHING_OBSERVED,
  toViewState,
  ViewState,
  type FinalityObservation,
} from './view-states.js';

const ALL_STATES = Object.values(SettlementState) as SettlementStateValue[];

const observed = (over: Partial<FinalityObservation> = {}): FinalityObservation => ({
  ...NOTHING_OBSERVED,
  ...over,
});

describe('view states (ADR-0013)', () => {
  it('projects every canonical state', () => {
    for (const state of ALL_STATES) {
      const { view, explanation } = toViewState(state);
      expect(Object.values(ViewState), `${state} projected to "${view}"`).toContain(view);
      expect(explanation.length).toBeGreaterThan(0);
    }
  });

  it('never authorizes anything', () => {
    // The whole risk of a derived state layer is that something downstream reads
    // READY_FINAL and treats it as permission. Only the chain decides.
    for (const state of ALL_STATES) {
      for (const flag of [true, false]) {
        const projection = toViewState(
          state,
          observed({ anyLegPreparedFast: flag, bothLegsPreparedFinal: flag, releasesFinal: flag }),
        );
        expect(projection.authorizes).toBe(false);
      }
    }
  });

  it('separates a fast prepare from a final one', () => {
    expect(toViewState(SettlementState.NONE).view).toBe(ViewState.AWAITING_PREPARE);
    expect(toViewState(SettlementState.NONE, observed({ anyLegPreparedFast: true })).view).toBe(
      ViewState.PREPARED_FAST,
    );
  });

  it('does not show READY_FINAL until both prepares are final', () => {
    // READY means both legs prepared. It says nothing about the finality of the
    // VAAs that carried them, which is exactly the gap this layer renders.
    expect(toViewState(SettlementState.READY).view).toBe(ViewState.FINALITY_PENDING);
    expect(toViewState(SettlementState.READY, observed({ bothLegsPreparedFinal: true })).view).toBe(
      ViewState.READY_FINAL,
    );
  });

  it('distinguishes settled-on-chain from settled-and-final', () => {
    expect(toViewState(SettlementState.SETTLED).view).toBe(ViewState.SETTLED_PENDING_FINALITY);
    expect(toViewState(SettlementState.SETTLED, observed({ releasesFinal: true })).view).toBe(
      ViewState.SETTLED_FINAL,
    );
  });

  it('renders commit as irreversible', () => {
    const { view, explanation } = toViewState(SettlementState.COMMIT_ISSUED);
    expect(view).toBe(ViewState.COMMITTED);
    expect(explanation).toContain('no longer be refunded');
  });

  it('renders held and contested rather than hiding them', () => {
    expect(toViewState(SettlementState.HELD).view).toBe(ViewState.HELD);
    expect(toViewState(SettlementState.CONTESTED).view).toBe(ViewState.CONTESTED);
  });

  it('marks only real waits as awaiting finality', () => {
    expect(isAwaitingFinality(ViewState.PREPARED_FAST)).toBe(true);
    expect(isAwaitingFinality(ViewState.FINALITY_PENDING)).toBe(true);
    expect(isAwaitingFinality(ViewState.SETTLED_PENDING_FINALITY)).toBe(true);

    expect(isAwaitingFinality(ViewState.COMMITTED)).toBe(false);
    expect(isAwaitingFinality(ViewState.HELD)).toBe(false);
    expect(isAwaitingFinality(ViewState.SETTLED_FINAL)).toBe(false);
  });

  it('treats held and contested as non-terminal in the view', () => {
    expect(isViewTerminal(ViewState.SETTLED_FINAL)).toBe(true);
    expect(isViewTerminal(ViewState.ABORTED)).toBe(true);
    expect(isViewTerminal(ViewState.HELD)).toBe(false);
    expect(isViewTerminal(ViewState.CONTESTED)).toBe(false);
  });

  it('is a pure projection with no state of its own', () => {
    const a = toViewState(SettlementState.READY, observed({ bothLegsPreparedFinal: true }));
    const b = toViewState(SettlementState.READY, observed({ bothLegsPreparedFinal: true }));
    expect(a).toStrictEqual(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { checkAll } from './invariants.js';
import {
  apply,
  type ApplyResult,
  type Command,
  INITIAL_SETTLEMENT,
  type Settlement,
  SettlementEvent,
  type SettlementEventValue,
} from './model.js';
import { canTransition, LegState, SettlementState } from './states.js';

/**
 * The reference model. PRD 19 phase 04.
 *
 * The scripted tests below fix the behaviour the PRD names explicitly. The
 * property tests then drive thousands of generated traces and assert that no
 * reachable state violates a PRD 14.4 invariant — which is the check that finds
 * the sequences nobody thought to write down.
 */

function run(commands: readonly Command[]): ApplyResult {
  let settlement: Settlement = INITIAL_SETTLEMENT;

  for (const command of commands) {
    const result = apply(settlement, command);
    if (!result.ok) return result;
    settlement = result.settlement;
  }

  return { ok: true, settlement };
}

function expectOk(result: ApplyResult): Settlement {
  if (!result.ok) throw new Error(`expected success, got: ${result.reason}`);
  return result.settlement;
}

function expectRejected(result: ApplyResult): string {
  if (result.ok) throw new Error('expected the command to be rejected');
  return result.reason;
}

/** bigint has no JSON representation, so snapshots stringify it explicitly. */
function snapshot(settlement: Settlement): string {
  return JSON.stringify(settlement, (_key: string, value: unknown): unknown =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

const prepareCash: Command = { event: SettlementEvent.PREPARE_CASH, amount: 1_000n };
const prepareAsset: Command = { event: SettlementEvent.PREPARE_ASSET, amount: 50n };
const prepareBoth: Command[] = [prepareCash, prepareAsset];

describe('preparation', () => {
  it('reaches READY only once both legs are prepared', () => {
    const afterCash = expectOk(run([prepareCash]));
    expect(afterCash.state).toBe(SettlementState.CASH_PREPARED);

    const afterBoth = expectOk(run(prepareBoth));
    expect(afterBoth.state).toBe(SettlementState.READY);
  });

  it('reaches READY regardless of which leg prepares first', () => {
    const cashFirst = expectOk(run(prepareBoth));
    const assetFirst = expectOk(run([...prepareBoth].reverse()));

    expect(cashFirst.state).toBe(assetFirst.state);
    expect(assetFirst.state).toBe(SettlementState.READY);
  });

  it('refuses to prepare a leg twice (PRD FR-004: cash may be prepared once)', () => {
    const result = run([...prepareBoth, { event: SettlementEvent.PREPARE_CASH, amount: 1n }]);

    expect(expectRejected(result)).toContain('already prepared');
  });

  it('refuses a zero amount', () => {
    expect(run([{ event: SettlementEvent.PREPARE_CASH, amount: 0n }]).ok).toBe(false);
  });
});

describe('the canonical decision (PRD FR-007, invariant I3)', () => {
  it('refuses to commit before both legs are prepared', () => {
    const result = run([prepareCash, { event: SettlementEvent.ISSUE_COMMIT }]);

    expect(expectRejected(result)).toContain('both legs must be prepared');
  });

  it('commits from READY', () => {
    const settlement = expectOk(run([...prepareBoth, { event: SettlementEvent.ISSUE_COMMIT }]));

    expect(settlement.state).toBe(SettlementState.COMMIT_ISSUED);
    expect(settlement.decision).toBe('COMMIT');
  });

  it('refuses a second commit', () => {
    const result = run([
      ...prepareBoth,
      { event: SettlementEvent.ISSUE_COMMIT },
      { event: SettlementEvent.ISSUE_COMMIT },
    ]);

    expect(expectRejected(result)).toContain('already been issued');
  });

  it('aborts before commit', () => {
    const settlement = expectOk(run([...prepareBoth, { event: SettlementEvent.ISSUE_ABORT }]));
    expect(settlement.state).toBe(SettlementState.ABORT_ISSUED);
  });
});

describe('no refund after COMMIT (invariant I4)', () => {
  it('refuses an abort once a commit exists', () => {
    const result = run([
      ...prepareBoth,
      { event: SettlementEvent.ISSUE_COMMIT },
      { event: SettlementEvent.ISSUE_ABORT },
    ]);

    expect(result.ok).toBe(false);
    // The message names the rule rather than reporting a generic illegal edge.
    expect(expectRejected(result)).toBe('no refund after COMMIT');
  });

  it('refuses to return a leg once a commit exists', () => {
    const result = run([
      ...prepareBoth,
      { event: SettlementEvent.ISSUE_COMMIT },
      { event: SettlementEvent.RETURN_CASH, amount: 1_000n },
    ]);

    expect(expectRejected(result)).toBe('no refund after COMMIT');
  });

  it('refuses a return even after the settlement is held', () => {
    // A held settlement is the case operators most want to "just undo". PRD 5.3
    // is explicit that refunds are permanently disabled after COMMIT.
    const result = run([
      ...prepareBoth,
      { event: SettlementEvent.ISSUE_COMMIT },
      { event: SettlementEvent.HOLD_CASH, amount: 1_000n },
      { event: SettlementEvent.RETURN_CASH, amount: 1_000n },
    ]);

    expect(expectRejected(result)).toBe('no refund after COMMIT');
  });
});

describe('release and completion (PRD FR-011)', () => {
  it('refuses to release without a commit', () => {
    const result = run([...prepareBoth, { event: SettlementEvent.RELEASE_CASH, amount: 1_000n }]);

    expect(expectRejected(result)).toContain('requires a canonical commit');
  });

  it('reaches SETTLED only after both legs are released', () => {
    const afterOne = expectOk(
      run([
        ...prepareBoth,
        { event: SettlementEvent.ISSUE_COMMIT },
        { event: SettlementEvent.RELEASE_CASH, amount: 1_000n },
      ]),
    );
    expect(afterOne.state).not.toBe(SettlementState.SETTLED);

    const afterBoth = expectOk(
      run([
        ...prepareBoth,
        { event: SettlementEvent.ISSUE_COMMIT },
        { event: SettlementEvent.RELEASE_CASH, amount: 1_000n },
        { event: SettlementEvent.RELEASE_ASSET, amount: 50n },
      ]),
    );
    expect(afterBoth.state).toBe(SettlementState.SETTLED);
  });

  it.each([
    ['more than was locked', 1_001n],
    ['less than was locked', 999n],
    ['nothing at all', 0n],
  ])('refuses to release %s', (_label, amount) => {
    // PRD FR-004 makes the prepared amount immutable and PRD FR-007 requires
    // exact amounts, so a release is all-or-nothing. Permitting a partial move
    // let a leg reach RELEASED with value still outstanding, which is how
    // conservation broke in an earlier version of this model.
    const result = run([
      ...prepareBoth,
      { event: SettlementEvent.ISSUE_COMMIT },
      { event: SettlementEvent.RELEASE_CASH, amount },
    ]);

    expect(result.ok).toBe(false);
  });

  it('counts the fee toward the exact outstanding balance', () => {
    // Releasing 1000 *plus* a fee of 10 would move 1010 against 1000 locked.
    const result = run([
      ...prepareBoth,
      { event: SettlementEvent.ISSUE_COMMIT },
      { event: SettlementEvent.RELEASE_CASH, amount: 1_000n, fee: 10n },
    ]);

    expect(expectRejected(result)).toContain('exact outstanding balance');
  });

  it('charges the protocol fee only from the cash leg (PRD 8.6)', () => {
    const settlement = expectOk(
      run([
        ...prepareBoth,
        { event: SettlementEvent.ISSUE_COMMIT },
        { event: SettlementEvent.RELEASE_CASH, amount: 990n, fee: 10n },
        { event: SettlementEvent.RELEASE_ASSET, amount: 50n },
      ]),
    );

    expect(settlement.cash.fee).toBe(10n);
    expect(settlement.asset.fee).toBe(0n);
    expect(checkAll(settlement)).toEqual([]);
  });
});

describe('held legs and disposition (invariant I9)', () => {
  it('moves the settlement to HELD when a leg cannot be released', () => {
    const settlement = expectOk(
      run([
        ...prepareBoth,
        { event: SettlementEvent.ISSUE_COMMIT },
        { event: SettlementEvent.HOLD_CASH, amount: 1_000n },
      ]),
    );

    expect(settlement.state).toBe(SettlementState.HELD);
    expect(settlement.cashLeg).toBe(LegState.HELD);
    expect(settlement.cash.held).toBe(1_000n);
  });

  it('disposes a held leg exactly once', () => {
    const settlement = expectOk(
      run([
        ...prepareBoth,
        { event: SettlementEvent.ISSUE_COMMIT },
        { event: SettlementEvent.HOLD_CASH, amount: 1_000n },
        { event: SettlementEvent.DISPOSE_CASH, amount: 1_000n },
      ]),
    );

    expect(settlement.cashLeg).toBe(LegState.DISPOSED);
    expect(settlement.cash.held).toBe(0n);
    expect(settlement.cash.released).toBe(1_000n);
  });

  it('refuses to dispose a leg that is not held', () => {
    const result = run([
      ...prepareBoth,
      { event: SettlementEvent.ISSUE_COMMIT },
      { event: SettlementEvent.DISPOSE_CASH, amount: 1_000n },
    ]);

    expect(expectRejected(result)).toContain('only a held leg');
  });

  it('refuses to dispose more than is held', () => {
    const result = run([
      ...prepareBoth,
      { event: SettlementEvent.ISSUE_COMMIT },
      { event: SettlementEvent.HOLD_CASH, amount: 400n },
      { event: SettlementEvent.DISPOSE_CASH, amount: 500n },
    ]);

    expect(result.ok).toBe(false);
  });
});

describe('abort path (PRD 5.2)', () => {
  it('reaches ABORTED only when both legs are returned', () => {
    const afterOne = expectOk(
      run([
        ...prepareBoth,
        { event: SettlementEvent.ISSUE_ABORT },
        { event: SettlementEvent.RETURN_CASH, amount: 1_000n },
      ]),
    );
    expect(afterOne.state).not.toBe(SettlementState.ABORTED);

    const afterBoth = expectOk(
      run([
        ...prepareBoth,
        { event: SettlementEvent.ISSUE_ABORT },
        { event: SettlementEvent.RETURN_CASH, amount: 1_000n },
        { event: SettlementEvent.RETURN_ASSET, amount: 50n },
      ]),
    );
    expect(afterBoth.state).toBe(SettlementState.ABORTED);
  });

  it('stays HELD when a return recipient is ineligible', () => {
    const settlement = expectOk(
      run([
        ...prepareBoth,
        { event: SettlementEvent.ISSUE_ABORT },
        { event: SettlementEvent.RETURN_CASH, amount: 1_000n },
        { event: SettlementEvent.HOLD_ASSET, amount: 50n },
      ]),
    );

    expect(settlement.state).toBe(SettlementState.HELD);
  });
});

describe('invariants hold across generated traces (PRD 14.4)', () => {
  const EVENTS: SettlementEventValue[] = Object.values(SettlementEvent);

  const commandArbitrary = fc.record({
    event: fc.constantFrom(...EVENTS),
    amount: fc.bigInt({ min: 0n, max: 1_200n }),
    fee: fc.bigInt({ min: 0n, max: 20n }),
  });

  it('never reaches a state that violates an invariant', () => {
    fc.assert(
      fc.property(fc.array(commandArbitrary, { maxLength: 24 }), (commands) => {
        let settlement: Settlement = INITIAL_SETTLEMENT;

        for (const command of commands) {
          const result = apply(settlement, command);
          if (!result.ok) continue; // A rejected command must leave state untouched.

          settlement = result.settlement;

          // Checked after every accepted step, so a violation is attributed to
          // the command that caused it rather than found at the end.
          const violations = checkAll(settlement);
          if (violations.length > 0) {
            throw new Error(
              `after ${command.event}: ${violations.map((v) => `${v.id} ${v.detail}`).join('; ')}`,
            );
          }
        }

        return true;
      }),
      { numRuns: 2_000 },
    );
  });

  it('never accepts a state transition the table forbids', () => {
    fc.assert(
      fc.property(fc.array(commandArbitrary, { maxLength: 24 }), (commands) => {
        let settlement: Settlement = INITIAL_SETTLEMENT;

        for (const command of commands) {
          const before = settlement.state;
          const result = apply(settlement, command);
          if (!result.ok) continue;

          settlement = result.settlement;
          const after = settlement.state;

          if (before !== after && !canTransition(before, after)) {
            throw new Error(`${command.event} produced forbidden transition ${before} -> ${after}`);
          }
        }

        return true;
      }),
      { numRuns: 2_000 },
    );
  });

  it('never refunds after a commit, across every generated trace', () => {
    fc.assert(
      fc.property(fc.array(commandArbitrary, { maxLength: 24 }), (commands) => {
        let settlement: Settlement = INITIAL_SETTLEMENT;
        let committed = false;

        for (const command of commands) {
          const result = apply(settlement, command);
          if (!result.ok) continue;

          settlement = result.settlement;
          if (settlement.state === SettlementState.COMMIT_ISSUED) committed = true;

          if (committed && (settlement.cash.returned > 0n || settlement.asset.returned > 0n)) {
            throw new Error('value returned after COMMIT');
          }
        }

        return true;
      }),
      { numRuns: 2_000 },
    );
  });

  it('leaves state untouched when a command is rejected', () => {
    fc.assert(
      fc.property(
        fc.array(commandArbitrary, { maxLength: 12 }),
        commandArbitrary,
        (setup, probe) => {
          let settlement: Settlement = INITIAL_SETTLEMENT;
          for (const command of setup) {
            const result = apply(settlement, command);
            if (result.ok) settlement = result.settlement;
          }

          const before = snapshot(settlement);

          const result = apply(settlement, probe);
          if (result.ok) return true;

          return snapshot(settlement) === before;
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

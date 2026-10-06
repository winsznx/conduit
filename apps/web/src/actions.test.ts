/**
 * The action resolver, branch by branch.
 *
 * Every branch that enables a value-moving button is exercised here, because
 * this is the one place where "who may do what, when" is decided off chain. The
 * contracts refuse the rest — but a page that offers a button the chain will
 * refuse has already wasted somebody's gas and, worse, told them something
 * untrue about their own settlement.
 */

import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';

import { history, nextAction, rolesOf, type Snapshot, type Terms } from './actions.js';
import type { CashLegRecord, ReservationRecord, SettlementRecord } from './onchain.js';

const PAYER = '0x1111111111111111111111111111111111111111' as Address;
const SELLER = '0x2222222222222222222222222222222222222222' as Address;
const STRANGER = '0x3333333333333333333333333333333333333333' as Address;
const ID: Hex = `0x${'ab'.repeat(32)}`;

const NOW = 1_800_000_000;

const TERMS: Terms = {
  cashAmount: 25_000_000n,
  cashPayer: PAYER,
  cashReceiver: SELLER,
  assetAmount: 500_000n,
  assetSeller: SELLER,
  assetReceiver: PAYER,
  prepareDeadline: BigInt(NOW + 3_600),
  commitDeadline: BigInt(NOW + 10_800),
  releaseDeadline: BigInt(NOW + 14_400),
};

function settlementRecord(over: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    state: 'NONE',
    decision: 'NONE',
    cashPrepared: false,
    assetPrepared: false,
    cashOutcome: 'NONE',
    assetOutcome: 'NONE',
    intentHash: ID,
    stateVersion: 0n,
    ...over,
  };
}

function reservationRecord(over: Partial<ReservationRecord> = {}): ReservationRecord {
  return {
    owner: SELLER,
    amount: TERMS.assetAmount,
    settlementId: ID,
    createdAt: BigInt(NOW - 60),
    announced: true,
    committed: false,
    released: false,
    cancelled: false,
    ...over,
  };
}

function cashLegRecord(over: Partial<CashLegRecord> = {}): CashLegRecord {
  return {
    payer: PAYER,
    receiver: SELLER,
    amount: TERMS.cashAmount,
    intentHash: ID,
    state: 'PREPARED',
    ...over,
  };
}

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    terms: TERMS,
    signatures: { payer: true, seller: true },
    settlement: undefined,
    cashLeg: undefined,
    reservation: undefined,
    intendedReceiver: undefined,
    messages: {},
    holdings: {},
    fresh: undefined,
    commitSimulated: false,
    dispositionCase: undefined,
    contestWindowSeconds: 300,
    verifierClass: undefined,
    account: undefined,
    nowSeconds: NOW,
    ...over,
  };
}

/** The whole asset leg standing on Base: reserved, announced, receiver bound. */
function assetLegOnBase(over: Partial<Snapshot> = {}): Partial<Snapshot> {
  return { reservation: reservationRecord(), intendedReceiver: PAYER, ...over };
}

describe('rolesOf', () => {
  it('reads both roles when one wallet plays both sides', () => {
    // #given terms where the payer is also the seller
    const selfTrade: Terms = { ...TERMS, assetSeller: PAYER };

    // #then the wallet holds both roles
    expect(rolesOf(selfTrade, PAYER)).toEqual(['payer', 'seller']);
  });

  it('is case-insensitive about addresses', () => {
    expect(rolesOf(TERMS, PAYER.toUpperCase() as Address)).toEqual(['payer']);
  });

  it('gives a stranger nothing', () => {
    expect(rolesOf(TERMS, STRANGER)).toEqual([]);
  });
});

describe('nextAction — signatures', () => {
  it('waits for the counterparty before offering to lock anything', () => {
    // #given only the payer has signed and nothing is prepared
    const state = snapshot({ signatures: { payer: true, seller: false }, account: SELLER });

    // #when the next action is resolved
    const action = nextAction(state);

    // #then it is the signature, not a preparation
    expect(action.kind).toBe('AWAITING_SIGNATURES');
    expect(action.title).toContain('seller');
    expect(action.enabled).toBe(false);
  });

  it('does not re-block a settlement whose asset leg is already on chain', () => {
    // #given a missing signature but a reservation that already exists
    const state = snapshot({
      signatures: { payer: true, seller: false },
      ...assetLegOnBase(),
      account: PAYER,
    });

    // #then the chain state wins over the projection's view of signatures
    expect(nextAction(state).kind).not.toBe('AWAITING_SIGNATURES');
  });
});

describe('nextAction — preparation', () => {
  it('asks the seller to reserve first, because Base finality is the long pole', () => {
    // #given both signatures and nothing prepared
    const action = nextAction(snapshot({ account: SELLER }));

    // #then the asset leg goes first and the seller may run it
    expect(action.kind).toBe('RESERVE_ASSET');
    expect(action.chainId).toBe(84_532);
    expect(action.enabled).toBe(true);
  });

  it('refuses the reserve button to anyone who is not the seller', () => {
    // #given the payer is connected
    const action = nextAction(snapshot({ account: PAYER }));

    // #then the action is named but not offered, and it says whose it is
    expect(action.kind).toBe('RESERVE_ASSET');
    expect(action.enabled).toBe(false);
    expect(action.blocked).toContain(SELLER);
  });

  it('refuses to reserve more than the seller has unreserved', () => {
    // #given the seller holds less than the settlement needs
    const action = nextAction(
      snapshot({ account: SELLER, holdings: { availableAsset: 100_000n } }),
    );

    // #then it is blocked with the shortfall stated
    expect(action.enabled).toBe(false);
    expect(action.blocked).toContain('100000');
    expect(action.blocked).toContain('500000');
  });

  it('moves to the cash leg once the asset leg stands on Base', () => {
    // #given the reservation is announced and the receiver bound
    const action = nextAction(snapshot({ ...assetLegOnBase(), account: PAYER }));

    // #then the payer locks the cash
    expect(action.kind).toBe('LOCK_CASH');
    expect(action.chainId).toBe(10_143);
    expect(action.enabled).toBe(true);
  });

  it('refuses to lock cash the payer does not hold', () => {
    const action = nextAction(
      snapshot({ ...assetLegOnBase(), account: PAYER, holdings: { cashBalance: 1n } }),
    );
    expect(action.enabled).toBe(false);
    expect(action.blocked).toContain('25000000');
  });

  it('closes preparation once the prepare deadline has passed', () => {
    const action = nextAction(snapshot({ account: SELLER, nowSeconds: NOW + 7_200 }));
    expect(action.kind).toBe('DEADLINE_PASSED');
    expect(action.enabled).toBe(false);
  });
});

describe('nextAction — the crossing', () => {
  const prepared = {
    ...assetLegOnBase(),
    cashLeg: cashLegRecord(),
    settlement: settlementRecord({ state: 'CASH_PREPARED', cashPrepared: true }),
  };

  it('waits for economic finality rather than for first observation', () => {
    // #given the message is observed but not finalized
    const action = nextAction(
      snapshot({
        ...prepared,
        messages: {
          assetPrepared: {
            messageType: 'ASSET_PREPARED',
            sequence: '4',
            emitter: SELLER,
            emitterChainId: 10_004,
            finalized: false,
            consumed: false,
          },
        },
        account: PAYER,
      }),
    );

    // #then nothing is executable and the reason is the threshold, not a delay
    expect(action.kind).toBe('WAITING_FOR_FINALITY');
    expect(action.enabled).toBe(false);
    expect(action.detail).toContain('FINALIZED');
  });

  it('lets anyone relay the finalized message', () => {
    const action = nextAction(
      snapshot({
        ...prepared,
        messages: {
          assetPrepared: {
            messageType: 'ASSET_PREPARED',
            sequence: '4',
            emitter: SELLER,
            emitterChainId: 10_004,
            finalized: true,
            consumed: false,
          },
        },
        account: STRANGER,
      }),
    );

    // #then a stranger may submit it: relaying is permissionless
    expect(action.kind).toBe('RECORD_ASSET_PREPARED');
    expect(action.actor).toBe('anyone');
    expect(action.enabled).toBe(true);
  });

  it('still refuses a permissionless action when no wallet is connected', () => {
    const action = nextAction(
      snapshot({
        ...prepared,
        messages: {
          assetPrepared: {
            messageType: 'ASSET_PREPARED',
            sequence: '4',
            emitter: SELLER,
            emitterChainId: 10_004,
            finalized: true,
            consumed: false,
          },
        },
      }),
    );
    expect(action.enabled).toBe(false);
    expect(action.blocked).toContain('Connect a wallet');
  });
});

describe('nextAction — ready and commit', () => {
  const ready = {
    ...assetLegOnBase(),
    cashLeg: cashLegRecord(),
    settlement: settlementRecord({ state: 'READY', cashPrepared: true, assetPrepared: true }),
  };

  it('asks for a fresh compliance answer before offering COMMIT', () => {
    const action = nextAction(snapshot({ ...ready, account: PAYER }));
    expect(action.kind).toBe('FRESH_COMPLIANCE_REQUIRED');
    expect(action.call).toBe('run-fresh-compliance');
    expect(action.enabled).toBe(true);
  });

  it('treats an expired answer as no answer', () => {
    // #given an answer that has aged past the contract's immutable window
    const action = nextAction(
      snapshot({
        ...ready,
        fresh: {
          eligible: true,
          checkedAt: 'earlier',
          expiresAt: NOW - 1,
          refusals: [],
          unavailable: false,
        },
        account: PAYER,
      }),
    );

    // #then compliance is asked again rather than reused
    expect(action.kind).toBe('FRESH_COMPLIANCE_REQUIRED');
  });

  it('does not expose COMMIT when a participant is refused', () => {
    const action = nextAction(
      snapshot({
        ...ready,
        fresh: {
          eligible: false,
          checkedAt: 'now',
          expiresAt: NOW + 600,
          refusals: [{ subject: PAYER, status: 'TIER_TOO_LOW', detail: 'observed tier 20' }],
          unavailable: false,
        },
        account: PAYER,
      }),
    );
    expect(action.kind).toBe('FRESH_COMPLIANCE_REQUIRED');
    expect(action.enabled).toBe(false);
    expect(action.detail).toContain('TIER_TOO_LOW');
  });

  it('keeps an outage distinct from a refusal', () => {
    const action = nextAction(
      snapshot({
        ...ready,
        fresh: {
          eligible: false,
          checkedAt: 'now',
          expiresAt: NOW + 600,
          refusals: [],
          unavailable: true,
        },
        account: PAYER,
      }),
    );
    expect(action.title).toContain('did not answer');
    expect(action.detail).toContain('absence of a decision');
    expect(action.enabled).toBe(false);
  });

  it('still reports an outage when the answer carries no expiry at all', () => {
    // #given an outage, which produces no attestation and therefore no window
    const action = nextAction(
      snapshot({
        ...ready,
        fresh: {
          eligible: false,
          checkedAt: 'now',
          expiresAt: 0,
          refusals: [],
          unavailable: true,
        },
        account: PAYER,
      }),
    );

    // #then it is not flattened into "the answer expired, ask again"
    expect(action.title).toContain('did not answer');
    expect(action.enabled).toBe(false);
  });

  it('waits for the simulation before it calls anything ready', () => {
    const action = nextAction(
      snapshot({
        ...ready,
        fresh: {
          eligible: true,
          checkedAt: 'now',
          expiresAt: NOW + 600,
          refusals: [],
          unavailable: false,
        },
        account: PAYER,
      }),
    );
    expect(action.kind).toBe('COMMIT_REQUIRED');
    expect(action.enabled).toBe(false);
  });

  it('offers COMMIT once the coordinator itself accepts the proof', () => {
    const action = nextAction(
      snapshot({
        ...ready,
        fresh: {
          eligible: true,
          checkedAt: 'now',
          expiresAt: NOW + 600,
          refusals: [],
          unavailable: false,
        },
        commitSimulated: true,
        account: STRANGER,
      }),
    );
    expect(action.kind).toBe('READY_TO_COMMIT');
    expect(action.actor).toBe('anyone');
    expect(action.enabled).toBe(true);
  });

  it('closes COMMIT when the commit deadline has passed', () => {
    const action = nextAction(
      snapshot({
        ...ready,
        commitSimulated: true,
        fresh: {
          eligible: true,
          checkedAt: 'now',
          expiresAt: NOW + 20_000,
          refusals: [],
          unavailable: false,
        },
        nowSeconds: NOW + 11_000,
        account: PAYER,
      }),
    );
    expect(action.kind).toBe('DEADLINE_PASSED');
  });
});

describe('nextAction — after COMMIT', () => {
  const committed = {
    ...assetLegOnBase(),
    cashLeg: cashLegRecord({ state: 'COMMITTED' }),
    settlement: settlementRecord({
      state: 'COMMIT_ISSUED',
      decision: 'COMMIT',
      cashPrepared: true,
      assetPrepared: true,
    }),
  };

  it('releases the cash first, permissionlessly', () => {
    const action = nextAction(snapshot({ ...committed, account: STRANGER }));
    expect(action.kind).toBe('EXECUTE_CASH_RELEASE');
    expect(action.chainId).toBe(10_143);
    expect(action.enabled).toBe(true);
  });

  it('waits for Monad finality before the asset can be delivered', () => {
    const action = nextAction(
      snapshot({
        ...committed,
        settlement: settlementRecord({
          state: 'COMMIT_ISSUED',
          decision: 'COMMIT',
          cashPrepared: true,
          assetPrepared: true,
          cashOutcome: 'RELEASED',
        }),
        account: STRANGER,
      }),
    );
    expect(action.kind).toBe('WAITING_FOR_FINALITY');
    expect(action.title).toContain('Monad');
  });

  it('delivers the asset once COMMIT is finalized', () => {
    const action = nextAction(
      snapshot({
        ...committed,
        settlement: settlementRecord({
          state: 'COMMIT_ISSUED',
          decision: 'COMMIT',
          cashPrepared: true,
          assetPrepared: true,
          cashOutcome: 'RELEASED',
        }),
        messages: {
          commit: {
            messageType: 'COMMIT',
            sequence: '1',
            emitter: PAYER,
            emitterChainId: 10_009,
            finalized: true,
            consumed: false,
          },
        },
        account: STRANGER,
      }),
    );
    expect(action.kind).toBe('EXECUTE_ASSET_RELEASE');
    expect(action.chainId).toBe(84_532);
    expect(action.enabled).toBe(true);
  });

  it('asks the asset chain to report once the reservation has closed', () => {
    const action = nextAction(
      snapshot({
        ...committed,
        reservation: reservationRecord({ released: true, committed: true }),
        settlement: settlementRecord({
          state: 'COMMIT_ISSUED',
          decision: 'COMMIT',
          cashPrepared: true,
          assetPrepared: true,
          cashOutcome: 'RELEASED',
        }),
        account: STRANGER,
      }),
    );
    expect(action.kind).toBe('WAITING_FOR_REMOTE_RESOLUTION');
    expect(action.call).toBe('report-resolution');
  });
});

describe('nextAction — held and disposition', () => {
  const heldState = {
    ...assetLegOnBase(),
    settlement: settlementRecord({
      state: 'HELD',
      decision: 'COMMIT',
      cashPrepared: true,
      assetPrepared: true,
      cashOutcome: 'RELEASED',
      assetOutcome: 'HELD',
    }),
  };

  it('names the disposition as the only way out', () => {
    const action = nextAction(snapshot({ ...heldState, account: PAYER }));
    expect(action.kind).toBe('HELD_DISPOSITION_REQUIRED');
    expect(action.detail).toContain('not refunded');
  });

  it('holds a filed order for its contest window', () => {
    const action = nextAction(
      snapshot({
        ...heldState,
        dispositionCase: {
          state: 'OPEN',
          leg: 1,
          settlementId: ID,
          policyId: ID,
          policyHash: ID,
          leadOrderHash: ID,
          filedAt: BigInt(NOW - 100),
          signatures: 1,
          executedType: 0,
          executedDestination: PAYER,
          executedAmount: 0n,
        },
        account: PAYER,
      }),
    );
    expect(action.kind).toBe('CONTEST_WINDOW');
    expect(action.enabled).toBe(false);
  });

  it('becomes executable once the window closes', () => {
    const action = nextAction(
      snapshot({
        ...heldState,
        dispositionCase: {
          state: 'OPEN',
          leg: 1,
          settlementId: ID,
          policyId: ID,
          policyHash: ID,
          leadOrderHash: ID,
          filedAt: BigInt(NOW - 400),
          signatures: 1,
          executedType: 0,
          executedDestination: PAYER,
          executedAmount: 0n,
        },
        account: PAYER,
      }),
    );
    expect(action.kind).toBe('DISPOSITION_EXECUTABLE');
    expect(action.enabled).toBe(true);
  });

  it('stops everything while two authorities disagree', () => {
    const action = nextAction(
      snapshot({
        ...heldState,
        dispositionCase: {
          state: 'CONTESTED',
          leg: 1,
          settlementId: ID,
          policyId: ID,
          policyHash: ID,
          leadOrderHash: ID,
          filedAt: BigInt(NOW - 400),
          signatures: 2,
          executedType: 0,
          executedDestination: PAYER,
          executedAmount: 0n,
        },
        account: PAYER,
      }),
    );
    expect(action.kind).toBe('DISPOSITION_CONTESTED');
    expect(action.enabled).toBe(false);
  });
});

describe('nextAction — terminal', () => {
  const settled = settlementRecord({
    state: 'SETTLED',
    decision: 'COMMIT',
    cashPrepared: true,
    assetPrepared: true,
    cashOutcome: 'RELEASED',
    assetOutcome: 'RELEASED',
  });

  it('keeps SETTLED and SETTLED_FINAL apart', () => {
    // #given the coordinator says SETTLED and no verifier run exists
    const action = nextAction(snapshot({ settlement: settled, account: PAYER }));

    // #then the page asks for verification rather than claiming it
    expect(action.kind).toBe('VERIFICATION_INCOMPLETE');
    expect(action.detail).toContain('SETTLED_FINAL');
  });

  it('is complete once an independent run agrees', () => {
    const action = nextAction(
      snapshot({ settlement: settled, verifierClass: 'SETTLED_FINAL', account: PAYER }),
    );
    expect(action.kind).toBe('SETTLEMENT_COMPLETE');
    expect(action.enabled).toBe(false);
  });
});

describe('history', () => {
  it('marks each rung from what the chain says, not from what was clicked', () => {
    const facts = history(
      snapshot({
        ...assetLegOnBase(),
        cashLeg: cashLegRecord(),
        settlement: settlementRecord({
          state: 'READY',
          cashPrepared: true,
          assetPrepared: true,
        }),
      }),
    );
    const done = facts.filter((fact) => fact.done).map((fact) => fact.label);
    expect(done).toContain('Asset reserved and announced');
    expect(done).toContain('Cash escrowed');
    expect(done).toContain('ASSET_PREPARED finalized and consumed');
    expect(done).not.toContain('COMMIT issued');
  });

  it('does not call a committed settlement unsigned because the store kept no signatures', () => {
    const facts = history(
      snapshot({
        signatures: { payer: false, seller: false },
        settlement: settlementRecord({
          state: 'SETTLED',
          decision: 'COMMIT',
          cashPrepared: true,
          assetPrepared: true,
          cashOutcome: 'RELEASED',
          assetOutcome: 'RELEASED',
        }),
      }),
    );
    const signed = facts.find((fact) => fact.label === 'Both parties signed');
    expect(signed?.done).toBe(true);
    expect(signed?.detail).not.toContain('not signed');
    const fresh = facts.find((fact) => fact.label === 'Fresh compliance at commit time');
    expect(fresh?.done).toBe(true);
    expect(fresh?.detail).not.toContain('not asked yet');
  });

  it('still reports a genuinely missing signature before COMMIT', () => {
    const facts = history(
      snapshot({ signatures: { payer: true, seller: false }, settlement: undefined }),
    );
    const signed = facts.find((fact) => fact.label === 'Both parties signed');
    expect(signed?.done).toBe(false);
    expect(signed?.detail).toContain('seller not signed');
  });
});

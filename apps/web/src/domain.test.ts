import { describe, expect, it } from 'vitest';

import { describeOutcome, type LegView, type SettlementView } from './domain.js';

const leg = (over: Partial<LegView>): LegView => ({
  chain: '',
  chainId: 10143,
  asset: '0xaa',
  assetSymbol: 'cSETTLE',
  amount: '25',
  outcome: 'RELEASED',
  counterparty: '0xbb',
  ...over,
});

function view(over: Partial<SettlementView> = {}): SettlementView {
  return {
    settlementId: `0x${'ab'.repeat(32)}`,
    deploymentId: 'gen3',
    generation: 3,
    canonicalState: 'SETTLED',
    decision: 'COMMIT',
    verifierClass: 'SETTLED_FINAL',
    cash: leg({}),
    asset: leg({ chain: '', chainId: 84532, assetSymbol: 'cBOND', amount: '0.5' }),
    messages: [],
    compliance: [],
    disposition: undefined,
    conservation: [],
    termsKnown: true,
    ...over,
  };
}

describe('describeOutcome', () => {
  it('states a verified settlement as delivered, with both legs named', () => {
    const outcome = describeOutcome(view());
    expect(outcome.headline).toBe('Settled.');
    expect(outcome.detail).toContain(
      '25 cSETTLE on Monad Testnet against 0.5 cBOND on Base Sepolia',
    );
    expect(outcome.detail).toContain('independent verifier');
  });

  it('does not claim verification the verifier has not given', () => {
    const outcome = describeOutcome(view({ verifierClass: undefined }));
    expect(outcome.detail).toContain('has not confirmed');
    expect(outcome.detail).not.toContain('read both chains');
  });

  it('says plainly that unrecovered terms are unknown, not zero', () => {
    const outcome = describeOutcome(
      view({ termsKnown: false, cash: leg({ amount: 'not recovered' }) }),
    );
    expect(outcome.detail).toContain('not recovered');
    expect(outcome.detail).not.toContain('not recovered cSETTLE');
  });

  it('describes a held settlement as neither failed nor refunded', () => {
    const outcome = describeOutcome(
      view({
        canonicalState: 'HELD',
        verifierClass: 'HELD_PENDING_DISPOSITION',
        asset: leg({ chainId: 84532, assetSymbol: 'cBOND', amount: '0.5', outcome: 'HELD' }),
      }),
    );
    expect(outcome.headline).toBe('Committed, and the value is held.');
    expect(outcome.detail).toContain('cash leg is released');
    expect(outcome.detail).toContain('asset leg is held');
    expect(outcome.detail).toContain('not a refund');
  });

  it('falls back to the coordinator’s own word for a state it has no sentence for', () => {
    const outcome = describeOutcome(view({ canonicalState: 'MYSTERY' }));
    expect(outcome.headline).toBe('The coordinator reports MYSTERY.');
  });
});

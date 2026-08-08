import { describe, expect, it } from 'vitest';

import {
  TOPICS,
  TOPIC_SENDS_TRANSACTION,
  classifyRevert,
  idempotencyKeyFor,
  requireSettlementScope,
  type Topic,
} from './handlers.js';

/**
 * The worker's safety argument, tested rather than asserted.
 *
 * At-least-once delivery is only safe because every job is a permissionless,
 * idempotent protocol action. These tests hold that line: the topic table
 * cannot grow a job that decides settlement truth without failing, a duplicate
 * delivery produces the same key, and the three kinds of chain refusal stay
 * apart.
 */

describe('what a worker may do', () => {
  it('has a declared transaction posture for every topic', () => {
    const topics = Object.values(TOPICS);
    expect(Object.keys(TOPIC_SENDS_TRANSACTION).sort()).toEqual([...topics].sort());
  });

  /**
   * PRD 4.5. Every job that sends a transaction is one the contracts let
   * *anybody* send, authorized by a signature or a VAA rather than by the
   * caller's identity. A topic named for a decision would break that, so the
   * names are checked.
   */
  it('never names a job that decides settlement truth', () => {
    const forbidden = /decide|authori[sz]e|approve|refund|abort|freeze|override|force/i;
    for (const topic of Object.values(TOPICS)) {
      expect(forbidden.test(topic), topic).toBe(false);
    }
  });

  it('sends transactions only for relaying', () => {
    for (const [topic, sends] of Object.entries(TOPIC_SENDS_TRANSACTION)) {
      if (sends) expect(topic.startsWith('relay.'), topic).toBe(true);
    }
  });
});

describe('idempotency keys', () => {
  it('gives two deliveries of the same fact the same key', () => {
    const first = idempotencyKeyFor(TOPICS.RELAY_COMMIT, {
      settlementId: '0xabc',
      sequence: 0,
    });
    const second = idempotencyKeyFor(TOPICS.RELAY_COMMIT, {
      sequence: 0,
      settlementId: '0xabc',
    });
    // Field order is not part of the fact, so it is not part of the key.
    expect(first).toBe(second);
  });

  it('gives different facts different keys', () => {
    const one = idempotencyKeyFor(TOPICS.RELAY_COMMIT, { settlementId: '0xabc', sequence: 0 });
    const two = idempotencyKeyFor(TOPICS.RELAY_COMMIT, { settlementId: '0xabc', sequence: 1 });
    expect(one).not.toBe(two);
  });

  it('separates the same fact under different topics', () => {
    const parts = { settlementId: '0xabc', sequence: 0 };
    expect(idempotencyKeyFor(TOPICS.RELAY_COMMIT, parts)).not.toBe(
      idempotencyKeyFor(TOPICS.RELAY_PREPARED, parts),
    );
  });

  /**
   * The failure mode a UUID key produces: every retry is a new row, the unique
   * constraint never fires, and the outbox stops protecting anything. Keys are
   * derived from the fact, so the same fact is the same key however many times
   * it is published.
   */
  it('does not vary between calls', () => {
    const key = () => idempotencyKeyFor(TOPICS.VERIFY_SETTLEMENT, { settlementId: '0xabc' });
    expect(key()).toBe(key());
  });
});

describe('classifying a chain refusal', () => {
  it('treats an already-consumed VAA as success', () => {
    // Two relayers racing to submit the same VAA is the normal case, not an
    // error. Reporting it as a failure would retry until the job died and page
    // somebody about a settlement that completed.
    const outcome = classifyRevert(new Error('execution reverted: VaaAlreadyConsumed(0xabc)'));
    expect(outcome.status).toBe('ALREADY_DONE');
  });

  it('treats an unmet precondition as retry-later, not failure', () => {
    const outcome = classifyRevert(new Error('reverted with ContestWindowOpen(1700, 1600)'));
    expect(outcome.status).toBe('NOT_YET');
  });

  /**
   * The important negative. A revert nobody recognises must stay a failure: a
   * catch-all "probably already done" would hide a real protocol refusal, which
   * is precisely what ADR-0019 exists to prevent on the evidence side.
   */
  it('never swallows an unrecognised revert', () => {
    const outcome = classifyRevert(new Error('reverted with SomeBrandNewError(1)'));
    expect(outcome.status).toBe('FAILED');
    expect(outcome.detail).toContain('SomeBrandNewError');
  });

  it('keeps a transport failure a failure', () => {
    expect(classifyRevert(new Error('fetch failed: ECONNRESET')).status).toBe('FAILED');
  });

  it('truncates a long revert without losing its head', () => {
    const outcome = classifyRevert(new Error(`Boom${'x'.repeat(5000)}`));
    expect(outcome.detail.startsWith('Boom')).toBe(true);
    expect(outcome.detail.length).toBeLessThanOrEqual(500);
  });
});

describe('settlement scope', () => {
  const context = (payload: Record<string, unknown>) => ({
    topic: TOPICS.RELAY_COMMIT as Topic as string,
    idempotencyKey: 'k',
    payload,
    attempt: 1,
  });

  it('returns the settlement a job belongs to', () => {
    const id = `0x${'11'.repeat(32)}`;
    expect(requireSettlementScope(context({ settlementId: id }))).toBe(id);
  });

  it('refuses a job with no settlement, so a dead letter can be read', () => {
    expect(() => requireSettlementScope(context({}))).toThrow(/no settlementId/);
    expect(() => requireSettlementScope(context({ settlementId: 'nope' }))).toThrow(
      /no settlementId/,
    );
  });
});

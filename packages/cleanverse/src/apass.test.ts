import { describe, expect, it } from 'vitest';

import {
  isRestorationEvent,
  isRestricted,
  normalizeApass,
  NormalizedApassStatus,
  type ApassRecord,
} from './apass.js';

/**
 * PRD 2.1 normalization.
 *
 * `now` is injected everywhere so these are exact rather than approximately
 * true, which matters: the boundary cases are the ones that decide whether a
 * settlement commits.
 */

const NOW = 1_786_060_800; // 2026-08-07T00:00:00Z
const DAY = 86_400;

function record(overrides: Partial<ApassRecord> = {}): ApassRecord {
  return {
    status: 1,
    expirationTime: NOW + 30 * DAY,
    tier: 2,
    subTier: 1,
    group: 'INSTITUTION',
    subGroup: 'TREASURY',
    currentKycHash: '0xabc',
    countries: ['SG'],
    ...overrides,
  };
}

const options = { now: NOW, warningWindowSeconds: 7 * DAY };

describe('normalizeApass', () => {
  it('reports MISSING when there is no record', () => {
    const result = normalizeApass(undefined, options);

    expect(result.status).toBe(NormalizedApassStatus.MISSING);
    expect(result.restricted).toBe(true);
  });

  it('reports ACTIVE for status 1 well before expiry', () => {
    expect(normalizeApass(record(), options).status).toBe(NormalizedApassStatus.ACTIVE);
  });

  it('reports EXPIRING inside the warning window', () => {
    const result = normalizeApass(record({ expirationTime: NOW + 3 * DAY }), options);

    expect(result.status).toBe(NormalizedApassStatus.EXPIRING);
    // Still eligible: PRD 2.1 puts EXPIRING outside the RESTRICTED set.
    expect(result.restricted).toBe(false);
  });

  it('treats the warning-window boundary as EXPIRING', () => {
    const result = normalizeApass(record({ expirationTime: NOW + 7 * DAY }), options);
    expect(result.status).toBe(NormalizedApassStatus.EXPIRING);
  });

  it('reports EXPIRED at exactly the expiry second', () => {
    // `expirationTime <= now` per PRD 2.1, so the boundary is expired rather
    // than the last valid instant.
    const result = normalizeApass(record({ expirationTime: NOW }), options);

    expect(result.status).toBe(NormalizedApassStatus.EXPIRED);
    expect(result.restricted).toBe(true);
  });

  it('reports FROZEN for status 2', () => {
    const result = normalizeApass(record({ status: 2 }), options);

    expect(result.status).toBe(NormalizedApassStatus.FROZEN);
    expect(result.restricted).toBe(true);
  });

  it('prefers FROZEN over EXPIRED when both hold', () => {
    // Both classify as restricted, so the settlement decision is identical. The
    // label reaches the audit package, and "expired" would point a held-case
    // operator at a renewal that fixes nothing.
    const result = normalizeApass(record({ status: 2, expirationTime: NOW - DAY }), options);
    expect(result.status).toBe(NormalizedApassStatus.FROZEN);
  });

  it('reports UNKNOWN for an undocumented status value', () => {
    // Fail closed. A status Cleanverse has not documented is not an implied
    // active.
    const result = normalizeApass(record({ status: 7, expirationTime: NOW + DAY }), options);

    expect(result.status).toBe(NormalizedApassStatus.UNKNOWN);
    expect(result.restricted).toBe(true);
  });

  it('reports seconds remaining so a caller can measure attestation freshness', () => {
    const result = normalizeApass(record({ expirationTime: NOW + 100 }), options);
    expect(result.secondsUntilExpiry).toBe(100);
  });
});

describe('RESTRICTED classification (PRD 2.1)', () => {
  it.each([
    NormalizedApassStatus.MISSING,
    NormalizedApassStatus.EXPIRED,
    NormalizedApassStatus.FROZEN,
    NormalizedApassStatus.UNKNOWN,
  ])('%s is restricted', (status) => {
    expect(isRestricted(status)).toBe(true);
  });

  it.each([NormalizedApassStatus.ACTIVE, NormalizedApassStatus.EXPIRING])(
    '%s is not restricted',
    (status) => {
      expect(isRestricted(status)).toBe(false);
    },
  );
});

describe('RESTORED as an event rather than a status', () => {
  it.each([
    [NormalizedApassStatus.FROZEN, NormalizedApassStatus.ACTIVE],
    [NormalizedApassStatus.EXPIRED, NormalizedApassStatus.ACTIVE],
    [NormalizedApassStatus.FROZEN, NormalizedApassStatus.EXPIRING],
  ])('%s becoming %s is a restoration', (previous, current) => {
    expect(isRestorationEvent(previous, current)).toBe(true);
  });

  it('is not raised without a prior observation', () => {
    expect(isRestorationEvent(undefined, NormalizedApassStatus.ACTIVE)).toBe(false);
  });

  it.each([
    [NormalizedApassStatus.ACTIVE, NormalizedApassStatus.ACTIVE],
    [NormalizedApassStatus.MISSING, NormalizedApassStatus.ACTIVE],
    [NormalizedApassStatus.FROZEN, NormalizedApassStatus.EXPIRED],
  ])('%s becoming %s is not a restoration', (previous, current) => {
    expect(isRestorationEvent(previous, current)).toBe(false);
  });
});

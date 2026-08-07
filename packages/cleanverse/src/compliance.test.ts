import { describe, expect, it, vi } from 'vitest';

import { CleanverseClient } from './client.js';
import { createCipher } from './encryption.js';
import { CleanverseApiError, CleanverseTransportError } from './errors.js';
import {
  attestEligibility,
  evidenceHashOf,
  isComplianceDecision,
  type AttestationRequest,
  type AttestationSigner,
} from './compliance.js';

import type { Hex } from 'viem';

const API_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

const SUBJECT = {
  address: '0x83C130ed9fb92830F09ea2b30E49009EF03065Bb',
  poolAddress: '0x1645BA0873118A997Bd39718A82dd268E46D3B48',
  chain: 'monad',
} as const;

const REQUEST: AttestationRequest = {
  settlementId: `0x${'11'.repeat(32)}`,
  intentHash: `0x${'22'.repeat(32)}`,
  subject: SUBJECT,
  validitySeconds: 300,
};

/** A stand-in digest, so these tests are about the service and not the hashing. */
const hashDigest = (): Hex => `0x${'ab'.repeat(32)}`;

async function clientAnswering(body: unknown, status = 200): Promise<CleanverseClient> {
  return new CleanverseClient({
    baseUrl: 'https://uatapi.cleanverse.com/api/cooperate',
    apiId: 'test-api-id',
    cipher: await createCipher(API_KEY),
    timeoutMs: 1000,
    maxReadRetries: 0,
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });
}

const SIGNATURE: Hex = `0x${'cd'.repeat(65)}`;
const signDigest = vi.fn((): Promise<Hex> => Promise.resolve(SIGNATURE));
const signer: AttestationSigner = {
  address: '0x000000000000000000000000000000000000C0DE',
  signDigest,
};

describe('compliance attestation service (PRD FR-006)', () => {
  it('signs an approval when Cleanverse says the subject is eligible', async () => {
    const client = await clientAnswering({
      code: '0000',
      message: 'ok',
      data: { valid: true },
    });

    const attested = await attestEligibility(client, signer, REQUEST, hashDigest, {
      now: () => 1_786_000_000_000,
    });

    expect(attested.eligible).toBe(true);
    expect(attested.subject).toBe(SUBJECT.address);
    expect(attested.issuedAt).toBe(1_786_000_000n);
    expect(attested.expiresAt).toBe(1_786_000_300n);
    expect(attested.signature).toMatch(/^0x[0-9a-f]+$/);
  });

  it('signs a refusal rather than throwing when the answer is valid:false', async () => {
    // PRD 2.2: a Cleanverse `valid: false` is a legitimate non-eligibility
    // decision, not an API failure. Signing it puts the refusal in the evidence
    // instead of leaving an absence there.
    const client = await clientAnswering({
      code: '0000',
      message: 'ok',
      data: { valid: false, reason: 'tier below pool minimum' },
    });

    const attested = await attestEligibility(client, signer, REQUEST, hashDigest, {
      now: () => 1_786_000_000_000,
    });

    expect(attested.eligible).toBe(false);
    expect(attested.evidence.reason).toBe('tier below pool minimum');
    expect(attested.signature).toMatch(/^0x[0-9a-f]+$/);
  });

  it('throws rather than signing a refusal when the API itself fails', async () => {
    // The failure this prevents: an outage silently becoming a signed
    // "ineligible", which is a decision nobody made appearing in an audit
    // package as though an authority had made it.
    const client = await clientAnswering({ code: '9999', message: 'internal error', data: {} });

    await expect(
      attestEligibility(client, signer, REQUEST, hashDigest, { now: () => 1_786_000_000_000 }),
    ).rejects.toBeInstanceOf(CleanverseApiError);
  });

  it('throws on a transport failure without signing anything', async () => {
    const client = await clientAnswering({}, 503);
    const signCount = signDigest.mock.calls.length;

    await expect(
      attestEligibility(client, signer, REQUEST, hashDigest, { now: () => 1_786_000_000_000 }),
    ).rejects.toBeInstanceOf(CleanverseTransportError);

    expect(signDigest.mock.calls.length).toBe(signCount);
  });

  it('carries the response hash as the evidence hash', async () => {
    // The hash is over the raw bytes the client received, taken before
    // redaction, so the stored record can be proven to be the one the decision
    // came from.
    const client = await clientAnswering({ code: '0000', message: 'ok', data: { valid: true } });

    const attested = await attestEligibility(client, signer, REQUEST, hashDigest, {
      now: () => 1_786_000_000_000,
    });

    expect(attested.evidenceHash).toBe(attested.evidence.responseHash);
    expect(attested.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('never puts the raw response in the attestation', async () => {
    const client = await clientAnswering({
      code: '0000',
      message: 'ok',
      data: { valid: true, reason: 'ok' },
    });

    const attested = await attestEligibility(client, signer, REQUEST, hashDigest, {
      now: () => 1_786_000_000_000,
    });

    // Only the redacted body and a hash are retained. PRD forbids raw PII, and
    // the attestation itself is published on chain. Asserting the exact key set
    // rather than the absence of one name means a future field has to be added
    // here deliberately instead of arriving unnoticed.
    expect(Object.keys(attested).sort()).toEqual([
      'eligible',
      'evidence',
      'evidenceHash',
      'expiresAt',
      'intentHash',
      'issuedAt',
      'settlementId',
      'signature',
      'subject',
    ]);
    expect(Object.keys(attested.evidence).sort()).toEqual([
      'code',
      'endpoint',
      'reason',
      'redactedBody',
      'requestId',
      'responseHash',
    ]);
  });

  it('separates a decision from an outage for retry purposes', () => {
    // Retrying a decision is pointless; retrying it until it changes is the
    // shape of a compliance bypass.
    expect(isComplianceDecision(new CleanverseApiError('/x', '1234', 'refused', 'rid'))).toBe(true);
    expect(isComplianceDecision(new CleanverseTransportError('boom', 503, 'rid'))).toBe(false);
  });
});

describe('evidenceHashOf', () => {
  it('hashes the exact bytes received', () => {
    const raw = '{"code":"0000","message":"ok","data":{"valid":true}}';
    expect(evidenceHashOf(raw)).toMatch(/^0x[0-9a-f]{64}$/);
    // Re-serializing changes the bytes, and a record that cannot be proven
    // identical to what arrived is not evidence.
    expect(evidenceHashOf(JSON.stringify(JSON.parse(raw)))).toBe(evidenceHashOf(raw));
    expect(evidenceHashOf(`${raw} `)).not.toBe(evidenceHashOf(raw));
  });
});

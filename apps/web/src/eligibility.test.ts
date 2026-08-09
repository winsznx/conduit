/**
 * The one behaviour these tests exist to protect: an outage must never render
 * as a refusal.
 *
 * Every case below is a different way for the answer to be absent or negative,
 * and the assertion is always the same shape — that the status distinguishes
 * "the authority said no" from "nobody answered". A boolean would pass all of
 * these while being wrong about half of them.
 */

import { CleanverseClient, createCipher } from '@conduit-protocol/cleanverse';
import { beforeAll, describe, expect, it } from 'vitest';

import { checkEligibility, type CheckTarget } from './eligibility.js';
import type { Env } from './data.js';

const SUBJECT = '0x83C130ed9fb92830F09ea2b30E49009EF03065Bb';
const ASSET = '0xFEfd2eA28dB25c720ec5298964F8d2F34e3f1F16';

const TARGET: CheckTarget = {
  chain: 'monad',
  chainId: 10_143,
  asset: ASSET,
  assetSymbol: 'cSETTLE',
};

// Env is only read when no client override is supplied, so these are inert.
const ENV = {
  DATABASE_URL: '',
  MONAD_RPC_URL: '',
  BASE_RPC_URL: '',
  DEPLOYMENT_ID: '0xdeadbeef',
  COMMIT_SHA: 'test',
} as unknown as Env;

/** A 32-byte AES key. Test-only, and not a secret in any environment. */
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

let cipher: Awaited<ReturnType<typeof createCipher>>;

beforeAll(async () => {
  cipher = await createCipher(TEST_KEY);
});

/**
 * A client whose transport is a stub.
 *
 * `/verify_apass` is a plain read in the endpoint table, so its responses are
 * unencrypted envelopes. Wrapping the body in the `{ data: ciphertext }` shape
 * the encrypted endpoints use makes every case fail schema validation, which
 * is a way to get eight green tests that prove nothing.
 */
function clientReturning(body: unknown, init?: { status?: number }): CleanverseClient {
  return new CleanverseClient({
    baseUrl: 'https://api.cleanverse.tech',
    apiId: 'test',
    cipher,
    timeoutMs: 1000,
    maxReadRetries: 0,
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: init?.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });
}

function clientThatFails(error: Error) {
  return new CleanverseClient({
    baseUrl: 'https://api.cleanverse.tech',
    apiId: 'test',
    cipher,
    timeoutMs: 1000,
    maxReadRetries: 0,
    fetch: () => Promise.reject(error),
  });
}

describe('eligibility', () => {
  it('reports ELIGIBLE only for verify_apass code 4', async () => {
    // #given the one code that authorises a transfer
    const client = clientReturning({ code: '0000', message: 'ok', data: { code: 4 } });

    // #when the participant is checked
    const result = await checkEligibility(ENV, TARGET, SUBJECT, client);

    // #then it is a decision, and a positive one
    expect(result.status).toBe('ELIGIBLE');
    expect(result.reason).toBe('ALLOWED');
    expect(result.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('separates a missing A-Pass from an ordinary refusal', async () => {
    // #given code 2, which means Cleanverse does not know this participant
    const client = clientReturning({ code: '0000', message: 'ok', data: { code: 2 } });

    // #when checked
    const result = await checkEligibility(ENV, TARGET, SUBJECT, client);

    // #then it is NO_APASS, not a generic no — a judge with a fresh wallet
    // needs to be told something different from a holder who was refused
    expect(result.status).toBe('NO_APASS');
    expect(result.detail).toContain('no A-Pass');
  });

  it('treats a frozen or expired pass as ineligible', async () => {
    const client = clientReturning({ code: '0000', message: 'ok', data: { code: 3 } });
    const result = await checkEligibility(ENV, TARGET, SUBJECT, client);
    expect(result.status).toBe('INELIGIBLE');
    expect(result.reason).toBe('TRANSFER_DISALLOWED');
  });

  it('reports an unknown token as unavailable rather than as a refusal', async () => {
    // #given code 1 — the token was not found, so nobody was asked about anybody
    const client = clientReturning({ code: '0000', message: 'ok', data: { code: 1 } });

    const result = await checkEligibility(ENV, TARGET, SUBJECT, client);

    // #then this is the absence of a question, not a negative answer
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.reason).toBe('ATOKEN_NOT_FOUND');
    expect(result.detail).toContain('not a refusal');
  });

  it('records a policy refusal as a decision, with its marker', async () => {
    // #given the live shape: a refusal arrives through the error envelope
    const client = clientReturning({
      code: '0002',
      message: 'execution reverted: TierTooLow(0x83c1, 21, 20)',
      data: null,
    });

    const result = await checkEligibility(ENV, TARGET, SUBJECT, client);

    // #then it is a refusal and it names the rule that refused
    expect(result.status).toBe('POLICY_REFUSAL');
    expect(result.reason).toBe('TierTooLow');
    expect(result.answer).toContain('TierTooLow');
  });

  it('reports a timeout as unavailable', async () => {
    const client = clientThatFails(
      Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }),
    );

    const result = await checkEligibility(ENV, TARGET, SUBJECT, client);

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.detail).toContain('not a refusal');
  });

  it('reports a malformed response as unavailable', async () => {
    // #given a body that does not match the schema
    const client = clientReturning({ code: '0000', message: 'ok', data: { nope: true } });

    const result = await checkEligibility(ENV, TARGET, SUBJECT, client);

    // #then the shape being wrong says nothing about the participant
    expect(result.status).toBe('UNAVAILABLE');
    expect(['SCHEMA', 'UNKNOWN']).toContain(result.reason);
  });

  it('reports a gateway failure as unavailable', async () => {
    const client = clientReturning(
      { code: '9999', message: 'internal error', data: null },
      { status: 500 },
    );

    const result = await checkEligibility(ENV, TARGET, SUBJECT, client);

    expect(result.status).toBe('UNAVAILABLE');
    expect(result.detail).toContain('not a refusal');
  });

  it('rejects a malformed address before asking anyone', async () => {
    const result = await checkEligibility(ENV, TARGET, 'not-an-address');
    expect(result.status).toBe('INVALID_REQUEST');
    expect(result.reason).toBe('MALFORMED_ADDRESS');
  });

  it('says so when the deployment has no Cleanverse credentials', async () => {
    // #given a Worker with no secrets bound
    const result = await checkEligibility(ENV, TARGET, SUBJECT);

    // #then the user is told nothing was checked, not that they were refused
    expect(result.status).toBe('UNAVAILABLE');
    expect(result.reason).toBe('NOT_CONFIGURED');
  });
});

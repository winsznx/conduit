import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { CleanverseClient, type Fetcher } from './client.js';
import { VerifyApassCode, verifyApassAllowsTransfer } from './codes.js';
import { createCipher, type CleanverseCipher } from './encryption.js';
import {
  CleanverseSchemaError,
  CleanverseTransportError,
  CleanverseWriteInFlightError,
} from './errors.js';

/**
 * PRD 15.2 requires: HTTP 200 with a business failure, validator `valid:false`,
 * paused pool 12027, verify_apass codes 1 through 4, and schema drift.
 *
 * The through-line is CLAUDE.md's invariant that a Cleanverse HTTP 200 is not
 * automatically business success. Several tests below would pass trivially
 * against a client that returned `response.ok`; they exist to fail against one.
 */

const KEY = Buffer.alloc(32, 0x5a).toString('base64');
const ATOKEN = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A `Response` body can only be read once, so a mock that resolves the *same*
 * object twice fails the second attempt with "Body is unusable" rather than
 * exercising the retry path. Every repeated answer is built per call.
 */
function always(fetch: ReturnType<typeof vi.fn<Fetcher>>, body: unknown, status = 200): void {
  fetch.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
}

interface Harness {
  client: CleanverseClient;
  fetch: ReturnType<typeof vi.fn<Fetcher>>;
  cipher: CleanverseCipher;
  sleeps: number[];
}

async function harness(maxReadRetries = 2): Promise<Harness> {
  const cipher = await createCipher(KEY);
  const fetch = vi.fn<Fetcher>();
  const sleeps: number[] = [];

  const client = new CleanverseClient({
    baseUrl: 'https://sandbox.example/api/',
    apiId: 'test-api-id',
    cipher,
    timeoutMs: 1_000,
    maxReadRetries,
    fetch,
    now: () => 1_786_060_800_000,
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
    sleep: (ms): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 0.5,
  });

  return { client, fetch, cipher, sleeps };
}

describe('the five-step response contract (PRD 9.3)', () => {
  it('rejects a non-2xx before it ever looks at the body', async () => {
    const { client, fetch } = await harness(0);
    fetch.mockResolvedValue(jsonResponse({ code: '0000', data: { valid: true } }, 503));

    await expect(client.validatorVerify('monad', ATOKEN, WALLET)).rejects.toBeInstanceOf(
      CleanverseTransportError,
    );
  });

  it('treats HTTP 200 with a non-zero code as a failed operation', async () => {
    const { client, fetch } = await harness(0);
    fetch.mockResolvedValue(
      jsonResponse({ code: '0002', message: 'wallet not permitted', data: null }),
    );

    // The response was HTTP 200. `response.ok` would have said success.
    await expect(client.validatorVerify('monad', ATOKEN, WALLET)).rejects.toMatchObject({
      name: 'CleanverseApiError',
      code: '0002',
    });
  });

  it('rejects a response whose shape does not match its schema', async () => {
    const { client, fetch } = await harness(0);
    // `valid` is required, not defaulted: a missing field must fail rather than
    // silently become false or true.
    fetch.mockResolvedValue(jsonResponse({ code: '0000', data: { reason: 'no answer' } }));

    await expect(client.validatorVerify('monad', ATOKEN, WALLET)).rejects.toBeInstanceOf(
      CleanverseSchemaError,
    );
  });

  it('rejects a body that is not JSON', async () => {
    const { client, fetch } = await harness(0);
    fetch.mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }));

    await expect(client.validatorVerify('monad', ATOKEN, WALLET)).rejects.toBeInstanceOf(
      CleanverseSchemaError,
    );
  });
});

describe('validator verify returning valid:false', () => {
  it('is a business answer, not an error', async () => {
    const { client, fetch } = await harness(0);
    fetch.mockResolvedValue(
      jsonResponse({ code: '0000', message: '', data: { valid: false, reason: 'tier too low' } }),
    );

    // PRD 2.2: a successful call returns code 0000 even when valid is false.
    const result = await client.validatorVerify('monad', ATOKEN, WALLET);

    expect(result.code).toBe('0000');
    expect(result.data.valid).toBe(false);
    expect(result.data.reason).toBe('tier too low');
  });

  it('is never retried, because it is a decision rather than a fault', async () => {
    const { client, fetch } = await harness(3);
    fetch.mockResolvedValue(jsonResponse({ code: '0000', data: { valid: false } }));

    await client.validatorVerify('monad', ATOKEN, WALLET);

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('paused validator pool (code 12027)', () => {
  it('retries under policy and then fails closed', async () => {
    const { client, fetch, sleeps } = await harness(2);
    always(fetch, { code: '12027', message: 'pool paused', data: null });

    await expect(client.validatorIsPaused('monad', ATOKEN)).rejects.toMatchObject({
      code: '12027',
    });

    // Three attempts: the original plus two retries.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleeps).toHaveLength(2);
    // Backoff grows rather than hammering.
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0);
  });

  it('succeeds if the pool un-pauses inside the retry budget', async () => {
    const { client, fetch } = await harness(2);
    fetch
      .mockResolvedValueOnce(jsonResponse({ code: '12027', message: 'paused', data: null }))
      .mockResolvedValueOnce(jsonResponse({ code: '0000', data: { paused: false } }));

    const result = await client.validatorIsPaused('monad', ATOKEN);

    expect(result.data.paused).toBe(false);
    expect(result.attempts).toBe(2);
  });
});

describe('retry policy (PRD 9.4)', () => {
  it('retries a 5xx on a read', async () => {
    const { client, fetch } = await harness(1);
    fetch
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse({ code: '0000', data: { paused: true } }));

    expect((await client.validatorIsPaused('monad', ATOKEN)).data.paused).toBe(true);
  });

  it('does not retry a 4xx, which would repeat a deterministic rejection', async () => {
    const { client, fetch } = await harness(3);
    fetch.mockResolvedValue(jsonResponse({}, 400));

    await expect(client.validatorIsPaused('monad', ATOKEN)).rejects.toBeInstanceOf(
      CleanverseTransportError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a parameter or signature failure', async () => {
    const { client, fetch } = await harness(3);
    fetch.mockResolvedValue(jsonResponse({ code: '0001', message: 'bad signature' }));

    await expect(client.validatorIsPaused('monad', ATOKEN)).rejects.toMatchObject({ code: '0001' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never blind-retries a write', async () => {
    const { client, fetch } = await harness(3);
    fetch.mockResolvedValue(jsonResponse({}, 503));

    await expect(
      client.call('validatorRegister', { chain: 'monad' }, z.object({ tx_hash: z.string() })),
    ).rejects.toBeInstanceOf(CleanverseTransportError);

    // A retried mutation that already landed produces two.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('validator write confirmation (PRD 9.4)', () => {
  const writeSchema = z.object({ tx_hash: z.string() });

  it('refuses a second mutation while the first is unconfirmed', async () => {
    const { client, fetch } = await harness(0);
    fetch.mockResolvedValue(jsonResponse({ code: '0000', data: { tx_hash: '0xdeadbeef' } }));

    await client.call('validatorSetRule', { chain: 'monad' }, writeSchema);
    expect(client.pendingMutation).toBe('0xdeadbeef');

    await expect(
      client.call('validatorAddRule', { chain: 'monad' }, writeSchema),
    ).rejects.toBeInstanceOf(CleanverseWriteInFlightError);
  });

  it('allows the next mutation once confirmation is reported', async () => {
    const { client, fetch } = await harness(0);
    always(fetch, { code: '0000', data: { tx_hash: '0xdeadbeef' } });

    await client.call('validatorSetRule', { chain: 'monad' }, writeSchema);
    client.confirmMutation();

    expect(client.pendingMutation).toBeUndefined();
    await expect(
      client.call('validatorAddRule', { chain: 'monad' }, writeSchema),
    ).resolves.toBeDefined();
  });

  it('does not block reads while a mutation is pending', async () => {
    const { client, fetch } = await harness(0);
    fetch.mockResolvedValueOnce(jsonResponse({ code: '0000', data: { tx_hash: '0xabc' } }));
    await client.call('validatorSetRule', { chain: 'monad' }, writeSchema);

    fetch.mockResolvedValueOnce(jsonResponse({ code: '0000', data: { paused: false } }));
    await expect(client.validatorIsPaused('monad', ATOKEN)).resolves.toBeDefined();
  });
});

describe('verify_apass result codes (PRD 2.2)', () => {
  it.each([
    [VerifyApassCode.ATOKEN_NOT_FOUND, false],
    [VerifyApassCode.NO_APASS, false],
    [VerifyApassCode.TRANSFER_DISALLOWED, false],
    [VerifyApassCode.ALLOWED, true],
  ])('code %i authorizes a transfer: %s', async (code, allowed) => {
    const { client, fetch } = await harness(0);
    fetch.mockResolvedValue(jsonResponse({ code: '0000', data: { code, message: '' } }));

    const result = await client.verifyApass('monad', WALLET, ATOKEN);

    expect(result.data.code).toBe(code);
    expect(verifyApassAllowsTransfer(result.data.code)).toBe(allowed);
  });

  it('treats an undocumented code as not eligible', () => {
    // Fail closed: a code Cleanverse has not documented is not an implied yes.
    expect(verifyApassAllowsTransfer(99)).toBe(false);
  });
});

describe('request construction and evidence', () => {
  it('sends an encrypted body and a per-request X-Request-ID', async () => {
    const { client, fetch, cipher } = await harness(0);
    fetch.mockResolvedValue(jsonResponse({ code: '0000', data: { paused: false } }));

    await client.validatorIsPaused('monad', ATOKEN);

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://sandbox.example/api/validator/is_paused');

    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Request-ID']).toBe('00000000-0000-4000-8000-000000000000');
    expect(headers['api-id']).toBe('test-api-id');

    // The plaintext payload must not be on the wire.
    const rawBody = init?.body;
    if (typeof rawBody !== 'string') throw new TypeError('expected a serialized request body');

    const body = JSON.parse(rawBody) as { data: string };
    expect(Object.keys(body)).toEqual(['data']);
    expect(rawBody).not.toContain(ATOKEN);
    expect(JSON.parse(await cipher.decrypt(body.data))).toMatchObject({ pool_address: ATOKEN });
  });

  it('hashes the raw body and returns a redacted copy', async () => {
    const { client, fetch } = await harness(0);
    fetch.mockResolvedValue(jsonResponse({ code: '0000', data: { paused: false } }));

    const result = await client.validatorIsPaused('monad', ATOKEN);

    expect(result.responseHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.requestId).toBe('00000000-0000-4000-8000-000000000000');
    // The redacted copy mirrors what actually arrived, not the schema-defaulted
    // envelope. It is evidence of the response, so a field Cleanverse omitted
    // must stay omitted here.
    expect(result.redactedBody).toEqual({ code: '0000', data: { paused: false } });
  });

  it('carries the request ID into errors so a support question can cite it', async () => {
    const { client, fetch } = await harness(0);
    fetch.mockResolvedValue(jsonResponse({ code: '0002', message: 'nope' }));

    await expect(client.validatorIsPaused('monad', ATOKEN)).rejects.toMatchObject({
      requestId: '00000000-0000-4000-8000-000000000000',
    });
  });

  it('decrypts an encrypted response envelope', async () => {
    const { client, fetch, cipher } = await harness(0);
    const inner = JSON.stringify({ code: '0000', message: '', data: { paused: true } });
    fetch.mockResolvedValue(jsonResponse({ data: await cipher.encrypt(inner) }));

    expect((await client.validatorIsPaused('monad', ATOKEN)).data.paused).toBe(true);
  });
});

describe('A-Token discovery (PRD 2.4)', () => {
  it('returns the discovered list rather than any hardcoded address', async () => {
    const { client, fetch } = await harness(0);
    fetch.mockResolvedValue(
      jsonResponse({
        code: '0000',
        data: {
          chain: '',
          tokens: [
            {
              origin_token: {
                address: '0x3333333333333333333333333333333333333333',
                name: 'USDC',
                symbol: 'usdc',
                decimals: 6,
              },
              atoken: { address: ATOKEN, name: 'aUSDC', symbol: 'ausdc', decimals: 6 },
              accesscore_address: '0x4444444444444444444444444444444444444444',
              apass_address: '0x5555555555555555555555555555555555555555',
            },
          ],
        },
      }),
    );

    const result = await client.queryDepositATokenList('monad');

    expect(result.data.tokens).toHaveLength(1);
    expect(result.data.tokens[0]?.atoken.address).toBe(ATOKEN);
    expect(result.data.tokens[0]?.atoken.decimals).toBe(6);
  });

  it('fails loudly when the token array is absent rather than reporting zero tokens', async () => {
    // Regression: `tokens` was declared with `.default([])`, so a response with
    // an entirely different shape validated cleanly as "no tokens available".
    // Schema drift reported as an empty result is the same failure mode as
    // treating HTTP 200 as business success.
    const { client, fetch } = await harness(0);
    fetch.mockResolvedValue(jsonResponse({ code: '0000', data: { somethingElse: [] } }));

    await expect(client.queryDepositATokenList('monad')).rejects.toBeInstanceOf(
      CleanverseSchemaError,
    );
  });
});

import { recoverMessageAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { CleanverseClient, type Fetcher } from './client.js';
import { createCipher } from './encryption.js';
import { pollApplyStatus, registerAToken, registrationMessage } from './registration.js';
import { isApplyStatusTerminal, isRegistrationComplete } from './schemas.js';

/**
 * Custom CVA registration. CCP guide Method B, v1.1 override section 6.
 *
 * Two things carry real risk here and both are tested directly rather than
 * through the happy path.
 *
 * The signing string must be exactly `lowercase(chain + atoken_address)`. A
 * checksummed address or a network name in place of the Cleanverse slug still
 * produces a perfectly valid signature — it just recovers to a different
 * address, and the gateway reports "chain signature invalid" without saying
 * which half was wrong.
 *
 * And `ISSUED` is the only terminal success. An `APPROVED` application still
 * fails `canTransfer`, so treating it as done would put a capability in the
 * audit package that the chain does not agree with.
 */

const KEY = Buffer.alloc(32, 0x5a).toString('base64');
const TOKEN = '0xd018aAd670585519e0953310D29CC2F65011782C';
const OWNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function harness(): Promise<{
  client: CleanverseClient;
  fetch: ReturnType<typeof vi.fn<Fetcher>>;
}> {
  const fetch = vi.fn<Fetcher>();
  const client = new CleanverseClient({
    baseUrl: 'https://sandbox.example/api/cooperate',
    apiId: 'test-api-id',
    cipher: await createCipher(KEY),
    timeoutMs: 1_000,
    maxReadRetries: 0,
    fetch,
    now: () => 1_786_060_800_000,
    randomUUID: () => '00000000-0000-4000-8000-000000000000',
    sleep: () => Promise.resolve(),
    random: () => 0.5,
  });
  return { client, fetch };
}

describe('the registration signing message', () => {
  it('lowercases the whole string, address included', () => {
    expect(registrationMessage('base', TOKEN)).toBe(
      'base0xd018aad670585519e0953310d29cc2f65011782c',
    );
  });

  it('takes the Cleanverse chain slug, not a network name', () => {
    // `base-sepolia` is the network; `base` is what Cleanverse calls it. The
    // wrong one signs cleanly and recovers to nothing useful.
    expect(registrationMessage('base', TOKEN)).not.toBe(registrationMessage('base-sepolia', TOKEN));
  });

  it('joins with no separator', () => {
    const message = registrationMessage('base', TOKEN);
    expect(message).toBe(`base${TOKEN.toLowerCase()}`);
    expect(message).not.toContain(':');
    expect(message).not.toContain('-');
  });

  it('recovers to the signer under EIP-191 personal_sign', async () => {
    // The property that actually matters: whatever the owner signs must recover
    // to the owner under the same semantics Cleanverse uses.
    const account = privateKeyToAccount(OWNER_KEY);
    const message = registrationMessage('base', TOKEN);
    const signature = await account.signMessage({ message });

    expect(await recoverMessageAddress({ message, signature })).toBe(account.address);
  });

  it('does not recover to the signer if the address is checksummed', async () => {
    const account = privateKeyToAccount(OWNER_KEY);
    const signature = await account.signMessage({ message: `base${TOKEN}` });

    // Signed over the checksummed form, verified against the lowercase form.
    const recovered = await recoverMessageAddress({
      message: registrationMessage('base', TOKEN),
      signature,
    });
    expect(recovered).not.toBe(account.address);
  });
});

describe('apply status semantics', () => {
  it.each(['ISSUED', 'issued'])('treats %s as registered', (status) => {
    expect(isRegistrationComplete(status)).toBe(true);
  });

  it.each(['PENDING', 'APPROVED', 'REJECTED', 'FAILED', 'UNKNOWN'])(
    'does not treat %s as registered',
    (status) => {
      expect(isRegistrationComplete(status)).toBe(false);
    },
  );

  it('treats APPROVED as still in flight, not terminal', () => {
    // The trap: approved-but-not-issued still fails canTransfer.
    expect(isApplyStatusTerminal('APPROVED')).toBe(false);
    expect(isApplyStatusTerminal('PENDING')).toBe(false);
    expect(isApplyStatusTerminal('ISSUED')).toBe(true);
    expect(isApplyStatusTerminal('REJECTED')).toBe(true);
  });
});

describe('registerAToken', () => {
  it('sends an encrypted body with the documented snake_case fields', async () => {
    const { client, fetch } = await harness();
    fetch.mockResolvedValue(
      jsonResponse({ code: '0000', data: { requestId: 'req-1', issueAssetRegisterId: 42 } }),
    );

    const data = await registerAToken(client, {
      chain: 'base',
      atokenAddress: TOKEN,
      ownerSignature: '0xdeadbeef',
      atokenIcon: 'https://example.test/icon.svg',
    });

    expect(data.requestId).toBe('req-1');

    const rawBody = fetch.mock.calls[0]?.[1]?.body;
    if (typeof rawBody !== 'string') throw new TypeError('expected a serialized body');
    // Encrypted, so no field names on the wire.
    expect(Object.keys(JSON.parse(rawBody) as Record<string, unknown>)).toEqual(['data']);
    expect(rawBody).not.toContain('owner_signature');
  });

  it('rejects a response missing requestId rather than defaulting it', async () => {
    const { client, fetch } = await harness();
    fetch.mockResolvedValue(jsonResponse({ code: '0000', data: { issueAssetRegisterId: 42 } }));

    await expect(
      registerAToken(client, {
        chain: 'base',
        atokenAddress: TOKEN,
        ownerSignature: '0xdeadbeef',
        atokenIcon: 'https://example.test/icon.svg',
      }),
    ).rejects.toThrow();
  });

  it('surfaces a chain signature failure as a business error', async () => {
    const { client, fetch } = await harness();
    fetch.mockResolvedValue(
      jsonResponse({ code: '0002', message: 'chain signature invalid', data: null }),
    );

    await expect(
      registerAToken(client, {
        chain: 'base',
        atokenAddress: TOKEN,
        ownerSignature: '0xnotthesigner',
        atokenIcon: 'https://example.test/icon.svg',
      }),
    ).rejects.toMatchObject({ code: '0002' });
  });
});

describe('pollApplyStatus', () => {
  it('keeps polling through PENDING and APPROVED, and stops at ISSUED', async () => {
    const { client, fetch } = await harness();
    fetch
      .mockResolvedValueOnce(jsonResponse({ code: '0000', data: { applyStatus: 'PENDING' } }))
      .mockResolvedValueOnce(jsonResponse({ code: '0000', data: { applyStatus: 'APPROVED' } }))
      .mockResolvedValueOnce(jsonResponse({ code: '0000', data: { applyStatus: 'ISSUED' } }));

    const outcome = await pollApplyStatus(client, 'req-1', {
      intervalMs: 0,
      sleep: () => Promise.resolve(),
    });

    expect(outcome.attempts).toBe(3);
    expect(outcome.applyStatus).toBe('ISSUED');
    expect(outcome.registered).toBe(true);
  });

  it('stops at REJECTED without claiming registration', async () => {
    const { client, fetch } = await harness();
    fetch.mockResolvedValue(
      jsonResponse({ code: '0000', data: { applyStatus: 'REJECTED', reason: 'owner mismatch' } }),
    );

    const outcome = await pollApplyStatus(client, 'req-1', {
      intervalMs: 0,
      sleep: () => Promise.resolve(),
    });

    expect(outcome.registered).toBe(false);
    expect(outcome.data.reason).toBe('owner mismatch');
  });

  it('gives up after the attempt budget without reporting success', async () => {
    const { client, fetch } = await harness();
    fetch.mockImplementation(() =>
      Promise.resolve(jsonResponse({ code: '0000', data: { applyStatus: 'PENDING' } })),
    );

    const outcome = await pollApplyStatus(client, 'req-1', {
      maxAttempts: 3,
      intervalMs: 0,
      sleep: () => Promise.resolve(),
    });

    expect(outcome.attempts).toBe(3);
    expect(outcome.applyStatus).toBe('PENDING');
    expect(outcome.registered).toBe(false);
  });

  it('ends the poll on a business error rather than burning the budget', async () => {
    const { client, fetch } = await harness();
    fetch.mockResolvedValue(
      jsonResponse({ code: '0002', message: 'request not found', data: null }),
    );

    const outcome = await pollApplyStatus(client, 'unknown', {
      intervalMs: 0,
      sleep: () => Promise.resolve(),
    });

    expect(outcome.attempts).toBe(1);
    expect(outcome.registered).toBe(false);
    expect(outcome.data.reason).toContain('request not found');
  });
});

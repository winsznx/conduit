import { describe, expect, it } from 'vitest';

import { hashRawBody, redact, REDACTED } from './redact.js';

/**
 * CLAUDE.md: "Store redacted response plus full-response hash", and never log
 * plaintext, ciphertext, key, or a decrypted sensitive response.
 */

describe('redaction', () => {
  it('keeps a business payload under the `data` key', () => {
    // Regression: `data` is the ciphertext key on an encrypted envelope and the
    // payload key on a decrypted one. Blanking it by name erased every response.
    expect(redact({ code: '0000', data: { paused: false } })).toEqual({
      code: '0000',
      data: { paused: false },
    });
  });

  it('redacts a `data` value that is a string, which is always ciphertext', () => {
    expect(redact({ data: 'U2FsdGVkX1+abcdef==' })).toEqual({ data: REDACTED });
  });

  it.each([
    'apiKey',
    'api_key',
    'secret',
    'password',
    'privateKey',
    'quoteToken',
    'signature',
    'iban',
    'email',
    'firstName',
    'bankAccount',
  ])('redacts %s', (key) => {
    expect(redact({ [key]: 'sensitive-value' })).toEqual({ [key]: REDACTED });
  });

  it('redacts regardless of key casing', () => {
    expect(redact({ APIKEY: 'x', Api_Key: 'y' })).toEqual({ APIKEY: REDACTED, Api_Key: REDACTED });
  });

  it('keeps wallet addresses, which PRD 16.4 classifies as pseudonymous', () => {
    const address = '0x1111111111111111111111111111111111111111';
    expect(redact({ address, from: address, to: address })).toEqual({
      address,
      from: address,
      to: address,
    });
  });

  it('reaches into nested objects and arrays', () => {
    expect(redact({ list: [{ email: 'a@b.c', tier: 2 }, { tier: 3 }] })).toEqual({
      list: [{ email: REDACTED, tier: 2 }, { tier: 3 }],
    });
  });

  it('preserves unknown keys so schema drift stays visible', () => {
    // A redactor that dropped unfamiliar fields would hide exactly the change
    // worth noticing.
    expect(redact({ brandNewField: 'value' })).toEqual({ brandNewField: 'value' });
  });

  it('does not mutate its input', () => {
    const input = { apiKey: 'secret', tier: 1 };
    redact(input);
    expect(input.apiKey).toBe('secret');
  });

  it('stops at a depth limit rather than recursing without bound', () => {
    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };

    expect(() => redact(deep)).not.toThrow();
  });

  it.each([null, 42, 'plain', true, undefined])('passes through the primitive %s', (value) => {
    expect(redact(value)).toBe(value);
  });
});

describe('response hashing', () => {
  it('produces lowercase 0x-prefixed sha256, per the CLAUDE.md repository rules', async () => {
    const hash = await hashRawBody('{"code":"0000"}');

    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    // Fixed vector, so switching algorithm or encoding fails here rather than
    // silently invalidating every attestation that anchored an older hash.
    expect(hash).toBe('0xa37095f6da2ff2b50490c66d4d9cffb7d30c320ee07dd1d292e531002eb40863');
  });

  it('is stable for identical bytes', async () => {
    expect(await hashRawBody('{"a":1}')).toBe(await hashRawBody('{"a":1}'));
  });

  it('differs for semantically equal but differently ordered bytes', async () => {
    // This is why the hash is taken over raw bytes rather than a parsed object:
    // an auditor recomputes it from what Cleanverse actually sent.
    expect(await hashRawBody('{"a":1,"b":2}')).not.toBe(await hashRawBody('{"b":2,"a":1}'));
  });

  it('hashes the empty body without throwing', async () => {
    expect(await hashRawBody('')).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

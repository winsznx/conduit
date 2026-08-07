import { createCipheriv } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCipher, encryptRequestBody } from './encryption.js';
import { CleanverseEncryptionError } from './errors.js';

/**
 * PRD 15.2 requires: AES round-trip, exact zero IV, malformed base64, invalid
 * key length.
 *
 * The zero-IV test is the one that matters. A round-trip passes with *any* IV
 * as long as both directions agree, so it cannot detect the one property
 * Cleanverse actually mandates. The check below compares against an independent
 * implementation — `node:crypto` with an explicitly constructed zero IV — so a
 * drift to a random or derived IV fails here rather than at the sandbox.
 */

const KEY_128 = Buffer.alloc(16, 0x11);
const KEY_192 = Buffer.alloc(24, 0x22);
const KEY_256 = Buffer.alloc(32, 0x33);

const b64 = (buffer: Buffer): string => buffer.toString('base64');

/** Independent reference: AES-CBC, PKCS#7, explicit sixteen zero bytes. */
function referenceEncrypt(key: Buffer, plaintext: string): string {
  const cipher = createCipheriv(`aes-${String(key.length * 8)}-cbc`, key, Buffer.alloc(16, 0));
  return Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('base64');
}

describe('AES round-trip', () => {
  it.each([
    ['128-bit', KEY_128],
    ['192-bit', KEY_192],
    ['256-bit', KEY_256],
  ])('%s key encrypts and decrypts back to the original', async (_label, key) => {
    const cipher = await createCipher(b64(key));
    const plaintext = JSON.stringify({ chain: 'monad', address: '0x'.padEnd(42, 'a') });

    expect(await cipher.decrypt(await cipher.encrypt(plaintext))).toBe(plaintext);
  });

  it('round-trips a payload containing multibyte characters', async () => {
    const cipher = await createCipher(b64(KEY_256));
    const plaintext = JSON.stringify({ note: 'ünïcödé — 日本語 — 🔐' });

    expect(await cipher.decrypt(await cipher.encrypt(plaintext))).toBe(plaintext);
  });

  it('round-trips the empty string, which pads to exactly one block', async () => {
    const cipher = await createCipher(b64(KEY_256));
    expect(await cipher.decrypt(await cipher.encrypt(''))).toBe('');
  });
});

describe('the fixed zero IV required by PRD 9.2', () => {
  it.each([
    ['128-bit', KEY_128],
    ['192-bit', KEY_192],
    ['256-bit', KEY_256],
  ])('%s ciphertext matches an independent zero-IV implementation', async (_label, key) => {
    const cipher = await createCipher(b64(key));
    const plaintext = '{"probe":"fixed-iv"}';

    expect(await cipher.encrypt(plaintext)).toBe(referenceEncrypt(key, plaintext));
  });

  it('is deterministic, which is the observable consequence of a fixed IV', async () => {
    const cipher = await createCipher(b64(KEY_256));

    // Equal plaintexts producing equal ciphertexts is a real weakness of the
    // upstream scheme. It is asserted here so nobody "fixes" it locally and
    // silently breaks compatibility with Cleanverse.
    expect(await cipher.encrypt('same')).toBe(await cipher.encrypt('same'));
  });
});

describe('key validation', () => {
  it.each([
    ['too short', Buffer.alloc(8)],
    ['between valid lengths', Buffer.alloc(20)],
    ['too long', Buffer.alloc(64)],
    ['empty', Buffer.alloc(0)],
  ])('rejects a %s key', async (_label, key) => {
    await expect(createCipher(b64(key))).rejects.toThrow(CleanverseEncryptionError);
  });

  it.each([
    ['contains invalid characters', 'not-base64!!'],
    ['is not a multiple of four', 'YWJj YQ'],
    ['is empty', ''],
  ])('rejects a key that %s', async (_label, value) => {
    await expect(createCipher(value)).rejects.toThrow(CleanverseEncryptionError);
  });

  it('never includes key material in the error message', async () => {
    const secret = b64(Buffer.alloc(20, 0xab));

    await expect(createCipher(secret)).rejects.toSatisfy(
      (error: Error) => !error.message.includes(secret),
    );
  });
});

describe('ciphertext validation', () => {
  it('rejects malformed base64', async () => {
    const cipher = await createCipher(b64(KEY_256));
    await expect(cipher.decrypt('!!!not base64!!!')).rejects.toThrow(CleanverseEncryptionError);
  });

  it('rejects a ciphertext that is not a whole number of blocks', async () => {
    const cipher = await createCipher(b64(KEY_256));
    await expect(cipher.decrypt(b64(Buffer.alloc(17)))).rejects.toThrow(CleanverseEncryptionError);
  });

  it('rejects an empty ciphertext', async () => {
    const cipher = await createCipher(b64(KEY_256));
    await expect(cipher.decrypt('')).rejects.toThrow(CleanverseEncryptionError);
  });

  it('reports the same message for a wrong key and bad padding', async () => {
    // Distinguishing the two would be a padding oracle, and the message reaches
    // logs.
    const right = await createCipher(b64(KEY_256));
    const wrong = await createCipher(b64(Buffer.alloc(32, 0x44)));
    const ciphertext = await right.encrypt('{"a":1}');

    const messageOf = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);

    const wrongKeyError = await wrong.decrypt(ciphertext).catch(messageOf);
    const garbageError = await right.decrypt(b64(Buffer.alloc(32, 0x99))).catch(messageOf);

    expect(wrongKeyError).toBe(garbageError);
  });
});

describe('request body envelope', () => {
  it('wraps ciphertext as { data } per PRD 9.2', async () => {
    const cipher = await createCipher(b64(KEY_256));
    const body = await encryptRequestBody(cipher, { chain: 'monad' });

    expect(Object.keys(body)).toEqual(['data']);
    expect(await cipher.decrypt(body.data)).toBe('{"chain":"monad"}');
  });
});

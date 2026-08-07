/**
 * Cleanverse request-body encryption. PRD 9.2.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * This is NOT authenticated encryption, and it is NOT a general-purpose helper.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Cleanverse V5.6 specifies AES/CBC/PKCS5Padding with a fixed sixteen-byte zero
 * IV. A fixed IV means identical plaintexts produce identical ciphertexts, so
 * the scheme leaks equality and provides no integrity. That is an upstream
 * protocol requirement, not a choice available to this repository.
 *
 * Consequences, all mandated by CLAUDE.md and PRD 9.2:
 *
 *   - confidentiality in transit comes from TLS, not from this function;
 *   - this file is the only place in the monorepo that may implement AES;
 *   - nothing here may be reused for internal cryptography, where a random IV
 *     and an AEAD mode are available and required;
 *   - no plaintext, ciphertext, or key material is ever logged, thrown, or
 *     included in an error message.
 *
 * WebCrypto is used rather than `node:crypto` so the same code runs unmodified
 * on Cloudflare Workers, per the v1.1 override. SubtleCrypto's AES-CBC applies
 * PKCS#7 padding, which is identical to PKCS5 at a sixteen-byte block size.
 */

import { CleanverseEncryptionError } from './errors.js';

/** Sixteen zero bytes. Required by Cleanverse; never vary it. */
const FIXED_ZERO_IV = new Uint8Array(16);

const VALID_KEY_LENGTHS = new Set([16, 24, 32]);

export interface CleanverseCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertextBase64: string): Promise<string>;
}

/**
 * Base64 padding is optional in practice, and Cleanverse omits it.
 *
 * The sandbox API key arrives as 43 characters: a 32-byte AES-256 key whose
 * trailing `=` was dropped. An earlier version of this function required the
 * length to be a multiple of four and rejected the real credential outright, so
 * padding is restored here rather than demanded of the operator.
 *
 * The charset is still enforced strictly. A value containing whitespace or any
 * character outside the base64 alphabet is malformed, not merely unpadded.
 */
function decodeBase64(value: string, label: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new CleanverseEncryptionError(`${label} is not valid base64`);
  }

  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  if (padded.length % 4 !== 0) {
    throw new CleanverseEncryptionError(`${label} is not valid base64`);
  }

  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    throw new CleanverseEncryptionError(`${label} is not valid base64`);
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Builds a cipher from the base64 API key.
 *
 * The key is imported as non-extractable, so a later bug cannot read it back out
 * of the CryptoKey and log it.
 */
export async function createCipher(apiKeyBase64: string): Promise<CleanverseCipher> {
  const keyBytes = decodeBase64(apiKeyBase64, 'API key');

  if (!VALID_KEY_LENGTHS.has(keyBytes.length)) {
    throw new CleanverseEncryptionError(
      `API key must decode to 16, 24, or 32 bytes, got ${String(keyBytes.length)}`,
    );
  }

  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, [
    'encrypt',
    'decrypt',
  ]);

  return {
    async encrypt(plaintext: string): Promise<string> {
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-CBC', iv: FIXED_ZERO_IV },
        key,
        new TextEncoder().encode(plaintext),
      );
      return encodeBase64(new Uint8Array(encrypted));
    },

    async decrypt(ciphertextBase64: string): Promise<string> {
      const ciphertext = decodeBase64(ciphertextBase64, 'ciphertext');

      if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
        throw new CleanverseEncryptionError(
          `ciphertext length ${String(ciphertext.length)} is not a positive multiple of the 16-byte block size`,
        );
      }

      let decrypted: ArrayBuffer;
      try {
        decrypted = await crypto.subtle.decrypt(
          { name: 'AES-CBC', iv: FIXED_ZERO_IV },
          key,
          ciphertext,
        );
      } catch {
        // Deliberately opaque. A padding-versus-key distinction here would be a
        // padding oracle, and the message reaches logs.
        throw new CleanverseEncryptionError('ciphertext could not be decrypted');
      }

      return new TextDecoder().decode(decrypted);
    },
  };
}

/** PRD 9.2: the encrypted request body is `{ "data": "<base64 ciphertext>" }`. */
export async function encryptRequestBody(
  cipher: CleanverseCipher,
  payload: unknown,
): Promise<{ data: string }> {
  return { data: await cipher.encrypt(JSON.stringify(payload)) };
}

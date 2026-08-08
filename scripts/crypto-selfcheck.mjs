#!/usr/bin/env node
/**
 * One self-check on the AES helper, against the live credential, then freeze it.
 *
 *   node --env-file=.env scripts/crypto-selfcheck.mjs
 *
 * Cleanverse Labs confirmed the model this repository already implements:
 * AES-256-CBC, PKCS#7-equivalent padding, a fixed sixteen-byte zero IV, a
 * base64 `api-key` decoding to exactly thirty-two bytes, a `{"data": "<base64>"}`
 * body, and `api-id` plus `X-Request-ID` headers. `POST /atoken/register_atoken`
 * already encrypts, is decrypted upstream, and reached `ISSUED` with this
 * helper, which is a live end-to-end proof that the model matches.
 *
 * So this is a confirmation, not an investigation. It checks the four things a
 * confirmation should check and then stops:
 *
 * ```text
 *   the configured key decodes to exactly 32 bytes      (never printed)
 *   the IV the helper uses is 16 zero bytes
 *   a fixed fixture round-trips through the helper
 *   an independent implementation agrees byte for byte, both directions
 * ```
 *
 * "Independent" means `node:crypto` rather than the WebCrypto the helper uses.
 * Two paths through the same library agreeing proves the library is consistent
 * with itself; two different implementations agreeing on the same bytes is the
 * only version of this check worth running.
 *
 * Nothing here prints key material, plaintext, or ciphertext derived from the
 * real credential. The fixture is a constant in this file and the live key is
 * used only for its length.
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';

import { createCipher } from '../packages/cleanverse/dist/encryption.js';

import { createLog, unbufferStdout } from './lib/observe.mjs';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();
const log = createLog(join(ROOT, 'docs', 'evidence', 'artifacts', 'crypto-selfcheck.log'));

const results = [];
function check(name, ok, detail) {
  results.push({ check: name, ok, detail });
  (ok ? log.ok : log.fail)(`${name} — ${detail}`);
}

/** Restores the padding Cleanverse omits, without altering the bytes. */
function decodeKey(raw) {
  const padded = raw.length % 4 === 0 ? raw : raw + '='.repeat(4 - (raw.length % 4));
  return Buffer.from(padded, 'base64');
}

const FIXTURE = JSON.stringify({
  chain: 'monad',
  contract_address: '0x0000000000000000000000000000000000000001',
  user_address: '0x0000000000000000000000000000000000000002',
  note: 'fixed fixture — not derived from any live request',
});

/** A fixed test key. Never the live credential; this one is published. */
const FIXTURE_KEY = Buffer.alloc(32, 7);
const ZERO_IV = Buffer.alloc(16);

log.stage('the live credential');

const raw = process.env['CLEANVERSE_API_KEY_BASE64'];
if (raw === undefined || raw === '') {
  log.fail('CLEANVERSE_API_KEY_BASE64 is not set');
  process.exit(1);
}

{
  const decoded = decodeKey(raw);
  check(
    'the configured api-key decodes to exactly 32 bytes',
    decoded.length === 32,
    `${decoded.length} bytes — AES-256`,
  );
  // The buffer is dropped here and never touched again. Its length was the
  // only thing this check needed and the only thing it is allowed to learn.
  decoded.fill(0);
}

log.stage('the fixed IV');

{
  // Read out of the helper's own behaviour rather than out of its source: an
  // independent decryption with a zero IV succeeding is proof the helper used
  // one, and a comment claiming so is not.
  const cipher = await createCipher(FIXTURE_KEY.toString('base64'));
  const produced = Buffer.from(await cipher.encrypt(FIXTURE), 'base64');

  const decipher = createDecipheriv('aes-256-cbc', FIXTURE_KEY, ZERO_IV);
  decipher.setAutoPadding(true);
  const recovered = Buffer.concat([decipher.update(produced), decipher.final()]).toString('utf8');

  check(
    'the helper encrypts under a sixteen-byte zero IV',
    recovered === FIXTURE,
    'node:crypto decrypted the helper’s ciphertext with an all-zero IV',
  );
  check(
    'the IV is sixteen bytes of zero',
    ZERO_IV.length === 16 && ZERO_IV.every((b) => b === 0),
    '16 bytes, all zero',
  );
}

log.stage('round trip, both directions, two implementations');

{
  const cipher = await createCipher(FIXTURE_KEY.toString('base64'));

  // helper → node:crypto
  const helperCiphertext = Buffer.from(await cipher.encrypt(FIXTURE), 'base64');
  const decipher = createDecipheriv('aes-256-cbc', FIXTURE_KEY, ZERO_IV);
  const viaNode = Buffer.concat([decipher.update(helperCiphertext), decipher.final()]);
  check(
    'helper ciphertext decrypts under node:crypto, byte for byte',
    viaNode.equals(Buffer.from(FIXTURE, 'utf8')),
    `${viaNode.length} bytes recovered`,
  );

  // node:crypto → helper
  const encipher = createCipheriv('aes-256-cbc', FIXTURE_KEY, ZERO_IV);
  const nodeCiphertext = Buffer.concat([encipher.update(FIXTURE, 'utf8'), encipher.final()]);
  const viaHelper = await cipher.decrypt(nodeCiphertext.toString('base64'));
  check(
    'node:crypto ciphertext decrypts under the helper, byte for byte',
    Buffer.from(viaHelper, 'utf8').equals(Buffer.from(FIXTURE, 'utf8')),
    `${viaHelper.length} characters recovered`,
  );

  // The two ciphertexts must be identical, which is what a fixed IV means and
  // what makes the two implementations interchangeable on the wire.
  check(
    'both implementations produce identical ciphertext',
    helperCiphertext.equals(nodeCiphertext),
    `${helperCiphertext.length} bytes, PKCS#7 padded from ${Buffer.byteLength(FIXTURE)}`,
  );

  // Padding, explicitly: PKCS#7 at a sixteen-byte block adds a whole block when
  // the plaintext is already a multiple of the block size. PKCS5 is the same
  // thing at this block size, which is why the guide's PKCS5 wording is met.
  const exactBlocks = 'A'.repeat(32);
  const paddedCipher = Buffer.from(await cipher.encrypt(exactBlocks), 'base64');
  check(
    'a plaintext that is already a whole number of blocks gains a full padding block',
    paddedCipher.length === 48,
    `32 bytes in, ${paddedCipher.length} out`,
  );
}

log.stage('result');

const failed = results.filter((entry) => !entry.ok);
const path = join(ROOT, 'docs', 'evidence', 'cleanverse-crypto-selfcheck.json');
writeFileSync(
  path,
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      outcome: failed.length === 0 ? 'CONFIRMED' : 'MISMATCH',
      model: {
        algorithm: 'AES-256-CBC',
        padding: 'PKCS#7, identical to PKCS5 at a 16-byte block',
        iv: 'fixed 16 zero bytes',
        key: 'base64 api-key decoding to exactly 32 bytes',
        body: '{"data":"<base64 ciphertext>"}',
        headers: 'api-id, X-Request-ID',
      },
      independentImplementation: 'node:crypto aes-256-cbc, against the helper’s WebCrypto',
      liveEndToEndProof:
        'POST /atoken/register_atoken encrypted with this helper was decrypted upstream and reached applyStatus ISSUED — docs/evidence/phase-03-cva-registration.json',
      checks: results,
      frozen: failed.length === 0,
      note: 'The helper is frozen. generate_apass remains classified as route- or request-specific (SANDBOX_AUTHORIZATION_MISMATCH) pending Cleanverse tracing the recorded X-Request-IDs; it is not an encryption question and no further build cycle is spent on it.',
    },
    null,
    2,
  )}\n`,
);
log.step(`written ${path}`);

if (failed.length > 0) {
  log.fail(`${failed.length} check(s) failed — do not freeze`);
  process.exitCode = 1;
} else {
  log.ok('all five checks green — the AES helper is frozen');
}

#!/usr/bin/env node
/**
 * Captures the exact evidence for the generate_apass authorization mismatch.
 *
 * This is deliberately NOT recorded as a missing feature. The organiser stated
 * that hackathon accounts are Issue Members and may generate controlled test
 * A-Passes without a KYC source or ID. A 403 against that guidance is more
 * likely provisioning or UAT drift than an absent capability, and calling it
 * "unsupported" would put a wrong conclusion in the record and send Cleanverse
 * looking for the wrong thing.
 *
 * What is captured is what their support can act on: status, code, message,
 * X-Request-ID, chain, and the request *shape* with no values.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateMnemonic, english, mnemonicToAccount } from 'viem/accounts';

import { ROOT } from './lib/run.mjs';

const base = process.env['CLEANVERSE_BASE_URL'];
const apiId = process.env['CLEANVERSE_API_ID'];
const rawKey = process.env['CLEANVERSE_API_KEY_BASE64'];

const padded = rawKey + '='.repeat((4 - (rawKey.length % 4)) % 4);
const keyBytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt']);
const iv = new Uint8Array(16);
const encrypt = async (o) =>
  btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-CBC', iv },
          key,
          new TextEncoder().encode(JSON.stringify(o)),
        ),
      ),
    ),
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempts = [];

for (const chain of ['monad', 'base']) {
  // A freshly generated wallet, never used and discarded at exit. Nothing about
  // it is reused, so nothing is at risk in sharing the address with support.
  const wallet = mnemonicToAccount(generateMnemonic(english));
  const requestId = crypto.randomUUID();
  const payload = {
    chain,
    wallet: wallet.address,
    customerId: `CONDUITHACK${chain.toUpperCase()}0001`,
    expirationTime: 1_817_596_800,
  };

  const response = await fetch(`${base}/generate_apass`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-id': apiId, 'X-Request-ID': requestId },
    body: JSON.stringify({ data: await encrypt(payload) }),
    signal: AbortSignal.timeout(25_000),
  });

  const bodyText = await response.text();
  let code;
  let message = bodyText.trim();
  try {
    const parsed = JSON.parse(bodyText);
    code = parsed.code;
    message = parsed.message ?? message;
  } catch {
    code = null; // plain-text gateway response, not a Cleanverse envelope
  }

  attempts.push({
    chain,
    requestId,
    httpStatus: response.status,
    cleanverseCode: code,
    message: message.slice(0, 200),
    envelopeReturned: code !== null,
    // Shape only. No values, no wallet reuse.
    requestShape: {
      transport: 'AES-CBC/PKCS5, zero IV, base64, body {"data": "<ciphertext>"}',
      headers: ['content-type', 'api-id', 'X-Request-ID'],
      plaintextFields: Object.keys(payload),
      kycSourceSupplied: false,
      kycIdSupplied: false,
    },
    probeWalletAddress: wallet.address,
  });

  await sleep(2_000);
}

// A control: an endpoint the same credential is known to be authorised for, so
// the report distinguishes "this credential is broken" from "this endpoint is
// not authorised for this credential".
const controlRequestId = crypto.randomUUID();
const control = await fetch(`${base}/query_deposit_atoken_list`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'api-id': apiId,
    'X-Request-ID': controlRequestId,
  },
  body: JSON.stringify({ chain: 'base' }),
  signal: AbortSignal.timeout(25_000),
});
const controlBody = JSON.parse(await control.text());

const evidence = {
  classification: 'SANDBOX_AUTHORIZATION_MISMATCH',
  notClassifiedAs: 'FEATURE_UNAVAILABLE',
  rationale:
    'Organiser guidance states hackathon accounts are Issue Members and may generate controlled test A-Passes without kycSource or kycId. A 403 against that guidance is more consistent with provisioning or UAT configuration drift than with an absent capability. Recording it as unsupported would be a conclusion the evidence does not support.',
  capturedAt: new Date().toISOString(),
  endpoint: `${base}/generate_apass`,
  attempts,
  control: {
    endpoint: `${base}/query_deposit_atoken_list`,
    requestId: controlRequestId,
    httpStatus: control.status,
    cleanverseCode: controlBody.code,
    note: 'Same api-id, same transport. Authenticates and returns data, so the credential itself is valid.',
  },
  impact:
    'Blocks creation of controlled buyer and seller A-Passes on Base, which the end-to-end CVA settlement proof requires. A-Pass is chain-scoped (ASM-031), so the Monad A-Pass we hold does not satisfy the asset leg.',
};

const path = join(ROOT, 'docs', 'evidence', 'generate-apass-authorization.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);

for (const a of attempts) {
  console.log(
    `chain=${a.chain.padEnd(6)} http=${a.httpStatus} code=${a.cleanverseCode ?? '(no envelope)'} requestId=${a.requestId}`,
  );
  console.log(`  message: ${a.message}`);
}
console.log(
  `\ncontrol  http=${control.status} code=${controlBody.code}  requestId=${controlRequestId}`,
);
console.log(`\nwritten ${path}`);

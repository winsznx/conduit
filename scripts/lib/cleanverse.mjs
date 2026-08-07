/**
 * One place scripts build a Cleanverse client.
 *
 * Every script that talks to the sandbox needs the same four things assembled
 * the same way, and the two that already existed each hand-rolled `fetch` with
 * their own header names and their own AES setup. That is how a base URL, a
 * header name, or a padding rule drifts between callers, and a Cleanverse call
 * that silently goes somewhere else is the failure CLAUDE.md forbids outright.
 *
 * The base URL is checked rather than trusted: the credential may only ever
 * reach the authenticated Cleanverse host.
 */
import { createCipher } from '../../packages/cleanverse/dist/encryption.js';
import { CleanverseClient } from '../../packages/cleanverse/dist/client.js';

const PERMITTED_HOST = 'uatapi.cleanverse.com';

export async function cleanverseClientFromEnv(env = process.env) {
  const baseUrl = env['CLEANVERSE_BASE_URL'];
  const apiId = env['CLEANVERSE_API_ID'];
  const apiKeyBase64 = env['CLEANVERSE_API_KEY_BASE64'];

  const missing = [
    ['CLEANVERSE_BASE_URL', baseUrl],
    ['CLEANVERSE_API_ID', apiId],
    ['CLEANVERSE_API_KEY_BASE64', apiKeyBase64],
  ]
    .filter(([, value]) => value === undefined || value === '')
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`missing environment: ${missing.join(', ')}`);
  }

  const host = new URL(baseUrl).host;
  if (host !== PERMITTED_HOST) {
    throw new Error(
      `refusing to send Cleanverse credentials to ${host}; only ${PERMITTED_HOST} is permitted`,
    );
  }

  return new CleanverseClient({
    baseUrl,
    apiId,
    cipher: await createCipher(apiKeyBase64),
    timeoutMs: Number(env['CLEANVERSE_REQUEST_TIMEOUT_MS'] ?? 15_000),
    maxReadRetries: Number(env['CLEANVERSE_MAX_READ_RETRIES'] ?? 2),
  });
}

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
    timeoutMs: positiveNumber(env['CLEANVERSE_REQUEST_TIMEOUT_MS'], 15_000),
    maxReadRetries: positiveNumber(env['CLEANVERSE_MAX_READ_RETRIES'], 2, { allowZero: true }),
  });
}

/**
 * `??` guards undefined and not the empty string, and `.env.example` ships every
 * name with an empty value.
 *
 * `Number('')` is 0, so an unset timeout became `AbortSignal.timeout(0)` and
 * every Cleanverse call aborted before it was sent. The error is `TimeoutError`,
 * which reads as the sandbox being slow or down — a diagnosis that sends you to
 * the wrong system entirely. It cost the first preflight run: eight identity and
 * registration checks failed identically and instantly, and nothing about the
 * message said the fault was local.
 */
function positiveNumber(raw, fallback, { allowZero = false } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (value === 0 && !allowZero)) {
    throw new Error(`invalid numeric environment value ${JSON.stringify(raw)}`);
  }
  return value;
}

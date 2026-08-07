/**
 * Redaction and response hashing. PRD 9.1, 9.2, 16.4.
 *
 * CLAUDE.md: "Store redacted response plus full-response hash."
 *
 * The order matters and is easy to get backwards. The hash is taken over the
 * raw bytes exactly as they arrived, *before* redaction, because that hash is
 * what a compliance attestation anchors and what an auditor recomputes. Hashing
 * the redacted form would anchor a document Cleanverse never sent.
 *
 * The redacted copy is what may be persisted or logged. Nothing else may.
 */

/**
 * Key names whose values never reach a log or the database.
 *
 * Wallet addresses are deliberately absent. PRD 16.4 classifies them as
 * pseudonymous identifiers that may be logged where operationally required, and
 * settlement is not debuggable without them.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
  [
    // credentials
    'api-key',
    'apiKey',
    'apikey',
    'api_key',
    'secret',
    'password',
    'privateKey',
    'private_key',
    'quoteToken',
    'quote_token',
    'signature',
    'owner_signature',
    // identity and payment detail from the ramp and travel-rule surfaces
    'firstName',
    'first_name',
    'lastName',
    'last_name',
    'fullName',
    'full_name',
    'email',
    'phone',
    'phoneNumber',
    'phone_number',
    'dateOfBirth',
    'date_of_birth',
    'nationalId',
    'national_id',
    'bankAccount',
    'bank_account',
    'accountNumber',
    'account_number',
    'iban',
    'swift',
    'routingNumber',
    'routing_number',
    'beneficiary',
    'street',
    'postalCode',
    'postal_code',
  ].map((key) => key.toLowerCase()),
);

export const REDACTED = '[redacted]' as const;

const MAX_DEPTH = 12;

/**
 * `data` carries two completely different things in this API, and treating them
 * alike breaks one or the other.
 *
 * In an encrypted request or response envelope, `data` is the base64 ciphertext,
 * which CLAUDE.md forbids logging. In a decrypted business envelope, `data` is
 * the payload — the A-Token list, the eligibility answer — which is the entire
 * point of keeping a redacted copy.
 *
 * The two are distinguishable by shape: ciphertext is always a string, a payload
 * is always an object or array. Redacting on that distinction keeps ciphertext
 * out of logs without blanking every response body.
 */
function isCiphertextField(key: string, value: unknown): boolean {
  return key.toLowerCase() === 'data' && typeof value === 'string';
}

/**
 * Deep copy with sensitive values replaced.
 *
 * Unknown keys are preserved rather than dropped: schema drift is something the
 * team needs to see, and a redactor that silently deletes unfamiliar fields
 * hides exactly the change worth noticing.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const sensitive = SENSITIVE_KEYS.has(key.toLowerCase()) || isCiphertextField(key, item);
    output[key] = sensitive ? REDACTED : redact(item, depth + 1);
  }
  return output;
}

/**
 * SHA-256 over the raw response bytes, lowercase `0x` hex per the CLAUDE.md
 * repository rules.
 *
 * Takes the body as the string it arrived as, not a parsed object. Re-serializing
 * a parsed object would reorder keys and change the hash, which would break every
 * attestation that anchored the original.
 */
export async function hashRawBody(rawBody: string): Promise<`0x${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `0x${hex}`;
}

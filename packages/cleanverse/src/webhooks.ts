/**
 * Cleanverse webhook verification. PRD 9.4, threats T-04 and T-05.
 *
 * Two rules, both of which are easy to violate by writing the obvious code.
 *
 * The HMAC is verified against the *raw bytes* before any JSON parsing. Parsing
 * first and re-serializing to check the signature would compare a signature over
 * what was sent against a re-encoding of it, and those differ on key order,
 * whitespace, and number formatting. An attacker who can make them differ
 * predictably can make a forged body verify.
 *
 * Delivery IDs are idempotency keys. A webhook that arrives twice is normal, and
 * processing it twice is a duplicate side effect.
 */

import { CleanverseError } from './errors.js';

export class WebhookVerificationError extends CleanverseError {
  public override readonly name = 'WebhookVerificationError';
}

export const DELIVERY_ID_HEADER = 'x-cleanverse-delivery-id';
export const SIGNATURE_HEADER = 'x-cleanverse-signature';

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (normalized.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(normalized)) {
    throw new WebhookVerificationError('signature is not valid hex');
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Length-independent, content-independent comparison.
 *
 * `crypto.subtle.verify` would be preferable, but the signature arrives as a hex
 * digest rather than a signature object, so the comparison is explicit. It runs
 * over a fixed number of iterations so an early mismatch does not return sooner
 * than a late one.
 */
function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;

  for (let i = 0; i < length; i += 1) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }

  return difference === 0;
}

export interface WebhookDelivery {
  readonly deliveryId: string;
  readonly rawBody: string;
  readonly payload: unknown;
}

/**
 * Verifies a delivery and returns its parsed payload.
 *
 * The raw body is taken as a string rather than a parsed object precisely so a
 * caller cannot parse first by accident.
 */
export async function verifyWebhook(
  rawBody: string,
  headers: Readonly<Record<string, string | undefined>>,
  hmacKey: string,
): Promise<WebhookDelivery> {
  const deliveryId = headers[DELIVERY_ID_HEADER];
  const signature = headers[SIGNATURE_HEADER];

  if (deliveryId === undefined || deliveryId.length === 0) {
    throw new WebhookVerificationError(`missing ${DELIVERY_ID_HEADER}`);
  }
  if (signature === undefined || signature.length === 0) {
    throw new WebhookVerificationError(`missing ${SIGNATURE_HEADER}`);
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(hmacKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)),
  );

  if (!constantTimeEquals(expected, hexToBytes(signature))) {
    throw new WebhookVerificationError('signature does not match the raw body');
  }

  // Only now, after verification, is the body allowed to be parsed.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new WebhookVerificationError('verified body is not valid JSON');
  }

  return { deliveryId, rawBody, payload };
}

/**
 * Idempotency guard keyed by delivery ID.
 *
 * The production implementation is a unique constraint on
 * `webhook_deliveries.delivery_id` in PRD 11.6. This in-memory form exists so
 * the handler logic is testable without a database, and so a Worker instance
 * short-circuits an obvious repeat before touching one.
 */
export class DeliveryLedger {
  private readonly seen = new Set<string>();
  private readonly capacity: number;

  public constructor(capacity = 10_000) {
    this.capacity = capacity;
  }

  /** Returns true when this delivery has not been seen before. */
  public claim(deliveryId: string): boolean {
    if (this.seen.has(deliveryId)) return false;

    if (this.seen.size >= this.capacity) {
      const oldest = this.seen.values().next();
      if (!oldest.done) this.seen.delete(oldest.value);
    }

    this.seen.add(deliveryId);
    return true;
  }
}

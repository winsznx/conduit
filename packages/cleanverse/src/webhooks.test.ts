import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DELIVERY_ID_HEADER,
  DeliveryLedger,
  SIGNATURE_HEADER,
  verifyWebhook,
  WebhookVerificationError,
} from './webhooks.js';

/**
 * PRD 15.2 requires webhook HMAC raw-body verification and webhook replay.
 * Threats T-04 and T-05.
 */

const KEY = 'webhook-hmac-key';
const BODY = '{"event":"atoken.apply","status":"approved","amount":"1000"}';

function sign(body: string, key = KEY): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

function headers(signature: string, deliveryId = 'delivery-1'): Record<string, string> {
  return { [DELIVERY_ID_HEADER]: deliveryId, [SIGNATURE_HEADER]: signature };
}

describe('HMAC verification against raw bytes', () => {
  it('accepts a correctly signed delivery and returns the parsed payload', async () => {
    const delivery = await verifyWebhook(BODY, headers(sign(BODY)), KEY);

    expect(delivery.deliveryId).toBe('delivery-1');
    expect(delivery.payload).toEqual({
      event: 'atoken.apply',
      status: 'approved',
      amount: '1000',
    });
  });

  it('rejects a body whose signature was computed with a different key', async () => {
    await expect(verifyWebhook(BODY, headers(sign(BODY, 'wrong-key')), KEY)).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it('rejects a tampered body', async () => {
    const signature = sign(BODY);
    const tampered = BODY.replace('"1000"', '"999999"');

    await expect(verifyWebhook(tampered, headers(signature), KEY)).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it('rejects a re-serialized body that is semantically identical', async () => {
    // This is why verification takes raw bytes. Cleanverse formats its payloads
    // with whitespace and `JSON.stringify` strips it, so the bytes differ while
    // the meaning does not — and only the bytes were signed. A client that
    // verified the re-encoding would reject genuine deliveries, or accept
    // forged ones once an attacker controls the difference.
    const onTheWire = '{"event": "atoken.apply", "status": "approved"}';
    const reserialized = JSON.stringify(JSON.parse(onTheWire));

    expect(reserialized).not.toBe(onTheWire);
    await expect(verifyWebhook(reserialized, headers(sign(onTheWire)), KEY)).rejects.toThrow(
      WebhookVerificationError,
    );
    await expect(verifyWebhook(onTheWire, headers(sign(onTheWire)), KEY)).resolves.toBeDefined();
  });

  it('rejects a delivery with no signature header', async () => {
    await expect(verifyWebhook(BODY, { [DELIVERY_ID_HEADER]: 'delivery-1' }, KEY)).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it('rejects a delivery with no delivery ID header', async () => {
    await expect(verifyWebhook(BODY, { [SIGNATURE_HEADER]: sign(BODY) }, KEY)).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it('rejects a signature that is not hex', async () => {
    await expect(verifyWebhook(BODY, headers('not-hex-at-all'), KEY)).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it('rejects a truncated signature rather than matching on a prefix', async () => {
    await expect(verifyWebhook(BODY, headers(sign(BODY).slice(0, 32)), KEY)).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it('does not parse a body that failed verification', async () => {
    // If parsing happened first, a malformed body would report a JSON error and
    // reveal that the signature was never the reason it was rejected.
    await expect(verifyWebhook('not json at all', headers(sign(BODY)), KEY)).rejects.toThrow(
      /signature does not match/,
    );
  });

  it('rejects a verified body that is not JSON', async () => {
    const body = 'plain text';
    await expect(verifyWebhook(body, headers(sign(body)), KEY)).rejects.toThrow(
      /verified body is not valid JSON/,
    );
  });
});

describe('delivery idempotency (PRD 9.4)', () => {
  it('claims a delivery once', () => {
    const ledger = new DeliveryLedger();

    expect(ledger.claim('delivery-1')).toBe(true);
    expect(ledger.claim('delivery-1')).toBe(false);
  });

  it('treats distinct deliveries independently', () => {
    const ledger = new DeliveryLedger();

    expect(ledger.claim('delivery-1')).toBe(true);
    expect(ledger.claim('delivery-2')).toBe(true);
  });

  it('bounds memory by evicting the oldest entry', () => {
    const ledger = new DeliveryLedger(2);

    ledger.claim('a');
    ledger.claim('b');
    ledger.claim('c');

    // 'a' was evicted, so it is claimable again. The durable guard is the unique
    // constraint on webhook_deliveries; this is only a fast path.
    expect(ledger.claim('a')).toBe(true);
    expect(ledger.claim('c')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { createApi, type ApiDependencies, type SettlementDetail } from './index.js';

/**
 * The API's job is to serve the projection without ever becoming an authority.
 *
 * These tests hold three lines. It refuses every mutating method, because a
 * write endpoint is the first step toward a service that decides something. It
 * keeps canonical Solidity state and verifier classifications in separate
 * fields, so a client cannot merge them into one "status" and lose ADR-0017's
 * distinction. And a verification run that hit an RPC scan gap is never served
 * as a verdict.
 */

const SETTLEMENT = `0x${'30'.repeat(32)}`;

const detail: SettlementDetail = {
  settlementId: SETTLEMENT,
  deploymentId: `0x${'dc'.repeat(32)}`,
  generation: 3,
  canonicalState: 'SETTLED',
  decision: 'COMMIT',
  verifierClass: 'SETTLED_FINAL',
  createdAt: '2026-08-08T00:00:00.000Z',
  chainReadAt: '2026-08-08T01:00:00.000Z',
  intent: { cashAmount: '25000000000' },
  legs: [{ leg: 'CASH', outcome: 'RELEASED' }],
  messages: [{ messageType: 'COMMIT', finality: 'FINALIZED' }],
  vaas: [{ vaaHash: `0x${'aa'.repeat(32)}` }],
  compliance: [{ subject: '0xabc', eligible: true }],
  dispositionCases: [],
  latestVerification: { classification: 'SETTLED_FINAL', hadScanGap: false },
};

function deps(overrides: Partial<ApiDependencies> = {}): ApiDependencies {
  return {
    version: 'test',
    deployments: { all: () => Promise.resolve([{ deploymentId: detail.deploymentId }]) },
    evidence: { manifest: () => Promise.resolve({ settlementId: SETTLEMENT, artifacts: [] }) },
    settlements: {
      list: () => Promise.resolve({ items: [detail], nextCursor: undefined }),
      detail: (id: string) => Promise.resolve(id === SETTLEMENT ? detail : undefined),
      dispositionCases: () => Promise.resolve([]),
      dispositionCase: () => Promise.resolve(undefined),
      latestVerification: () =>
        Promise.resolve({ classification: 'SETTLED_FINAL', hadScanGap: false }),
    },
    ...overrides,
  };
}

const call = async (path: string, init?: RequestInit, overrides?: Partial<ApiDependencies>) =>
  await createApi(deps(overrides)).handle(new Request(`https://api.test${path}`, init));

describe('the API never decides settlement truth', () => {
  it('registers no mutating route at all', () => {
    // Not "rejects a POST" — has no way to express one. The router has no
    // `post`, so a handler that changed something could not be registered
    // without editing the router itself, which shows up in a diff.
    const router = createApi(deps());
    expect(router.paths().length).toBeGreaterThan(0);
    expect('post' in router).toBe(false);
  });

  it('refuses every mutating method with a reason', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await call('/v1/settlements', { method });
      expect(response.status, method).toBe(405);
      const body = (await response.json()) as { error: { code: string; detail: string } };
      expect(body.error.code).toBe('method_not_allowed');
      expect(body.error.detail).toContain('read-only');
    }
  });

  it('says what it is in its own health check', async () => {
    const body = (await (await call('/health')).json()) as { role: string };
    expect(body.role).toContain('decides no settlement truth');
  });
});

describe('canonical state and verifier classification stay apart', () => {
  it('serves them as separate fields', async () => {
    const body = (await (await call(`/v1/settlements/${SETTLEMENT}`)).json()) as SettlementDetail;
    // ADR-0017: `SETTLED` is a Solidity enum, `SETTLED_FINAL` is a derived
    // claim. A single `status` field would make them indistinguishable to every
    // consumer downstream.
    expect(body.canonicalState).toBe('SETTLED');
    expect(body.verifierClass).toBe('SETTLED_FINAL');
    expect(body.canonicalState).not.toBe(body.verifierClass);
  });

  it('leaves the classification absent rather than guessing it', async () => {
    const unverified = { ...detail, verifierClass: undefined };
    const response = await call(`/v1/settlements/${SETTLEMENT}`, undefined, {
      settlements: {
        ...deps().settlements,
        detail: () => Promise.resolve(unverified),
      },
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['canonicalState']).toBe('SETTLED');
    expect(body['verifierClass']).toBeUndefined();
  });
});

describe('a scan gap is not a verdict', () => {
  it('refuses to serve an incomplete verification as a result', async () => {
    const response = await call(`/v1/settlements/${SETTLEMENT}/verification`, undefined, {
      settlements: {
        ...deps().settlements,
        latestVerification: () =>
          Promise.resolve({ classification: 'SETTLED_FINAL', hadScanGap: true }),
      },
    });

    // 409 rather than 200: a client that ignored a field would render this
    // green, and the whole reason the field exists is that the verifier could
    // not read part of the history.
    expect(response.status).toBe(409);
    const body = (await response.json()) as { incomplete: boolean; reason: string };
    expect(body.incomplete).toBe(true);
    expect(body.reason).toContain('scan gap');
  });

  it('serves a complete verification normally', async () => {
    const response = await call(`/v1/settlements/${SETTLEMENT}/verification`);
    expect(response.status).toBe(200);
  });
});

describe('input validation and honest absence', () => {
  it('rejects a malformed settlement ID before it reaches a query', async () => {
    const response = await call('/v1/settlements/not-a-hash');
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'bad_settlement_id',
    );
  });

  it('accepts either case and answers about one canonical form', async () => {
    const upper = `0x${'30'.repeat(32)}`.toUpperCase().replace('0X', '0x');
    const response = await call(`/v1/settlements/${upper}`);
    expect(response.status).toBe(200);
  });

  /**
   * A projection miss is not proof of absence. The same rule ADR-0019 states
   * for a chain refusal: the answer has to say which layer it came from.
   */
  it('says a miss is a projection miss, not a settlement that does not exist', async () => {
    const response = await call(`/v1/settlements/0x${'99'.repeat(32)}`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string; note: string } };
    expect(body.error.code).toBe('unknown_settlement');
    expect(body.error.note).toContain('may simply not have indexed it');
  });

  it('lists the routes it does have when asked for one it does not', async () => {
    const response = await call('/v1/nope');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { available: string[] } };
    expect(body.error.available).toContain('/v1/settlements/:settlementId');
  });

  it('caps a page size a caller asks to exceed', async () => {
    const response = await call('/v1/settlements?limit=100000');
    expect(response.status).toBe(200);
  });

  it('never serves a stale verification from a cache', async () => {
    const response = await call(`/v1/settlements/${SETTLEMENT}/verification`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

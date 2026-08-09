import { Router, json, parseSettlementId, problem } from './router.js';

import type { RouteContext } from './router.js';

/**
 * @conduit-protocol/app-api
 *
 * The read surface over the projection and the verifier. PRD 11.x.
 *
 * The one architectural rule, and it is worth stating at the top because every
 * route depends on it: **this API never decides settlement truth.** It serves
 * what the chains said, what Cleanverse said, and what the independent verifier
 * concluded from reading both. A caller who disagrees with a response can
 * re-derive every field from two RPC URLs and a settlement ID without asking
 * this service anything, and the verifier exists so they can.
 *
 * Two consequences show up in the shapes below. Canonical Solidity state and
 * verifier classifications are always separate fields, never merged into one
 * "status" — ADR-0017's distinction, carried through to the wire. And a
 * verification run that hit an RPC scan gap is reported as incomplete rather
 * than as a verdict, because a gap means the verifier could not look, which is
 * different from having looked and found nothing.
 */

export const PACKAGE_ID = '@conduit-protocol/app-api';

/** PRD 11.x / phase 06, matching this workspace's README. */
export const IMPLEMENTATION_PHASE = '06';

/** Everything a handler is allowed to reach. No signer, deliberately. */
export interface ApiDependencies {
  readonly settlements: SettlementReader;
  readonly deployments: DeploymentReader;
  readonly evidence: EvidenceReader;
  readonly version: string;
}

export interface SettlementSummary {
  readonly settlementId: string;
  readonly deploymentId: string;
  readonly generation: number;
  /** The coordinator's own enum. Read from chain, never advanced here. */
  readonly canonicalState: string;
  readonly decision: string;
  /** The verifier's classification. A different thing, and named as one. */
  readonly verifierClass: string | undefined;
  readonly createdAt: string;
  readonly chainReadAt: string | undefined;
}

export interface SettlementDetail extends SettlementSummary {
  readonly intent: Record<string, unknown>;
  readonly legs: readonly Record<string, unknown>[];
  readonly messages: readonly Record<string, unknown>[];
  readonly vaas: readonly Record<string, unknown>[];
  readonly compliance: readonly Record<string, unknown>[];
  readonly dispositionCases: readonly Record<string, unknown>[];
  readonly latestVerification: Record<string, unknown> | undefined;
}

export interface SettlementReader {
  list(options: {
    limit: number;
    cursor: string | undefined;
    state: string | undefined;
  }): Promise<{ items: readonly SettlementSummary[]; nextCursor: string | undefined }>;
  detail(settlementId: string): Promise<SettlementDetail | undefined>;
  dispositionCases(settlementId: string | undefined): Promise<readonly Record<string, unknown>[]>;
  dispositionCase(caseId: string): Promise<Record<string, unknown> | undefined>;
  latestVerification(settlementId: string): Promise<Record<string, unknown> | undefined>;
}

export interface DeploymentReader {
  all(): Promise<readonly Record<string, unknown>[]>;
}

export interface EvidenceReader {
  manifest(settlementId: string): Promise<Record<string, unknown> | undefined>;
}

const MAX_PAGE = 100;

export function createApi(deps: ApiDependencies): Router {
  const router = new Router();

  router.get('/health', () =>
    json({
      status: 'ok',
      version: deps.version,
      // Said in the response rather than only in a document, because the
      // clearest place to state what a service is not is the service.
      role: 'read-only projection and verifier surface; decides no settlement truth',
    }),
  );

  router.get('/v1/deployments', async () => json({ deployments: await deps.deployments.all() }));

  router.get('/v1/settlements', async (context: RouteContext) => {
    const limit = clamp(Number(context.url.searchParams.get('limit') ?? '25'), 1, MAX_PAGE);
    const page = await deps.settlements.list({
      limit,
      cursor: context.url.searchParams.get('cursor') ?? undefined,
      state: context.url.searchParams.get('state') ?? undefined,
    });
    return json({ settlements: page.items, nextCursor: page.nextCursor });
  });

  router.get('/v1/settlements/:settlementId', async (context: RouteContext) => {
    const settlementId = parseSettlementId(context.params['settlementId']);
    if (settlementId === undefined) {
      return problem(400, 'bad_settlement_id', 'a settlement ID is 32 bytes of 0x-prefixed hex');
    }
    const detail = await deps.settlements.detail(settlementId);
    if (detail === undefined) {
      return problem(404, 'unknown_settlement', `no settlement ${settlementId} in the projection`, {
        // A projection miss is not proof of absence, and saying so is the same
        // rule ADR-0019 states for negative claims about a chain.
        note:
          'The projection may simply not have indexed it. Verify against the chains directly ' +
          'with `conduit verify <id>` before concluding the settlement does not exist.',
      });
    }
    return json(detail);
  });

  router.get('/v1/settlements/:settlementId/verification', async (context: RouteContext) => {
    const settlementId = parseSettlementId(context.params['settlementId']);
    if (settlementId === undefined) {
      return problem(400, 'bad_settlement_id', 'a settlement ID is 32 bytes of 0x-prefixed hex');
    }
    const run = await deps.settlements.latestVerification(settlementId);
    if (run === undefined) {
      return problem(404, 'not_verified', `no verification run recorded for ${settlementId}`);
    }
    // A run that could not read part of the history is not a verdict. Served
    // with 409 so a client cannot render it as green by ignoring a field.
    if (run['hadScanGap'] === true) {
      return json(
        {
          ...run,
          incomplete: true,
          reason: 'an RPC scan gap means part of the history was never read',
        },
        409,
      );
    }
    return json(run);
  });

  router.get('/v1/settlements/:settlementId/evidence', async (context: RouteContext) => {
    const settlementId = parseSettlementId(context.params['settlementId']);
    if (settlementId === undefined) {
      return problem(400, 'bad_settlement_id', 'a settlement ID is 32 bytes of 0x-prefixed hex');
    }
    const manifest = await deps.evidence.manifest(settlementId);
    if (manifest === undefined) {
      return problem(404, 'no_evidence', `no evidence manifest for ${settlementId}`);
    }
    return json(manifest);
  });

  router.get('/v1/dispositions', async (context: RouteContext) => {
    const settlementId = parseSettlementId(
      context.url.searchParams.get('settlementId') ?? undefined,
    );
    return json({ cases: await deps.settlements.dispositionCases(settlementId) });
  });

  router.get('/v1/dispositions/:caseId', async (context: RouteContext) => {
    const caseId = parseSettlementId(context.params['caseId']);
    if (caseId === undefined) {
      return problem(400, 'bad_case_id', 'a case ID is 32 bytes of 0x-prefixed hex');
    }
    const found = await deps.settlements.dispositionCase(caseId);
    if (found === undefined) return problem(404, 'unknown_case', `no disposition case ${caseId}`);
    return json(found);
  });

  return router;
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(Math.max(Math.trunc(value), low), high);
}

export { Router, json, parseSettlementId, problem } from './router.js';
export type { RouteContext, RouteHandler } from './router.js';

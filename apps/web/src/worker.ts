/**
 * The deployed surface: the landing page, the settlement console, the public
 * proof pages, and the read API.
 *
 * One Worker serves all of them because they answer the same questions from the
 * same data, and splitting them would double the configuration for no isolation
 * benefit — none of them can write anything.
 *
 * ## Nothing here decides anything
 *
 * There is no signer in this Worker and no private key. That has not changed
 * now that participants can act: signing happens in the user's own wallet, in
 * their browser, and this Worker sees a signature and a settlement id — both of
 * which anyone can re-derive. A service that could sign on a user's behalf
 * would be custody rather than settlement.
 *
 * One route accepts a write, `POST /api/intents`, and it writes to the
 * projection only. Storing a signed intent lets a counterparty open the same
 * settlement from their own browser. It authorises nothing: the coordinator
 * verifies both signatures against the digest itself, and a database that
 * disagreed with the chain would simply be wrong.
 *
 * The projection this reads is convenient and is never evidence. A settlement's
 * authority is the coordinator on chain, and a reader who wants proof runs the
 * verifier against the chains rather than trusting this page.
 *
 * ## Presentation
 *
 * `design.md` is the authoritative visual specification. It is implemented in
 * `theme.ts` as tokens, `ui.ts` as primitives and `components.ts` as the
 * protocol's own vocabulary; routes here compose pages and never style.
 */

import CLIENT_BUNDLE from './client.bundle.js.txt';
import { CLIENT_PATH } from './client-manifest.js';
import { checkTargets, deploymentConfig, targetForChain } from './deployment.js';
import { checkEligibility, isAddress } from './eligibility.js';
import { signRequest, storeSignedIntent } from './intents.js';
import type { Env } from './data.js';
import {
  deployments,
  dispositionCases,
  evidenceFor,
  latestVerification,
  recentSettlements,
  settlementView,
  totals,
} from './data.js';
import {
  renderComposer,
  renderDeployments,
  renderDispositions,
  renderError,
  renderEvidence,
  renderEvidenceHome,
  renderLanding,
  renderNotFound,
  renderOverview,
  renderSettlement,
  renderSettlements,
  renderSignRequest,
  renderSystem,
  renderVerification,
  renderVerifierHome,
} from './pages.js';

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/**
 * Headers a proof page has to send.
 *
 * A page whose whole purpose is to be trusted should not be embeddable in
 * somebody else's frame, and should not load code it did not ship.
 *
 * ## Why `script-src 'self'` now exists
 *
 * This app shipped no JavaScript at all, which was the strongest possible
 * version of this policy and also the reason it could only ever be read. A
 * participant has to sign an EIP-712 intent and send transactions from their
 * own wallet, and there is no server-side substitute for that — a service that
 * could sign for them would be custody, not settlement.
 *
 * So exactly one directive changed. `'self'` admits the bundle this Worker
 * serves and nothing else: no CDN, no inline script, no `eval`, no
 * `unsafe-inline`. Wallet extensions inject into the page's own context and are
 * unaffected by it. `connect-src` allows the two chain RPCs the browser reads
 * from directly, and this origin for Conduit's own endpoints.
 *
 * `font-src` is still absent, so the design system's font token falls through
 * to the platform sans rather than fetching Geist.
 */
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self' https://testnet-rpc.monad.xyz https://sepolia.base.org; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
};

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { ...HTML, ...SECURITY_HEADERS } });
}

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { ...JSON_HEADERS, ...SECURITY_HEADERS },
  });
}

/**
 * The browser bundle.
 *
 * Served from this origin so `script-src 'self'` covers it, and cached
 * immutably because the path carries the build's content hash.
 */
function script(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
      ...SECURITY_HEADERS,
    },
  });
}

function redirect(location: string): Response {
  return new Response(null, { status: 308, headers: { location, ...SECURITY_HEADERS } });
}

const SETTLEMENT_ID = /^0x[0-9a-fA-F]{64}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'POST' && path === '/api/intents') {
      try {
        return await storeIntent(request, env);
      } catch (error) {
        console.error('storeIntent failed', error);
        return json(
          { error: { code: 'store_failed', message: 'the signed intent could not be stored' } },
          500,
        );
      }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(
        {
          error: {
            code: 'method_not_allowed',
            message: `${request.method} is not accepted`,
            detail:
              'Conduit’s surfaces are read-only. Protocol state changes are transactions sent ' +
              'to a chain, never requests sent here.',
          },
        },
        405,
      );
    }

    try {
      return await route(path, url, env);
    } catch (error) {
      // The message is deliberately not echoed. A stack trace from a Worker
      // holding a database credential is a place credentials surface.
      console.error('handler failed', error);
      if (url.pathname.startsWith('/api/')) {
        return json(
          { error: { code: 'handler_failed', message: 'the request could not be served' } },
          500,
        );
      }
      return html(
        renderError(
          'The projection could not be read. This says nothing about the settlement itself — ' +
            'chain state is unaffected by whether this page can reach its database.',
        ),
        500,
      );
    }
  },
};

/**
 * The one write this Worker accepts.
 *
 * It records a signature so a counterparty can find the settlement. Every field
 * is revalidated: the id is recomputed from the terms rather than trusted, the
 * signature is recovered, and only the payer or seller the terms name may sign.
 */
async function storeIntent(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: { code: 'invalid_request', message: 'body is not JSON' } }, 400);
  }
  const result = await storeSignedIntent(env, body);
  return json(result.body, result.status);
}

/** The generation label shown in the shell, short enough to read at a glance. */
function generationLabel(env: Env): string {
  return `${env.DEPLOYMENT_ID.slice(0, 10)}…`;
}

async function route(path: string, url: URL, env: Env): Promise<Response> {
  // ── Static ────────────────────────────────────────────────────────────────

  if (path === CLIENT_PATH) return script(CLIENT_BUNDLE);

  // ── API ───────────────────────────────────────────────────────────────────

  if (path === '/health' || path === '/api/health') {
    return json({
      status: 'ok',
      commit: env.COMMIT_SHA,
      deployment: env.DEPLOYMENT_ID,
    });
  }

  /**
   * Eligibility, asked of Cleanverse on the caller's behalf.
   *
   * `GET` with the subject in the query string, because it is a read with no
   * side effect and a shareable URL is useful when debugging a refusal. The
   * inputs are public — an address and a chain — and the response carries no
   * identity data, only a verdict and the endpoint's own answer.
   *
   * A failure to reach Cleanverse is reported as `UNAVAILABLE` with HTTP 200,
   * deliberately. The request succeeded; it is the *answer* that is missing,
   * and a 503 here would make an outage indistinguishable from a refusal to
   * every caller that only checks the status line.
   */
  if (path === '/api/eligibility') {
    const config = deploymentConfig(env);
    if (config === undefined) {
      return json(
        { error: { code: 'not_configured', message: 'no deployment addresses are configured' } },
        503,
      );
    }
    const subject = url.searchParams.get('subject') ?? '';
    const chainParam = url.searchParams.get('chainId');

    if (!isAddress(subject)) {
      return json(
        {
          error: {
            code: 'invalid_request',
            message: 'subject must be a 20-byte hex address',
          },
        },
        400,
      );
    }

    const targets =
      chainParam === null
        ? checkTargets(config)
        : [targetForChain(config, Number(chainParam))].filter((target) => target !== undefined);

    if (targets.length === 0) {
      return json(
        { error: { code: 'invalid_request', message: `no such chain: ${String(chainParam)}` } },
        400,
      );
    }

    const results = await Promise.all(
      targets.map((target) => checkEligibility(env, target, subject)),
    );
    return json({ subject, results });
  }

  // ── Landing ───────────────────────────────────────────────────────────────

  if (path === '/') {
    const [counts, recent] = await Promise.all([totals(env), recentSettlements(env, 1)]);
    // The landing diagram shows a real trade, so it needs the full view. The
    // list query deliberately skips terms, and passing that shallow row
    // straight through rendered a settlement with no chain and no amounts.
    const head = recent[0];
    const featured = head === undefined ? undefined : await settlementView(env, head.settlementId);
    return html(renderLanding(counts, featured === undefined ? [] : [featured]));
  }

  // ── Console ───────────────────────────────────────────────────────────────

  if (path === '/app') {
    const [counts, recent] = await Promise.all([totals(env), recentSettlements(env, 8)]);
    return html(renderOverview(generationLabel(env), counts, recent));
  }

  if (path === '/app/settlements') {
    return html(renderSettlements(generationLabel(env), await recentSettlements(env)));
  }

  if (path === '/app/settlements/new') {
    return html(renderComposer(generationLabel(env), deploymentConfig(env)));
  }

  const settlementMatch = /^\/app\/settlements\/(0x[0-9a-fA-F]{64})$/.exec(path);
  const settlementId = settlementMatch?.[1];
  if (settlementId !== undefined) {
    const view = await settlementView(env, settlementId.toLowerCase());
    if (view === undefined) {
      return html(
        renderNotFound(
          'This settlement is not in the projection',
          'That is not proof it does not exist — the indexer may simply not have reached it. Run the verifier against the chains before concluding anything.',
        ),
        404,
      );
    }
    return html(renderSettlement(generationLabel(env), view));
  }

  const signMatch = /^\/app\/settlements\/(0x[0-9a-fA-F]{64})\/sign$/.exec(path);
  const signId = signMatch?.[1];
  if (signId !== undefined) {
    const config = deploymentConfig(env);
    const request = config === undefined ? undefined : await signRequest(env, signId.toLowerCase());
    if (config === undefined || request === undefined) {
      return html(
        renderNotFound(
          'No such settlement request',
          'Nothing with this identifier has been signed and shared. A signing link is created when the first party signs; check the link you were sent.',
        ),
        404,
      );
    }
    return html(
      renderSignRequest(generationLabel(env), signId.toLowerCase(), {
        ...request,
        deployment: config,
      }),
    );
  }

  if (path === '/app/dispositions') {
    return html(renderDispositions(generationLabel(env), await dispositionCases(env)));
  }

  const dispositionMatch = /^\/app\/dispositions\/(0x[0-9a-fA-F]{64})$/.exec(path);
  if (dispositionMatch) {
    const cases = await dispositionCases(env);
    const found = cases.find(
      (row) => row.caseId.toLowerCase() === dispositionMatch[1]?.toLowerCase(),
    );
    if (found === undefined) {
      return html(
        renderNotFound(
          'No such disposition case',
          'No case with this identifier is in the projection. Cases are opened only when committed value cannot be delivered and an order is filed.',
        ),
        404,
      );
    }
    return redirect(`/app/settlements/${found.settlementId}`);
  }

  if (path === '/app/verifier') {
    return html(renderVerifierHome(generationLabel(env)));
  }

  if (path === '/app/evidence') {
    return html(renderEvidenceHome(generationLabel(env)));
  }

  if (path === '/app/deployments') {
    return html(renderDeployments(generationLabel(env), await deployments(env)));
  }

  if (path === '/app/system') {
    return html(
      renderSystem(generationLabel(env), {
        deploymentId: env.DEPLOYMENT_ID,
        commit: env.COMMIT_SHA,
      }),
    );
  }

  // ── Public proof pages ────────────────────────────────────────────────────
  //
  // `/verify?id=…` is what the form posts to; `/verify/:id` is the shareable
  // link. Both are public and neither requires the console.

  const verifyQuery = path === '/verify' ? url.searchParams.get('id') : undefined;
  const verifyMatch = /^\/verify\/(0x[0-9a-fA-F]{64})$/.exec(path);
  const toVerify = verifyMatch?.[1] ?? verifyQuery ?? undefined;

  if (path === '/verify' || verifyMatch) {
    if (toVerify === undefined || !SETTLEMENT_ID.test(toVerify)) {
      return html(renderVerifierHome(generationLabel(env)), toVerify === undefined ? 200 : 400);
    }
    const settlementId = toVerify.toLowerCase();
    const result = await latestVerification(env, settlementId);
    if (result === undefined) {
      return html(
        renderNotFound(
          'No verification run for this settlement',
          'Nothing has verified this identifier yet. A missing run is not a negative result — run the verifier against the chains to produce one.',
        ),
        404,
      );
    }
    return html(renderVerification(generationLabel(env), settlementId, result));
  }

  const evidenceMatch = /^\/evidence\/(0x[0-9a-fA-F]{64})$/.exec(path);
  const evidenceId = evidenceMatch?.[1];
  if (evidenceId !== undefined) {
    const id = evidenceId.toLowerCase();
    return html(renderEvidence(generationLabel(env), id, await evidenceFor(env, id)));
  }

  // ── Legacy paths ──────────────────────────────────────────────────────────
  //
  // The console moved under /app. These were public links, so they redirect
  // rather than 404.

  if (path === '/settlements') return redirect('/app/settlements');
  const legacySettlement = /^\/settlements\/(0x[0-9a-fA-F]{64})$/.exec(path);
  if (legacySettlement) return redirect(`/app/settlements/${legacySettlement[1] ?? ''}`);
  if (path === '/dispositions') return redirect('/app/dispositions');

  if (path.startsWith('/api/')) {
    return json({ error: { code: 'not_found', message: `no route for ${path}` } }, 404);
  }

  return html(renderNotFound('No such page', `Nothing is served at ${path}.`), 404);
}

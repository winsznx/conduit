import {
  renderHome,
  renderNotFound,
  renderSettlement,
  renderVerification,
  type SettlementView,
} from './render.js';

/**
 * The deployed surface: the console, the public proof pages, and the read API.
 *
 * One Worker serves both because they answer the same questions from the same
 * data and splitting them would double the configuration for no isolation
 * benefit — neither can write anything.
 *
 * ## Nothing here decides anything
 *
 * Every route is a read. There is no signer in this Worker, no private key in
 * its bindings, and no endpoint that accepts a mutation. A settlement's state
 * comes from the coordinator; a verification comes from reading two chains and
 * the guardian set. If this Worker were compromised it could lie to a browser,
 * which is why `/verify` exists and why the CLI does the same job without
 * asking this service anything.
 *
 * ## Secrets
 *
 * `DATABASE_URL` is a Worker *secret*, never a `var` — a `var` is plaintext in
 * `wrangler.toml` and in the dashboard, and this one is the whole database. It
 * is read at request time and never returned in any response, including error
 * responses, which is why failures here report a code rather than an exception
 * message.
 */

export interface Env {
  /** Secret. The Supabase transaction pooler, which needs `prepare: false`. */
  readonly DATABASE_URL: string;
  readonly MONAD_RPC_URL: string;
  readonly BASE_RPC_URL: string;
  readonly DEPLOYMENT_ID: string;
  readonly COMMIT_SHA: string;
}

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/**
 * Headers a proof page has to send.
 *
 * A page whose whole purpose is to be trusted should not be embeddable in
 * somebody else's frame, and should not be able to load a script from anywhere.
 * The CSP is deliberately absolute: no external origin, no inline script, no
 * eval. The pages are server-rendered and need none of it.
 */
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
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

const SETTLEMENT_ID = /^0x[0-9a-fA-F]{64}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

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
      return json(
        { error: { code: 'handler_failed', message: 'the request could not be served' } },
        500,
      );
    }
  },
};

async function route(path: string, url: URL, env: Env): Promise<Response> {
  if (path === '/health' || path === '/api/health') {
    return json({
      status: 'ok',
      commit: env.COMMIT_SHA,
      deployment: env.DEPLOYMENT_ID,
      role: 'read-only console, proof pages and API; decides no settlement truth',
    });
  }

  if (path === '/') {
    return html(renderHome(await recentSettlements(env)));
  }

  if (path === '/settlements') {
    return html(renderHome(await recentSettlements(env)));
  }

  const settlementMatch = /^\/settlements\/(0x[0-9a-fA-F]{64})$/.exec(path);
  if (settlementMatch) {
    const view = await settlementView(env, (settlementMatch[1] as string).toLowerCase());
    if (view === undefined) {
      return html(
        renderNotFound(
          'This settlement is not in the projection.',
          'That is not proof it does not exist — the indexer may simply not have reached it. ' +
            'Run `conduit verify <id>` against the chains before concluding anything.',
        ),
        404,
      );
    }
    return html(renderSettlement(view));
  }

  // `/verify?id=…` is what the form posts to; `/verify/:id` is the shareable link.
  const verifyQuery = path === '/verify' ? url.searchParams.get('id') : undefined;
  const verifyMatch = /^\/verify\/(0x[0-9a-fA-F]{64})$/.exec(path);
  const toVerify = verifyMatch?.[1] ?? verifyQuery ?? undefined;

  if (path === '/verify' || verifyMatch) {
    if (toVerify === undefined || !SETTLEMENT_ID.test(toVerify)) {
      return html(
        renderNotFound(
          'A settlement ID is 32 bytes of 0x-prefixed hex.',
          'The most common cause is a truncated copy — check you have all 64 digits.',
        ),
        400,
      );
    }
    const run = await latestVerification(env, toVerify.toLowerCase());
    if (run === undefined) {
      return html(
        renderNotFound(
          'No verification run is recorded for this settlement.',
          'The verifier reads two chains and the guardian set; run `conduit verify` to produce one.',
        ),
        404,
      );
    }
    return html(renderVerification(toVerify.toLowerCase(), run), run.hadScanGap ? 409 : 200);
  }

  if (path === '/dispositions') {
    return html(renderHome(await recentSettlements(env)));
  }

  const evidenceMatch = /^\/evidence\/(0x[0-9a-fA-F]{64})$/.exec(path);
  if (evidenceMatch) {
    const manifest = await evidenceManifest(env, (evidenceMatch[1] as string).toLowerCase());
    if (manifest === undefined) {
      return json(
        { error: { code: 'no_evidence', message: 'no manifest for this settlement' } },
        404,
      );
    }
    return json(manifest);
  }

  if (path.startsWith('/api/')) {
    return json({ error: { code: 'not_found', message: `no route for ${path}` } }, 404);
  }

  return html(renderNotFound('No such page.', `Nothing is served at ${path}.`), 404);
}

/**
 * Reads are stubbed against the projection until the indexer runs in production.
 *
 * Returning an empty list rather than fabricating rows: a console that showed
 * plausible settlements nobody had indexed would be the most misleading thing
 * in the repository. The shape is real, the source is real, and the absence is
 * honest.
 */
async function recentSettlements(env: Env): Promise<readonly SettlementView[]> {
  void env;
  return [];
}

async function settlementView(env: Env, settlementId: string): Promise<SettlementView | undefined> {
  void env;
  void settlementId;
  return undefined;
}

async function latestVerification(
  env: Env,
  settlementId: string,
): Promise<
  | {
      classification: string;
      findings: readonly { check: string; ok: boolean; detail: string }[];
      hadScanGap: boolean;
      searchedRanges: Readonly<Record<string, { from: string; to: string }>>;
      trustRoot: string;
    }
  | undefined
> {
  void env;
  void settlementId;
  return undefined;
}

async function evidenceManifest(
  env: Env,
  settlementId: string,
): Promise<Record<string, unknown> | undefined> {
  void env;
  void settlementId;
  return undefined;
}

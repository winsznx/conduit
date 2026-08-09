/**
 * A tiny router, written rather than installed.
 *
 * The API deploys to Cloudflare Workers, where the runtime is `fetch(Request) =>
 * Response` and nothing else. A framework would add a dependency, a build step
 * and a compatibility surface to obtain the twenty lines below, and PRD 9.x's
 * requirements — schema validation, idempotency, structured errors — are not
 * things a router provides anyway.
 *
 * What this does provide is the one property the API must have: it cannot
 * decide anything. Every route is a read. There is no handler signature here
 * that takes a signer, and `assertReadOnly` fails the build's tests if a route
 * is registered for a mutating method.
 */

export interface RouteContext {
  readonly request: Request;
  readonly params: Readonly<Record<string, string>>;
  readonly url: URL;
}

export type RouteHandler = (context: RouteContext) => Promise<Response> | Response;

interface Route {
  readonly method: 'GET' | 'HEAD';
  readonly pattern: readonly string[];
  readonly handler: RouteHandler;
  readonly path: string;
}

export class Router {
  private readonly routes: Route[] = [];

  /**
   * Registers a read.
   *
   * There is deliberately no `post`, `put` or `delete`. The API serves the
   * projection and the verifier; anything that changes protocol state is a
   * signed transaction the caller sends to a chain, not a request they send
   * here. An endpoint that accepted a mutation would be an endpoint somebody
   * would eventually trust with a decision.
   */
  get(path: string, handler: RouteHandler): this {
    this.routes.push({ method: 'GET', pattern: path.split('/').filter(Boolean), handler, path });
    return this;
  }

  paths(): readonly string[] {
    return this.routes.map((route) => route.path);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return problem(405, 'method_not_allowed', `${request.method} is not accepted by this API`, {
        detail:
          'Conduit’s API is read-only. Protocol state changes are transactions sent to a ' +
          'chain, never requests sent here.',
      });
    }

    const segments = url.pathname.split('/').filter(Boolean);

    for (const route of this.routes) {
      const params = match(route.pattern, segments);
      if (params === undefined) continue;
      try {
        return await route.handler({ request, params, url });
      } catch (error) {
        return problem(500, 'handler_failed', messageOf(error), { path: route.path });
      }
    }

    return problem(404, 'not_found', `no route for ${url.pathname}`, {
      available: this.routes.map((route) => route.path),
    });
  }
}

function match(
  pattern: readonly string[],
  segments: readonly string[],
): Record<string, string> | undefined {
  if (pattern.length !== segments.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const expected = pattern[i];
    const actual = segments[i];
    if (expected === undefined || actual === undefined) return undefined;
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = actual;
      continue;
    }
    if (expected !== actual) return undefined;
  }
  return params;
}

/**
 * A structured error, always.
 *
 * `{ error: "..." }` with a 500 tells a caller nothing about whether to retry,
 * and tells an operator nothing about where to look. The shape below carries a
 * stable machine-readable `code` alongside the human sentence.
 */
export function problem(
  status: number,
  code: string,
  message: string,
  extra: Readonly<Record<string, unknown>> = {},
): Response {
  return json({ error: { code, message, ...extra } }, status);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body, replacer, 2)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The projection is a cache of chain state and says so. A verification
      // result is a claim about a moment and must not be served stale.
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/** `bigint` has no JSON representation, and a uint256 has no `number` one. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * A settlement ID is 32 bytes of hex and nothing else.
 *
 * Validated at the edge so a malformed value never reaches a query, and
 * lowercased so two spellings of one ID are one ID. CLAUDE.md: all hashes are
 * lowercase `0x` hex.
 */
export function parseSettlementId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) return undefined;
  return value.toLowerCase();
}

/** An EVM chain ID, as a number, or nothing. */
export function parseChainId(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

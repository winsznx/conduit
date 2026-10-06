import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { BRAND_ROOT_FILES } from './brand-manifest.js';
import { consoleOverview, type Env } from './data.js';
import { IMAGES } from './image-manifest.js';
import { renderLanding } from './pages.js';
import worker from './worker.js';

/**
 * Only the overview read is replaced, and it falls back to the real one, so the tests that rely on
 * an unreachable database still reach it. A test that wants rows asks for them with `mockResolvedValue`.
 */
vi.mock('./data.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./data.js')>();
  return { ...actual, consoleOverview: vi.fn(actual.consoleOverview) };
});

const ROOT = join(import.meta.dirname, '..', '..', '..');
const kit = (file: string): Buffer => readFileSync(join(ROOT, 'brand', file));

/**
 * Most routes under test here touch neither the database nor a chain, so the connection string
 * is a placeholder that fails loudly if one does. The last tests rely on exactly that: its host
 * can never resolve, which is an unreachable database.
 */
const BARE: Env = {
  DATABASE_URL: 'postgresql://unused.invalid/none',
  MONAD_RPC_URL: 'https://unused.invalid',
  BASE_RPC_URL: 'https://unused.invalid',
  DEPLOYMENT_ID: '0x0',
  COMMIT_SHA: 'test',
};

const ENV: Env = { ...BARE, SITE_URL: 'https://tryconduit.xyz' };

const get = (path: string, init?: RequestInit, env: Env = ENV): Promise<Response> =>
  worker.fetch(new Request(`https://tryconduit.xyz${path}`, init), env);

const bytesOf = async (response: Response): Promise<Buffer> =>
  Buffer.from(await response.arrayBuffer());

/** Public path, the kit file it must equal, and its content type. */
const ROOT_FILES: readonly [string, string, string][] = [
  ['/favicon.ico', 'favicon/favicon.ico', 'image/x-icon'],
  ['/favicon.svg', 'favicon/favicon.svg', 'image/svg+xml'],
  ['/apple-touch-icon.png', 'favicon/apple-touch-icon.png', 'image/png'],
  ['/icon-192.png', 'favicon/icon-192.png', 'image/png'],
  ['/icon-512.png', 'favicon/icon-512.png', 'image/png'],
  ['/icon-maskable-512.png', 'favicon/icon-maskable-512.png', 'image/png'],
  ['/site.webmanifest', 'favicon/site.webmanifest', 'application/manifest+json'],
];

describe('the files browsers ask for by name', () => {
  it.each(ROOT_FILES)('serves %s with its content type', async (path, _file, type) => {
    // #given a request for a fixed-name brand file
    // #when the Worker answers
    const response = await get(path);

    // #then it is a 200 of the right type
    expect([response.status, response.headers.get('content-type')]).toEqual([200, type]);
  });

  it.each(ROOT_FILES)('serves %s as the kit file, byte for byte', async (path, file) => {
    // #given a request for a fixed-name brand file
    // #when the Worker answers
    const served = await bytesOf(await get(path));

    // #then there is one copy of it
    expect(served.equals(kit(file))).toBe(true);
  });

  it('serves exactly the set the manifest and the page head refer to', async () => {
    // #given the root paths a page head links and the icons the web manifest lists
    const html = await (await get('/app/verifier')).text();
    const linked = [
      ...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="(\/[^"#?]*)"/g),
    ].map((match) => match[1] ?? '');
    const { icons } = JSON.parse(
      (await bytesOf(await get('/site.webmanifest'))).toString('utf8'),
    ) as {
      icons: { src: string }[];
    };
    const referred = [...new Set([...linked, ...icons.map((icon) => icon.src)])].sort();

    // #when the table of root files is read
    const served = Object.keys(BRAND_ROOT_FILES).sort();

    // #then nothing is served that nothing refers to, and nothing referred to is missing
    expect(served).toEqual(referred);
  });

  it('lets a stale icon live for a day, because the name does not change with the bytes', async () => {
    // #given a fixed-name file
    // #when the Worker answers
    const response = await get('/favicon.ico');

    // #then it is cacheable for a day and not immutable
    expect(response.headers.get('cache-control')).toBe('public, max-age=86400');
  });

  it('ignores a trailing slash, as every other route does', async () => {
    // #given a request with a trailing slash
    // #when the Worker answers
    const response = await get('/favicon.ico/');

    // #then it is served
    expect(response.status).toBe(200);
  });

  it('ignores a run of trailing slashes', async () => {
    // #given a request with several trailing slashes
    // #when the Worker answers
    const response = await get('/favicon.ico//////');

    // #then it is served as the same file
    expect(response.status).toBe(200);
  });

  it('answers HEAD', async () => {
    // #given a HEAD request
    // #when the Worker answers
    const response = await get('/favicon.ico', { method: 'HEAD' });

    // #then it is a 200 of the right type
    expect([response.status, response.headers.get('content-type')]).toEqual([200, 'image/x-icon']);
  });

  it('refuses a well-formed write', async () => {
    // #given a POST with a JSON body
    const init = { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } };

    // #when the Worker answers
    const response = await get('/favicon.ico', init);

    // #then it is a method the surface does not accept
    expect(response.status).toBe(405);
  });

  it.each(['/FAVICON.ICO', '/favicon.png'])('does not serve %s', async (path) => {
    // #given a name the Worker was not given
    // #when the Worker answers
    const response = await get(path);

    // #then it is not found
    expect(response.status).toBe(404);
  });
});

describe('the web manifest', () => {
  interface Manifest {
    name: string;
    theme_color: string;
    background_color: string;
    icons: { src: string; sizes: string; type: string; purpose?: string }[];
  }

  const manifest = async (): Promise<Manifest> =>
    JSON.parse((await bytesOf(await get('/site.webmanifest'))).toString('utf8')) as Manifest;

  it('names the product', async () => {
    // #given the served manifest
    // #when it is parsed
    const parsed = await manifest();

    // #then it names Conduit
    expect(parsed.name).toBe('Conduit');
  });

  it('matches the page colour', async () => {
    // #given the served manifest
    // #when it is parsed
    const parsed = await manifest();

    // #then theme and background are the white of the page
    expect([parsed.theme_color, parsed.background_color]).toEqual(['#ffffff', '#ffffff']);
  });

  it('lists an any-purpose icon and a maskable one', async () => {
    // #given the served manifest
    // #when its icons are read
    const purposes = (await manifest()).icons.map((icon) => icon.purpose ?? 'any');

    // #then both kinds are present
    expect(purposes).toEqual(expect.arrayContaining(['any', 'maskable']));
  });

  it('lists only icons that the Worker serves', async () => {
    // #given the served manifest
    const { icons } = await manifest();

    // #when each icon is requested
    const statuses = await Promise.all(icons.map(async (icon) => (await get(icon.src)).status));

    // #then none is missing
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it('states each icon at the size it really has', async () => {
    // #given the served manifest
    const { icons } = await manifest();

    // #when each icon's PNG header is read
    const sizes = await Promise.all(
      icons.map(async (icon) => {
        const png = await bytesOf(await get(icon.src));
        return `${String(png.readUInt32BE(16))}x${String(png.readUInt32BE(20))}`;
      }),
    );

    // #then the header matches the claim
    expect(sizes).toEqual(icons.map((icon) => icon.sizes));
  });
});

describe('the link-preview card', () => {
  const card = IMAGES['brand-og.png'];

  it('is served at its hashed path as an immutable PNG', async () => {
    // #given the card's hashed path
    // #when the Worker answers
    const response = await get(card?.path ?? '/missing');

    // #then it is a PNG cached for good, because the path carries the hash
    expect([
      response.status,
      response.headers.get('content-type'),
      response.headers.get('cache-control'),
    ]).toEqual([200, 'image/png', 'public, max-age=31536000, immutable']);
  });

  it('is the kit card, byte for byte', async () => {
    // #given the card's hashed path
    // #when the Worker answers
    const served = await bytesOf(await get(card?.path ?? '/missing'));

    // #then there is one copy of it
    expect(served.equals(kit('social/conduit-og-1200x630.png'))).toBe(true);
  });

  it.each(['/assets/conduit-og.000000000000.png', '/assets/conduit-nothing.png'])(
    'does not serve %s, which was never built',
    async (path) => {
      // #given a brand path with no matching file
      // #when the Worker answers
      const response = await get(path);

      // #then it is not found
      expect(response.status).toBe(404);
    },
  );
});

/** Every directive, in the order the Worker sends them. Widening any one of them edits this line. */
const POLICY =
  "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; " +
  "manifest-src 'self'; " +
  "connect-src 'self' https://testnet-rpc.monad.xyz https://sepolia.base.org; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

describe('the Content-Security-Policy', () => {
  const policyOf = async (): Promise<Map<string, string>> => {
    const header = (await get('/favicon.ico')).headers.get('content-security-policy') ?? '';
    return new Map(
      header.split(';').map((directive) => {
        const [name = '', ...sources] = directive.trim().split(/\s+/);
        return [name, sources.join(' ')] as const;
      }),
    );
  };

  it('is exactly the policy the design states, so a change is a deliberate edit here', async () => {
    // #given the policy the Worker sends
    // #when the whole header is read
    const header = (await get('/favicon.ico')).headers.get('content-security-policy');

    // #then it equals the literal, which names connect-src and form-action as well
    expect(header).toBe(POLICY);
  });

  it('lets the manifest load from this origin and nowhere else', async () => {
    // #given the policy the Worker sends
    // #when its manifest-src is read
    const policy = await policyOf();

    // #then only this origin is allowed
    expect(policy.get('manifest-src')).toBe("'self'");
  });

  it('keeps everything else as strict as it was', async () => {
    // #given the policy the Worker sends
    // #when the other directives are read
    const policy = await policyOf();

    // #then no origin was added for scripts, styles, images or frames
    expect([
      policy.get('default-src'),
      policy.get('script-src'),
      policy.get('img-src'),
      policy.get('style-src'),
      policy.get('frame-ancestors'),
    ]).toEqual(["'none'", "'self'", "'self' data:", "'unsafe-inline'", "'none'"]);
  });

  it('still allows no web font', async () => {
    // #given the policy the Worker sends
    // #when it is read
    const policy = await policyOf();

    // #then font-src stays absent, which theme.ts records as a deliberate choice
    expect(policy.has('font-src')).toBe(false);
  });
});

describe('the www host', () => {
  const at = (host: string, path: string, scheme = 'https', env: Env = ENV): Promise<Response> =>
    worker.fetch(new Request(`${scheme}://${host}${path}`), env);

  it('redirects to the same path on the canonical origin, permanently', async () => {
    // #given a request on the www host, with a path and a query
    // #when the Worker answers
    const response = await at('www.tryconduit.xyz', '/app/settlements?x=1');

    // #then it is sent to the apex with both preserved
    expect([response.status, response.headers.get('location')]).toEqual([
      308,
      'https://tryconduit.xyz/app/settlements?x=1',
    ]);
  });

  it('sends cleartext www to https on the apex in one step', async () => {
    // #given a cleartext request on the www host
    // #when the Worker answers
    const response = await at('www.tryconduit.xyz', '/app', 'http');

    // #then it lands on the canonical origin directly, not on https www first
    expect(response.headers.get('location')).toBe('https://tryconduit.xyz/app');
  });

  it('does not redirect the canonical host', async () => {
    // #given a request on the canonical host
    // #when the Worker answers
    const response = await at('tryconduit.xyz', '/favicon.ico');

    // #then it is served, not redirected
    expect(response.status).toBe(200);
  });

  it('serves cleartext on the canonical host, which is how wrangler dev presents every local request', async () => {
    // #given a cleartext request on the canonical host: with routes in wrangler.toml, the
    // local dev server hands the Worker `http://tryconduit.xyz/...` for requests to localhost
    // #when the Worker answers
    const response = await at('tryconduit.xyz', '/favicon.ico', 'http');

    // #then it is served, because a redirect to https would send every local visitor to the
    // production site, or loop
    expect(response.status).toBe(200);
  });

  it('does not redirect the workers.dev address', async () => {
    // #given a request on the workers.dev host
    // #when the Worker answers
    const response = await at('conduit.timjosh507.workers.dev', '/favicon.ico');

    // #then it is still served
    expect(response.status).toBe(200);
  });

  it('does not redirect a www host that belongs to some other site', async () => {
    // #given a www host that is not www of the canonical host
    // #when the Worker answers
    const response = await at('www.example.com', '/favicon.ico');

    // #then it is served, not redirected
    expect(response.status).toBe(200);
  });

  it('does nothing when no site is configured', async () => {
    // #given a deployment with no SITE_URL
    // #when a www request arrives
    const response = await at('www.tryconduit.xyz', '/favicon.ico', 'https', BARE);

    // #then it is served
    expect(response.status).toBe(200);
  });
});

describe('the head a page is served with', () => {
  const canonicalOf = (html: string): string | undefined =>
    /<link rel="canonical" href="([^"]*)">/.exec(html)?.[1];

  it('points the canonical link at the configured site', async () => {
    // #given a page that needs no database
    // #when the Worker serves it
    const html = await (await get('/app/verifier')).text();

    // #then the canonical link is the configured origin plus the page's own path
    expect(canonicalOf(html)).toBe('https://tryconduit.xyz/app/verifier');
  });

  it('announces whatever site the deployment is configured with', async () => {
    // #given a deployment configured with another origin
    const env: Env = { ...BARE, SITE_URL: 'https://preview.example.test' };

    // #when the Worker serves the same page
    const html = await (await get('/app/verifier', undefined, env)).text();

    // #then the canonical link follows the configuration, not a constant
    expect(canonicalOf(html)).toBe('https://preview.example.test/app/verifier');
  });

  it('serves a page that does not exist as noindex, with no canonical link', async () => {
    // #given a path no route serves
    // #when the Worker answers
    const html = await (await get('/no-such-page')).text();

    // #then it asks to be left out of the index and names no address of its own
    expect([html.includes('<meta name="robots" content="noindex">'), canonicalOf(html)]).toEqual([
      true,
      undefined,
    ]);
  });
});

describe('a path of thousands of slashes', () => {
  const hostile = `${'/'.repeat(30_000)}x`;

  it('is answered as a page that does not exist', async () => {
    // #given a long run of slashes ending in a letter, which no route serves
    // #when the Worker answers
    const response = await get(hostile);

    // #then it is a 404 like any other unknown path
    expect(response.status).toBe(404);
  });

  it('is answered without stalling the isolate', async () => {
    // #given the same path, which a quadratic trim of trailing slashes took seconds over
    const started = performance.now();

    // #when the Worker answers
    await get(hostile);
    const elapsed = performance.now() - started;

    // #then it finishes far inside that, with room for a loaded runner
    expect(elapsed).toBeLessThan(250);
  });
});

describe('SITE_URL', () => {
  it('fails the request loudly when it is not an origin', async () => {
    // #given a deployment configured with a path in its site address
    const env: Env = { ...ENV, SITE_URL: 'https://tryconduit.xyz/app' };

    // #when a request arrives
    const answer = get('/favicon.ico', undefined, env);

    // #then it fails, instead of announcing a wrong address on every page
    await expect(answer).rejects.toThrow(/SITE_URL/);
  });
});

/**
 * Nothing is mocked here. The driver is the real one and the host cannot resolve, so the read
 * fails the way an outage does. The generous timeout is for a network that drops the lookup
 * instead of refusing it, where a resolver can take several seconds to give up.
 */
describe('the landing page when the database cannot be read', { timeout: 30_000 }, () => {
  const SENTENCE =
    'Live counts are unavailable right now, and the recorded proof below does not depend on them.';

  const statLabels = (html: string): readonly string[] =>
    [...html.matchAll(/<div class="stat-label">([^<]*)<\/div>/g)].map((match) => match[1] ?? '');

  let logged: MockInstance<typeof console.error>;

  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logged.mockRestore();
  });

  it('still answers 200', async () => {
    // #given a database that cannot be reached
    // #when the landing is requested
    const response = await get('/');

    // #then the page is served
    expect(response.status).toBe(200);
  });

  it('serves the landing page without its live figures', async () => {
    // #given a database that cannot be reached
    // #when the landing is requested
    const html = await (await get('/')).text();

    // #then it is the landing page with no counts and no featured settlement, and nothing else
    expect(html).toBe(renderLanding(undefined, []));
  });

  it('shows none of the four figures', async () => {
    // #given a database that cannot be reached
    // #when the landing is requested
    const html = await (await get('/')).text();

    // #then no statistic is printed, so no zero can pass for a count
    expect(statLabels(html)).toEqual([]);
  });

  it('says the live counts are unavailable', async () => {
    // #given a database that cannot be reached
    // #when the landing is requested
    const html = await (await get('/')).text();

    // #then the one sentence is there
    expect(html).toContain(SENTENCE);
  });

  it('features no settlement', async () => {
    // #given a database that cannot be reached
    // #when the landing is requested
    const html = await (await get('/')).text();

    // #then the hero has no settlement to link
    expect(html).not.toContain('class="hero-proof"');
  });

  it('logs the failure once, with the error', async () => {
    // #given a database that cannot be reached
    // #when the landing is requested
    await get('/');

    // #then the outage is in the log and not only on the page
    expect(logged).toHaveBeenCalledExactlyOnceWith('landing facts unavailable', expect.any(Error));
  });

  it('keeps the connection string out of the log', async () => {
    // #given a database that cannot be reached
    // #when the landing is requested
    await get('/');

    // #then nothing written to the log holds the connection string
    expect(inspect(logged.mock.calls, { depth: 8 })).not.toContain(BARE.DATABASE_URL);
  });

  it('is not stored by any cache', async () => {
    // #given a database that cannot be reached
    // #when the landing is requested
    const response = await get('/');

    // #then a page that is only true for now is never kept
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it.each(['/app', '/app/settlements', '/app/deployments'])(
    'leaves %s on its error page, because it has nothing true to show',
    async (path) => {
      // #given a database that cannot be reached
      // #when a route that exists to show its data is requested
      const response = await get(path);

      // #then it still answers the error page
      expect([response.status, (await response.text()).includes('could not be read')]).toEqual([
        500,
        true,
      ]);
    },
  );
});

describe('the welcome reserve on the overview, decided by the Cookie header', () => {
  const EMPTY_OVERVIEW = {
    totals: { settlements: 0, held: 0, messages: 0, verifications: 0, generations: 1 },
    recent: [],
  };

  const onboardingHost = async (cookie?: string): Promise<string> => {
    const response = await get('/app', cookie === undefined ? undefined : { headers: { cookie } });
    return /<div[^>]*data-onboarding[^>]*>/.exec(await response.text())?.[0] ?? '';
  };

  beforeEach(() => {
    vi.mocked(consoleOverview).mockResolvedValue(EMPTY_OVERVIEW);
  });

  afterEach(() => {
    vi.mocked(consoleOverview).mockReset();
  });

  it.each([
    ['the cookie alone', 'conduit-welcomed=1'],
    ['the cookie after another', 'theme=dark; conduit-welcomed=1'],
    ['the cookie before another', 'conduit-welcomed=1; theme=dark'],
  ])('leaves the reserve class off the onboarding host with %s', async (_label, cookie) => {
    // #given a visitor whose Cookie header says they were welcomed
    // #when the overview is requested
    const host = await onboardingHost(cookie);

    // #then the host is rendered without the reserve class
    expect(host).not.toContain('reserve');
  });

  it.each([
    ['no Cookie header', undefined],
    ['conduit-welcomed=0', 'conduit-welcomed=0'],
    ['an empty value', 'conduit-welcomed='],
    ['a different cookie name', 'theme=dark'],
    ['a longer name that contains it', 'conduit-welcomed-v2=1'],
    ['a name that merely ends with it', 'x-conduit-welcomed=1'],
  ])('keeps the reserve class on the onboarding host with %s', async (_label, cookie) => {
    // #given a visitor the Cookie header does not show as welcomed
    // #when the overview is requested
    const host = await onboardingHost(cookie);

    // #then the host holds its space
    expect(host).toContain('class="reserve"');
  });

  it('keeps the personal overview reserve for a welcomed visitor', async () => {
    // #given a visitor whose Cookie header says they were welcomed
    // #when the overview is requested
    const html = await (await get('/app', { headers: { cookie: 'conduit-welcomed=1' } })).text();

    // #then the personal overview host still holds its space
    expect(html).toContain('<div class="reserve" data-overview></div>');
  });

  it('never sets a cookie itself', async () => {
    // #given a visitor with and without the cookie
    const withCookie = await get('/app', { headers: { cookie: 'conduit-welcomed=1' } });
    const without = await get('/app');

    // #then neither response carries a Set-Cookie header
    expect([withCookie.headers.has('set-cookie'), without.headers.has('set-cookie')]).toEqual([
      false,
      false,
    ]);
  });

  it('is never stored by a cache, because the page depends on the Cookie header', async () => {
    // #given a visitor carrying the cookie
    // #when the overview is requested
    const response = await get('/app', { headers: { cookie: 'conduit-welcomed=1' } });

    // #then the page is not kept
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('puts no blocking attribute on the script tag with or without the cookie', async () => {
    // #given the overview for a welcomed and an unwelcomed visitor
    const script = async (cookie?: string): Promise<string | undefined> => {
      const response = await get(
        '/app',
        cookie === undefined ? undefined : { headers: { cookie } },
      );
      return /<script[^>]*>/.exec(await response.text())?.[0];
    };

    // #then both carry one script element and neither blocks the paint
    expect([await script('conduit-welcomed=1'), await script()]).toEqual([
      expect.not.stringContaining('blocking'),
      expect.not.stringContaining('blocking'),
    ]);
  });
});

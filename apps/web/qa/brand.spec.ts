/**
 * The brand as a browser and a link-preview crawler receive it.
 *
 * `head.test.ts` and `worker.test.ts` prove the pieces on their own. This proves the
 * pieces are joined: every page announces itself, every file those announcements point
 * at resolves, a crawler is handed the same card a person would be, the browser accepts
 * the manifest under the page's own policy, and the lockup the pages draw is the brand's.
 *
 * Every request is a GET and every visit is a read, so it is safe against any
 * `WEB_BASE_URL`, including one that shares a database with production.
 */

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * The first request after the console starts is slow, and nearly every page reads the
 * shared database, so the default budget is too tight for a cold start.
 */
test.describe.configure({ timeout: 60_000 });

/**
 * The address the product announces itself at.
 *
 * The console reads SITE_URL from wrangler.toml, so this is the production origin even
 * when the console under test is local. A declared URL is therefore fetched by its path,
 * against the origin under test, and never by the address it declares.
 */
const SITE = 'https://tryconduit.xyz';

/** A settlement the projection and the proof pages both know. */
const SETTLEMENT_ID = '0xc113ad335d202d985d527b0a193498ef2ecceb9a129a58c5002943c88601a3b0';

const BRAND_RED = 'rgb(231, 0, 11)';

/** The landing page leads with the product. Every other page leads with itself. */
const PRODUCT_TITLE = /^Conduit: \S/;
const PAGE_TITLE = /^\S.* \| Conduit$/;

interface Surface {
  readonly name: string;
  readonly path: string;
  readonly status: 200 | 404;
  readonly title: RegExp;
  /** Drawn inside the console shell, so it has a sidebar. */
  readonly sidebar: boolean;
}

/** A page drawn inside the console shell, which is every page but the landing and the 404. */
const inShell = (name: string, path: string): Surface => ({
  name,
  path,
  status: 200,
  title: PAGE_TITLE,
  sidebar: true,
});

const SURFACES: readonly Surface[] = [
  { name: 'landing', path: '/', status: 200, title: PRODUCT_TITLE, sidebar: false },
  inShell('overview', '/app'),
  inShell('settlements', '/app/settlements'),
  inShell('composer', '/app/settlements/new'),
  inShell('settlement-detail', `/app/settlements/${SETTLEMENT_ID}`),
  inShell('verification', `/verify/${SETTLEMENT_ID}`),
  inShell('evidence-detail', `/evidence/${SETTLEMENT_ID}`),
  inShell('dispositions', '/app/dispositions'),
  inShell('verifier', '/app/verifier'),
  inShell('evidence', '/app/evidence'),
  inShell('deployments', '/app/deployments'),
  inShell('system', '/app/system'),
  { name: 'not-found', path: '/no-such-page', status: 404, title: PAGE_TITLE, sidebar: false },
];

const surfaces = (...names: readonly string[]): readonly Surface[] =>
  SURFACES.filter((surface) => names.includes(surface.name));

/** An error page is not a canonical anything, so it has no address to declare. */
const addressOf = (surface: Surface): string | undefined =>
  surface.status === 404 ? undefined : `${SITE}${surface.path}`;

// ── Reading a served page the way a crawler does ────────────────────────────

type Attributes = Readonly<Record<string, string>>;

interface Head {
  readonly titles: readonly string[];
  readonly tags: readonly Attributes[];
}

interface Served {
  readonly status: number;
  readonly html: string;
  readonly head: Head;
}

const decode = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The titles, metas and links of the document head, from the HTML alone, with no script run. */
function readHead(html: string): Head {
  const end = html.indexOf('</head>');
  if (end === -1) throw new Error('the response has no </head>, so it is not a page');
  const head = html.slice(0, end);

  const tags = [...head.matchAll(/<(?:meta|link)\s+([^>]*)>/g)].map((element) => {
    const attributes: Record<string, string> = {};
    for (const pair of (element[1] ?? '').matchAll(/([a-z:-]+)="([^"]*)"/g)) {
      attributes[pair[1] ?? ''] = decode(pair[2] ?? '');
    }
    return attributes;
  });
  const titles = [...head.matchAll(/<title>([^<]*)<\/title>/g)].map((title) =>
    decode(title[1] ?? ''),
  );
  return { titles, tags };
}

/** Every value a meta tag of this name or property carries, so a duplicate is visible. */
const values = (head: Head, key: string): string[] =>
  head.tags
    .filter((tag) => tag['property'] === key || tag['name'] === key)
    .map((tag) => tag['content'] ?? '');

const links = (head: Head, rel: string): readonly Attributes[] =>
  head.tags.filter((tag) => tag['rel'] === rel);

/** The one value a tag is expected to have. Anything else is a page that is wired wrongly. */
function only(head: Head, key: string): string {
  const found = values(head, key);
  const [first] = found;
  if (found.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one ${key} tag, found ${String(found.length)}`);
  }
  return first;
}

async function fetchPage(
  request: APIRequestContext,
  path: string,
  userAgent?: string,
): Promise<Served> {
  const response = await request.get(
    path,
    userAgent === undefined ? {} : { headers: { 'user-agent': userAgent } },
  );
  const html = await response.text();
  return { status: response.status(), html, head: readHead(html) };
}

/** A URL a page declared, reduced to the path the console under test serves it at. */
function pathOf(declared: string): string {
  const { pathname, search } = new URL(declared, SITE);
  return `${pathname}${search}`;
}

const bytesAt = async (request: APIRequestContext, path: string): Promise<Buffer> =>
  (await request.get(path)).body();

// ── Reading the files they point at ─────────────────────────────────────────

const PNG_SIGNATURE = '89504e470d0a1a0a';

/** The size a PNG states in its header, or undefined when the bytes are not a PNG. */
function pngSize(bytes: Buffer): string | undefined {
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return undefined;
  return `${String(bytes.readUInt32BE(16))}x${String(bytes.readUInt32BE(20))}`;
}

/** The sizes an ICO holds, from its directory. A zero in a size byte means 256. */
function icoSizes(bytes: Buffer): string[] {
  const isIcon = bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1;
  if (!isIcon) return [];
  const count = bytes.readUInt16LE(4);
  if (bytes.length < 6 + count * 16) return [];

  const dimension = (byte: number): number => (byte === 0 ? 256 : byte);
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + index * 16;
    return `${String(dimension(bytes.readUInt8(entry)))}x${String(dimension(bytes.readUInt8(entry + 1)))}`;
  });
}

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
}

/** Untrusted JSON, so `icons` is optional and a manifest without it reads as having none. */
async function manifestIcons(request: APIRequestContext): Promise<readonly ManifestIcon[]> {
  const response = await request.get('/site.webmanifest');
  const manifest = (await response.json()) as { readonly icons?: readonly ManifestIcon[] };
  return manifest.icons ?? [];
}

// ── The head of every page ──────────────────────────────────────────────────

const filled = [expect.stringMatching(/\S/)];

for (const surface of SURFACES) {
  const address = addressOf(surface);

  test.describe(`head of ${surface.name}`, () => {
    test('has exactly one title that names the page and the product', async ({ request }) => {
      // #given the page as a crawler fetches it
      const { head } = await fetchPage(request, surface.path);

      // #when its titles are read
      const titles = head.titles;

      // #then there is one, in the form this page uses
      expect(titles).toEqual([expect.stringMatching(surface.title)]);
    });

    test('has a description', async ({ request }) => {
      // #given the page as a crawler fetches it
      const { head } = await fetchPage(request, surface.path);

      // #when the description tags are read
      const descriptions = values(head, 'description');

      // #then there is exactly one and it says something
      expect(descriptions).toEqual(filled);
    });

    test(
      address === undefined
        ? 'has no canonical address and asks to be kept out of the index'
        : `declares ${address} as its canonical address and stays in the index`,
      async ({ request }) => {
        // #given the page as a crawler fetches it
        const { head } = await fetchPage(request, surface.path);

        // #when the canonical links and the robots directive are read
        const indexing = {
          canonical: links(head, 'canonical').map((tag) => tag['href']),
          robots: values(head, 'robots'),
        };

        // #then an error page has no address and says noindex, and any other has its own
        expect(indexing).toEqual({
          canonical: address === undefined ? [] : [address],
          robots: address === undefined ? ['noindex'] : [],
        });
      },
    );

    test('carries the full social card', async ({ request }) => {
      // #given the page as a crawler fetches it
      const { head } = await fetchPage(request, surface.path);

      // #when the Open Graph and Twitter tags are read
      const card = Object.fromEntries(
        [
          'og:title',
          'og:description',
          'og:url',
          'og:image',
          'og:image:width',
          'og:image:height',
          'og:image:alt',
          'twitter:card',
          'twitter:image',
        ].map((key) => [key, values(head, key)]),
      );

      // #then each is present once, the image is the hashed card on the canonical origin,
      // and Twitter is pointed at the same card
      expect(card).toEqual({
        'og:title': filled,
        'og:description': filled,
        'og:url': address === undefined ? [] : [address],
        'og:image': [
          expect.stringMatching(
            /^https:\/\/tryconduit\.xyz\/assets\/conduit-og\.[0-9a-f]{12}\.png$/,
          ),
        ],
        'og:image:width': ['1200'],
        'og:image:height': ['630'],
        'og:image:alt': filled,
        'twitter:card': ['summary_large_image'],
        'twitter:image': card['og:image'],
      });
    });

    test('links the icons, the manifest and the theme colour', async ({ request }) => {
      // #given the page as a crawler fetches it
      const { head } = await fetchPage(request, surface.path);

      // #when the tags a browser reads for its chrome are read
      const chrome = {
        icons: links(head, 'icon').map((tag) => [tag['href'], tag['sizes'] ?? tag['type']]),
        appleTouchIcons: links(head, 'apple-touch-icon').map((tag) => tag['href']),
        manifests: links(head, 'manifest').map((tag) => tag['href']),
        themeColors: values(head, 'theme-color'),
      };

      // #then the ICO is sized so it does not outrank the SVG, and the rest are linked once
      expect(chrome).toEqual({
        icons: [
          ['/favicon.ico', '32x32'],
          ['/favicon.svg', 'image/svg+xml'],
        ],
        appleTouchIcons: ['/apple-touch-icon.png'],
        manifests: ['/site.webmanifest'],
        themeColors: ['#ffffff'],
      });
    });

    test(`is answered with ${String(surface.status)}`, async ({ request }) => {
      // #given the page's path
      // #when it is fetched
      const { status } = await fetchPage(request, surface.path);

      // #then the status is the one this page is meant to have
      expect(status).toBe(surface.status);
    });
  });
}

// ── The files the heads point at ────────────────────────────────────────────

test.describe('the files the head points at', () => {
  const FIXED_NAMES: readonly { path: string; type: string }[] = [
    { path: '/favicon.ico', type: 'image/x-icon' },
    { path: '/favicon.svg', type: 'image/svg+xml' },
    { path: '/apple-touch-icon.png', type: 'image/png' },
    { path: '/site.webmanifest', type: 'application/manifest+json' },
  ];

  for (const file of FIXED_NAMES) {
    test(`${file.path} is served as ${file.type}`, async ({ request }) => {
      // #given a file the head links by a fixed name
      // #when it is fetched
      const response = await request.get(file.path);

      // #then it exists and says what it is
      expect([response.status(), response.headers()['content-type']]).toEqual([200, file.type]);
    });
  }

  test('favicon.ico holds the size its link claims', async ({ request }) => {
    // #given the size the landing head says the ICO has
    const { head } = await fetchPage(request, '/');
    const claimed = links(head, 'icon').find((tag) => tag['href'] === '/favicon.ico')?.['sizes'];

    // #when the file's own directory is read
    const held = icoSizes(await bytesAt(request, '/favicon.ico'));

    // #then the claimed size is among the images it holds
    expect(held).toContain(claimed);
  });

  test('apple-touch-icon.png is the 180 by 180 that iOS asks for', async ({ request }) => {
    // #given the touch icon, whose link states no size because iOS wants exactly one
    // #when its PNG header is read
    const size = pngSize(await bytesAt(request, '/apple-touch-icon.png'));

    // #then it is that size
    expect(size).toBe('180x180');
  });

  test('the manifest lists icons', async ({ request }) => {
    // #given the served manifest
    // #when its icons are read
    const icons = await manifestIcons(request);

    // #then there are some, so the test below is not vacuously true
    expect(icons.length).toBeGreaterThan(0);
  });

  test('every icon the manifest lists is served as the type and size it claims', async ({
    request,
  }) => {
    // #given the icons the manifest lists
    const icons = await manifestIcons(request);

    // #when each is fetched and its PNG header read
    const served = await Promise.all(
      icons.map(async (icon) => {
        const response = await request.get(pathOf(icon.src));
        return {
          src: icon.src,
          status: response.status(),
          type: response.headers()['content-type'],
          size: pngSize(await response.body()),
        };
      }),
    );

    // #then each answers 200 with the type and size the manifest states
    expect(served).toEqual(
      icons.map((icon) => ({ src: icon.src, status: 200, type: icon.type, size: icon.sizes })),
    );
  });

  test('the og:image is a PNG at the size the tags claim', async ({ request }) => {
    // #given the card and the size the landing head says it has
    const { head } = await fetchPage(request, '/');
    const claimed = `${only(head, 'og:image:width')}x${only(head, 'og:image:height')}`;

    // #when the card is fetched at the path it is declared at
    const response = await request.get(pathOf(only(head, 'og:image')));

    // #then it is a PNG of exactly that size
    expect({
      status: response.status(),
      type: response.headers()['content-type'],
      size: pngSize(await response.body()),
    }).toEqual({ status: 200, type: 'image/png', size: claimed });
  });

  test('the og:image is no larger than 300000 bytes', async ({ request }) => {
    // #given the card's declared path
    const { head } = await fetchPage(request, '/');

    // #when the card is fetched
    const card = await bytesAt(request, pathOf(only(head, 'og:image')));

    // #then it is small enough that a strict crawler does not drop it without saying so
    expect(card.length).toBeLessThanOrEqual(300_000);
  });
});

// ── Link-preview crawlers ───────────────────────────────────────────────────

test.describe('link-preview crawlers', () => {
  const CRAWLERS: readonly { name: string; agent: string }[] = [
    {
      name: 'Facebook',
      agent: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uagent.php)',
    },
    { name: 'Twitter', agent: 'Twitterbot/1.0' },
    { name: 'Slack', agent: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' },
    {
      name: 'LinkedIn',
      agent: 'LinkedInBot/1.0 (compatible; Mozilla/5.0; +http://www.linkedin.com)',
    },
    { name: 'Discord', agent: 'Discordbot/2.0 (+https://discordapp.com)' },
    { name: 'WhatsApp', agent: 'WhatsApp/2.23.20.0' },
    { name: 'Telegram', agent: 'TelegramBot (like TwitterBot)' },
    {
      name: 'Google',
      agent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    },
  ];

  for (const crawler of CRAWLERS) {
    for (const surface of surfaces('landing', 'settlement-detail')) {
      test(`${crawler.name} gets the preview card from the ${surface.name} page`, async ({
        request,
      }) => {
        // #given a crawler that sends its own user agent and runs no script
        // #when it fetches the page, then the image the page declares
        const served = await fetchPage(request, surface.path, crawler.agent);
        const [image] = values(served.head, 'og:image');
        const card =
          image === undefined
            ? undefined
            : await request.get(pathOf(image), { headers: { 'user-agent': crawler.agent } });

        // #then both answer, and what the image answers with is a PNG
        expect({
          pageStatus: served.status,
          imageDeclared: image !== undefined,
          cardStatus: card?.status(),
          cardType: card?.headers()['content-type'],
        }).toEqual({
          pageStatus: 200,
          imageDeclared: true,
          cardStatus: 200,
          cardType: 'image/png',
        });
      });
    }
  }
});

// ── What the browser says about it ──────────────────────────────────────────

test.describe('the browser', () => {
  const POLICY_VIOLATION = /Content Security Policy|Refused to/;

  /** Everything the page writes to its console or throws, kept as text. */
  function listen(page: Page): string[] {
    const heard: string[] = [];
    page.on('console', (message) => {
      heard.push(message.text());
    });
    page.on('pageerror', (error) => {
      heard.push(error.message);
    });
    return heard;
  }

  for (const surface of surfaces('landing', 'overview', 'verification')) {
    test(`loads the ${surface.name} page without a policy violation`, async ({ page }) => {
      // #given a browser that is listening before the page starts to load
      const heard = listen(page);

      // #when the page loads and everything it requests has settled
      await page.goto(surface.path);
      await page.waitForLoadState('networkidle');

      // #then nothing it said is a refusal by the Content-Security-Policy
      expect(heard.filter((message) => POLICY_VIOLATION.test(message))).toEqual([]);
    });

    test(`reads the manifest the ${surface.name} page links, under the page's own policy`, async ({
      page,
      browserName,
    }) => {
      test.skip(browserName !== 'chromium', 'the manifest is requested over the DevTools protocol');

      // #given a browser that records every answer to a manifest request, and what it says
      const heard = listen(page);
      const statuses: number[] = [];
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/site.webmanifest') {
          statuses.push(response.status());
        }
      });

      // #when the page has loaded and the browser is asked for its manifest
      // A browser fetches the manifest lazily, when something such as an install check
      // wants it, and the headless one these tests run in never asks on its own. Asking
      // is what makes the fetch happen, and it happens under the page's policy, which is
      // what is on trial. A policy that forbids it leaves no response at all, and says so
      // only on the console, so the console is part of what is compared.
      await page.goto(surface.path);
      const session = await page.context().newCDPSession(page);
      const { errors } = await session.send('Page.getAppManifest');

      // #then it was fetched, every answer was a 200, and nothing refused or rejected it
      await expect
        .poll(() => ({
          statuses: [...new Set(statuses)],
          errors,
          refusals: heard.filter((message) => POLICY_VIOLATION.test(message)),
        }))
        .toEqual({ statuses: [200], errors: [], refusals: [] });
    });
  }
});

// ── The lockup ──────────────────────────────────────────────────────────────

const BRAND_LINK = 'Conduit, back to the home page';

interface Placement {
  readonly name: string;
  readonly path: string;
  /** The height the stylesheet gives the lockup in this place. */
  readonly height: number;
  readonly locate: (page: Page) => Locator;
}

const PLACEMENTS: readonly Placement[] = [
  {
    name: 'sidebar',
    path: '/app',
    height: 20,
    locate: (page) =>
      page.getByRole('link', { name: BRAND_LINK, exact: true }).locator('svg.lockup'),
  },
  {
    name: 'landing header',
    path: '/',
    height: 26,
    locate: (page) => page.locator('.landing-nav svg.lockup'),
  },
  {
    name: 'landing footer',
    path: '/',
    height: 24,
    locate: (page) => page.locator('.landing-foot svg.lockup'),
  },
];

test.describe('the lockup', () => {
  for (const placement of PLACEMENTS) {
    test(`is visible in the ${placement.name}`, async ({ page }) => {
      // #given the page the lockup sits on
      await page.goto(placement.path);

      // #when the lockup is looked for in that place
      const lockup = placement.locate(page);

      // #then it is drawn
      await expect(lockup).toBeVisible();
    });

    test(`is ${String(placement.height)}px high in the ${placement.name}`, async ({ page }) => {
      // #given the page the lockup sits on
      await page.goto(placement.path);

      // #when its height is measured after layout
      const height = await placement
        .locate(page)
        .evaluate((svg) => svg.getBoundingClientRect().height);

      // #then it is the height the stylesheet gives it there, give or take a pixel
      expect(
        Math.abs(height - placement.height),
        `measured ${String(height)}px, expected ${String(placement.height)}px`,
      ).toBeLessThanOrEqual(1);
    });

    test(`draws the point in the ${placement.name} in the brand red and nothing else in it`, async ({
      page,
    }) => {
      // #given the page the lockup sits on
      await page.goto(placement.path);

      // #when every element of the lockup is asked for its computed fill
      const red = await placement
        .locate(page)
        .evaluate(
          (svg, brandRed) =>
            [...svg.querySelectorAll('*')]
              .filter((element) => getComputedStyle(element).fill === brandRed)
              .map((element) => element.tagName.toLowerCase()),
          BRAND_RED,
        );

      // #then the only one that is red is the point
      expect(red).toEqual(['circle']);
    });

    test(`hides the ${placement.name} lockup from assistive technology`, async ({ page }) => {
      // #given the page the lockup sits on
      await page.goto(placement.path);

      // #when the artwork is looked at
      const lockup = placement.locate(page);

      // #then it is decoration, because its wrapper already carries the name
      await expect(lockup).toHaveAttribute('aria-hidden', 'true');
    });
  }

  test('makes the sidebar brand a link to the home page', async ({ page }) => {
    // #given the console
    await page.goto('/app');

    // #when the brand is found by the name a screen reader would announce
    const brand = page.getByRole('link', { name: BRAND_LINK, exact: true });

    // #then it goes to the landing page
    await expect(brand).toHaveAttribute('href', '/');
  });

  test('names each unlinked wordmark on the landing page once, as Conduit', async ({ page }) => {
    // #given the landing page, whose header and footer wordmarks point at the page they are on
    await page.goto('/');

    // #when the images a screen reader would announce as Conduit are counted
    const announced = page.getByRole('img', { name: 'Conduit', exact: true });

    // #then there is one for the header and one for the footer
    await expect(announced).toHaveCount(2);
  });

  test.describe('under forced colours in a dark palette', () => {
    test('does not leave the sidebar lockup in the ink the palette cannot remap', async ({
      page,
    }) => {
      // #given the console in a dark high-contrast palette, which forces the ground to black
      await page.emulateMedia({ forcedColors: 'active', colorScheme: 'dark' });
      await page.goto('/app');

      // #when the fill of every path in the sidebar lockup is read
      const fills = await page
        .locator('.sidebar svg.lockup path')
        .evaluateAll((paths) => paths.map((path) => getComputedStyle(path).fill));

      // #then none is the brand ink, which would vanish into that ground
      expect(fills.filter((fill) => fill === 'rgb(10, 10, 10)')).toEqual([]);
    });
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('lets the landing page scroll no wider than the screen', async ({ page }) => {
      // #given the landing page on a 390 pixel screen
      await page.goto('/');

      // #when the document's width is compared with the window's
      const widths = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth,
        window: window.innerWidth,
      }));

      // #then nothing, the lockup included, has pushed the page sideways
      expect(widths.document).toBeLessThanOrEqual(widths.window);
    });

    test('still shows the lockup in the landing header', async ({ page }) => {
      // #given the landing page on a 390 pixel screen
      await page.goto('/');

      // #when the header lockup is looked for
      const lockup = page.locator('.landing-nav svg.lockup');

      // #then it is drawn
      await expect(lockup).toBeVisible();
    });
  });
});

test.describe('the sidebar identity', () => {
  for (const surface of SURFACES.filter(({ sidebar }) => sidebar)) {
    test(`holds exactly one identity on the ${surface.name} page`, async ({ page }) => {
      // #given a console page, after its script has run
      await page.goto(surface.path);
      await page.waitForLoadState('networkidle');

      // #when the elements with the identity class in the sidebar are counted
      const identities = page.locator('.sidebar .identity');

      // #then the brand is the only one
      await expect(identities).toHaveCount(1);
    });
  }
});

test.describe('the lockup on every page', () => {
  for (const surface of SURFACES) {
    test(`is drawn on the ${surface.name} page and none of it is exposed`, async ({ request }) => {
      // #given the page as served
      const { html } = await fetchPage(request, surface.path);

      // #when the lockups in it are found
      const lockups = [...html.matchAll(/<svg class="lockup"[^>]*>/g)].map((match) => match[0]);

      // #then there is at least one, and none is missing aria-hidden
      expect({
        drawn: lockups.length > 0,
        exposed: lockups.filter((tag) => !tag.includes('aria-hidden="true"')),
      }).toEqual({ drawn: true, exposed: [] });
    });
  }
});

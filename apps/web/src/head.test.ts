import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DESCRIPTOR, headTags, setSite, type PageMeta } from './head.js';
import { IMAGES } from './image-manifest.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SITE = 'https://tryconduit.xyz';

const PAGE: PageMeta = {
  title: 'Settlements',
  description: 'Every settlement the projection has seen.',
  path: '/app/settlements',
};

/** Every `<meta>` or `<link>` as an attribute map, so tests read tags rather than strings. */
function tags(html: string): readonly Record<string, string>[] {
  return [...html.matchAll(/<(meta|link)\s+([^>]*)>/g)].map((match) => {
    const attributes: Record<string, string> = { tag: match[1] ?? '' };
    for (const pair of (match[2] ?? '').matchAll(/([a-z:-]+)="([^"]*)"/g)) {
      attributes[pair[1] ?? ''] = (pair[2] ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
    }
    return attributes;
  });
}

const content = (html: string, key: string): string | undefined =>
  tags(html).find((tag) => tag['property'] === key || tag['name'] === key)?.['content'];

const links = (html: string, rel: string): readonly Record<string, string>[] =>
  tags(html).filter((tag) => tag['tag'] === 'link' && tag['rel'] === rel);

/** The head for a page on the configured site. */
function build(page: PageMeta = PAGE): string {
  setSite(SITE);
  return headTags(page);
}

afterEach(() => {
  setSite(undefined);
});

describe('setSite', () => {
  it('names SITE_URL when the value is a bare host, not an unlabelled parse error', () => {
    // #given a value with no scheme, the likeliest typo
    const set = (): void => {
      setSite('tryconduit.xyz');
    };

    // #when it is set
    // #then the error says which variable is wrong
    expect(set).toThrow(/SITE_URL must be an http or https URL/);
  });

  it('accepts an origin with a trailing slash', () => {
    // #given an origin written with a trailing slash
    setSite(`${SITE}/`);

    // #when a page with a path is described
    const head = headTags({ title: 'A', path: '/x' });

    // #then the slash does not double up
    expect(content(head, 'og:url')).toBe(`${SITE}/x`);
  });

  it('treats blank as absent', () => {
    // #given a blank value
    setSite('   ');

    // #when a page with a path is described
    const head = headTags({ title: 'A', path: '/x' });

    // #then there is no address to announce
    expect(content(head, 'og:url')).toBeUndefined();
  });

  it.each([`${SITE}/app`, `${SITE}/?a=1`, `${SITE}/#top`])(
    'refuses %s, which is not an origin',
    (value) => {
      // #given a value with a path, query or fragment
      // #when it is set
      const set = (): void => {
        setSite(value);
      };

      // #then it is refused
      expect(set).toThrow(/origin/);
    },
  );

  it('refuses a scheme a browser cannot use as a canonical address', () => {
    // #given an ftp address
    // #when it is set
    const set = (): void => {
      setSite('ftp://tryconduit.xyz');
    };

    // #then it is refused
    expect(set).toThrow(/http or https/);
  });

  it('refuses a value that is not a URL, loudly', () => {
    // #given a bare host name
    // #when it is set
    const set = (): void => {
      setSite('tryconduit.xyz');
    };

    // #then it throws instead of announcing a wrong address
    expect(set).toThrow();
  });
});

describe('headTags with the site configured', () => {
  it('puts the site name after the page name in the document title', () => {
    // #given an ordinary page
    // #when the head is built
    const head = build();

    // #then the title reads page, then product
    expect(head).toContain('<title>Settlements | Conduit</title>');
  });

  it('writes the page description', () => {
    // #given a page with a description
    // #when the head is built
    const head = build();

    // #then it is the description tag
    expect(content(head, 'description')).toBe('Every settlement the projection has seen.');
  });

  it('writes one canonical link at the absolute address', () => {
    // #given a page with a path
    // #when the head is built
    const head = build();

    // #then the canonical link is that path on the site
    expect(links(head, 'canonical').map((tag) => tag['href'])).toEqual([`${SITE}/app/settlements`]);
  });

  it('writes an og:url that matches the canonical link', () => {
    // #given a page with a path
    // #when the head is built
    const head = build();

    // #then the two addresses agree
    expect(content(head, 'og:url')).toBe(links(head, 'canonical')[0]?.['href']);
  });

  it('points og:image at the hashed card, absolutely', () => {
    // #given the card in the image table
    const card = IMAGES['brand-og.png'];

    // #when the head is built
    const head = build();

    // #then the image is the card's hashed path on the site
    expect(content(head, 'og:image')).toBe(`${SITE}${card?.path ?? ''}`);
  });

  it('states the size the card really has', () => {
    // #given the card is 1200 by 630
    // #when the head is built
    const head = build();

    // #then the tags say so
    expect([content(head, 'og:image:width'), content(head, 'og:image:height')]).toEqual([
      '1200',
      '630',
    ]);
  });

  it('states the card is a PNG and describes it', () => {
    // #given the card
    // #when the head is built
    const head = build();

    // #then the type and the alt text are present
    expect([content(head, 'og:image:type'), content(head, 'og:image:alt')]).toEqual([
      'image/png',
      expect.stringContaining('Two chains. One commitment.'),
    ]);
  });

  it('asks for the large Twitter card', () => {
    // #given a site with a card
    // #when the head is built
    const head = build();

    // #then the large card is requested
    expect(content(head, 'twitter:card')).toBe('summary_large_image');
  });

  it('repeats the title, description and image for Twitter', () => {
    // #given a page
    // #when the head is built
    const head = build();

    // #then the Twitter tags carry the same values as the Open Graph ones
    expect([
      content(head, 'twitter:title'),
      content(head, 'twitter:description'),
      content(head, 'twitter:image'),
    ]).toEqual([
      content(head, 'og:title'),
      content(head, 'og:description'),
      content(head, 'og:image'),
    ]);
  });

  it('uses the bare page name as the social title, because og:site_name carries the product', () => {
    // #given an ordinary page
    // #when the head is built
    const head = build();

    // #then the social title has no site suffix
    expect(content(head, 'og:title')).toBe('Settlements');
  });

  it('names the product as the site', () => {
    // #given any page
    // #when the head is built
    const head = build();

    // #then og:site_name is Conduit
    expect(content(head, 'og:site_name')).toBe('Conduit');
  });

  it('links the two favicons by the fixed names browsers expect', () => {
    // #given any page
    // #when the head is built
    const head = build();

    // #then the ICO is sized so Chrome does not prefer it to the SVG, and the SVG is typed
    expect(links(head, 'icon').map((tag) => [tag['href'], tag['sizes'] ?? tag['type']])).toEqual([
      ['/favicon.ico', '32x32'],
      ['/favicon.svg', 'image/svg+xml'],
    ]);
  });

  it('links the Apple touch icon', () => {
    // #given any page
    // #when the head is built
    const head = build();

    // #then iOS has its icon
    expect(links(head, 'apple-touch-icon').map((tag) => tag['href'])).toEqual([
      '/apple-touch-icon.png',
    ]);
  });

  it('links the web manifest', () => {
    // #given any page
    // #when the head is built
    const head = build();

    // #then the manifest is linked at its fixed name
    expect(links(head, 'manifest').map((tag) => tag['href'])).toEqual(['/site.webmanifest']);
  });

  it('matches the browser chrome to the light page', () => {
    // #given a product that is light only
    // #when the head is built
    const head = build();

    // #then theme-color is white
    expect(content(head, 'theme-color')).toBe('#ffffff');
  });

  it('does not hide an ordinary page from search', () => {
    // #given a page with a path
    // #when the head is built
    const head = build();

    // #then there is no robots tag
    expect(content(head, 'robots')).toBeUndefined();
  });

  it.each([
    'description',
    'og:title',
    'og:description',
    'og:image',
    'og:url',
    'twitter:card',
    'theme-color',
  ])('writes %s exactly once', (key) => {
    // #given a page with every tag
    // #when the head is built
    const head = build();

    // #then the tag is not duplicated
    expect(tags(head).filter((tag) => tag['property'] === key || tag['name'] === key)).toHaveLength(
      1,
    );
  });

  it('writes exactly one title', () => {
    // #given any page
    // #when the head is built
    const head = build();

    // #then there is one title element
    expect(head.match(/<title>/g)).toHaveLength(1);
  });
});

describe('headTags, descriptions', () => {
  it('falls back to the descriptor when the description is blank', () => {
    // #given a page whose description is only whitespace
    const head = build({ title: 'A', path: '/a', description: '   ' });

    // #when its description is read
    const description = content(head, 'description');

    // #then a page never ships an empty description
    expect(description).toBe(DESCRIPTOR);
  });
});

describe('headTags, other shapes', () => {
  const PRODUCT: PageMeta = {
    title: 'Conduit',
    documentTitle: 'Conduit: cross-chain delivery versus payment',
    path: '/',
  };

  it('lets the product page lead with its name in the document title', () => {
    // #given a page with a document title
    // #when the head is built
    const head = build(PRODUCT);

    // #then it replaces the page-then-product form
    expect(head).toContain('<title>Conduit: cross-chain delivery versus payment</title>');
  });

  it('uses the same words for the social title of the product page', () => {
    // #given a page with a document title
    // #when the head is built
    const head = build(PRODUCT);

    // #then og:title matches it
    expect(content(head, 'og:title')).toBe('Conduit: cross-chain delivery versus payment');
  });

  it('falls back to the product descriptor when a page has no description', () => {
    // #given a page without a description
    // #when the head is built
    const head = build({ title: 'A', path: '/a' });

    // #then the descriptor is used
    expect(content(head, 'description')).toBe(
      'Cross-chain delivery versus payment for verified assets.',
    );
  });

  it('keeps error pages out of the index', () => {
    // #given a page with no path, as an error page has
    // #when the head is built
    const head = build({ title: 'Not found' });

    // #then it asks not to be indexed
    expect(content(head, 'robots')).toBe('noindex');
  });

  it('gives error pages no address', () => {
    // #given a page with no path
    // #when the head is built
    const head = build({ title: 'Not found' });

    // #then there is no canonical link and no og:url
    expect([links(head, 'canonical').length, content(head, 'og:url')]).toEqual([0, undefined]);
  });

  it('leaves out every tag that needs an absolute URL when no site is configured', () => {
    // #given no site
    setSite(undefined);

    // #when a page with a path is described
    const head = headTags({ title: 'A', path: '/x' });

    // #then nothing is written relative
    expect([
      links(head, 'canonical').length,
      content(head, 'og:url'),
      content(head, 'og:image'),
      content(head, 'twitter:image'),
    ]).toEqual([0, undefined, undefined, undefined]);
  });

  it('falls back to the small Twitter card when there is no absolute image', () => {
    // #given no site
    setSite(undefined);

    // #when a page is described
    const head = headTags({ title: 'A', path: '/x' });

    // #then the large card is not requested without an image
    expect(content(head, 'twitter:card')).toBe('summary');
  });

  it('still writes what does not depend on the origin when no site is configured', () => {
    // #given no site
    setSite(undefined);

    // #when a page is described
    const head = headTags({ title: 'A', path: '/x' });

    // #then the description and the manifest link remain
    expect([content(head, 'description') !== undefined, links(head, 'manifest').length]).toEqual([
      true,
      1,
    ]);
  });

  it('escapes anything that could close an attribute or a tag', () => {
    // #given a hostile title, description and path
    const hostile = `"><script>alert(1)</script>`;

    // #when the head is built
    const head = build({ title: hostile, description: hostile, path: `/x"${hostile}` });

    // #then no script element exists in the output
    expect(head).not.toContain('<script>');
  });

  it('keeps hostile text readable after escaping, so nothing is lost', () => {
    // #given a hostile description
    const hostile = `"><script>alert(1)</script>`;

    // #when the head is built and read back through a parser
    const head = build({ title: 'A', description: hostile, path: '/x' });

    // #then the value round-trips
    expect(content(head, 'description')).toBe(hostile);
  });
});

describe('the card the tags point at', () => {
  it('is the card in the brand kit, byte for byte', () => {
    // #given the card embedded in the Worker and the one in the kit
    const card = IMAGES['brand-og.png'];
    const kit = readFileSync(join(ROOT, 'brand', 'social', 'conduit-og-1200x630.png'));

    // #when they are compared
    const same = Buffer.from(card?.base64 ?? '', 'base64').equals(kit);

    // #then there is one card
    expect(same).toBe(true);
  });

  it('has the size the tags claim', () => {
    // #given the embedded card
    const card = IMAGES['brand-og.png'];
    const bytes = Buffer.from(card?.base64 ?? '', 'base64');

    // #when its PNG header is read
    const size = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

    // #then it is the 1200 by 630 the tags state
    expect(size).toEqual([card?.width, card?.height]);
  });

  it('sits at a content-hashed path, so a changed card is a new URL', () => {
    // #given the card
    // #when its path is read
    const path = IMAGES['brand-og.png']?.path;

    // #then the path carries a hash of the bytes
    expect(path).toMatch(/^\/assets\/conduit-og\.[0-9a-f]{12}\.png$/);
  });
});

describe('the SITE_URL the Worker is deployed with', () => {
  const toml = readFileSync(join(ROOT, 'apps', 'web', 'wrangler.toml'), 'utf8');
  const declared = /^SITE_URL\s*=\s*"([^"]*)"/m.exec(toml)?.[1];

  it('is declared in wrangler.toml and not blank', () => {
    // #given the deployment configuration
    // #when the variable is read
    const value = declared ?? '';

    // #then it is there, because without it every page loses its canonical link
    expect(value).not.toBe('');
  });

  it('is accepted by the head, so a typo fails here and not on the first request', () => {
    // #given the declared value
    // #when it is handed to the head
    const accept = (): void => {
      setSite(declared);
    };

    // #then it is an origin the head takes
    expect(accept).not.toThrow();
  });

  it('is an https origin', () => {
    // #given the declared value
    // #when its scheme is read
    // #then the product announces itself over https
    expect(declared).toMatch(/^https:\/\/[^/]+$/);
  });
});

describe('the head and brand.json', () => {
  interface Identity {
    colour: { paper: { value: string } };
    concept: { tagline: string; descriptor: string };
  }

  const identity = JSON.parse(readFileSync(join(ROOT, 'brand', 'brand.json'), 'utf8')) as Identity;

  it('describes the product in the descriptor the brand approved', () => {
    // #given a page with no description of its own
    const head = build({ title: 'A', path: '/a' });

    // #when its description is read
    const description = content(head, 'description');

    // #then it is the descriptor in brand.json
    expect(description).toBe(identity.concept.descriptor);
  });

  it('gives the card the tagline and the descriptor as its alternative text', () => {
    // #given any page
    const head = build();

    // #when the card's alternative text is read
    const alt = content(head, 'og:image:alt');

    // #then it is the product name, the tagline and the descriptor from brand.json
    expect(alt).toBe(`Conduit. ${identity.concept.tagline} ${identity.concept.descriptor}`);
  });

  it('colours the browser chrome with the paper of the brand', () => {
    // #given any page
    const head = build();

    // #when the theme colour is read
    const colour = content(head, 'theme-color');

    // #then it is the paper value in brand.json
    expect(colour).toBe(identity.colour.paper.value);
  });
});

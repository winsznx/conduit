/**
 * What a page tells browsers, search engines and link-preview crawlers about itself.
 *
 * Three audiences read the same few tags, and they read them without running any
 * JavaScript: a crawler fetches the HTML, takes what is in `<head>`, and leaves. So
 * everything here is server-rendered, absolute where a crawler needs it to be, and
 * escaped, because several of these values are built from identifiers in the URL.
 *
 * ## Why each page names its own path
 *
 * The canonical URL and `og:url` need the page's path, and the obvious source is the
 * request. It is also the wrong one. A Worker isolate serves many requests at once, so
 * anything written to module state per request can be read back by a different request
 * that interleaves with it, and a settlement page would then announce another page's
 * address. The origin is safe to hold in module state, because it comes from the
 * deployment's configuration and is the same for every request. The path is not, so the
 * page that knows what it is says where it lives.
 */

import { IMAGES } from './image-manifest.js';
import { esc } from './ui.js';

export interface PageMeta {
  /** The page's own name. The document title appends the site name. */
  readonly title: string;
  /** One or two plain sentences. Falls back to the product descriptor. */
  readonly description?: string;
  /**
   * Where the page lives on the canonical origin, beginning with a slash.
   *
   * Absent on error pages: a 404 is not a canonical anything, and telling a search
   * engine otherwise indexes the failure.
   */
  readonly path?: string;
  /** For the one page that is the product itself and should lead with its name. */
  readonly documentTitle?: string;
}

export const SITE_NAME = 'Conduit';
export const DESCRIPTOR = 'Cross-chain delivery versus payment for verified assets.';

/** The page ground. The product is light only, so the browser chrome follows it. */
const THEME_COLOUR = '#ffffff';

/** What the link card shows, for anyone who cannot see it. */
const CARD_ALT =
  'Conduit. Two chains. One commitment. Cross-chain delivery versus payment for verified assets.';

let origin: string | undefined;

/**
 * The canonical origin, from the deployment's configuration.
 *
 * Module state, and safe the same way `setDeployment` is: it is derived from `env`, so
 * every request an isolate will ever serve sets the same value.
 *
 * Absent, the tags that need an absolute URL are left out rather than written
 * relative. A crawler ignores a relative `og:image`, and a tag that looks present and
 * does nothing is worse than one that is missing.
 *
 * A malformed value throws. It can only come from the deploy configuration, and a loud
 * failure on the first request is better than a site that quietly announces itself
 * at the wrong address.
 */
export function setSite(value: string | undefined): void {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') {
    origin = undefined;
    return;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (cause) {
    throw new Error(`SITE_URL must be an http or https URL, got ${trimmed}`, { cause });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`SITE_URL must be an http or https URL, got ${trimmed}`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`SITE_URL must be an origin with no path, query or fragment, got ${trimmed}`);
  }
  origin = url.origin;
}

function absolute(path: string): string | undefined {
  return origin === undefined ? undefined : `${origin}${path}`;
}

const meta = (attribute: 'name' | 'property', key: string, value: string): string =>
  `<meta ${attribute}="${key}" content="${esc(value)}">`;

/**
 * The title, description, icons, canonical link, Open Graph and Twitter tags.
 *
 * The icon links use fixed root paths on purpose. Browsers and the web manifest ask for
 * `/favicon.ico` and `/icon-192.png` by name, so those URLs are part of the contract,
 * and the Worker serves them (see `BRAND_ROOT_FILES`).
 */
export function headTags(page: PageMeta): string {
  const documentTitle = page.documentTitle ?? `${page.title} | ${SITE_NAME}`;
  const socialTitle = page.documentTitle ?? page.title;
  const given = page.description?.trim() ?? '';
  const description = given === '' ? DESCRIPTOR : given;
  const url = page.path === undefined ? undefined : absolute(page.path);

  const card = IMAGES['brand-og.png'];
  const image = card === undefined ? undefined : absolute(card.path);

  const tags: string[] = [
    meta('name', 'theme-color', THEME_COLOUR),
    `<title>${esc(documentTitle)}</title>`,
    meta('name', 'description', description),
  ];

  if (url !== undefined) tags.push(`<link rel="canonical" href="${esc(url)}">`);
  if (page.path === undefined) tags.push(meta('name', 'robots', 'noindex'));

  tags.push(
    '<link rel="icon" href="/favicon.ico" sizes="32x32">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
    '<link rel="manifest" href="/site.webmanifest">',
    meta('property', 'og:site_name', SITE_NAME),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:title', socialTitle),
    meta('property', 'og:description', description),
  );
  if (url !== undefined) tags.push(meta('property', 'og:url', url));

  if (card !== undefined && image !== undefined) {
    tags.push(
      meta('property', 'og:image', image),
      meta('property', 'og:image:type', card.type),
      meta('property', 'og:image:width', String(card.width)),
      meta('property', 'og:image:height', String(card.height)),
      meta('property', 'og:image:alt', CARD_ALT),
    );
  }

  tags.push(
    meta('name', 'twitter:card', image === undefined ? 'summary' : 'summary_large_image'),
    meta('name', 'twitter:title', socialTitle),
    meta('name', 'twitter:description', description),
  );
  if (image !== undefined) {
    tags.push(meta('name', 'twitter:image', image), meta('name', 'twitter:image:alt', CARD_ALT));
  }

  return tags.join('\n');
}

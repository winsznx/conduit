import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOCKUP_INLINE } from './brand-manifest.js';
import { sidebar, wordmark } from './components.js';
import { STYLESHEET } from './theme.js';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MASTER = readFileSync(join(ROOT, 'brand', 'source', 'conduit-lockup-horizontal.svg'), 'utf8');

const EMBER = '#e7000b';
const HOME_LABEL = 'Conduit, back to the home page';

interface Tag {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
}

/** An opening tag as a name and an attribute map, so tests read markup rather than match strings. */
function parseTag(tag: string): Tag {
  const match = /^<([a-z]+)([^>]*)>/.exec(tag);
  const attributes: Record<string, string> = {};
  for (const pair of (match?.[2] ?? '').matchAll(/([a-z-]+)="([^"]*)"/g)) {
    attributes[pair[1] ?? ''] = pair[2] ?? '';
  }
  return { name: match?.[1] ?? '', attributes };
}

const contentOf = (markup: string): string | undefined =>
  /^<([a-z]+)[^>]*>([\s\S]*)<\/\1>$/.exec(markup)?.[2];

const occurrences = (whole: string, part: string): number => whole.split(part).length - 1;

/** The master and the inline copy differ in every attribute around the paths, so only `d` is compared. */
const pathData = (svg: string): string[] =>
  [...svg.matchAll(/\sd="([^"]+)"/g)].map((match) => match[1] ?? '');

/** A grey has equal channels, so any colour whose channels differ is a hue, and Ember must be the only one. */
function chromaticHexes(markup: string): string[] {
  return (markup.match(/#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/gi) ?? [])
    .map((hex) => hex.toLowerCase())
    .filter((hex) => {
      const channels = hex.slice(1).match(hex.length === 4 ? /./g : /../g) ?? [];
      return new Set(channels).size > 1;
    });
}

/** Matches the whole selector, because `.identity .lockup` is also the tail of the header and footer ones. */
function declarations(selector: string): readonly string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?:^|[{}])${escaped}\\{([^}]*)\\}`).exec(STYLESHEET);
  return rule?.[1]?.split(';') ?? [];
}

/** What sits between the braces of the first `@media` block with this query. */
function mediaBlock(query: string): string {
  const open = STYLESHEET.indexOf('{', STYLESHEET.indexOf(`@media ${query}{`));
  let depth = 0;
  for (let index = open; index < STYLESHEET.length; index += 1) {
    if (STYLESHEET[index] === '{') depth += 1;
    if (STYLESHEET[index] === '}') depth -= 1;
    if (depth === 0) return STYLESHEET.slice(open + 1, index);
  }
  return '';
}

describe('wordmark', () => {
  it('is a link home, named for where it goes, when linked', () => {
    // #given the wordmark as the console sidebar draws it
    // #when its opening tag is read
    const tag = parseTag(wordmark(true));

    // #then it is an anchor to the home page
    expect(tag).toEqual({
      name: 'a',
      attributes: { class: 'identity', href: '/', 'aria-label': HOME_LABEL },
    });
  });

  it('is an image named Conduit, and not a link, when unlinked', () => {
    // #given the wordmark as the landing header and footer draw it
    // #when its opening tag is read
    const tag = parseTag(wordmark(false));

    // #then it is a labelled image
    expect(tag).toEqual({
      name: 'span',
      attributes: { class: 'identity', role: 'img', 'aria-label': 'Conduit' },
    });
  });

  it('is unlinked by default, which is how the landing asks for it', () => {
    // #given a call with no argument
    // #when the wordmark is drawn
    const markup = wordmark();

    // #then it is the unlinked one
    expect(markup).toBe(wordmark(false));
  });

  describe.each([
    ['linked', true],
    ['unlinked', false],
  ] as const)('the %s wordmark', (_name, linked) => {
    const markup = wordmark(linked);

    it('draws the lockup exactly once', () => {
      // #given the wordmark
      // #when the lockup is counted
      const count = occurrences(markup, LOCKUP_INLINE);

      // #then it is there once
      expect(count).toBe(1);
    });

    it('holds nothing but the lockup inside its wrapper', () => {
      // #given the wordmark
      // #when the wrapper is opened
      const inner = contentOf(markup);

      // #then the lockup is all that is in it
      expect(inner).toBe(LOCKUP_INLINE);
    });

    it('draws no text element, so it needs no font', () => {
      // #given the wordmark
      // #when it is searched for SVG text
      // #then there is none, because the lettering is outlined
      expect(markup).not.toContain('<text');
    });

    it('carries no id, so two on one page cannot collide', () => {
      // #given the wordmark, which the landing draws twice
      // #when it is searched for an id attribute
      // #then there is none
      expect(markup).not.toMatch(/\sid=/);
    });

    it('leaves out the old bold text span', () => {
      // #given the wordmark
      // #when it is searched for the weight the old span set
      // #then it is gone
      expect(markup).not.toContain('font-weight');
    });

    it('carries the Ember point once and no other chromatic colour', () => {
      // #given the wordmark
      // #when its colours are read
      const chromatic = chromaticHexes(markup);

      // #then the point is the only one
      expect(chromatic).toEqual([EMBER]);
    });
  });
});

describe('the inlined lockup', () => {
  it('hides its artwork from assistive technology, so the name is read once', () => {
    // #given the lockup
    // #when its root element is read
    const root = parseTag(LOCKUP_INLINE);

    // #then it is hidden, and the wrapper carries the name
    expect(root.attributes['aria-hidden']).toBe('true');
  });

  it('finds path data in the master, so the comparison below cannot pass on nothing', () => {
    // #given the master lockup in the brand kit
    // #when its path data is read
    const paths = pathData(MASTER);

    // #then there is something to compare
    expect(paths.length).toBeGreaterThan(0);
  });

  it('carries exactly the path data of the master, so the page cannot drift from it', () => {
    // #given the master lockup in the brand kit
    // #when the paths of the inline copy are read
    const inline = pathData(LOCKUP_INLINE);

    // #then they are the master's, in order
    expect(inline).toEqual(pathData(MASTER));
  });
});

describe('sidebar', () => {
  it('has one identity element, and it is the link home', () => {
    // #given the sidebar for the console overview
    const html = sidebar('/app');

    // #when every identity element is read
    const identities = [...html.matchAll(/<[a-z]+\s[^>]*\bclass="identity"[^>]*>/g)].map((match) =>
      parseTag(match[0]),
    );

    // #then there is one and it is the anchor
    expect(identities).toEqual([
      { name: 'a', attributes: { class: 'identity', href: '/', 'aria-label': HOME_LABEL } },
    ]);
  });

  it('carries the Ember point once and no other chromatic colour', () => {
    // #given the sidebar for the console overview
    const html = sidebar('/app');

    // #when its colours are read
    const chromatic = chromaticHexes(html);

    // #then the point in the lockup is the only one, as the brand allows once per surface
    expect(chromatic).toEqual([EMBER]);
  });
});

describe('the stylesheet, for the lockup', () => {
  it.each([
    ['.identity .lockup', 'height:20px'],
    ['.landing-nav .identity .lockup', 'height:26px'],
    ['.landing-foot .identity .lockup', 'height:24px'],
  ])('sizes %s with %s', (selector, height) => {
    // #given the generated stylesheet
    // #when the rule for the selector is read
    const rule = declarations(selector);

    // #then it states the height for that surface
    expect(rule).toContain(height);
  });

  it('lets the viewBox set the width, and keeps a crowded row from squeezing the lockup', () => {
    // #given the generated stylesheet
    // #when the base lockup rule is read
    const rule = declarations('.identity .lockup');

    // #then it is a block with an automatic width that does not shrink
    expect(rule).toEqual(expect.arrayContaining(['display:block', 'width:auto', 'flex:none']));
  });

  it('steps the header lockup down below 360px, where it would meet the console button', () => {
    // #given the rules the stylesheet applies below 360px
    const narrow = mediaBlock('(max-width:359px)');

    // #when the header lockup's rule is found among them
    const rule = /(?:^|\})\.landing-nav \.identity \.lockup\{([^}]*)\}/.exec(narrow)?.[1];

    // #then it is the 22px lockup, whatever else the block holds
    expect(rule).toBe('height:22px');
  });

  it('leaves a hovered identity link undecorated', () => {
    // #given the generated stylesheet
    // #when the hover rule for the identity link is read
    const rule = declarations('a.identity:hover');

    // #then it has no underline
    expect(rule).toContain('text-decoration:none');
  });

  it('no longer underlines a span inside a hovered identity link', () => {
    // #given the generated stylesheet
    // #when it is searched for the old span rule
    // #then it is gone, because the link holds an SVG and no span
    expect(STYLESHEET).not.toContain('a.identity:hover span');
  });

  it('shows keyboard focus on the identity link as a 2px ink outline with room around the artwork', () => {
    // #given the generated stylesheet
    // #when the focus rule for the identity link is read
    const rule = declarations('a.identity:focus-visible');

    // #then it is a 2px ink outline with room around the artwork
    expect(rule).toEqual(
      expect.arrayContaining(['outline:2px solid var(--color-ink)', 'outline-offset:4px']),
    );
  });

  it('removes the page-wide focus ring from the identity link, so the two do not stack', () => {
    // #given the generated stylesheet
    // #when the focus rule for the identity link is read
    const rule = declarations('a.identity:focus-visible');

    // #then the box-shadow ring is switched off
    expect(rule).toContain('box-shadow:none');
  });
});

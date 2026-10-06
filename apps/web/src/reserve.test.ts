import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Totals } from './data.js';
import { renderLanding, renderOverview, renderSettlements } from './pages.js';
import {
  OVERVIEW_LEAD_GAP,
  OVERVIEW_RESERVE,
  RESERVE_RELEASE,
  STYLESHEET,
  WELCOME_RESERVE,
} from './theme.js';

const TOTALS: Totals = { settlements: 0, held: 0, messages: 0, verifications: 0, generations: 1 };
const RELEASE_DEADLINE_MS = 5000;

function overview(welcomed = false): string {
  return renderOverview('Generation 3', TOTALS, [], welcomed);
}

function head(html: string): string {
  const end = html.indexOf('</head>');
  expect(end).toBeGreaterThan(-1);
  return html.slice(0, end);
}

describe('the space the overview holds for its script', () => {
  it('marks the onboarding host as holding space for a visitor not yet welcomed', () => {
    // #given the overview as the server renders it for a visitor with no cookie
    const html = overview(false);

    // #then the onboarding host carries the reserve class
    expect(html).toMatch(/<div class="reserve" data-onboarding[ >]/);
  });

  it('leaves the onboarding host without the reserve class for a welcomed visitor', () => {
    // #given the overview as the server renders it for a visitor carrying the cookie
    const html = overview(true);

    // #then the onboarding host is a plain empty div
    expect(html).toMatch(/<div data-onboarding[ >]/);
  });

  it('marks the personal overview host as holding space', () => {
    // #given the overview as the server renders it
    const html = overview(false);

    // #then the personal overview host carries the reserve class
    expect(html).toContain('<div class="reserve" data-overview></div>');
  });

  it('keeps the personal overview reserve for a welcomed visitor', () => {
    // #given the overview rendered for a visitor carrying the cookie
    const html = overview(true);

    // #then the personal overview host still holds its space, because a wallet may yet connect
    expect(html).toContain('<div class="reserve" data-overview></div>');
  });

  it('holds the welcome space by default, because a missing answer must not drop it', () => {
    // #given the overview rendered with no answer about the visitor
    const html = renderOverview('Generation 3', TOTALS, []);

    // #then the onboarding host holds its space
    expect(html).toMatch(/<div class="reserve" data-onboarding[ >]/);
  });

  it('releases the space in a noscript style when JavaScript is off', () => {
    // #given the overview as the server renders it
    const html = overview();

    // #then a noscript block carries the rule that gives the space back
    expect(html).toContain(`<noscript><style>${RESERVE_RELEASE}</style></noscript>`);
  });

  it('keeps the noscript rule out of the stylesheet, where it would apply to everyone', () => {
    // #given the stylesheet every page carries
    // #then the release rule is not in it
    expect(STYLESHEET).not.toContain(RESERVE_RELEASE);
  });

  it('loads the script once on the overview', () => {
    // #given the overview as the server renders it
    const html = overview();

    // #when the script tags are counted
    const tags = html.match(/<script type="module"[^>]*>/g) ?? [];

    // #then there is one
    expect(tags).toHaveLength(1);
  });

  it('puts the overview script after the content, where every other page puts it', () => {
    // #given the overview as the server renders it
    const html = overview();
    const script = html.indexOf('<script type="module"');
    const content = html.indexOf('</main>');

    // #when the position of the script is compared with the end of the content
    // #then both were found and the script is last
    expect([script, content].every((index) => index !== -1) && script > content).toBe(true);
  });

  it('keeps every script out of the head of the overview', () => {
    // #given the overview as the server renders it
    // #then nothing before the head closes is a script
    expect(head(overview())).not.toContain('<script');
  });

  it.each([
    ['the overview for a new visitor', () => overview(false)],
    ['the overview for a welcomed visitor', () => overview(true)],
    ['the settlements list', () => renderSettlements('Generation 3', [])],
    ['the landing', () => renderLanding(undefined, [])],
  ])('never asks the browser to hold the first paint on %s', (_page, render) => {
    // #given a page
    // #then no element carries a blocking attribute
    expect(render()).not.toContain('blocking=');
  });
});

describe('the reserve stylesheet', () => {
  it('holds the first-visit card height from the widest step up', () => {
    // #given the last step of the welcome table
    const [minWidth, height] = WELCOME_RESERVE.at(-1) ?? [0, 0];

    // #then the stylesheet has a media rule with exactly that height
    expect(STYLESHEET).toContain(
      `@media (min-width:${String(minWidth)}px){[data-onboarding].reserve{min-height:${String(height)}px}}`,
    );
  });

  it('holds the widest-wrapping paragraph on the narrowest screens', () => {
    // #given the first step of the overview table
    const [, lines] = OVERVIEW_RESERVE[0] ?? [0, 0];

    // #then the base rule is that many caption lines
    expect(STYLESHEET).toContain(
      `[data-overview].reserve{min-height:calc(var(--text-caption) * var(--leading-caption) * ${String(lines)})}`,
    );
  });

  it('lists welcome steps in ascending width, because the later rule wins', () => {
    // #given the welcome table
    const widths = WELCOME_RESERVE.map(([minWidth]) => minWidth);

    // #then each width is greater than the one before
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  it('lists overview steps in ascending width, because the later rule wins', () => {
    // #given the overview table
    const widths = OVERVIEW_RESERVE.map(([minWidth]) => minWidth);

    // #then each width is greater than the one before
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  it('starts every table at width zero so no screen is without a rule', () => {
    // #given both tables
    // #then each begins at zero
    expect([WELCOME_RESERVE[0]?.[0], OVERVIEW_RESERVE[0]?.[0]]).toEqual([0, 0]);
  });

  it('gives the space back by itself within the deadline when the script never runs', () => {
    // #given the fallback animation in the stylesheet
    const delay = /\.reserve\{animation:reserve-release 1ms linear (\d+)s forwards\}/.exec(
      STYLESHEET,
    );

    // #then it starts before the deadline
    expect(Number(delay?.[1]) * 1000).toBeLessThan(RELEASE_DEADLINE_MS);
  });

  it('ends the fallback animation at no height, width or lead gap', () => {
    // #given the keyframes
    // #then they finish at zero on every property a reserve sets
    expect(STYLESHEET).toContain(
      '@keyframes reserve-release{to{min-height:0;min-width:0;margin-top:0}}',
    );
  });
});

describe('the footprint of the position paragraph', () => {
  it('gives the empty personal overview the gap its paragraph will bring', () => {
    // #given the stylesheet
    // #then the empty host takes the paragraph's top margin, so the section below does not move
    expect(STYLESHEET).toContain(`[data-overview].reserve:empty{margin-top:${OVERVIEW_LEAD_GAP}}`);
  });

  it('matches the margin the browser script puts on that paragraph', () => {
    // #given the script that builds the paragraph
    const source = readFileSync(join(import.meta.dirname, 'client', 'overview.ts'), 'utf8');

    // #then it sets the same margin the empty host holds
    expect(source).toContain(`line.style.marginTop = '${OVERVIEW_LEAD_GAP}';`);
  });

  it('drops the gap in the noscript release too', () => {
    // #given the rule a visitor without scripting receives
    // #then it zeroes the margin as well as the height
    expect(RESERVE_RELEASE).toContain('margin-top:0!important');
  });
});

describe('the shell hosts the script fills on every console page', () => {
  it('holds the width of the Connect button in the empty participant slot', () => {
    // #given the stylesheet
    // #then an empty participant slot has a minimum width
    expect(STYLESHEET).toMatch(/\[data-participant\]:empty\{min-width:\d+px\}/);
  });

  it('holds the height of the status line in the sidebar footer, where the sidebar is a column', () => {
    // #given the stylesheet
    // #then the footer reserve exists only from 1025px, above the width where the sidebar is a strip
    expect(STYLESHEET).toMatch(
      /@media \(min-width:1025px\)\{\[data-identity-strip\]:has\(>noscript\)\{min-height:\d+px\}\}/,
    );
  });

  it('holds the footer space only while the noscript note is its child', () => {
    // #given the footer selector
    // #then it matches only while the server's noscript child is still there
    expect(STYLESHEET).toContain('[data-identity-strip]:has(>noscript)');
  });

  it('gives both back by themselves when the script never runs', () => {
    // #given the stylesheet
    // #then the fallback animation covers the participant slot and the footer
    expect(STYLESHEET).toMatch(
      /\[data-participant\]:empty,\[data-identity-strip\]:has\(>noscript\)\{animation:reserve-release 1ms linear \d+s forwards\}/,
    );
  });

  it('releases both at once when JavaScript is off, on a page that is not the overview', () => {
    // #given a console page that is not the overview
    const html = renderSettlements('Generation 3', []);

    // #then its head carries the noscript release
    expect(head(html)).toContain(`<noscript><style>${RESERVE_RELEASE}</style></noscript>`);
  });

  it('includes both hosts in the noscript release', () => {
    // #given the release rule
    // #then it reaches the participant slot and the footer
    expect(RESERVE_RELEASE).toContain(
      '[data-participant]:empty,[data-identity-strip]:has(>noscript)',
    );
  });
});

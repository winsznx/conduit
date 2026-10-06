import { describe, expect, it } from 'vitest';

import { STYLESHEET } from './theme.js';

/** Matches the whole selector, so `.field:focus` is not found inside a longer one. */
function declarations(selector: string): readonly string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?:^|[{}])${escaped}\\{([^}]*)\\}`).exec(STYLESHEET);
  return rule?.[1]?.split(';') ?? [];
}

/**
 * What sits between the braces of the last `@media` block with this query. The nav links
 * have a one-line 1024px block of their own earlier on, and the responsive block is last.
 */
function mediaBlock(query: string): string {
  const open = STYLESHEET.indexOf('{', STYLESHEET.lastIndexOf(`@media ${query}{`));
  let depth = 0;
  for (let index = open; index < STYLESHEET.length; index += 1) {
    if (STYLESHEET[index] === '{') depth += 1;
    if (STYLESHEET[index] === '}') depth -= 1;
    if (depth === 0) return STYLESHEET.slice(open + 1, index);
  }
  return '';
}

const RING = 'box-shadow:0 0 0 1px var(--color-paper),0 0 0 3px var(--color-ink)';

describe('the focus ring in forced-colors mode', () => {
  it('keeps a transparent outline on every focused element, because box-shadow is dropped there', () => {
    // #given the page-wide focus rule
    // #when its declarations are read
    const rule = declarations(':focus-visible');

    // #then the outline is transparent, which forced-colors mode repaints
    expect(rule).toContain('outline:2px solid transparent');
  });

  it('does not remove the outline on a focused element', () => {
    // #given the page-wide focus rule
    // #when its declarations are read
    const rule = declarations(':focus-visible');

    // #then outline:none is gone
    expect(rule).not.toContain('outline:none');
  });

  it('keeps a transparent outline on a focused input', () => {
    // #given the input focus rule
    // #when its declarations are read
    const rule = declarations('.field:focus');

    // #then the outline is transparent
    expect(rule).toContain('outline:2px solid transparent');
  });
});

describe('the current-page sidebar link', () => {
  it('draws the focus ring, because the hairline rule out-ranks the page-wide one', () => {
    // #given the focus rule for the current link
    // #when its declarations are read
    const rule = declarations('.nav a[aria-current="page"]:focus-visible');

    // #then the ring is declared on it
    expect(rule).toContain(RING);
  });
});

describe('the sidebar strip under 1024px', () => {
  it('pads the scroll edge by the strip inset so a scrolled-in ring is not clipped', () => {
    // #given the 1024px media block
    // #when it is read
    const block = mediaBlock('(max-width:1024px)');

    // #then the strip declares scroll padding on the inline axis
    expect(block).toContain('scroll-padding-inline:var(--spacing-12)');
  });
});

describe('the skip link', () => {
  it('is clipped rather than removed until it has focus, so it stays focusable', () => {
    // #given the resting rule
    // #when its declarations are read
    const rule = declarations('.skip-link');

    // #then it uses the clip technique
    expect(rule).toContain('clip:rect(0 0 0 0)');
  });

  it('is never display:none', () => {
    // #given the resting rule
    // #when its declarations are read
    const rule = declarations('.skip-link');

    // #then it stays in the accessibility tree and the tab order
    expect(rule).not.toContain('display:none');
  });

  it('shows fixed at the top left on focus, so nothing moves', () => {
    // #given the focused rule
    // #when its declarations are read
    const rule = declarations('.skip-link:focus');

    // #then it is fixed and unclipped
    expect(rule).toEqual(expect.arrayContaining(['position:fixed', 'clip:auto']));
  });

  it('sits above the sticky headers, the activity tray and the modal root', () => {
    // #given the focused rule
    // #when its z-index is read
    const zIndex = declarations('.skip-link:focus').find((line) => line.startsWith('z-index:'));

    // #then it is above 50, the highest layer the page uses
    expect(Number(zIndex?.slice('z-index:'.length))).toBeGreaterThan(50);
  });
});

describe('the main landmark', () => {
  it('shows no ring when the skip link moves focus into it', () => {
    // #given the rule for a focused main
    // #when its declarations are read
    const rule = declarations('main:focus');

    // #then the ring is suppressed
    expect(rule).toEqual(['outline:none', 'box-shadow:none']);
  });
});

describe('the dimmed mechanism steps', () => {
  it('stay at opacity .8 or above, so grey text keeps 4.5:1 contrast on white', () => {
    // #given the mechanism step rule
    // #when its opacity is read
    const opacity = declarations('.mech-step').find((line) => line.startsWith('opacity:'));

    // #then it is .8
    expect(opacity).toBe('opacity:.8');
  });
});

describe('the table header', () => {
  it('contains a visually hidden label, so a wide table does not widen the page', () => {
    // #given the table header rule
    // #when its declarations are read
    const rule = declarations('.table th');

    // #then it is the containing block for an absolutely positioned label
    expect(rule).toContain('position:relative');
  });
});

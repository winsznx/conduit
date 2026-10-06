/**
 * The console as a keyboard, a screen reader and a forced-colors display meet it.
 *
 * `pages.test.ts` and `theme.test.ts` prove the markup and the rules exist. This proves
 * they do their job in a browser: Tab reaches the skip link first and Enter lands in the
 * page, a focused control is visible when box-shadow is forced off, the sidebar strip
 * scrolls a focused link fully into view, and the dimmed steps of the mechanism still
 * read at 4.5:1.
 *
 * Every request is a GET and every visit is a read, so it is safe against any
 * `WEB_BASE_URL`, including one that shares a database with production.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe.configure({ timeout: 60_000 });

/** A settlement the projection and the proof pages both know. */
const SETTLEMENT_ID = '0xc113ad335d202d985d527b0a193498ef2ecceb9a129a58c5002943c88601a3b0';

const WCAG_BODY_CONTRAST = 4.5;

/** The ring is 3px, and a ring cut by the edge of the strip is a ring the reader cannot see. */
const RING = 3;
const TOLERANCE = 1;

const MAX_TABS = 80;

const PAGES = [
  { name: 'landing', path: '/' },
  { name: 'overview', path: '/app' },
  { name: 'settlements', path: '/app/settlements' },
  { name: 'settlement', path: `/app/settlements/${SETTLEMENT_ID}` },
  { name: 'verification', path: `/verify/${SETTLEMENT_ID}` },
  { name: 'evidence', path: `/evidence/${SETTLEMENT_ID}` },
  { name: 'not found', path: '/no-such-page' },
] as const;

/** Presses Tab until the locator holds focus, so :focus-visible matches the way a keyboard user gets it. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < MAX_TABS; presses += 1) {
    await page.keyboard.press('Tab');
    const focused = await target.evaluate((element) => element === document.activeElement);
    if (focused) return;
  }
  throw new Error(`Tab never reached the element within ${String(MAX_TABS)} presses`);
}

for (const { name, path } of PAGES) {
  test(`${name}: has one main landmark`, async ({ page }) => {
    // #given a page
    await page.goto(path);

    // #when its main landmarks are counted
    const landmarks = await page.locator('main, [role="main"]').count();

    // #then there is one
    expect(landmarks).toBe(1);
  });

  test(`${name}: the skip link is first in the tab order and moves focus into main`, async ({
    page,
  }) => {
    // #given a loaded page with nothing focused
    await page.goto(path);

    // #when a reader tabs once and presses Enter
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => document.activeElement?.className);
    await page.keyboard.press('Enter');
    const landed = await page.evaluate(() => ({
      tag: document.activeElement?.tagName,
      id: document.activeElement?.id,
    }));

    // #then the first stop was the skip link and focus is now on main
    expect({ first, landed }).toEqual({
      first: 'skip-link',
      landed: { tag: 'MAIN', id: 'content' },
    });
  });
}

test('the 404 page has exactly one h1', async ({ page }) => {
  // #given the not-found page
  await page.goto('/no-such-page');

  // #when its h1 elements are counted
  const headings = await page.locator('h1').count();

  // #then there is one
  expect(headings).toBe(1);
});

for (const path of ['/app', '/app/settlements']) {
  test(`${path}: no table header is empty`, async ({ page }) => {
    // #given a page that lists settlements
    await page.goto(path);

    // #when the headers with no text of their own are counted
    const headers = await page.locator('th').evaluateAll((cells) => ({
      total: cells.length,
      empty: cells.filter((cell) => cell.textContent.trim() === '').length,
    }));

    // #then the table exists and none is empty
    expect({ hasHeaders: headers.total > 0, empty: headers.empty }).toEqual({
      hasHeaders: true,
      empty: 0,
    });
  });
}

for (const path of ['/app', '/app/settlements']) {
  test(`${path}: the hidden header label does not widen the page on a phone`, async ({ page }) => {
    // #given a phone-width viewport on a page with a wide settlements table
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(path);

    // #when the document width is read
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );

    // #then the page does not scroll sideways
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test.describe('in forced-colors mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/app/settlements');
  });

  const FOCUSABLE = [
    {
      name: 'a nav link',
      target: (page: Page) => page.locator('.nav a:not([aria-current])').first(),
    },
    {
      name: 'the current-page nav link',
      target: (page: Page) => page.locator('.nav a[aria-current="page"]'),
    },
    { name: 'a button', target: (page: Page) => page.locator('.topbar button[type="submit"]') },
    { name: 'an input', target: (page: Page) => page.locator('.topbar input.field') },
  ] as const;

  for (const { name, target } of FOCUSABLE) {
    test(`${name} shows an outline when focused`, async ({ page }) => {
      // #given an element reached by keyboard
      const element = target(page);
      await tabTo(page, element);

      // #when its outline is read
      const painted = await element.evaluate((node) => {
        const style = getComputedStyle(node);
        return style.outlineStyle !== 'none' && style.outlineWidth !== '0px';
      });

      // #then box-shadow is gone but an outline is painted
      expect(painted).toBe(true);
    });
  }
});

test('the current-page nav link shows a different ring focused than unfocused', async ({
  page,
}) => {
  // #given the settlements page with its current link at rest
  await page.goto('/app/settlements');
  const current = page.locator('.nav a[aria-current="page"]');
  const resting = await current.evaluate((node) => getComputedStyle(node).boxShadow);

  // #when a keyboard reader tabs onto it
  await tabTo(page, current);
  const focused = await current.evaluate((node) => getComputedStyle(node).boxShadow);

  // #then the shadow changed
  expect(focused).not.toBe(resting);
});

test.describe('the sidebar strip', () => {
  for (const width of [320, 390, 768, 1024]) {
    test(`keeps every focused link and its ring inside the viewport at ${String(width)}px`, async ({
      page,
    }) => {
      // #given a console page at a width where the sidebar is a scrolling strip
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/app');
      const stops = await page.locator('.sidebar a[href], .sidebar button').count();

      // #when a reader tabs through the whole sidebar
      const edges: { left: number; right: number; inner: number }[] = [];
      for (let presses = 0; presses < MAX_TABS; presses += 1) {
        await page.keyboard.press('Tab');
        const rect = await page.evaluate(() => {
          const active = document.querySelector('.sidebar :focus');
          if (active === null) return undefined;
          const box = active.getBoundingClientRect();
          return { left: box.left, right: box.right, inner: window.innerWidth };
        });
        if (rect !== undefined) edges.push(rect);
        else if (edges.length > 0) break;
      }
      const clipped = edges.filter(
        ({ left, right, inner }) => left - RING < -TOLERANCE || right + RING > inner + TOLERANCE,
      );

      // #then every stop was visited and none, ring included, crosses a viewport edge
      expect({ visited: edges.length, clipped }).toEqual({ visited: stops, clipped: [] });
    });
  }
});

test('the dimmed mechanism steps keep 4.5:1 contrast', async ({ browser }) => {
  // #given the landing page with motion on, because reduced motion shows every step at full opacity
  const context = await browser.newContext({ reducedMotion: 'no-preference' });
  const page = await context.newPage();
  await page.goto('/');
  await page.locator('#mechanism').scrollIntoViewIfNeeded();

  // #when the opacity of every step has stopped changing
  const opacities = () =>
    page.locator('.mech-step').evaluateAll((steps) =>
      steps.map((step) => {
        let opacity = 1;
        for (let node: Element | null = step; node !== null; node = node.parentElement) {
          opacity *= Number(getComputedStyle(node).opacity);
        }
        return opacity;
      }),
    );
  let before = await opacities();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(400);
    const after = await opacities();
    const settled = after.every((value, index) => value === before[index]);
    before = after;
    if (settled) break;
  }

  // #and the text of every step that is not current is read with its colour blended over white
  const ratios = await page.locator('.mech-step:not([data-current])').evaluateAll((steps) => {
    const channel = (value: number): number => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    const found: number[] = [];
    for (const step of steps) {
      let opacity = 1;
      for (let node: Element | null = step; node !== null; node = node.parentElement) {
        opacity *= Number(getComputedStyle(node).opacity);
      }
      const walker = document.createTreeWalker(step, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
        if ((text.textContent ?? '').trim() === '' || text.parentElement === null) continue;
        const [red = 0, green = 0, blue = 0, alpha = 1] = (
          getComputedStyle(text.parentElement).color.match(/[\d.]+/g) ?? []
        ).map(Number);
        const blend = (value: number): number =>
          value * alpha * opacity + 255 * (1 - alpha * opacity);
        const luminance =
          0.2126 * channel(blend(red)) +
          0.7152 * channel(blend(green)) +
          0.0722 * channel(blend(blue));
        found.push(1.05 / (luminance + 0.05));
      }
    }
    return found;
  });
  await context.close();

  // #then there is text to measure and the lowest ratio meets the minimum
  const lowest = ratios.length === 0 ? 0 : Math.min(...ratios);
  expect(lowest).toBeGreaterThanOrEqual(WCAG_BODY_CONTRAST);
});

/**
 * The landing hero, measured at the four viewports it was designed against.
 *
 * These are layout assertions rather than screenshots, because the things that
 * break here break numerically: a column that stops being 45% wide, an image
 * that reserves the wrong box and shifts the page as it loads, a sticky header
 * that changes height when it sticks, or a `sizes` attribute that quietly ships
 * a 1440px picture to a phone.
 *
 * Both device pixel ratios are walked. The whole point of the srcset is that a
 * 2x display gets a different file, and a test that only ever runs at 1x would
 * never notice if it stopped doing that.
 */

import { expect, test, type Browser } from '@playwright/test';

const VIEWPORTS = [
  { label: '1440x900', width: 1440, height: 900, share: 0.528, stacked: false },
  { label: '1280x800', width: 1280, height: 800, share: 0.528, stacked: false },
  { label: '1024x768', width: 1024, height: 768, share: 0.51, stacked: false },
  { label: '390x844', width: 390, height: 844, share: 1, stacked: true },
] as const;

/** What the browser should have chosen, given the box and the pixel ratio. */
const EXPECTED_VARIANT: Readonly<Record<string, string>> = Object.freeze({
  '1440x900@1': 'hero-840',
  '1440x900@2': 'hero-1440',
  '1280x800@1': 'hero-840',
  '1280x800@2': 'hero-1440',
  '1024x768@1': 'hero-560',
  '1024x768@2': 'hero-1120',
  '390x844@1': 'hero-560',
  '390x844@2': 'hero-840',
});

async function open(browser: Browser, width: number, height: number, dpr: number) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
  });
  const page = await context.newPage();
  await page.goto('/', { waitUntil: 'load' });

  // Buffered, so a shift that happened before this ran is still counted.
  await page.evaluate(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as unknown as { value: number; hadRecentInput: boolean };
        if (!shift.hadRecentInput) (window as unknown as { __cls: number }).__cls += shift.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.waitForTimeout(900);
  return { context, page };
}

for (const viewport of VIEWPORTS) {
  for (const dpr of [1, 2]) {
    test(`hero at ${viewport.label} @${String(dpr)}x`, async ({ browser }) => {
      const { context, page } = await open(browser, viewport.width, viewport.height, dpr);

      const measured = await page.evaluate(() => {
        // Narrowed rather than cast: a selector that stops matching should fail
        // by name here, not by reading a property of null three lines later.
        const must = (selector: string, root: ParentNode = document): Element => {
          const found = root.querySelector(selector);
          if (found === null) throw new Error(`missing element: ${selector}`);
          return found;
        };

        const hero = must('.hero');
        const copy = must('.hero-copy');
        const art = must('.hero-mech');
        const nav = must('.landing-nav');

        const img = art.querySelector('img');
        if (img === null) throw new Error('the hero artwork did not render');

        const h = hero.getBoundingClientRect();
        const c = copy.getBoundingClientRect();
        const a = art.getBoundingClientRect();
        const navStyle = getComputedStyle(nav);

        return {
          artShare: a.width / h.width,
          gap: a.left - c.right,
          artCenterY: (a.top + a.bottom) / 2,
          copyCenterY: (c.top + c.bottom) / 2,
          artTop: a.top,
          ctaBottom: must('.hero .actions').getBoundingClientRect().bottom,
          currentSrc: img.currentSrc,
          navPosition: navStyle.position,
          navTop: navStyle.top,
          navZIndex: Number(navStyle.zIndex),
          navBackground: navStyle.backgroundColor,
          navHeight: nav.getBoundingClientRect().height,
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
          cls: (window as unknown as { __cls: number }).__cls,
        };
      });

      // #then the artwork holds the proportion the layout was designed around
      expect(measured.artShare).toBeCloseTo(viewport.share, 1);

      if (viewport.stacked) {
        // #then it falls below the CTA rather than beside it
        expect(measured.artTop).toBeGreaterThan(measured.ctaBottom);
      } else {
        // #then it is centred against the copy, with room between the two
        expect(Math.abs(measured.artCenterY - measured.copyCenterY)).toBeLessThan(2);
        // The gap is the grid gap at minimum: 48px on desktop, 24 on tablet.
        // What matters is that the copy and the mechanism never touch.
        expect(measured.gap).toBeGreaterThanOrEqual(24);
      }

      // #then the browser asked for the file this display actually resolves
      const key = `${viewport.label}@${String(dpr)}`;
      expect(measured.currentSrc).toContain(EXPECTED_VARIANT[key] ?? 'unreachable');

      // #then nothing moved while the picture arrived
      expect(measured.cls).toBeLessThan(0.01);

      // #then the page does not scroll sideways at any width
      expect(measured.documentWidth).toBeLessThanOrEqual(measured.viewportWidth + 1);

      // #then the header is sticky by CSS alone, on the page's own canvas tone
      expect(measured.navPosition).toBe('sticky');
      expect(measured.navTop).toBe('0px');
      expect(measured.navZIndex).toBeGreaterThanOrEqual(20);
      expect(measured.navBackground).toBe('rgb(255, 255, 255)');

      // #when the reader scrolls to the bottom of the landing page
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(300);

      const stuck = await page.evaluate(() => {
        const nav = document.querySelector('.landing-nav');
        if (nav === null) throw new Error('missing element: .landing-nav');
        const box = nav.getBoundingClientRect();
        return { top: box.top, height: box.height };
      });

      // #then it is still pinned, and it is exactly as tall as it was
      expect(stuck.top).toBeLessThanOrEqual(1);
      expect(stuck.top).toBeGreaterThanOrEqual(-1);
      expect(stuck.height).toBeCloseTo(measured.navHeight, 1);

      await context.close();
    });
  }
}

test('the sticky header keeps its links reachable from the keyboard', async ({ page }) => {
  await page.goto('/');

  // #given a reader who scrolls past the hero and then tabs
  await page.evaluate(() => {
    window.scrollTo(0, 1200);
  });
  // The skip link is the first stop and is drawn fixed on screen, so the header is the second.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');

  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return { inNav: false, onScreen: false };
    const box = active.getBoundingClientRect();
    return {
      inNav: active.closest('.landing-nav') !== null,
      onScreen: box.top >= 0 && box.bottom <= window.innerHeight,
    };
  });

  // #then focus lands in the header that is actually on screen, not on a link
  // scrolled far above it
  expect(focused.inNav).toBe(true);
  expect(focused.onScreen).toBe(true);
});

test('a section linked by anchor lands below the sticky header', async ({ page }) => {
  await page.goto('/');

  const clearance = await page.evaluate(() => {
    const section = document.querySelector('.landing-section');
    const nav = document.querySelector('.landing-nav');
    if (section === null || nav === null) throw new Error('the landing page did not render');
    return {
      scrollMargin: getComputedStyle(section).scrollMarginTop,
      navHeight: nav.getBoundingClientRect().height,
    };
  });

  // #then the reserved space clears the header rather than hiding under it
  expect(Number.parseFloat(clearance.scrollMargin)).toBeGreaterThan(clearance.navHeight);
});

/**
 * Visual QA against `design.md`.
 *
 * Two jobs. It captures every surface at the four viewports the work order
 * names, and it asserts the things a screenshot cannot: that no leftover dark
 * surface survived, that radii come from the named scale, that the only
 * chromatic pixel is Ember, and that nothing overflows horizontally on mobile.
 *
 * The assertions matter more than the images. "Design implemented" is not a
 * claim CSS variables can support on their own — these checks read the computed
 * styles of what actually rendered.
 */

import { expect, test, type Page } from '@playwright/test';

const REAL_ID = '0xc113ad335d202d985d527b0a193498ef2ecceb9a129a58c5002943c88601a3b0';

const ROUTES: readonly { path: string; name: string }[] = [
  { path: '/', name: 'landing' },
  { path: '/app', name: 'overview' },
  { path: '/app/settlements', name: 'settlements' },
  { path: '/app/settlements/new', name: 'composer' },
  { path: `/app/settlements/${REAL_ID}`, name: 'settlement-detail' },
  { path: '/app/dispositions', name: 'dispositions' },
  { path: '/app/verifier', name: 'verifier' },
  { path: `/verify/${REAL_ID}`, name: 'verification' },
  { path: '/app/evidence', name: 'evidence' },
  { path: `/evidence/${REAL_ID}`, name: 'evidence-detail' },
  { path: '/app/deployments', name: 'deployments' },
  { path: '/app/system', name: 'system' },
];

const VIEWPORTS: readonly { width: number; height: number; label: string }[] = [
  { width: 1440, height: 900, label: '1440x900' },
  { width: 1280, height: 800, label: '1280x800' },
  { width: 1024, height: 768, label: '1024x768' },
  { width: 390, height: 844, label: '390x844' },
];

/** The two palette values the audit compares against directly. */
const CANVAS = 'rgb(255, 255, 255)';
const EMBER = 'rgb(231, 0, 11)';

/** The radius scale design.md permits, plus 0 and the pill cap. */
const ALLOWED_RADII = new Set(['0px', '6px', '10px', '18px', '24px', '50%', '999px']);

async function auditPage(page: Page, name: string): Promise<void> {
  // ── No leftover dark theme ───────────────────────────────────────────────
  const bodyBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bodyBackground, `${name}: body must sit on the canvas token`).toBe(CANVAS);

  // ── Every colour is achromatic or Ember ──────────────────────────────────
  const chromatic = await page.evaluate((ember) => {
    const offenders: string[] = [];
    const achromatic = (value: string): boolean => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value);
      if (m === null) return true;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const a = m[4] === undefined ? 1 : Number(m[4]);
      if (a === 0) return true;
      if (r === 231 && g === 0 && b === 11) return true;
      return r === g && g === b;
    };
    for (const element of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(element);
      for (const property of ['color', 'backgroundColor', 'borderTopColor'] as const) {
        const value = style[property];
        if (!achromatic(value)) {
          offenders.push(
            `${element.tagName.toLowerCase()}.${element.className || '-'} ${property}=${value}`,
          );
        }
      }
    }
    void ember;
    return offenders.slice(0, 10);
  }, EMBER);
  expect(chromatic, `${name}: only Ember may be chromatic`).toEqual([]);

  // ── Radii come from the named scale ──────────────────────────────────────
  const radii = await page.evaluate((allowed) => {
    const offenders: string[] = [];
    for (const element of Array.from(document.querySelectorAll('*'))) {
      const radius = getComputedStyle(element).borderTopLeftRadius;
      if (radius !== '' && !allowed.includes(radius)) {
        offenders.push(`${element.tagName.toLowerCase()}.${element.className || '-'} r=${radius}`);
      }
    }
    return Array.from(new Set(offenders)).slice(0, 10);
  }, Array.from(ALLOWED_RADII));
  expect(radii, `${name}: radius must be 6/10/18/24px`).toEqual([]);

  // ── No horizontal overflow of the page body ──────────────────────────────
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${name}: the page body must not scroll horizontally`).toBeLessThanOrEqual(1);

  // ── Cards are separated ──────────────────────────────────────────────────
  // Two cards with nothing between them read as one broken box. The Deployments
  // page once put its intro card outside the stack that spaced the cards below it,
  // so the first two touched while every other pair had a gap. This looks at the
  // layout that rendered, not at the markup, so it catches the same mistake made
  // any other way.
  const touching = await page.evaluate(() => {
    const label = (element: Element): string =>
      element.textContent.trim().replace(/\s+/g, ' ').slice(0, 36);
    const cards = Array.from(document.querySelectorAll('.card')).filter(
      (card) => card instanceof HTMLElement && card.offsetParent !== null,
    );
    const offenders: string[] = [];
    for (const above of cards) {
      for (const below of cards) {
        if (above === below || above.contains(below) || below.contains(above)) continue;
        const a = above.getBoundingClientRect();
        const b = below.getBoundingClientRect();
        const gap = b.top - a.bottom;
        const shared = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        if (gap > -4 && gap < 8 && shared > Math.min(a.width, b.width) * 0.5) {
          offenders.push(`${label(above)} -> ${label(below)} (${String(Math.round(gap))}px)`);
        }
      }
    }
    return offenders.slice(0, 6);
  });
  expect(touching, `${name}: cards must have space between them`).toEqual([]);

  // ── Body text is never smaller than the scale allows ─────────────────────
  const tooSmall = await page.evaluate(() => {
    const offenders: string[] = [];
    for (const element of Array.from(document.querySelectorAll('p, td, li, span, div'))) {
      if (element.children.length > 0) continue;
      if (element.textContent.trim() === '') continue;
      const size = Number.parseFloat(getComputedStyle(element).fontSize);
      if (size < 12) offenders.push(`${element.tagName.toLowerCase()} ${String(size)}px`);
    }
    return Array.from(new Set(offenders)).slice(0, 6);
  });
  expect(tooSmall, `${name}: no text below the 12px caption size`).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  test.describe(viewport.label, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const route of ROUTES) {
      test(route.name, async ({ page }) => {
        const response = await page.goto(route.path, { waitUntil: 'load' });
        expect(response?.status(), `${route.name} should render`).toBe(200);
        await auditPage(page, `${route.name}@${viewport.label}`);
        await page.screenshot({
          path: `qa/screens/${viewport.label}/${route.name}.png`,
          fullPage: true,
        });
      });
    }
  });
}

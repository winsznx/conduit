/**
 * The console overview holding still while its script fills it in.
 *
 * `/app` renders two empty hosts and the browser script places a welcome card and a
 * position line into them a few hundred milliseconds later. Without space held for them
 * the page jumped by the height of the card. `reserve.test.ts` proves the markup and the
 * rules exist. This proves they do their job.
 *
 * Four kinds of visitor are measured:
 *
 *   a first-time visitor, who holds the welcome space and gets the card in it;
 *   a returning visitor whose first request carries the `conduit-welcomed` cookie, for whom
 *     the server leaves the welcome space out of the very first frame;
 *   a returning visitor who dismissed the welcome before the cookie existed, whose script
 *     sets it on this visit so the next one is clean;
 *   a visitor with a remembered wallet that is already oriented, whose session sets it.
 *
 * The cookie is the whole mechanism for the second. The script runs after the first paint, so
 * the server has to know before the first byte. The first section's top edge is sampled in
 * every animation frame in Chromium and in WebKit, because WebKit has no layout-shift entries
 * and a frame-by-frame position is the only thing both engines can be asked.
 *
 * Mobile emulation is left off on purpose. It marks the page's input as recent and the
 * browser then drops the very entries this measures.
 *
 * Every request is a GET and every visit is a read, so it is safe against any
 * `WEB_BASE_URL`, including one that shares a database with production.
 */

import {
  expect,
  test,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

test.describe.configure({ timeout: 60_000 });

const SHIFT_BUDGET = 0.01;
const OBSERVATION_MS = 3500;
const RESERVE_TOLERANCE_PX = 4;
const TOP_EDGE_TOLERANCE_PX = 0.5;
// The product releases the space after 4 s (reserve.test.ts pins that). This is how long a test
// waits for it, with room for a page that loads slowly while other workers use the machine.
const RELEASE_DEADLINE_MS = 8000;
const ONE_YEAR_SECONDS = 31_536_000;

const COOKIE = 'conduit-welcomed';
const ACCOUNT = '0x83C130ed9fb92830F09ea2b30E49009EF03065Bb';

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
] as const;

const CLIENT_SCRIPT = '**/assets/client.*.js';

interface Frame {
  readonly onboarding: number | null;
  readonly top: number | null;
}

interface FrameWindow {
  __frames: Frame[];
  __shift: { value: number; count: number };
}

/** Records every shift the visitor did not cause, from the first frame. */
async function observeShifts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const total = { value: 0, count: 0 };
    (window as unknown as FrameWindow).__shift = total;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as {
        value: number;
        hadRecentInput: boolean;
      }[]) {
        if (entry.hadRecentInput) continue;
        total.value += entry.value;
        total.count += 1;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

async function totalShift(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as FrameWindow).__shift.value);
}

async function shiftCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as FrameWindow).__shift.count);
}

/**
 * Records the onboarding host's height and the first section's top in every animation frame.
 *
 * The loop starts before any page script, so the first entry is the first frame the browser
 * was able to paint. A frame in which the host or the section is not yet in the document
 * records nothing for it.
 */
async function sampleFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const frames: Frame[] = [];
    (window as unknown as FrameWindow).__frames = frames;
    const started = performance.now();
    const tick = (): void => {
      const host = document.querySelector('[data-onboarding]');
      const section = document.querySelector('main section');
      frames.push({
        onboarding: host === null ? null : host.getBoundingClientRect().height,
        top: section === null ? null : section.getBoundingClientRect().top,
      });
      if (performance.now() - started < 5000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function framesOf(page: Page): Promise<readonly Frame[]> {
  return page.evaluate(() => (window as unknown as FrameWindow).__frames);
}

/** The heights the onboarding host had in every frame where it existed. */
async function onboardingHeights(page: Page): Promise<readonly number[]> {
  return (await framesOf(page)).flatMap((frame) =>
    frame.onboarding === null ? [] : [frame.onboarding],
  );
}

/** The furthest the first section's top ever was from where it ended up. */
async function topTravel(page: Page): Promise<number> {
  const tops = (await framesOf(page)).flatMap((frame) => (frame.top === null ? [] : [frame.top]));
  const settled = tops.at(-1);
  if (settled === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(...tops.map((top) => Math.abs(top - settled)));
}

async function hostHeight(page: Page, host: 'onboarding' | 'overview'): Promise<number> {
  return page.locator(`[data-${host}]`).evaluate((node) => node.getBoundingClientRect().height);
}

async function welcomedCookie(
  context: BrowserContext,
): Promise<Awaited<ReturnType<BrowserContext['cookies']>>[number] | undefined> {
  return (await context.cookies()).find((cookie) => cookie.name === COOKIE);
}

/** The state of a visitor whose first request already carries the cookie. */
async function visitWelcomed(context: BrowserContext, baseURL: string | undefined): Promise<void> {
  await context.addCookies([{ name: COOKIE, value: '1', url: baseURL ?? 'http://localhost:8787' }]);
}

/** Waits until the personal overview line is placed, which is the last thing an anonymous visit adds. */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('[data-overview] p')).toBeVisible();
}

/**
 * A wallet the session restores silently, for an account that has already been oriented.
 *
 * It mirrors the provider in `wallet.spec.ts`, which announces itself the way a real wallet does
 * (EIP-6963) and answers the two reads a restore makes. The welcome card was never dismissed, so
 * `conduit.welcomed` is left unset: this visitor is oriented through the account, not the card.
 */
async function rememberOrientedWallet(page: Page): Promise<void> {
  await page.addInitScript((account) => {
    localStorage.setItem('conduit.wallet', 'mock-uuid');
    localStorage.setItem(`conduit.oriented:${account.toLowerCase()}`, '1');

    const provider = {
      request: ({ method }: { method: string }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') {
          return Promise.resolve([account]);
        }
        if (method === 'eth_chainId') return Promise.resolve('0x279f');
        return Promise.resolve(null);
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
    const announce = (): void => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: {
            info: { uuid: 'mock-uuid', name: 'Mock Wallet', icon: '', rdns: 'dev.conduit.mock' },
            provider,
          },
        }),
      );
    };
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, ACCOUNT);
}

for (const viewport of VIEWPORTS) {
  test.describe(`at ${String(viewport.width)} wide`, () => {
    test.use({ viewport });

    test.describe('a first-time visitor', () => {
      test('sees the page hold still', async ({ page }) => {
        // #given a visitor with nothing stored
        await observeShifts(page);

        // #when the overview loads and settles
        await page.goto('/app');
        await expect(page.locator('[data-onboarding] .card')).toBeVisible();
        await page.waitForTimeout(OBSERVATION_MS);

        // #then the page moved less than the budget
        expect(await totalShift(page)).toBeLessThan(SHIFT_BUDGET);
      });

      test('keeps the first section where it first painted', async ({ page }) => {
        // #given a visitor with nothing stored
        await sampleFrames(page);

        // #when the overview loads and the card and the position line are placed
        await page.goto('/app');
        await expect(page.locator('[data-onboarding] .card')).toBeVisible();
        await settle(page);
        await page.waitForTimeout(500);

        // #then the first section never strayed from its final top edge
        expect(await topTravel(page)).toBeLessThanOrEqual(TOP_EDGE_TOLERANCE_PX);
      });

      test('is given no cookie by looking at the page', async ({ page, context }) => {
        // #given a visitor with nothing stored
        // #when the overview loads and the welcome card is shown
        await page.goto('/app');
        await expect(page.locator('[data-onboarding] .card')).toBeVisible();

        // #then nothing was stored on their behalf
        expect(await context.cookies()).toEqual([]);
      });

      test('dismissing the welcome sets the cookie with its attributes', async ({
        page,
        context,
        baseURL,
      }) => {
        // #given a visitor looking at the welcome card
        await page.goto('/app');
        const card = page.locator('[data-onboarding] .card');
        await expect(card).toBeVisible();

        // #when they dismiss it
        await card.getByRole('button', { name: 'Dismiss' }).click();

        // #then the browser holds a year-long, site-wide, script-set Lax cookie
        const cookie = await welcomedCookie(context);
        const secure = (baseURL ?? '').startsWith('https:');
        expect(cookie).toMatchObject({
          value: '1',
          path: '/',
          sameSite: 'Lax',
          httpOnly: false,
          secure,
        });
      });

      test('dismissing the welcome sets a cookie that lasts a year', async ({ page, context }) => {
        // #given a visitor looking at the welcome card
        await page.goto('/app');
        const card = page.locator('[data-onboarding] .card');
        await expect(card).toBeVisible();

        // #when they dismiss it
        await card.getByRole('button', { name: 'Dismiss' }).click();

        // #then the cookie expires about a year from now
        const cookie = await welcomedCookie(context);
        const remaining = (cookie?.expires ?? 0) - Date.now() / 1000;
        expect(Math.abs(remaining - ONE_YEAR_SECONDS)).toBeLessThan(120);
      });

      test('dismissing the welcome also keeps the storage flag', async ({ page }) => {
        // #given a visitor looking at the welcome card
        await page.goto('/app');
        const card = page.locator('[data-onboarding] .card');
        await expect(card).toBeVisible();

        // #when they dismiss it
        await card.getByRole('button', { name: 'Dismiss' }).click();

        // #then localStorage records it too, as it always did
        expect(await page.evaluate(() => localStorage.getItem('conduit.welcomed'))).toBe('1');
      });

      test('arrives with no blank band after dismissing and reloading', async ({ page }) => {
        // #given a visitor who has just dismissed the welcome
        await page.goto('/app');
        const card = page.locator('[data-onboarding] .card');
        await expect(card).toBeVisible();
        await card.getByRole('button', { name: 'Dismiss' }).click();

        // #when the overview is loaded again with frames sampled from the first
        await sampleFrames(page);
        await page.reload();
        await settle(page);

        // #then the onboarding host never had any height
        expect(Math.max(0, ...(await onboardingHeights(page)))).toBe(0);
      });
    });

    test.describe('a returning visitor whose first request carries the cookie', () => {
      test('sees no layout shift at all', async ({ page, context, baseURL }) => {
        // #given the cookie, sent with the very first request
        await visitWelcomed(context, baseURL);
        await observeShifts(page);

        // #when the overview loads and settles
        await page.goto('/app');
        await settle(page);
        await page.waitForTimeout(OBSERVATION_MS);

        // #then the page did not move
        expect(await totalShift(page)).toBeCloseTo(0, 4);
      });

      test('has an onboarding host with no height in any frame, from the first', async ({
        page,
        context,
        baseURL,
      }) => {
        // #given the cookie, sent with the very first request
        await visitWelcomed(context, baseURL);
        await sampleFrames(page);

        // #when the overview loads and settles
        await page.goto('/app');
        await settle(page);

        // #then frames were sampled, and the host was never taller than nothing
        const heights = await onboardingHeights(page);
        expect({ sampled: heights.length > 0, tallest: Math.max(0, ...heights) }).toEqual({
          sampled: true,
          tallest: 0,
        });
      });

      test('keeps the first section where it first painted', async ({ page, context, baseURL }) => {
        // #given the cookie, sent with the very first request
        await visitWelcomed(context, baseURL);
        await sampleFrames(page);

        // #when the overview loads and the position line is placed
        await page.goto('/app');
        await settle(page);
        await page.waitForTimeout(500);

        // #then the first section never strayed from its final top edge
        expect(await topTravel(page)).toBeLessThanOrEqual(TOP_EDGE_TOLERANCE_PX);
      });

      test('shows no welcome card even though storage holds nothing', async ({
        page,
        context,
        baseURL,
      }) => {
        // #given the cookie and an empty localStorage
        await visitWelcomed(context, baseURL);

        // #when the overview loads and the session has hydrated
        await page.goto('/app');
        await settle(page);

        // #then no card was placed in the host that has no space held for it
        await expect(page.locator('[data-onboarding] .card')).toHaveCount(0);
      });

      test('is left no blank band above the content', async ({ page, context, baseURL }) => {
        // #given the cookie, sent with the very first request
        await visitWelcomed(context, baseURL);

        // #when the overview loads and the script has run
        await page.goto('/app');
        await settle(page);

        // #then the onboarding host takes no height
        expect(await hostHeight(page, 'onboarding')).toBe(0);
      });
    });

    test.describe('a returning visitor who dismissed before the cookie existed', () => {
      test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
          localStorage.setItem('conduit.welcomed', '1');
        });
      });

      test('has the cookie set by the script on this visit', async ({ page, context }) => {
        // #given storage that says the welcome was dismissed, and no cookie
        // #when the overview loads and the script has run
        await page.goto('/app');
        await settle(page);

        // #then the script mirrored it into the cookie
        expect((await welcomedCookie(context))?.value).toBe('1');
      });

      test('shifts the page once on this visit, and the size is on the record', async ({
        page,
      }, testInfo) => {
        // #given storage that says the welcome was dismissed, and no cookie
        await observeShifts(page);

        // #when the overview loads and settles
        await page.goto('/app');
        await settle(page);
        await page.waitForTimeout(OBSERVATION_MS);

        // #then the card space was given back in a single shift
        testInfo.annotations.push({
          type: 'migration-shift',
          description: (await totalShift(page)).toFixed(4),
        });
        expect(await shiftCount(page)).toBe(1);
      });

      test('has no reserve in the first frame of the second visit', async ({ page }) => {
        // #given a first visit that has set the cookie
        await page.goto('/app');
        await settle(page);

        // #when the overview is loaded again with frames sampled from the first
        await sampleFrames(page);
        await page.reload();
        await settle(page);

        // #then the onboarding host never had any height
        const heights = await onboardingHeights(page);
        expect({ sampled: heights.length > 0, tallest: Math.max(0, ...heights) }).toEqual({
          sampled: true,
          tallest: 0,
        });
      });

      test('sees no layout shift on the second visit', async ({ page }) => {
        // #given a first visit that has set the cookie
        await page.goto('/app');
        await settle(page);

        // #when the overview is loaded again and settles
        await observeShifts(page);
        await page.reload();
        await settle(page);
        await page.waitForTimeout(OBSERVATION_MS);

        // #then the page did not move
        expect(await totalShift(page)).toBeCloseTo(0, 4);
      });
    });

    test.describe('a visitor with a remembered wallet that is already oriented', () => {
      test('has the cookie set once the session has hydrated', async ({ page, context }) => {
        // #given a wallet the session restores, for an account that was oriented before
        await rememberOrientedWallet(page);

        // #when the overview loads and the session reports the account
        await page.goto('/app');
        await expect(page.locator('[data-participant] [data-account]')).toBeVisible();

        // #then no card will ever show, and the cookie says so
        await expect.poll(async () => (await welcomedCookie(context))?.value).toBe('1');
      });

      test('has no blank band in the first frame of the second visit', async ({
        page,
        context,
      }) => {
        // #given a first visit that has set the cookie
        await rememberOrientedWallet(page);
        await page.goto('/app');
        await expect.poll(async () => (await welcomedCookie(context))?.value).toBe('1');

        // #when the overview is loaded again with frames sampled from the first
        await sampleFrames(page);
        await page.reload();
        await expect(page.locator('[data-participant] [data-account]')).toBeVisible();

        // #then the onboarding host never had any height
        const heights = await onboardingHeights(page);
        expect({ sampled: heights.length > 0, tallest: Math.max(0, ...heights) }).toEqual({
          sampled: true,
          tallest: 0,
        });
      });
    });

    test('the space held for the welcome card matches the card', async ({ page, context }) => {
      // #given the space the server holds, read from a page whose script never arrives
      const bare = await context.newPage();
      await bare.route(CLIENT_SCRIPT, (route) => route.abort());
      await bare.goto('/app');
      const held = await hostHeight(bare, 'onboarding');
      await bare.close();

      // #when the real card is placed on a page whose script does run
      await page.goto('/app');
      const card = page.locator('[data-onboarding] .card');
      await expect(card).toBeVisible();
      const real = await card.evaluate((node) => node.getBoundingClientRect().height);

      // #then the two differ by no more than the tolerance
      expect(Math.abs(held - real)).toBeLessThanOrEqual(RESERVE_TOLERANCE_PX);
    });

    test('the space held for the position line matches the line', async ({ page, context }) => {
      // #given the space the server holds, read from a page whose script never arrives
      const bare = await context.newPage();
      await bare.route(CLIENT_SCRIPT, (route) => route.abort());
      await bare.goto('/app');
      const held = await hostHeight(bare, 'overview');
      await bare.close();

      // #when the line is placed on a page whose script does run
      await page.goto('/app');
      await settle(page);
      const real = await hostHeight(page, 'overview');

      // #then the two differ by no more than the tolerance
      expect(Math.abs(held - real)).toBeLessThanOrEqual(RESERVE_TOLERANCE_PX);
    });
  });
}

test.describe('in WebKit', () => {
  let engine: Browser;

  test.beforeAll(async () => {
    engine = await webkit.launch();
  });

  test.afterAll(async () => {
    await engine.close();
  });

  for (const viewport of VIEWPORTS) {
    test.describe(`at ${String(viewport.width)} wide`, () => {
      async function open(
        baseURL: string | undefined,
        welcomed: boolean,
      ): Promise<{ context: BrowserContext; page: Page }> {
        const origin = baseURL ?? 'http://localhost:8787';
        const context = await engine.newContext({ viewport, baseURL: origin });
        if (welcomed) await context.addCookies([{ name: COOKIE, value: '1', url: origin }]);
        const page = await context.newPage();
        await sampleFrames(page);
        return { context, page };
      }

      test('a returning visitor has an onboarding host with no height in any frame', async ({
        baseURL,
      }) => {
        // #given the cookie, sent with the very first request
        const { context, page } = await open(baseURL, true);

        // #when the overview loads and settles
        await page.goto('/app');
        await settle(page);

        // #then frames were sampled, and the host was never taller than nothing
        const heights = await onboardingHeights(page);
        await context.close();
        expect({ sampled: heights.length > 0, tallest: Math.max(0, ...heights) }).toEqual({
          sampled: true,
          tallest: 0,
        });
      });

      test('a returning visitor keeps the first section where it first painted', async ({
        baseURL,
      }) => {
        // #given the cookie, sent with the very first request
        const { context, page } = await open(baseURL, true);

        // #when the overview loads and the position line is placed
        await page.goto('/app');
        await settle(page);
        await page.waitForTimeout(500);

        // #then the first section never strayed from its final top edge
        const travel = await topTravel(page);
        await context.close();
        expect(travel).toBeLessThanOrEqual(TOP_EDGE_TOLERANCE_PX);
      });

      test('a first-time visitor keeps the first section where it first painted', async ({
        baseURL,
      }) => {
        // #given a visitor with nothing stored
        const { context, page } = await open(baseURL, false);

        // #when the overview loads and the card and the position line are placed
        await page.goto('/app');
        await expect(page.locator('[data-onboarding] .card')).toBeVisible();
        await settle(page);
        await page.waitForTimeout(500);

        // #then the first section never strayed from its final top edge
        const travel = await topTravel(page);
        await context.close();
        expect(travel).toBeLessThanOrEqual(TOP_EDGE_TOLERANCE_PX);
      });

      test('a visitor migrating from storage has the cookie on the next visit', async ({
        baseURL,
      }) => {
        // #given storage that says the welcome was dismissed, and no cookie
        const { context, page } = await open(baseURL, false);
        await page.addInitScript(() => {
          localStorage.setItem('conduit.welcomed', '1');
        });
        await page.goto('/app');
        await settle(page);

        // #when the overview is loaded again with frames sampled from the first
        await page.reload();
        await settle(page);

        // #then the onboarding host never had any height
        const heights = await onboardingHeights(page);
        await context.close();
        expect({ sampled: heights.length > 0, tallest: Math.max(0, ...heights) }).toEqual({
          sampled: true,
          tallest: 0,
        });
      });
    });
  }
});

test.describe('when the script does not run', () => {
  test('a visitor whose bundle never loads gets the space back from CSS alone', async ({
    page,
  }) => {
    // #given a page whose script request fails
    await page.route(CLIENT_SCRIPT, (route) => route.abort());

    // #when the overview loads and the fallback animation has had its time
    await page.goto('/app');

    // #then the onboarding host ends up with no height
    await expect
      .poll(() => hostHeight(page, 'onboarding'), { timeout: RELEASE_DEADLINE_MS })
      .toBe(0);
  });

  test('a visitor whose bundle never loads gets the overview space back too', async ({ page }) => {
    // #given a page whose script request fails
    await page.route(CLIENT_SCRIPT, (route) => route.abort());

    // #when the overview loads and the fallback animation has had its time
    await page.goto('/app');

    // #then the overview host ends up with no height
    await expect.poll(() => hostHeight(page, 'overview'), { timeout: RELEASE_DEADLINE_MS }).toBe(0);
  });

  test('a visitor whose bundle never loads gets the participant slot back too', async ({
    page,
  }) => {
    // #given a page whose script request fails
    await page.route(CLIENT_SCRIPT, (route) => route.abort());

    // #when the overview loads and the fallback animation has had its time
    await page.goto('/app');

    // #then the participant slot ends up with no width
    await expect
      .poll(
        () =>
          page.locator('[data-participant]').evaluate((node) => node.getBoundingClientRect().width),
        {
          timeout: RELEASE_DEADLINE_MS,
        },
      )
      .toBe(0);
  });
});

test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });

  test('the onboarding host holds no blank space', async ({ page }) => {
    // #given a visitor with scripting disabled
    // #when the overview loads
    await page.goto('/app');

    // #then the onboarding host is released at once
    expect(await hostHeight(page, 'onboarding')).toBe(0);
  });

  test('the overview host holds no blank space', async ({ page }) => {
    // #given a visitor with scripting disabled
    // #when the overview loads
    await page.goto('/app');

    // #then the overview host is released at once
    expect(await hostHeight(page, 'overview')).toBe(0);
  });

  test('the participant slot holds no blank width', async ({ page }) => {
    // #given a visitor with scripting disabled
    // #when the overview loads
    await page.goto('/app');

    // #then the slot is released at once
    expect(
      await page
        .locator('[data-participant]')
        .evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(0);
  });
});

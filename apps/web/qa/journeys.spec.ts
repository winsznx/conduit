/**
 * The three journeys a judge actually takes, walked end to end.
 *
 * Not a unit test of anything. It is the check that nobody hits a dead end: a
 * page that 404s, a panel that says nothing, a link that goes somewhere empty.
 * Those are the failures a reader meets first and the ones a test suite full of
 * passing assertions is least likely to notice.
 *
 * Runs against whatever `WEB_BASE_URL` points at, so the same walk covers local
 * and production.
 */

import { expect, test, type Page } from '@playwright/test';

/** The settlement a judge is pointed at: driven from a browser, verified. */
const CANONICAL = '0xd46775dc9cbcdfdd4f60df1c9de4de15fc609b29f47f1d3d1860e398c33aca77';

/** The one where compliance changed after the commitment. */
const COMPLIANCE_CHANGE = '0xc113ad335d202d985d527b0a193498ef2ecceb9a129a58c5002943c88601a3b0';

/**
 * A wallet this sandbox answers `NO_APASS` for.
 *
 * Chosen by asking, not by assuming: the sandbox clears some unknown addresses
 * with `code 4` and refuses others with `code 2`, so "an address nobody has
 * heard of" is not a reliable way to produce a refusal. This one is refused
 * today, and if that ever changes the assertion below is the thing that says so.
 */
const UNKNOWN = '0xabc0000000000000000000000000000000000001';

async function installStrangerWallet(page: Page, address: string): Promise<void> {
  await page.addInitScript((account: string) => {
    const provider = {
      request: ({ method }: { method: string }) => {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return Promise.resolve([account]);
          case 'eth_chainId':
            return Promise.resolve('0x279f');
          default:
            return Promise.resolve(null);
        }
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
    const announce = (): void => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: { info: { uuid: 'judge', name: 'Judge Wallet', icon: '' }, provider },
        }),
      );
    };
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, address);
}

/** Nothing on any journey may 404, and nothing may render an empty shell. */
async function reaches(page: Page, path: string, heading: RegExp): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), `${path} must not be an error page`).toBeLessThan(400);
  await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
}

test.describe('journey A — a judge with no eligible wallet', () => {
  test('lands, is refused honestly, and is given somewhere to go', async ({ page }) => {
    await installStrangerWallet(page, UNKNOWN);

    // #given the landing page
    await page.goto('/');

    // #then the seven questions are answerable without opening anything
    for (const answer of [
      'The problem',
      'Compliance is part of the state machine',
      'Wormhole moves settlement facts, not assets',
      'Proven live',
      'Try Conduit',
    ]) {
      await expect(page.getByRole('heading', { name: answer })).toBeVisible();
    }

    // #and the honest exits exist for a wallet that will be refused
    await expect(page.getByRole('link', { name: 'Explore a proven settlement' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'HELD → disposition proof' })).toBeVisible();

    // #when the judge tries to compose anyway
    await page.goto('/app/settlements/new');
    await page.getByRole('button', { name: 'Connect wallet' }).first().click();
    await page.getByText('Judge Wallet').click();
    await page.locator('#f-role').selectOption('both');
    await page.locator('#f-cashAmount').fill('1');
    await page.locator('#f-assetAmount').fill('0.1');
    await page.getByRole('button', { name: 'Check compliance' }).click();

    // #then Cleanverse answers for real, the verdict is named, and signing is
    // not offered while a participant cannot receive their leg
    await expect(page.locator('[data-matrix] tbody tr')).toHaveCount(4, { timeout: 60_000 });
    await expect(page.locator('[data-matrix]')).toContainText(
      /NO APASS|INELIGIBLE|POLICY REFUSAL|UNAVAILABLE/,
    );
    await expect(page.getByRole('button', { name: 'Review and sign' })).toBeDisabled();
  });

  test('every page the exits lead to is a real page', async ({ page }) => {
    await reaches(page, '/app', /Overview/);
    await reaches(page, '/app/settlements', /Settlements/);
    await reaches(page, '/app/dispositions', /Disposition center/);
    await reaches(page, '/app/verifier', /Verifier/);
    await reaches(page, '/app/evidence', /Evidence explorer/);
    await reaches(page, '/app/deployments', /Deployments/);
    await reaches(page, '/app/system', /System/);
  });
});

test.describe('journey B — the settlement a participant produced', () => {
  test('shows the whole record and links to both proofs', async ({ page }) => {
    await reaches(page, `/app/settlements/${CANONICAL}`, /Settlement/);

    const body = page.locator('body');
    await expect(body).toContainText('Monad Testnet');
    await expect(body).toContainText('Base Sepolia');
    await expect(body).toContainText('SETTLED');
    await expect(body).toContainText('SETTLED_FINAL');
    await expect(body).toContainText('FINALIZED');

    // #then both public proofs are one click away and neither is empty
    await reaches(page, `/verify/${CANONICAL}`, /Verification/);
    await expect(page.locator('body')).toContainText('of 18 passed');

    await reaches(page, `/evidence/${CANONICAL}`, /Evidence/);
    await expect(page.locator('body')).toContainText('transaction');
  });
});

test.describe('journey C — compliance changed after the commitment', () => {
  test('walks refusal, held value and the disposition that resolved it', async ({ page }) => {
    await reaches(page, `/app/settlements/${COMPLIANCE_CHANGE}`, /Settlement/);
    await expect(page.locator('body')).toContainText('SETTLED_FINAL');

    // #then the disposition center carries the path rather than an empty table
    await reaches(page, '/app/dispositions', /Disposition center/);
    const dispositions = page.locator('body');
    await expect(dispositions).toContainText('Protocol history');
    await expect(dispositions).toContainText('REVERIFY_AND_RESUME');
    await expect(dispositions).toContainText('RuleV2');
    await expect(dispositions).toContainText('The six order types');

    // #and every order type is described rather than merely listed
    await expect(page.locator('[data-dtype], .dtype')).toHaveCount(6);

    // #and the evidence for it is reachable and populated
    await reaches(page, `/evidence/${COMPLIANCE_CHANGE}`, /Evidence/);
    await expect(page.locator('body')).toContainText('policy');
    await expect(page.locator('body')).toContainText('refusal');
  });
});

test.describe('no dead ends', () => {
  test('an unknown settlement says what that does and does not mean', async ({ page }) => {
    const response = await page.goto(`/app/settlements/0x${'11'.repeat(32)}`);
    expect(response?.status()).toBe(404);
    await expect(page.locator('body')).toContainText('not proof it does not exist');
  });

  test('an unknown page still offers a way back', async ({ page }) => {
    await page.goto('/nothing-here');
    await expect(page.getByRole('link', { name: 'Back to settlements' })).toBeVisible();
  });
});

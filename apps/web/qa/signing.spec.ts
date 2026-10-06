/**
 * The participant flow, up to and including a real EIP-712 signature.
 *
 * The mock wallet does not fake signing. It calls back into Node through an
 * exposed binding, where a real private key signs the real typed data with
 * viem. That matters: the app recovers the signer in the browser and the server
 * recovers it again before storing, so a stubbed signature would fail both
 * checks and the test would prove nothing.
 *
 * The one thing this cannot cover is a wallet extension's own UI. That is what
 * the manual smoke test against testnet is for.
 */

import { expect, test, type Page } from '@playwright/test';
import { privateKeyToAccount } from 'viem/accounts';

import { skipUnlessDatabaseWritesAllowed } from './database-writes.js';

// A throwaway key. It holds nothing, on any chain, and is checked in on purpose
// so this test is deterministic.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(KEY);

/**
 * A mock wallet that signs for real.
 *
 * `exposeFunction` gives page code a bridge into Node, so `eth_signTypedData_v4`
 * produces a signature that actually recovers to this account.
 */
async function installSigningWallet(page: Page): Promise<void> {
  await page.exposeFunction('__signTypedData', async (raw: string) => {
    const payload = JSON.parse(raw) as {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    };
    // The wire carries every numeric field as a string; viem wants the real
    // types back before it will hash them the way the contract does.
    const message: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload.message)) {
      message[key] =
        /^\d+$/.test(String(value)) && key !== 'version' ? BigInt(String(value)) : value;
    }
    if (typeof message['version'] === 'string') message['version'] = Number(message['version']);

    return account.signTypedData({
      domain: payload.domain,
      types: payload.types,
      primaryType: payload.primaryType,
      message,
    });
  });

  await page.addInitScript((address: string) => {
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [address];
          case 'eth_chainId':
            return '0x279f';
          case 'wallet_switchEthereumChain':
            return null;
          case 'eth_signTypedData_v4': {
            const [, typed] = params as [string, string];
            const bridge = window as unknown as {
              __signTypedData: (raw: string) => Promise<string>;
            };
            return bridge.__signTypedData(typed);
          }
          default:
            return null;
        }
      },
      on: () => undefined,
      removeListener: () => undefined,
    };
    const announce = (): void => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', {
          detail: { info: { uuid: 'mock', name: 'Mock Wallet', icon: '' }, provider },
        }),
      );
    };
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, account.address);
}

/**
 * Forces the preflight to pass.
 *
 * The signing tests are about the composer and the digest, not about Cleanverse
 * — and the throwaway key below is a wallet the sandbox has never issued an
 * A-Pass to, so a live preflight correctly refuses it and the flow correctly
 * refuses to sign. That gate is the product working; ten unit tests in
 * `eligibility.test.ts` drive the real endpoint against the real client. Here
 * it is stubbed so the signature path can be exercised deterministically.
 */
async function stubEligible(page: Page): Promise<void> {
  await page.route('**/api/eligibility*', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        subject: url.searchParams.get('subject'),
        results: [
          {
            chain: url.searchParams.get('chainId') === '10143' ? 'monad' : 'base',
            chainId: Number(url.searchParams.get('chainId')),
            status: 'ELIGIBLE',
            reason: 'ALLOWED',
            detail: 'stubbed for the signing test',
            assetSymbol: url.searchParams.get('chainId') === '10143' ? 'cSETTLE' : 'cBOND',
            checkedAt: new Date().toISOString(),
          },
        ],
      }),
    });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByText('Mock Wallet').click();
  await expect(page.getByText(`${account.address.slice(0, 6)}…`).first()).toBeVisible();
}

test.describe('participant flow', () => {
  test('the composer no longer sends anyone to the CLI', async ({ page }) => {
    await page.goto('/app/settlements/new');
    const body = (await page.textContent('body')) ?? '';
    expect(body).not.toContain('Signing happens elsewhere');
    expect(body).not.toContain('conduit intent sign');
    // The control is in the document but lives in step 3, which is hidden until
    // the earlier steps pass — so it is absent from the accessibility tree and
    // has to be located structurally rather than by role.
    await expect(page.locator('[data-sign]')).toHaveCount(1);
    await expect(page.locator('[data-sign]')).toHaveText('Sign with my wallet');
  });

  test('terms that do not parse cannot advance', async ({ page }) => {
    await installSigningWallet(page);
    await page.goto('/app/settlements/new');
    await connect(page);

    // #given an amount but no valid addresses
    await page.locator('#f-cashAmount').fill('25');
    await page.locator('#f-assetAmount').fill('0.5');
    await page.locator('#f-cashPayer').fill('not-an-address');

    // #when the step is attempted
    await page.getByRole('button', { name: 'Check compliance' }).click();

    // #then it refuses, and says which field
    await expect(page.locator('[data-terms-error]')).toContainText('cashPayer');
  });

  test('runs a real compliance preflight and gates signing on it', async ({ page }) => {
    await installSigningWallet(page);
    await page.goto('/app/settlements/new');
    await connect(page);

    // #given a wallet that plays both roles, so every participant is this key
    await page.locator('#f-role').selectOption('both');
    await page.locator('#f-cashAmount').fill('25');
    await page.locator('#f-assetAmount').fill('0.5');

    // #when compliance runs
    await page.getByRole('button', { name: 'Check compliance' }).click();

    // #then all four participants are reported, from the live endpoint
    await expect(page.locator('[data-matrix] tbody tr')).toHaveCount(4, { timeout: 45_000 });
    await expect(page.locator('[data-matrix]')).toContainText('Payer');
    await expect(page.locator('[data-matrix]')).toContainText('Asset receiver');
  });

  test('defaults each receiver to the counterparty and says so in a sentence', async ({ page }) => {
    await installSigningWallet(page);
    await stubEligible(page);
    await page.goto('/app/settlements/new');
    await connect(page);

    // #given a payer and a seller who are different wallets, and no receivers
    const payer = account.address;
    const seller = '0x2222222222222222222222222222222222222222';
    await page.locator('#f-cashAmount').fill('25');
    await page.locator('#f-assetAmount').fill('0.5');
    await page.locator('#f-cashPayer').fill(payer);
    await page.locator('#f-assetSeller').fill(seller);
    await expect(page.locator('#f-cashReceiver')).toHaveValue('');
    await expect(page.locator('#f-assetReceiver')).toHaveValue('');

    // #when the terms are checked and reviewed
    await page.getByRole('button', { name: 'Check compliance' }).click();
    const review = page.getByRole('button', { name: 'Review and sign' });
    await expect(review).toBeEnabled({ timeout: 45_000 });
    await review.click();

    // #then the seller is the cash receiver and the payer the asset receiver,
    // and the recap states the trade as a sentence before the table
    const summary = page.locator('[data-summary]');
    await expect(summary).toContainText(
      `${seller.slice(0, 6)}…${seller.slice(-4)} delivers 0.5 cBOND on Base Sepolia to ${payer.slice(0, 6)}…${payer.slice(-4)}`,
    );
    await expect(summary.locator('tr', { hasText: 'Cash receiver' })).toContainText(seller);
    await expect(summary.locator('tr', { hasText: 'Asset receiver' })).toContainText(payer);
  });

  test('signs the intent in the browser and stores it for the counterparty', async ({ page }) => {
    skipUnlessDatabaseWritesAllowed();
    await installSigningWallet(page);
    await stubEligible(page);
    await page.goto('/app/settlements/new');
    await connect(page);

    await page.locator('#f-role').selectOption('both');
    await page.locator('#f-cashAmount').fill('25');
    await page.locator('#f-assetAmount').fill('0.5');
    await page.getByRole('button', { name: 'Check compliance' }).click();

    const review = page.getByRole('button', { name: 'Review and sign' });
    await expect(review).toBeEnabled({ timeout: 45_000 });
    await review.click();

    // #given the summary the user sees before their wallet is asked
    await expect(page.locator('[data-summary]')).toContainText('25 cSETTLE');
    await expect(page.locator('[data-summary]')).toContainText('0.5 cBOND');

    // #when they sign
    await page.getByRole('button', { name: 'Sign with my wallet' }).click();

    // #then the signature recovers to the connected account, locally and on the
    // server, and a counterparty link exists
    await expect(page.locator('[data-sign-status]')).toContainText(account.address, {
      timeout: 30_000,
    });
    await expect(page.locator('[data-sign-result]')).toContainText('SIGNED');
    await expect(page.locator('[data-sign-result]')).toContainText('/sign');
  });

  test('the counterparty link opens a signable request', async ({ page }) => {
    skipUnlessDatabaseWritesAllowed();
    await installSigningWallet(page);
    await stubEligible(page);
    await page.goto('/app/settlements/new');
    await connect(page);
    await page.locator('#f-role').selectOption('both');
    await page.locator('#f-cashAmount').fill('25');
    await page.locator('#f-assetAmount').fill('0.5');
    await page.getByRole('button', { name: 'Check compliance' }).click();
    await expect(page.getByRole('button', { name: 'Review and sign' })).toBeEnabled({
      timeout: 45_000,
    });
    await page.getByRole('button', { name: 'Review and sign' }).click();
    await page.getByRole('button', { name: 'Sign with my wallet' }).click();
    await expect(page.locator('[data-sign-result]')).toContainText('SIGNED', { timeout: 30_000 });

    // #when the shared link is opened
    const link = (await page.locator('[data-sign-result] .nested').textContent()) ?? '';
    expect(link).toContain('/sign');
    await page.goto(new URL(link).pathname);

    // #then the counterparty sees the terms and the signature state
    await expect(page.getByRole('heading', { name: 'Settlement request' })).toBeVisible();
    await expect(page.getByText('SIGNED').first()).toBeVisible();
  });
});

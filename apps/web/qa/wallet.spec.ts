/**
 * Wallet interaction, against a mock EIP-1193 provider.
 *
 * A real extension cannot run in CI, and a test that needs one is a test that
 * does not run. This injects a provider that announces itself the way a real
 * wallet does (EIP-6963) and records the RPC calls the app makes, so the
 * assertions are about Conduit's behaviour rather than about MetaMask's.
 *
 * What it is deliberately not: a substitute for signing something real. It
 * proves the app asks the right wallet for the right chain at the right moment.
 * A live wallet against testnet is still the check that matters for the parts
 * that move value.
 */

import { expect, test, type Page } from '@playwright/test';

const ACCOUNT = '0x83C130ed9fb92830F09ea2b30E49009EF03065Bb';
const MONAD = '0x279f'; // 10143

/**
 * Installs the mock before any page script runs.
 *
 * `addInitScript` matters here: the app dispatches `eip6963:requestProvider`
 * during startup, so a provider injected after load would never be discovered
 * and the test would be asserting against a race.
 */
async function installMockWallet(page: Page, options?: { chainId?: string }): Promise<void> {
  await page.addInitScript(
    ({ account, chainId }) => {
      const calls: { method: string; params?: unknown }[] = [];
      let current = chainId;

      const provider = {
        isMockWallet: true,
        request: ({ method, params }: { method: string; params?: unknown }) => {
          calls.push({ method, params });
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return Promise.resolve([account]);
            case 'eth_chainId':
              return Promise.resolve(current);
            case 'wallet_switchEthereumChain': {
              const target = (params as [{ chainId: string }])[0].chainId;
              current = target;
              return Promise.resolve(null);
            }
            default:
              return Promise.resolve(null);
          }
        },
        on: () => undefined,
        removeListener: () => undefined,
      };

      (window as unknown as { __walletCalls: typeof calls }).__walletCalls = calls;

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
    },
    { account: ACCOUNT, chainId: options?.chainId ?? MONAD },
  );
}

async function walletCalls(page: Page): Promise<{ method: string; params?: unknown }[]> {
  return page.evaluate(
    () => (window as unknown as { __walletCalls: { method: string }[] }).__walletCalls,
  );
}

test.describe('wallet', () => {
  test('offers to connect, and connects', async ({ page }) => {
    await installMockWallet(page);
    await page.goto('/app');

    const connect = page.getByRole('button', { name: 'Connect wallet' }).first();
    await expect(connect).toBeVisible();

    await connect.click();
    const dialog = page.getByRole('dialog', { name: 'Connect a wallet' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Mock Wallet')).toBeVisible();

    await dialog.getByText('Mock Wallet').click();

    // The chip replaces the connect button in every mount point at once.
    await expect(page.getByText('0x83C1…65Bb').first()).toBeVisible();
    await expect(page.getByText('Monad Testnet').first()).toBeVisible();

    const methods = (await walletCalls(page)).map((call) => call.method);
    expect(methods).toContain('eth_requestAccounts');
    expect(methods).toContain('eth_chainId');
  });

  test('reconnects silently on the next page without prompting', async ({ page }) => {
    await installMockWallet(page);
    await page.goto('/app');
    await page.getByRole('button', { name: 'Connect wallet' }).first().click();
    await page.getByText('Mock Wallet').click();
    await expect(page.getByText('0x83C1…65Bb').first()).toBeVisible();

    await page.goto('/app/settlements');
    await expect(page.getByText('0x83C1…65Bb').first()).toBeVisible();

    // `eth_accounts` reports an existing authorisation; `eth_requestAccounts`
    // is what pops a dialog. A restore must never use the second one.
    const methods = (await walletCalls(page)).map((call) => call.method);
    expect(methods).toContain('eth_accounts');
    expect(methods).not.toContain('eth_requestAccounts');
  });

  /**
   * The participant panel reports both chains and offers to switch to neither.
   *
   * Conduit has no active network. A settlement uses both chains at once, and a
   * control that let you pick one would be inventing a mode the protocol does
   * not have — the switch belongs to the action that needs the chain, which is
   * where `runWrite` asks for it. This asserts the panel states both and stops
   * there; `settlement.spec.ts` covers the switch a real write triggers.
   */
  test('reports both chains without offering a network to choose', async ({ page }) => {
    // #given a wallet connected while pointing at Monad
    await installMockWallet(page, { chainId: MONAD });
    await page.goto('/app');
    await page.getByRole('button', { name: 'Connect wallet' }).first().click();
    await page.getByText('Mock Wallet').click();

    // #when the participant opens the account panel
    await page.locator('[data-participant] [data-account]').click();
    const account = page.getByRole('dialog', { name: 'Participant' });
    await expect(account).toBeVisible();
    await expect(account.getByText(ACCOUNT)).toBeVisible();

    // #then both chains are stated, and the one the wallet is on is marked
    const networks = account.locator('.stack-8', { hasText: 'Networks' });
    await expect(networks.getByText('Monad Testnet')).toBeVisible();
    await expect(networks.getByText('Base Sepolia')).toBeVisible();
    await expect(networks.getByText('wallet is here')).toBeVisible();

    // #then no switch was asked for, because nothing asked for a chain
    const calls = await walletCalls(page);
    expect(calls.map((call) => call.method)).not.toContain('wallet_switchEthereumChain');
  });

  test('disconnects', async ({ page }) => {
    await installMockWallet(page);
    await page.goto('/app');
    await page.getByRole('button', { name: 'Connect wallet' }).first().click();
    await page.getByText('Mock Wallet').click();
    await expect(page.getByText('0x83C1…65Bb').first()).toBeVisible();

    // The sidebar strip reports the same identity and offers no controls, so
    // the panel is opened from the one control that has them.
    await page.locator('[data-participant] [data-account]').click();
    await page.getByRole('button', { name: 'Disconnect' }).click();

    await expect(page.getByRole('button', { name: 'Connect wallet' }).first()).toBeVisible();
  });

  test('stays fully readable with no wallet at all', async ({ page }) => {
    await page.goto('/app/settlements');
    // The product is server-rendered; the absence of a wallet removes controls,
    // never content.
    await expect(page.getByRole('heading', { name: 'Settlements' })).toBeVisible();
    await expect(page.getByText('SETTLED').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect wallet' }).first()).toBeVisible();
  });
});

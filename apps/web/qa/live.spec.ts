/**
 * One real settlement, driven entirely from the deployed browser surface.
 *
 *   CONDUIT_LIVE=1 WEB_BASE_URL=https://tryconduit.xyz \
 *   LIVE_PRIVATE_KEY=0x… pnpm exec playwright test apps/web/qa/live.spec.ts
 *
 * Opt-in, and skipped by default, because it moves real value on two testnets
 * and waits out Base economic finality — observed between 999 and 1485 seconds
 * on this deployment. A gate that took half an hour would be a gate nobody runs,
 * and a settlement burned on every commit would be a chain full of noise.
 *
 * ## What makes this different from `settlement.spec.ts`
 *
 * Nothing is intercepted. The RPCs are the public endpoints, the compliance
 * answers come from Cleanverse through the deployed Worker, the guardian
 * signatures come from the guardian set, and every transaction is broadcast and
 * mined. The wallet is a real key signing real payloads; it is a bridge into
 * Node rather than a browser extension only because Playwright cannot drive one.
 *
 * Everything the browser does is the production code path: the resolver decides
 * each step from chain state, the executor refuses to advance until the effect
 * is observable, and the compliance proof is minted after finality and checked
 * against the coordinator before a wallet is asked for anything.
 */

import { expect, test, type Page } from '@playwright/test';
import { createWalletClient, http, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const LIVE = process.env['CONDUIT_LIVE'] === '1';
const KEY = process.env['LIVE_PRIVATE_KEY'] ?? '';

/**
 * Resume an existing settlement instead of composing a new one.
 *
 * A run that dies at minute forty leaves cash in escrow and a bond reserved, and
 * composing a fresh intent would abandon it. The workspace resolves the next
 * action from chain state, so resuming needs nothing but the id: whatever the
 * settlement still needs is what the panel offers.
 */
const RESUME = process.env['LIVE_SETTLEMENT_ID'] ?? '';

const MONAD: Chain = {
  id: 10_143,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: ['https://testnet-rpc.monad.xyz'] } },
};

const BASE: Chain = {
  id: 84_532,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia.base.org'] } },
};

function stamp(message: string): void {
  // Line-buffered, timestamped, because a forty-minute run that prints at the
  // end is a forty-minute run you cannot debug.
  process.stdout.write(`${new Date().toISOString()}  ${message}\n`);
}

/**
 * A wallet that signs and broadcasts for real.
 *
 * The chain a transaction goes to is decided by the chain the page last asked
 * for, exactly as a real wallet decides it — Conduit holds no app-wide network
 * and each action asks for the one it needs.
 */
async function installLiveWallet(page: Page): Promise<void> {
  const account = privateKeyToAccount(KEY as Hex);
  let current: Chain = MONAD;

  const clientFor = (chain: Chain) =>
    createWalletClient({ account, chain, transport: http(chain.rpcUrls.default.http[0]) });

  await page.exposeFunction('__liveSwitch', (chainIdHex: string) => {
    current = Number(chainIdHex) === BASE.id ? BASE : MONAD;
    stamp(`wallet switched to ${current.name}`);
    return null;
  });

  await page.exposeFunction('__liveChainId', () => `0x${current.id.toString(16)}`);

  await page.exposeFunction('__liveSign', async (raw: string) => {
    const payload = JSON.parse(raw) as {
      domain: Record<string, unknown>;
      types: Record<string, unknown>;
      primaryType: string;
      message: Record<string, unknown>;
    };
    const message: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload.message)) {
      message[key] =
        /^\d+$/.test(String(value)) && key !== 'version' && key !== 'leg'
          ? BigInt(String(value))
          : value;
    }
    if (typeof message['version'] === 'string') message['version'] = Number(message['version']);
    stamp(`signing ${payload.primaryType}`);
    return account.signTypedData({
      domain: payload.domain,
      types: payload.types,
      primaryType: payload.primaryType,
      message,
    });
  });

  await page.exposeFunction(
    '__liveSend',
    async (transaction: { to: Hex; data: Hex; value?: Hex }) => {
      const chain = current;
      const hash = await clientFor(chain).sendTransaction({
        account,
        chain,
        to: transaction.to,
        data: transaction.data,
        value: transaction.value === undefined ? 0n : BigInt(transaction.value),
      });
      // Printed at broadcast, not at completion.
      stamp(`broadcast on ${chain.name}: ${hash}`);
      return hash;
    },
  );

  await page.addInitScript((address: string) => {
    const bridge = window as unknown as {
      __liveSign: (raw: string) => Promise<string>;
      __liveSend: (transaction: unknown) => Promise<string>;
      __liveSwitch: (chainId: string) => Promise<null>;
      __liveChainId: () => Promise<string>;
    };
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [address];
          case 'eth_chainId':
            return bridge.__liveChainId();
          case 'wallet_switchEthereumChain': {
            const [{ chainId }] = params as [{ chainId: string }];
            return bridge.__liveSwitch(chainId);
          }
          case 'wallet_addEthereumChain':
            return null;
          case 'eth_signTypedData_v4': {
            const [, typed] = params as [string, string];
            return bridge.__liveSign(typed);
          }
          case 'eth_sendTransaction': {
            const [transaction] = params as [unknown];
            return bridge.__liveSend(transaction);
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
          detail: { info: { uuid: 'live', name: 'Live Wallet', icon: '' }, provider },
        }),
      );
    };
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, account.address);
}

const actionKind = '[data-action-host] .action-head .badge';

/** Waits for the panel to offer exactly this action, then takes it. */
async function runAction(page: Page, call: string, budgetMs = 300_000): Promise<void> {
  stamp(`waiting for ${call}`);
  const button = page.locator(`[data-action-run="${call}"]`);
  await expect(button).toBeEnabled({ timeout: budgetMs });
  stamp(`taking ${call}`);
  await button.click();
}

test.describe('live participant flow', () => {
  test.skip(!LIVE || KEY === '', 'set CONDUIT_LIVE=1 and LIVE_PRIVATE_KEY to run this');

  test('settles one real intent end to end from the browser', async ({ page }) => {
    // Base economic finality is the long pole and has run to 1485 seconds on
    // this deployment. The budget allows for the slowest observation plus the
    // eleven transactions around it.
    test.setTimeout(60 * 60 * 1000);

    const account = privateKeyToAccount(KEY as Hex);
    await installLiveWallet(page);

    stamp(`live run as ${account.address}`);
    let settlementId = RESUME;

    if (RESUME === '') {
      await page.goto('/app/settlements/new');
      await page.getByRole('button', { name: 'Connect wallet' }).first().click();
      await page.getByText('Live Wallet').click();
      await expect(page.getByText(`${account.address.slice(0, 6)}…`).first()).toBeVisible();

      // #given terms this wallet plays both sides of. `generate_apass` is 403 for
      // this credential (ASM-035), so no second A-Passed identity can exist.
      await page.locator('#f-role').selectOption('both');
      await page.locator('#f-cashAmount').fill('1');
      await page.locator('#f-assetAmount').fill('0.1');

      // #when Cleanverse is asked about every participant, for real
      await page.getByRole('button', { name: 'Check compliance' }).click();
      const review = page.getByRole('button', { name: 'Review and sign' });
      await expect(review).toBeEnabled({ timeout: 120_000 });
      stamp('compliance preflight passed');
      await review.click();

      await page.getByRole('button', { name: 'Sign with my wallet' }).click();
      await expect(page.locator('[data-sign-result]')).toContainText('SIGNED', {
        timeout: 120_000,
      });
      const link = (await page.locator('[data-sign-result] .nested').textContent()) ?? '';
      settlementId = /0x[0-9a-f]{64}/.exec(link)?.[0] ?? '';
      expect(settlementId).toMatch(/^0x[0-9a-f]{64}$/);
      stamp(`settlement ${settlementId}`);

      await page.goto(`/app/settlements/${settlementId}`);
      await expect(page.locator(actionKind)).toHaveText('RESERVE_ASSET', { timeout: 120_000 });

      await runAction(page, 'reserve-asset');
      await runAction(page, 'lock-cash');
    } else {
      stamp(`resuming ${settlementId}`);
      await page.goto(`/app/settlements/${settlementId}`);
      await page.getByRole('button', { name: 'Connect wallet' }).first().click();
      await page.getByText('Live Wallet').click();
      await expect(page.getByText(`${account.address.slice(0, 6)}…`).first()).toBeVisible();
    }

    // The wait that cannot be shortened. The adapter published ASSET_PREPARED
    // within seconds; the coordinator refuses it below FINALIZED.
    stamp('waiting for Base economic finality');

    await runAction(page, 'record-asset-prepared', 40 * 60 * 1000);
    stamp('finalized ASSET_PREPARED consumed — the settlement is READY');

    await runAction(page, 'run-fresh-compliance');
    await runAction(page, 'issue-commit');
    stamp('COMMIT issued — there is no refund from here');

    await runAction(page, 'release-cash');
    await runAction(page, 'release-asset', 15 * 60 * 1000);
    await runAction(page, 'report-resolution');
    await runAction(page, 'record-leg-resolved', 40 * 60 * 1000);

    // #then the coordinator's own enum is terminal
    await expect(page.locator(actionKind)).toHaveText(
      /SETTLEMENT_COMPLETE|VERIFICATION_INCOMPLETE/,
      {
        timeout: 300_000,
      },
    );
    stamp(`SETTLED: ${settlementId}`);
  });
});

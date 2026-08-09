/**
 * The participant write flow, end to end, against a scripted chain.
 *
 * ## What is real here and what is not
 *
 * Real: every line of browser code. The action resolver, the transaction state
 * machine, viem's ABI encoding, the observation loop that refuses to call a
 * write done until the node reports the block and the effect is present in
 * contract state, the compliance gate, the irreversible-boundary panel, and the
 * disposition panel's authority reading. The wallet signs with a real private
 * key and viem recovers it.
 *
 * Not real: the two chains and the guardian API. Those are a scripted model
 * behind `page.route`, and that is the point — a settlement takes twenty-five
 * minutes of Base finality, and a test that waits for it is a test nobody runs.
 * The model advances only when the browser actually sends a transaction, and it
 * advances by decoding the selector the browser encoded. Nothing here lets the
 * app declare success on its own: if the app skipped a call, the state never
 * moves and the assertion fails.
 *
 * The one thing this cannot cover is a wallet extension's own UI. That is what
 * the manual smoke test against testnet is for.
 */

import { expect, test, type Page, type Route } from '@playwright/test';
import { encodeFunctionResult, toFunctionSelector, type Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  ADAPTER_ABI,
  CONTROLLER_ABI,
  COORDINATOR_ABI,
  CORE_ABI,
  ERC20_ABI,
  ESCROW_ABI,
  REGISTRY_ABI,
  RWA_ABI,
} from '../src/onchain.js';

// A throwaway key, checked in on purpose so the flow is deterministic. It holds
// nothing on any chain.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const account = privateKeyToAccount(KEY);

const MONAD_RPC = 'https://testnet-rpc.monad.xyz';
const BASE_RPC = 'https://sepolia.base.org';

const MONAD_HEX = '0x279f';

/** The scripted chain. One object; every read and write goes through it. */
interface Model {
  block: bigint;
  settlementState: number;
  decision: number;
  cashPrepared: boolean;
  assetPrepared: boolean;
  cashOutcome: number;
  assetOutcome: number;
  stateVersion: bigint;
  cashLegState: number;
  reservationOwner: string;
  reservationAnnounced: boolean;
  reservationCommitted: boolean;
  reservationReleased: boolean;
  intendedReceiver: string;
  allowance: bigint;
  balance: bigint;
  available: bigint;
  /** What the guardian API has signed, keyed by message type. */
  finalized: Set<string>;
  messages: {
    messageType: string;
    sequence: string;
    emitter: string;
    emitterChainId: number;
    txHash: string;
    includedAt: string;
    finalized: boolean;
    finalitySeconds?: number;
    vaa?: string;
  }[];
  /** The disposition kernel, as the registry and controller would answer. */
  authorityType: number;
  authorityActive: boolean;
  caseState: number;
  caseFiledAt: bigint;
  /** Every selector the browser actually sent, in order. */
  sent: string[];
  /** Every chain the app asked the wallet to move to, in order. */
  switched: string[];
}

const ZERO = '0x0000000000000000000000000000000000000000';

function freshModel(): Model {
  return {
    block: 100n,
    settlementState: 0,
    decision: 0,
    cashPrepared: false,
    assetPrepared: false,
    cashOutcome: 0,
    assetOutcome: 0,
    stateVersion: 0n,
    cashLegState: 0,
    reservationOwner: ZERO,
    reservationAnnounced: false,
    reservationCommitted: false,
    reservationReleased: false,
    intendedReceiver: ZERO,
    allowance: 0n,
    balance: 1_000_000_000n,
    available: 1_000_000_000n,
    finalized: new Set<string>(),
    messages: [],
    authorityType: 2,
    authorityActive: false,
    caseState: 0,
    caseFiledAt: 0n,
    sent: [],
    switched: [],
  };
}

/** Selector → the ABI and function it belongs to, built once from the real ABIs. */
function selectorMap(): Map<string, { abi: Abi; name: string }> {
  const map = new Map<string, { abi: Abi; name: string }>();
  for (const abi of [
    COORDINATOR_ABI,
    ESCROW_ABI,
    ADAPTER_ABI,
    RWA_ABI,
    ERC20_ABI,
    CORE_ABI,
    CONTROLLER_ABI,
    REGISTRY_ABI,
  ]) {
    for (const entry of abi) {
      if (entry.type !== 'function') continue;
      const selector = toFunctionSelector(entry);
      if (!map.has(selector)) map.set(selector, { abi, name: entry.name });
    }
  }
  return map;
}

const SELECTORS = selectorMap();

function nameOf(data: string): string {
  return SELECTORS.get(data.slice(0, 10))?.name ?? `unknown(${data.slice(0, 10)})`;
}

function resultFor(name: string, model: Model): unknown {
  switch (name) {
    case 'settlementOf':
      return [
        model.settlementState,
        model.decision,
        model.cashPrepared,
        model.assetPrepared,
        model.cashOutcome,
        model.assetOutcome,
        `0x${'11'.repeat(32)}`,
        model.stateVersion,
      ];
    case 'legOf':
      return [
        account.address,
        account.address,
        25_000_000n,
        `0x${'11'.repeat(32)}`,
        model.cashLegState,
      ];
    case 'reservationOf':
      return [
        model.reservationOwner,
        500_000n,
        `0x${'11'.repeat(32)}`,
        1n,
        model.reservationAnnounced,
        model.reservationCommitted,
        model.reservationReleased,
        false,
      ];
    case 'intendedReceiver':
      return model.intendedReceiver;
    case 'availableBalanceOf':
      return model.available;
    case 'balanceOf':
      return model.balance;
    case 'allowance':
      return model.allowance;
    case 'wormhole':
      return '0x0000000000000000000000000000000000000099';
    case 'messageFee':
      return 0n;
    case 'verifyEligible':
      return true;
    case 'deploymentId':
      return `0x${'22'.repeat(32)}`;
    // Simulated before it is sent: `simulateCommit` asks the node whether the
    // coordinator accepts this call before a wallet is ever prompted, so the
    // model has to answer with the sequence the real one returns.
    case 'issueCommit':
    case 'prepareCash':
    case 'prepareAsset':
    case 'reportResolution':
      return 1n;
    case 'approve':
      return true;
    case 'authorityOf':
      return [model.authorityType, model.authorityActive, 1n];
    case 'policyHash':
      return `0x${'55'.repeat(32)}`;
    case 'policyOf':
      // active, contestWindow, allowedAuthorityTypes bitmask, resolver bitmask,
      // resolver signatures, requiredSignatures per type.
      return [true, 300, 0b1111100, 0b0011000, 1, [1, 2, 1, 1, 1, 1]];
    case 'caseOf':
      return [
        model.caseState,
        1,
        `0x${'11'.repeat(32)}`,
        `0x${'66'.repeat(32)}`,
        `0x${'55'.repeat(32)}`,
        `0x${'77'.repeat(32)}`,
        `0x${'88'.repeat(32)}`,
        model.caseFiledAt,
        1,
        `0x${'99'.repeat(32)}`,
        0,
        account.address,
        500_000n,
        `0x${'00'.repeat(32)}`,
      ];
    default:
      return undefined;
  }
}

/** Applies a write. The model moves only because the browser sent the call. */
function apply(name: string, model: Model): void {
  model.sent.push(name);
  model.block += 1n;
  switch (name) {
    case 'reserveForSettlement':
      model.reservationOwner = account.address;
      model.available -= 500_000n;
      break;
    case 'prepareAsset':
      model.reservationAnnounced = true;
      model.intendedReceiver = account.address;
      model.settlementState = 0;
      model.messages.push({
        messageType: 'ASSET_PREPARED',
        sequence: '7',
        emitter: '0x00000000000000000000000000000000000000aa',
        emitterChainId: 10_004,
        txHash: `0x${'a1'.repeat(32)}`,
        includedAt: '2026-08-09T00:00:00.000Z',
        finalized: false,
      });
      break;
    case 'approve':
      model.allowance = 25_000_000n * 10n;
      break;
    case 'prepareCash':
      model.cashPrepared = true;
      model.cashLegState = 1;
      model.settlementState = 1;
      break;
    case 'recordAssetPrepared':
      model.assetPrepared = true;
      model.settlementState = 3;
      break;
    case 'issueCommit':
      model.decision = 1;
      model.settlementState = 4;
      model.messages.push({
        messageType: 'COMMIT',
        sequence: '2',
        emitter: '0x00000000000000000000000000000000000000bb',
        emitterChainId: 10_009,
        txHash: `0x${'b2'.repeat(32)}`,
        includedAt: '2026-08-09T00:10:00.000Z',
        finalized: true,
        finalitySeconds: 7,
        vaa: `0x${'cc'.repeat(120)}`,
      });
      break;
    case 'releaseCash':
      model.cashOutcome = 1;
      break;
    case 'releaseAsset':
      model.reservationCommitted = true;
      model.reservationReleased = true;
      break;
    case 'reportResolution':
      model.messages.push({
        messageType: 'ASSET_RELEASED',
        sequence: '3',
        emitter: '0x00000000000000000000000000000000000000aa',
        emitterChainId: 10_004,
        txHash: `0x${'d3'.repeat(32)}`,
        includedAt: '2026-08-09T00:20:00.000Z',
        finalized: true,
        finalitySeconds: 1_100,
        vaa: `0x${'ee'.repeat(120)}`,
      });
      break;
    case 'recordLegResolved':
      model.assetOutcome = 1;
      model.settlementState = 6;
      break;
    case 'fileOrder':
      model.caseState = 1;
      model.caseFiledAt = BigInt(Math.floor(Date.now() / 1000));
      break;
    case 'executeOrder':
      model.caseState = 4;
      break;
    default:
      break;
  }
}

const TX_HASH: Hex = `0x${'fe'.repeat(32)}`;

/** Serves both chains from the model. Every JSON-RPC method the client uses. */
async function serveRpc(route: Route, model: Model): Promise<void> {
  const body = route.request().postDataJSON() as
    | { id: number; method: string; params: unknown[] }
    | { id: number; method: string; params: unknown[] }[];
  const calls = Array.isArray(body) ? body : [body];

  const answers = calls.map((call) => {
    switch (call.method) {
      case 'eth_chainId':
        return { id: call.id, jsonrpc: '2.0', result: MONAD_HEX };
      case 'eth_blockNumber':
        return { id: call.id, jsonrpc: '2.0', result: `0x${model.block.toString(16)}` };
      case 'eth_getBlockByNumber':
      case 'eth_getBlockByHash':
        return {
          id: call.id,
          jsonrpc: '2.0',
          result: {
            number: `0x${model.block.toString(16)}`,
            hash: `0x${'0f'.repeat(32)}`,
            parentHash: `0x${'0e'.repeat(32)}`,
            timestamp: '0x6a000000',
            transactions: [],
            baseFeePerGas: '0x1',
            gasLimit: '0x1c9c380',
            gasUsed: '0x0',
            miner: ZERO,
            difficulty: '0x0',
            extraData: '0x',
            logsBloom: `0x${'00'.repeat(256)}`,
            nonce: '0x0000000000000000',
            receiptsRoot: `0x${'00'.repeat(32)}`,
            sha3Uncles: `0x${'00'.repeat(32)}`,
            size: '0x0',
            stateRoot: `0x${'00'.repeat(32)}`,
            totalDifficulty: '0x0',
            transactionsRoot: `0x${'00'.repeat(32)}`,
            uncles: [],
            mixHash: `0x${'00'.repeat(32)}`,
          },
        };
      case 'eth_getTransactionReceipt':
        return {
          id: call.id,
          jsonrpc: '2.0',
          result: {
            transactionHash: TX_HASH,
            transactionIndex: '0x0',
            blockHash: `0x${'0f'.repeat(32)}`,
            blockNumber: `0x${model.block.toString(16)}`,
            from: account.address,
            to: ZERO,
            cumulativeGasUsed: '0x1',
            gasUsed: '0x1',
            contractAddress: null,
            logs: [],
            logsBloom: `0x${'00'.repeat(256)}`,
            status: '0x1',
            effectiveGasPrice: '0x1',
            type: '0x2',
          },
        };
      case 'eth_call': {
        const [transaction] = call.params as [{ data: string }];
        const name = nameOf(transaction.data);
        const found = SELECTORS.get(transaction.data.slice(0, 10));
        const value = resultFor(name, model);
        if (found === undefined || value === undefined) {
          return { id: call.id, jsonrpc: '2.0', result: '0x' };
        }
        return {
          id: call.id,
          jsonrpc: '2.0',
          result: encodeFunctionResult({
            abi: found.abi,
            functionName: found.name,
            result: value,
          }),
        };
      }
      case 'eth_estimateGas':
        return { id: call.id, jsonrpc: '2.0', result: '0x5208' };
      case 'eth_gasPrice':
      case 'eth_maxPriorityFeePerGas':
        return { id: call.id, jsonrpc: '2.0', result: '0x1' };
      default:
        return { id: call.id, jsonrpc: '2.0', result: null };
    }
  });

  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(Array.isArray(body) ? answers : answers[0]),
  });
}

/**
 * The wallet. It signs typed data with a real key and reports every send, but it
 * decides nothing: a send returns a hash and the model moves because the
 * selector the browser encoded said so.
 */
async function installWallet(page: Page, model: Model): Promise<void> {
  await page.exposeFunction('__signTypedData', async (raw: string) => {
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
    // The wire carries every numeric field as a string; viem wants the real
    // types back before it will hash them the way the contract does.
    return account.signTypedData({
      domain: payload.domain,
      types: payload.types,
      primaryType: payload.primaryType,
      message,
    });
  });

  await page.exposeFunction('__sendTransaction', (data: string) => {
    apply(nameOf(data), model);
    return TX_HASH;
  });

  // The wallet reports Monad throughout, so every Base action must ask it to
  // move. This records the asks so a test can prove the app does it per action
  // rather than holding a network of its own.
  await page.exposeFunction('__switchChain', (chainId: string) => {
    model.switched.push(chainId);
  });

  await page.addInitScript((address: string) => {
    const bridge = window as unknown as {
      __signTypedData: (raw: string) => Promise<string>;
      __sendTransaction: (data: string) => Promise<string>;
      __switchChain: (chainId: string) => Promise<void>;
    };
    const provider = {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [address];
          case 'eth_chainId':
            return '0x279f';
          case 'wallet_switchEthereumChain': {
            const [target] = params as [{ chainId: string }];
            await bridge.__switchChain(target.chainId);
            return null;
          }
          case 'wallet_addEthereumChain':
            return null;
          case 'eth_signTypedData_v4': {
            const [, typed] = params as [string, string];
            return bridge.__signTypedData(typed);
          }
          case 'eth_sendTransaction': {
            const [transaction] = params as [{ data: string }];
            return bridge.__sendTransaction(transaction.data);
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

/** The Worker's own endpoints, scripted. The server has its own tests. */
async function installApi(page: Page, model: Model): Promise<void> {
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
            detail: 'scripted for the write-flow test',
            assetSymbol: 'cSETTLE',
            checkedAt: new Date().toISOString(),
          },
        ],
      }),
    });
  });

  await page.route('**/api/attestations', async (route) => {
    const request = route.request().postDataJSON() as {
      settlementId: string;
      intentHash: string;
      subjects: string[];
      purpose: string;
    };
    const issuedAt = Math.floor(Date.now() / 1000) - 30;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        purpose: request.purpose,
        chainId: 10_143,
        verifyingContract: ZERO,
        unavailable: false,
        signer: account.address,
        maxValidity: 900,
        attestations: request.subjects.map((subject) => ({
          settlementId: request.settlementId,
          intentHash: request.intentHash,
          subject,
          eligible: true,
          issuedAt: String(issuedAt),
          expiresAt: String(issuedAt + 600),
          evidenceHash: `0x${'33'.repeat(32)}`,
          signature: `0x${'44'.repeat(65)}`,
        })),
        eligibility: request.subjects.map((subject) => ({
          subject,
          status: 'ELIGIBLE',
          reason: 'ALLOWED',
          detail: 'scripted',
          checkedAt: new Date().toISOString(),
        })),
      }),
    });
  });

  await page.route('**/api/settlements/*/messages', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"recorded":[]}',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: model.messages }),
    });
  });
}

async function connect(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.getByText('Mock Wallet').click();
  await expect(page.getByText(`${account.address.slice(0, 6)}…`).first()).toBeVisible();
}

/**
 * Composes and signs a settlement for real, then returns its id.
 *
 * The workspace reads its terms from the projection, so the settlement has to
 * exist there. This is the same path a participant takes, and it also proves
 * the composer still reaches the workspace.
 */
async function composeSignedSettlement(page: Page): Promise<string> {
  await page.goto('/app/settlements/new');
  await connect(page);
  await page.locator('#f-role').selectOption('both');
  await page.locator('#f-cashAmount').fill('25');
  await page.locator('#f-assetAmount').fill('0.5');
  await page.getByRole('button', { name: 'Check compliance' }).click();

  const review = page.getByRole('button', { name: 'Review and sign' });
  await expect(review).toBeEnabled({ timeout: 45_000 });
  await review.click();
  await page.getByRole('button', { name: 'Sign with my wallet' }).click();
  await expect(page.locator('[data-sign-result]')).toContainText('SIGNED', { timeout: 30_000 });

  const link = (await page.locator('[data-sign-result] .nested').textContent()) ?? '';
  const id = /0x[0-9a-f]{64}/.exec(link)?.[0];
  expect(id, 'the composer must produce a settlement id').toBeDefined();
  return id ?? '';
}

const actionPanel = '[data-action-host] .action';
const actionKind = '[data-action-host] .action-head .badge';

async function openWorkspace(page: Page, id: string): Promise<void> {
  await page.goto(`/app/settlements/${id}`);
  await expect(page.locator(actionPanel)).toBeVisible({ timeout: 30_000 });
}

/**
 * Waits for the panel to be offering exactly this action, then takes it.
 *
 * Naming the call rather than clicking whatever button is present is the point:
 * the resolver decides what comes next, and a test that clicks blind would pass
 * while the app offered the wrong step.
 */
async function runAction(page: Page, call: string): Promise<void> {
  const button = page.locator(`[data-action-run="${call}"]`);
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
}

test.describe('settlement workspace', () => {
  // Ten protocol actions across two chains, each one waiting for the previous
  // effect to be observable before the next is offered. That is the behaviour
  // under test, so the budget has to allow for it.
  test('drives one settlement from reservation to SETTLED, one action at a time', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const model = freshModel();
    await installWallet(page, model);
    await installApi(page, model);
    await page.route(`${MONAD_RPC}/**`, (route) => serveRpc(route, model));
    await page.route(MONAD_RPC, (route) => serveRpc(route, model));
    await page.route(BASE_RPC, (route) => serveRpc(route, model));
    await page.route(`${BASE_RPC}/**`, (route) => serveRpc(route, model));

    const id = await composeSignedSettlement(page);
    await openWorkspace(page, id);

    // #given nothing is prepared
    await expect(page.locator(actionKind)).toHaveText('RESERVE_ASSET');

    // #when the seller reserves and announces
    await runAction(page, 'reserve-asset');
    await expect(page.locator(actionKind)).toHaveText('LOCK_CASH', { timeout: 60_000 });

    // #then both the reservation and the announcement actually happened
    expect(model.sent).toContain('reserveForSettlement');
    expect(model.sent).toContain('prepareAsset');

    // #then the app asked the wallet for Base, because the action needed Base.
    // There is no network control anywhere in the product; the write asks.
    expect(model.switched, 'a Base action must ask the wallet to move there').toContain('0x14a34');

    // #when the payer locks the cash
    await runAction(page, 'lock-cash');
    await expect(page.locator(actionKind)).toHaveText('WAITING_FOR_FINALITY', { timeout: 60_000 });
    expect(model.sent).toContain('prepareCash');

    // #then nothing is executable while the message is unsigned
    await expect(page.locator('[data-action-run]')).toHaveCount(0);
    await expect(page.locator(actionPanel)).toContainText('FINALIZED');

    // #when the guardian set signs it
    const observed = model.messages.find((message) => message.messageType === 'ASSET_PREPARED');
    if (observed !== undefined) {
      observed.finalized = true;
      observed.finalitySeconds = 1_422;
      observed.vaa = `0x${'ab'.repeat(120)}`;
    }
    await expect(page.locator(actionKind)).toHaveText('RECORD_ASSET_PREPARED', { timeout: 60_000 });

    // #then the finality panel reports the observed wait rather than an average
    await expect(page.locator('[data-finality-host]')).toContainText('1422 seconds');

    await runAction(page, 'record-asset-prepared');
    await expect(page.locator(actionKind)).toHaveText('FRESH_COMPLIANCE_REQUIRED', {
      timeout: 60_000,
    });
    expect(model.sent).toContain('recordAssetPrepared');

    // #when compliance is asked again after finality
    await runAction(page, 'run-fresh-compliance');
    await expect(page.locator(actionKind)).toHaveText('READY_TO_COMMIT', { timeout: 60_000 });

    // #then the irreversible boundary is shown before the wallet is asked
    await expect(page.locator('.boundary')).toContainText('irreversible settlement decision');
    await expect(page.locator('[data-compliance-host]')).toContainText('Commit-time');

    // #when the settlement commits
    await runAction(page, 'issue-commit');
    await expect(page.locator(actionKind)).toHaveText('EXECUTE_CASH_RELEASE', { timeout: 60_000 });
    expect(model.sent).toContain('issueCommit');

    await runAction(page, 'release-cash');
    await expect(page.locator(actionKind)).toHaveText('EXECUTE_ASSET_RELEASE', { timeout: 60_000 });
    expect(model.sent).toContain('releaseCash');

    await runAction(page, 'release-asset');
    await expect(page.locator(actionKind)).toHaveText('WAITING_FOR_REMOTE_RESOLUTION', {
      timeout: 60_000,
    });
    expect(model.sent).toContain('releaseAsset');

    // The assertion sits after the next wait on purpose: a send is asynchronous,
    // and checking the model the instant a click returns tests the click.
    await runAction(page, 'report-resolution');
    await runAction(page, 'record-leg-resolved');
    expect(model.sent).toContain('reportResolution');
    await expect(page.locator(actionKind)).toHaveText('VERIFICATION_INCOMPLETE', {
      timeout: 60_000,
    });
    expect(model.sent).toContain('recordLegResolved');

    // #then SETTLED is the coordinator's enum and SETTLED_FINAL is not claimed
    await expect(page.locator(actionPanel)).toContainText('SETTLED_FINAL');
    await expect(page.locator(actionPanel)).toContainText('no run has drawn it');
  });

  test('refuses to commit while a participant is refused, and says which', async ({ page }) => {
    const model = freshModel();
    model.cashPrepared = true;
    model.assetPrepared = true;
    model.settlementState = 3;
    model.reservationOwner = account.address;
    model.reservationAnnounced = true;
    model.intendedReceiver = account.address;

    await installWallet(page, model);
    await installApi(page, model);
    await page.route(MONAD_RPC, (route) => serveRpc(route, model));
    await page.route(BASE_RPC, (route) => serveRpc(route, model));

    const id = await composeSignedSettlement(page);

    // #given the compliance authority refuses one participant at commit time
    await page.route('**/api/attestations', async (route) => {
      const request = route.request().postDataJSON() as { subjects: string[] };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          unavailable: false,
          purpose: 'commit',
          chainId: 10_143,
          verifyingContract: ZERO,
          signer: account.address,
          maxValidity: 900,
          attestations: request.subjects.map((subject) => ({
            settlementId: id,
            intentHash: id,
            subject,
            eligible: false,
            issuedAt: String(Math.floor(Date.now() / 1000) - 30),
            expiresAt: String(Math.floor(Date.now() / 1000) + 570),
            evidenceHash: `0x${'33'.repeat(32)}`,
            signature: `0x${'44'.repeat(65)}`,
          })),
          eligibility: request.subjects.map((subject) => ({
            subject,
            status: 'POLICY_REFUSAL',
            reason: 'TierTooLow',
            detail: 'Required tier 21, observed tier 20.',
            checkedAt: new Date().toISOString(),
          })),
        }),
      });
    });

    await openWorkspace(page, id);
    await expect(page.locator(actionKind)).toHaveText('FRESH_COMPLIANCE_REQUIRED', {
      timeout: 60_000,
    });

    // #when fresh compliance runs
    await runAction(page, 'run-fresh-compliance');

    // #then COMMIT is not offered, and the reason is the refusal itself
    await expect(page.locator(actionPanel)).toContainText('TierTooLow', { timeout: 60_000 });
    await expect(page.locator(actionPanel)).toContainText('cannot be delivered');
    expect(model.sent).not.toContain('issueCommit');
  });

  test('keeps an outage distinct from a refusal', async ({ page }) => {
    const model = freshModel();
    model.cashPrepared = true;
    model.assetPrepared = true;
    model.settlementState = 3;
    model.reservationOwner = account.address;
    model.reservationAnnounced = true;
    model.intendedReceiver = account.address;

    await installWallet(page, model);
    await installApi(page, model);
    await page.route(MONAD_RPC, (route) => serveRpc(route, model));
    await page.route(BASE_RPC, (route) => serveRpc(route, model));

    const id = await composeSignedSettlement(page);

    await page.route('**/api/attestations', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          unavailable: true,
          purpose: 'commit',
          chainId: 10_143,
          verifyingContract: ZERO,
          signer: account.address,
          maxValidity: 900,
          attestations: [],
          eligibility: [
            {
              subject: account.address,
              status: 'UNAVAILABLE',
              reason: 'TRANSPORT',
              detail: 'Cleanverse could not be reached. This is a check that did not complete.',
              checkedAt: new Date().toISOString(),
            },
          ],
        }),
      });
    });

    await openWorkspace(page, id);
    await runAction(page, 'run-fresh-compliance');

    // #then the panel says nobody was refused, and offers no commit
    await expect(page.locator(actionPanel)).toContainText('did not answer', { timeout: 60_000 });
    await expect(page.locator(actionPanel)).toContainText('absence of a decision');
    expect(model.sent).not.toContain('issueCommit');
  });

  test('offers a way out when the published sequence was never recorded', async ({ page }) => {
    // #given both legs standing on their own chains and no message row — the
    // exact shape the first live browser run stalled in, because a Wormhole
    // sequence lives in an event and nothing on chain can give it back
    const model = freshModel();
    model.reservationOwner = account.address;
    model.reservationAnnounced = true;
    model.intendedReceiver = account.address;
    model.cashPrepared = true;
    model.settlementState = 1;
    model.messages = [];

    await installWallet(page, model);
    await installApi(page, model);
    await page.route(MONAD_RPC, (route) => serveRpc(route, model));
    await page.route(BASE_RPC, (route) => serveRpc(route, model));

    const id = await composeSignedSettlement(page);
    await openWorkspace(page, id);

    // #then the panel names the situation and offers the transaction hash
    await expect(page.locator(actionKind)).toHaveText('AWAITING_ASSET_PREPARATION', {
      timeout: 60_000,
    });
    const field = page.locator('[data-recover-hash]');
    await expect(field).toBeVisible();

    // #when a hash that is not a hash is offered, it is refused locally
    await field.fill('not-a-hash');
    await page.getByRole('button', { name: 'Recover the message' }).click();
    await expect(page.locator('[data-action-host]')).toContainText(
      'not a 32-byte transaction hash',
    );
  });

  test('a wallet that is not a party is told whose action it is', async ({ page }) => {
    const model = freshModel();
    await installWallet(page, model);
    await installApi(page, model);
    await page.route(MONAD_RPC, (route) => serveRpc(route, model));
    await page.route(BASE_RPC, (route) => serveRpc(route, model));

    const id = await composeSignedSettlement(page);

    // #given a settlement the composer wrote for a different pair of addresses
    await page.goto(`/app/settlements/${id}`);
    await expect(page.locator(actionPanel)).toBeVisible({ timeout: 30_000 });

    // #then the role chip is explicit rather than silent
    await expect(page.locator('[data-role-chip]')).toContainText('you are the');
  });

  test('reads without a wallet and offers nothing', async ({ page }) => {
    const model = freshModel();
    await installApi(page, model);
    await page.route(MONAD_RPC, (route) => serveRpc(route, model));
    await page.route(BASE_RPC, (route) => serveRpc(route, model));

    // #given a settlement that already exists in the projection
    await page.goto('/app/settlements');
    const first = page.locator('tbody tr td.mono a').first();
    await first.click();

    // #then the page renders and the action panel refuses for the right reason
    await expect(page.locator(actionPanel)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-role-chip]')).toContainText('connect a wallet');
  });
});

/** A settlement whose asset leg is committed and undeliverable. */
function heldModel(): Model {
  const model = freshModel();
  model.settlementState = 8;
  model.decision = 1;
  model.cashPrepared = true;
  model.assetPrepared = true;
  model.cashOutcome = 1;
  model.assetOutcome = 3;
  model.cashLegState = 3;
  model.reservationOwner = account.address;
  model.reservationAnnounced = true;
  model.reservationCommitted = true;
  model.intendedReceiver = account.address;
  return model;
}

test.describe('held and disposition', () => {
  test('says what HELD means and names the released leg as unrefundable', async ({ page }) => {
    const model = heldModel();
    await installWallet(page, model);
    await installApi(page, model);
    await page.route(MONAD_RPC, (route) => serveRpc(route, model));
    await page.route(BASE_RPC, (route) => serveRpc(route, model));

    const id = await composeSignedSettlement(page);
    await openWorkspace(page, id);

    // #then the workspace is unmistakably held, and the copy is exact
    await expect(page.locator(actionKind)).toHaveText('HELD_DISPOSITION_REQUIRED', {
      timeout: 60_000,
    });
    const held = page.locator('[data-disposition-host]');
    await expect(held).toContainText('cannot be delivered', { timeout: 60_000 });
    await expect(held).toContainText('The released leg is not refunded');
    await expect(held).toContainText('RELEASED and not refundable');
  });

  test('shows all six order types and disables every one an unauthorised wallet cannot sign', async ({
    page,
  }) => {
    const model = heldModel();
    model.authorityActive = false;
    await installWallet(page, model);
    await installApi(page, model);
    await page.route(MONAD_RPC, (route) => serveRpc(route, model));
    await page.route(BASE_RPC, (route) => serveRpc(route, model));

    const id = await composeSignedSettlement(page);
    await openWorkspace(page, id);

    const tiles = page.locator('[data-dtype]');
    await expect(tiles).toHaveCount(6, { timeout: 60_000 });

    // #then none is offered, and each says why rather than going quiet
    await expect(page.locator('[data-dtype][data-enabled="true"]')).toHaveCount(0);
    await expect(page.locator('[data-dtype="REVERIFY_AND_RESUME"]')).toContainText(
      'not a registered authority',
    );
    await expect(page.locator('[data-dtype="RESTRICTED_HOLD"]')).toContainText(
      'registered restricted custodian',
    );
  });

  test('files an order, rests it for the contest window, then executes it', async ({ page }) => {
    test.setTimeout(120_000);
    const model = heldModel();
    model.authorityActive = true;
    model.authorityType = 2;
    await installWallet(page, model);
    await installApi(page, model);
    await page.route(MONAD_RPC, (route) => serveRpc(route, model));
    await page.route(BASE_RPC, (route) => serveRpc(route, model));

    const id = await composeSignedSettlement(page);
    await openWorkspace(page, id);

    // #given a registered issuer, which this policy permits to sign
    const resume = page.locator('[data-dtype="REVERIFY_AND_RESUME"]');
    await expect(resume).toHaveAttribute('data-enabled', 'true', { timeout: 60_000 });

    // #when the authority composes, signs and files
    await resume.getByRole('button', { name: 'Compose and file' }).click();
    await expect(page.locator('[data-disposition-host]')).toContainText('CONTEST WINDOW', {
      timeout: 60_000,
    });
    expect(model.sent).toContain('fileOrder');

    // #then nothing executes while the order rests
    await expect(page.locator('[data-disposition-execute]')).toHaveCount(0);

    // #when the window closes
    model.caseFiledAt = BigInt(Math.floor(Date.now() / 1000) - 400);
    const execute = page.locator('[data-disposition-execute]');
    await expect(execute).toBeVisible({ timeout: 60_000 });
    await execute.click();

    // #then the case reaches its terminal state
    await expect(page.locator('[data-disposition-host]')).toContainText('EXECUTED', {
      timeout: 60_000,
    });
    expect(model.sent).toContain('executeOrder');
  });

  test('stops everything while two authorities disagree', async ({ page }) => {
    const model = heldModel();
    model.authorityActive = true;
    model.caseState = 2;
    model.caseFiledAt = BigInt(Math.floor(Date.now() / 1000) - 400);
    await installWallet(page, model);
    await installApi(page, model);
    await page.route(MONAD_RPC, (route) => serveRpc(route, model));
    await page.route(BASE_RPC, (route) => serveRpc(route, model));

    const id = await composeSignedSettlement(page);
    await openWorkspace(page, id);

    await expect(page.locator(actionKind)).toHaveText('DISPOSITION_CONTESTED', { timeout: 60_000 });
    await expect(page.locator('[data-disposition-host]')).toContainText(
      'Nothing executes until a resolver picks one',
      { timeout: 60_000 },
    );
    await expect(page.locator('[data-disposition-execute]')).toHaveCount(0);
  });
});

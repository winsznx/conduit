#!/usr/bin/env node
/**
 * Mints real aUSDC by depositing origin USDC. PRD 19 phase 01.
 *
 * The phase 01 gate needs a *real* A-Token, and the two obvious sources are
 * both closed: `generate_apass` answers 403 for this credential, and `/faucet`
 * reaches its transfer and reverts `ERC20InsufficientBalance` on its own source
 * wallet `0xc448042e…` with a balance of zero. Neither is our bug and neither is
 * worth working around.
 *
 * The path that is open is the ordinary one. `POST /query_deposit_address`
 * returns a per-user deposit wallet when called with `address`, and returns a
 * shared institution wallet when called without it — a difference worth naming,
 * because depositing to the shared wallet credits nobody in particular.
 *
 *   query_deposit_address { chain, symbol }            → 0x15fd89cf…  shared
 *   query_deposit_address { chain, symbol, address }   → 0x97E6103C…  ours
 *
 * Send USDC there, Cleanverse mints aUSDC to the depositor. This script sends,
 * waits for the mint, and reports the exact deltas on both tokens.
 *
 *   node --env-file=.env scripts/fund-cash-leg.mjs [amount-in-usdc]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ROOT } from './lib/run.mjs';

const ORIGIN_USDC = '0x534b2f3A21130d7a60830c2Df862319e593943A3';
const A_USDC = process.env['MONAD_CASH_ATOKEN'];
const DECIMALS = 6;

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
]);

const amount = parseUnits(process.argv[2] ?? '10', DECIMALS);

const account = privateKeyToAccount(process.env['DEPLOYER_PRIVATE_KEY']);
const transport = http(process.env['MONAD_TESTNET_RPC_URL']);
const pub = createPublicClient({ transport });
const wallet = createWalletClient({ account, transport, chain: { id: 10143 } });

const base = process.env['CLEANVERSE_BASE_URL'];
if (new URL(base).host !== 'uatapi.cleanverse.com') {
  throw new Error('refusing to send Cleanverse credentials to a non-Cleanverse host');
}

async function depositWalletFor(address) {
  const response = await fetch(`${base}/query_deposit_address`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Request-ID': crypto.randomUUID(),
      'api-id': process.env['CLEANVERSE_API_ID'],
    },
    body: JSON.stringify({ chain: 'monad', symbol: 'usdc', address }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json();
  if (body.code !== '0000') throw new Error(`query_deposit_address: ${body.code} ${body.message}`);
  // The echoed address is the check that matters: a response carrying an empty
  // `address` is the shared institution wallet, and depositing there credits
  // nobody. Failing here beats sending real value to a wallet we do not own.
  if (body.data.address?.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`deposit address is not bound to ${address}; got "${body.data.address}"`);
  }
  return body.data.depositUSDCWallet;
}

const balances = async () => ({
  usdc: await pub.readContract({
    address: ORIGIN_USDC,
    abi: ERC20,
    functionName: 'balanceOf',
    args: [account.address],
  }),
  aUsdc: await pub.readContract({
    address: A_USDC,
    abi: ERC20,
    functionName: 'balanceOf',
    args: [account.address],
  }),
});

const fmt = (v) => `${formatUnits(v, DECIMALS)}`;

const chainId = await pub.getChainId();
if (chainId !== 10143) throw new Error(`RPC reports chain ${chainId}, expected 10143`);

const depositWallet = await depositWalletFor(account.address);
const before = await balances();

console.log(`Monad Testnet ${chainId}`);
console.log(`depositor      ${account.address}`);
console.log(`deposit wallet ${depositWallet}`);
console.log(`before         USDC ${fmt(before.usdc)}   aUSDC ${fmt(before.aUsdc)}`);

if (before.usdc < amount) {
  console.error(`insufficient USDC: have ${fmt(before.usdc)}, need ${fmt(amount)}`);
  process.exit(1);
}

const hash = await wallet.writeContract({
  address: ORIGIN_USDC,
  abi: ERC20,
  functionName: 'transfer',
  args: [depositWallet, amount],
});
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`deposit        ${receipt.status}  ${hash}`);

/** Minting is Cleanverse-side and asynchronous, so poll rather than assume. */
let after = await balances();
const deadline = Date.now() + 300_000;
while (after.aUsdc === before.aUsdc && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  after = await balances();
  process.stdout.write('.');
}
console.log('');

const minted = after.aUsdc - before.aUsdc;
console.log(`after          USDC ${fmt(after.usdc)}   aUSDC ${fmt(after.aUsdc)}`);
console.log(`minted         ${fmt(minted)} aUSDC for ${fmt(before.usdc - after.usdc)} USDC`);

/**
 * A zero mint alongside an unchanged USDC balance is not "nothing happened".
 * Cleanverse's own ledger classifies both legs, and the classification is the
 * finding: guessing at it from chain state would have produced a story about a
 * failed mint when what actually happened was a refused depositor.
 */
const ledger = await (async () => {
  const response = await fetch(`${base}/query_txs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Request-ID': crypto.randomUUID(),
      'api-id': process.env['CLEANVERSE_API_ID'],
    },
    body: JSON.stringify({ chain: 'monad', address: account.address }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json();
  return (body?.data?.txs ?? []).map((tx) => ({
    type: tx.type,
    txHash: tx.tx_hash,
    from: tx.from_address,
    to: tx.to_address,
    amount: tx.amount,
    status: tx.status,
    blockNumber: tx.block_number,
  }));
})();

const refunded = ledger.find((tx) => tx.type === 'non_whitelist_refund');
if (refunded !== undefined) {
  console.log(`\n  Cleanverse classified the deposit "non_whitelist_transfer" and refunded it`);
  console.log(`  refund ${refunded.txHash}`);
  console.log(`  the depositing address is not bound to a whitelisted institution`);
}

const evidence = {
  capturedAt: new Date().toISOString(),
  purpose: 'Obtain real A-Token for the phase 01 custody round trip',
  chain: { key: 'monadTestnet', nativeChainId: chainId },
  depositor: account.address,
  depositWallet,
  depositWalletIsPerUser: true,
  originToken: ORIGIN_USDC,
  aToken: A_USDC,
  depositTx: hash,
  depositStatus: receipt.status,
  requested: amount.toString(),
  balances: {
    before: { usdc: before.usdc.toString(), aUsdc: before.aUsdc.toString() },
    after: { usdc: after.usdc.toString(), aUsdc: after.aUsdc.toString() },
  },
  mintedATokenUnits: minted.toString(),
  cleanverseLedger: ledger,
  outcome:
    minted > 0n
      ? 'MINTED'
      : refunded !== undefined
        ? 'REFUSED_NON_WHITELIST_DEPOSITOR'
        : 'NO_MINT_AND_NO_REFUND_RECORDED',
  alternativesClosed: {
    faucet:
      'HTTP 200 code 0002: InstitutionFaucet failed, ERC20InsufficientBalance(0xc448042edac1899b023caa0e9da5e4a8833de873, balance 0) — the sandbox faucet source wallet is empty, so no amount succeeds',
    generateApass: 'HTTP 403 on both chains; see docs/evidence/generate-apass-authorization.json',
    institutionTxs:
      'query_institution_txs answers code 0002 "institution address is empty", so this credential has no institution address bound to it',
  },
  classification:
    minted > 0n
      ? null
      : 'SANDBOX_AUTHORIZATION_MISMATCH — the deposit, faucet, and institution-ledger paths all fail on provisioning of this credential rather than on a missing platform capability. The deposit itself executed and was refunded by policy, which is the platform working as designed.',
};

const path = join(ROOT, 'docs', 'evidence', 'phase-01-cash-funding.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`written ${path}`);
process.exitCode = minted > 0n ? 0 : 1;

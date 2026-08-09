#!/usr/bin/env node
/**
 * Captures a settlement that was driven from the browser, from chain state.
 *
 *   node --env-file=.env scripts/capture-browser-run.mjs <settlementId>
 *
 * The live runs under `scripts/run-*.mjs` write their own evidence as they go,
 * because they are the thing doing the work. A browser run has no such vantage
 * point: the transactions came from a wallet in a page, and the only durable
 * record is what the two chains and the guardian set say afterwards.
 *
 * So this reads rather than remembers. Every field below is fetched from a
 * coordinator, an escrow, a token, an adapter, or the guardian API at capture
 * time. Nothing is carried over from the run's own log, which means the artifact
 * cannot claim something the chains would not repeat — and a reader who does not
 * trust it can run this script themselves against the same identifier.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, http } from 'viem';

import {
  ADAPTER_ABI,
  BASE_EVM_CHAIN_ID,
  COORDINATOR_ABI,
  ERC20_ABI,
  ESCROW_ABI,
  MONAD_EVM_CHAIN_ID,
  RWA_ABI,
  cashLeg,
  reservation,
  settlement,
} from './lib/dvp.mjs';
import { ROOT } from './lib/run.mjs';

const settlementId = process.argv[2];
if (settlementId === undefined || !/^0x[0-9a-fA-F]{64}$/.test(settlementId)) {
  console.error('usage: capture-browser-run.mjs <settlementId>');
  process.exit(1);
}

const surface = process.env['CONDUIT_WEB_URL'] ?? 'https://conduit.timjosh507.workers.dev';

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`missing env ${name}`);
  return value.trim();
}

const addresses = {
  coordinator: required('SETTLEMENT_COORDINATOR_ADDRESS'),
  escrow: required('CASH_ESCROW_ADDRESS'),
  cash: required('SETTLEMENT_CVA_ADDRESS'),
  rwa: required('RWA_CVA_ADDRESS'),
  adapter: required('RWA_CVA_ADAPTER_ADDRESS'),
};

const monad = createPublicClient({ transport: http(required('MONAD_TESTNET_RPC_URL')) });
const base = createPublicClient({ transport: http(required('BASE_SEPOLIA_RPC_URL')) });

const stringify = (value) => (typeof value === 'bigint' ? value.toString() : value);

const state = settlement(
  await monad.readContract({
    address: addresses.coordinator,
    abi: COORDINATOR_ABI,
    functionName: 'settlementOf',
    args: [settlementId],
  }),
);

const leg = cashLeg(
  await monad.readContract({
    address: addresses.escrow,
    abi: ESCROW_ABI,
    functionName: 'legOf',
    args: [settlementId],
  }),
);

const reserved = reservation(
  await base.readContract({
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'reservationOf',
    args: [settlementId],
  }),
);

const receiver = await base.readContract({
  address: addresses.adapter,
  abi: ADAPTER_ABI,
  functionName: 'intendedReceiver',
  args: [settlementId],
});

/**
 * The messages, from the surface's own endpoint.
 *
 * This is the one thing the chains cannot answer: a Wormhole sequence lives in
 * an event. The endpoint re-derives every field from the publishing receipt, so
 * what is recorded here is still a chain fact — it is simply one that needed a
 * transaction hash to find.
 */
const messages = await fetch(`${surface}/api/settlements/${settlementId}/messages`)
  .then((response) => (response.ok ? response.json() : { messages: [] }))
  .then((body) =>
    (body.messages ?? []).map((message) => ({
      messageType: message.messageType,
      sequence: message.sequence,
      emitter: message.emitter,
      emitterChainId: message.emitterChainId,
      publishedTx: message.txHash,
      publishedAtBlock: message.block,
      includedAt: message.includedAt ?? null,
      finality: message.finality,
      finalized: message.finalized,
      observedSecondsAfterPublication: message.finalitySeconds ?? null,
    })),
  )
  .catch(() => []);

const balances = {
  cashPayer: await monad.readContract({
    address: addresses.cash,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [leg.payer],
  }),
  cashReceiver: await monad.readContract({
    address: addresses.cash,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [leg.receiver],
  }),
  escrow: await monad.readContract({
    address: addresses.cash,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [addresses.escrow],
  }),
  assetHolder: await base.readContract({
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'balanceOf',
    args: [receiver],
  }),
  assetReserved: await base.readContract({
    address: addresses.rwa,
    abi: RWA_ABI,
    functionName: 'reservedBalanceOf',
    args: [reserved.owner],
  }),
};

const evidence = {
  capturedAt: new Date().toISOString(),
  settlementId,
  deploymentId: required('CONDUIT_DEPLOYMENT_ID'),
  surface,
  driver:
    'a browser. Every transaction below was sent by a wallet in a page, through the settlement ' +
    'workspace, with the next action decided from chain state rather than from a script.',
  addresses,
  coordinator: {
    state: state.state,
    decision: state.decision,
    cashPrepared: state.cashPrepared,
    assetPrepared: state.assetPrepared,
    cashOutcome: state.cashOutcome,
    assetOutcome: state.assetOutcome,
    stateVersion: stringify(state.stateVersion),
  },
  cashLeg: {
    payer: leg.payer,
    receiver: leg.receiver,
    amount: stringify(leg.amount),
    state: leg.state,
  },
  reservation: {
    owner: reserved.owner,
    amount: stringify(reserved.amount),
    announced: reserved.announced,
    committed: reserved.committed,
    released: reserved.released,
    cancelled: reserved.cancelled,
  },
  intendedReceiver: receiver,
  messages,
  balances: Object.fromEntries(
    Object.entries(balances).map(([key, value]) => [key, stringify(value)]),
  ),
  chains: { monad: MONAD_EVM_CHAIN_ID, base: BASE_EVM_CHAIN_ID },
  limitations: [
    'The payer and the seller are one key. `generate_apass` returns 403 for this credential ' +
      '(ASM-035), so no second A-Passed identity exists and both intent signatures come from one ' +
      'wallet. Each leg still moves value into and out of a settlement contract; conservation is ' +
      'proven at the escrow balance and at the reservation rather than at a wallet delta.',
    'The wallet is a real key signing real payloads through an EIP-1193 provider Playwright can ' +
      'drive. A browser extension cannot be automated, so the extension UI itself is covered by a ' +
      'manual smoke test rather than by this run.',
  ],
};

const path = join(ROOT, 'docs', 'evidence', 'phase-06-browser-dvp.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`wrote ${path}`);
console.log(`state ${state.state} · cash ${state.cashOutcome} · asset ${state.assetOutcome}`);

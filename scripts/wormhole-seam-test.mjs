#!/usr/bin/env node
/**
 * The two-direction Wormhole transport seam test. PRD 19 phase 02, ASM-011, ASM-012.
 *
 * The gate is:
 *
 *   Monad Testnet publish → signed VAA → Base Sepolia parseAndVerifyVM valid
 *   Base Sepolia publish  → signed VAA → Monad Testnet parseAndVerifyVM valid
 *   with replay rejected
 *
 * What this establishes, exactly: Wormhole network availability between the two
 * chains, and destination core acceptance of a guardian-signed message from the
 * other chain. Nothing more.
 *
 * What it does not establish: the emitter here is an EOA, so the locked
 * peer-emitter path is not exercised, and neither are the deployment ID, the
 * protocol version, the message type, the settlement ID, the intent hash, or
 * replay consumption. Those checks live in `WormholeTransport`, not in the core
 * contract, and they need a source-contract-to-destination-contract run to be
 * proven. Publishing from `CashEscrow` here would have mixed the two: a failure
 * could then be transport or settlement, and the point of a seam test is that it
 * cannot be both.
 *
 * The timings are transport latency at consistency level 200, which is Wormhole's
 * *instant*: guardians sign on observation, before the source state is
 * irreversible. They are not settlement latency. See ADR-0013 — Conduit enforces
 * FINALIZED for every message that authorizes value, and Base's finalized path is
 * roughly eighteen minutes.
 *
 * Verification is `eth_call` against the real destination core contract, not an
 * off-chain parse. CLAUDE.md is explicit that off-chain VAA parsing is never
 * trusted on its own, and an off-chain check here would prove nothing about
 * whether the destination chain accepts the guardian set.
 *
 *   node --env-file=.env scripts/wormhole-seam-test.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseEventLogs,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ROOT } from './lib/run.mjs';

const CORE_ABI = [
  {
    name: 'publishMessage',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: 'nonce', type: 'uint32' },
      { name: 'payload', type: 'bytes' },
      { name: 'consistencyLevel', type: 'uint8' },
    ],
    outputs: [{ name: 'sequence', type: 'uint64' }],
  },
  {
    name: 'messageFee',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'parseAndVerifyVM',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'encodedVM', type: 'bytes' }],
    outputs: [
      {
        name: 'vm',
        type: 'tuple',
        components: [
          { name: 'version', type: 'uint8' },
          { name: 'timestamp', type: 'uint32' },
          { name: 'nonce', type: 'uint32' },
          { name: 'emitterChainId', type: 'uint16' },
          { name: 'emitterAddress', type: 'bytes32' },
          { name: 'sequence', type: 'uint64' },
          { name: 'consistencyLevel', type: 'uint8' },
          { name: 'payload', type: 'bytes' },
          { name: 'guardianSetIndex', type: 'uint32' },
          {
            name: 'signatures',
            type: 'tuple[]',
            components: [
              { name: 'r', type: 'bytes32' },
              { name: 's', type: 'bytes32' },
              { name: 'v', type: 'uint8' },
              { name: 'guardianIndex', type: 'uint8' },
            ],
          },
          { name: 'hash', type: 'bytes32' },
        ],
      },
      { name: 'valid', type: 'bool' },
      { name: 'reason', type: 'string' },
    ],
  },
  {
    type: 'event',
    name: 'LogMessagePublished',
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'sequence', type: 'uint64', indexed: false },
      { name: 'nonce', type: 'uint32', indexed: false },
      { name: 'payload', type: 'bytes', indexed: false },
      { name: 'consistencyLevel', type: 'uint8', indexed: false },
    ],
  },
];

const CHAINS = {
  monadTestnet: {
    label: 'Monad Testnet',
    rpc: process.env['MONAD_TESTNET_RPC_URL'],
    core: process.env['WORMHOLE_CORE_MONAD_TESTNET'],
    wormholeChainId: 10009,
    nativeChainId: 10143,
  },
  baseSepolia: {
    label: 'Base Sepolia',
    rpc: process.env['BASE_SEPOLIA_RPC_URL'],
    core: process.env['WORMHOLE_CORE_BASE_SEPOLIA'],
    wormholeChainId: 10004,
    nativeChainId: 84532,
  },
};

const account = privateKeyToAccount(process.env['DEPLOYER_PRIVATE_KEY']);
const emitter = `0x${account.address.slice(2).toLowerCase().padStart(64, '0')}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clientsFor(chain) {
  const transport = http(chain.rpc);
  return {
    pub: createPublicClient({ transport }),
    wallet: createWalletClient({ account, transport, chain: { id: chain.nativeChainId } }),
  };
}

/**
 * Consistency level 200 is Wormhole's "instant": guardians sign as soon as they
 * observe the message, before the source state is irreversible. It is the right
 * level for a seam test, which is measuring whether the network carries a message
 * at all, and the wrong level for settlement.
 *
 * Production runs FINALIZED, enforced on chain per message class by
 * `WormholeTransport` and bound into the bytecode as an immutable (ADR-0013).
 * Base's finalized path is 512 blocks at ~2s, roughly eighteen minutes. Both
 * numbers are published: hiding the fast one understates the transport, hiding
 * the slow one misrepresents settlement.
 */
const CONSISTENCY_INSTANT = 200;

async function publish(chain, payloadHex) {
  const { pub, wallet } = clientsFor(chain);

  const reported = await pub.getChainId();
  if (reported !== chain.nativeChainId) {
    throw new Error(
      `${chain.label} RPC reports chain ${reported}, expected ${chain.nativeChainId}`,
    );
  }

  const fee = await pub.readContract({
    address: chain.core,
    abi: CORE_ABI,
    functionName: 'messageFee',
  });

  const hash = await wallet.sendTransaction({
    to: chain.core,
    value: fee,
    data: encodeFunctionData({
      abi: CORE_ABI,
      functionName: 'publishMessage',
      args: [0, payloadHex, CONSISTENCY_INSTANT],
    }),
  });

  const receipt = await pub.waitForTransactionReceipt({ hash });
  const [log] = parseEventLogs({
    abi: CORE_ABI,
    eventName: 'LogMessagePublished',
    logs: receipt.logs,
  });
  if (log === undefined) throw new Error(`${chain.label}: no LogMessagePublished in the receipt`);

  return { txHash: hash, sequence: log.args.sequence, fee, blockNumber: receipt.blockNumber };
}

/** Polls the guardian API until the VAA is signed and available. */
async function fetchVaa(chain, sequence, budgetMs = 300_000) {
  const url = `https://api.testnet.wormholescan.io/v1/signed_vaa/${chain.wormholeChainId}/${emitter.slice(2)}/${sequence}`;
  const started = Date.now();

  while (Date.now() - started < budgetMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) {
        const body = await response.json();
        if (typeof body.vaaBytes === 'string') {
          return {
            vaaHex: `0x${Buffer.from(body.vaaBytes, 'base64').toString('hex')}`,
            waitedMs: Date.now() - started,
          };
        }
      }
    } catch {
      // Transport hiccup while waiting is not a result; keep polling.
    }
    await sleep(5_000);
  }
  throw new Error(`VAA for ${chain.label} sequence ${sequence} not available within the budget`);
}

/** Verification happens on the destination core contract, never off-chain. */
async function verifyOn(chain, vaaHex) {
  const { pub } = clientsFor(chain);
  const [vm, valid, reason] = await pub.readContract({
    address: chain.core,
    abi: CORE_ABI,
    functionName: 'parseAndVerifyVM',
    args: [vaaHex],
  });
  return { vm, valid, reason };
}

async function runDirection(from, to, label) {
  const marker = `conduit-seam-${label}-${process.env['SEAM_RUN_ID'] ?? '1'}`;
  const payloadHex = `0x${Buffer.from(marker, 'utf8').toString('hex')}`;

  console.log(`\n── ${from.label} → ${to.label} ─────────────────────────────`);

  const published = await publish(from, payloadHex);
  console.log(`  published    tx ${published.txHash}`);
  console.log(`               sequence ${published.sequence}  fee ${published.fee} wei`);

  const { vaaHex, waitedMs } = await fetchVaa(from, published.sequence);
  console.log(
    `  VAA signed   ${(vaaHex.length - 2) / 2} bytes after ${(waitedMs / 1000).toFixed(1)}s`,
  );

  const { vm, valid, reason } = await verifyOn(to, vaaHex);
  console.log(
    `  verified on  ${to.label}: valid=${valid} ${reason === '' ? '' : `reason="${reason}"`}`,
  );
  console.log(`               emitterChain ${vm.emitterChainId} guardians ${vm.signatures.length}`);

  const roundTripped = Buffer.from(vm.payload.slice(2), 'hex').toString('utf8');
  const payloadIntact = roundTripped === marker;
  console.log(`  payload      ${payloadIntact ? 'intact' : `CORRUPTED: ${roundTripped}`}`);

  return {
    direction: `${from.label} → ${to.label}`,
    sourceWormholeChainId: from.wormholeChainId,
    destinationWormholeChainId: to.wormholeChainId,
    txHash: published.txHash,
    sequence: String(published.sequence),
    messageFeeWei: String(published.fee),
    vaaBytes: (vaaHex.length - 2) / 2,
    guardianSignatures: vm.signatures.length,
    guardianSetIndex: vm.guardianSetIndex,
    vaaAvailableAfterMs: waitedMs,
    verifiedOnDestination: valid,
    reason,
    emitterChainIdInVaa: vm.emitterChainId,
    emitterMatches: vm.emitterAddress.toLowerCase() === emitter.toLowerCase(),
    payloadIntact,
    vaaHash: vm.hash,
  };
}

const results = [];
results.push(await runDirection(CHAINS.monadTestnet, CHAINS.baseSepolia, 'monad-to-base'));
results.push(await runDirection(CHAINS.baseSepolia, CHAINS.monadTestnet, 'base-to-monad'));

const evidence = {
  capturedAt: new Date().toISOString(),
  classification: 'FAST_TRANSPORT_SEAM_EVIDENCE',
  proves: [
    'Wormhole network availability between Monad Testnet and Base Sepolia',
    'destination Core acceptance of a guardian-signed message from the other chain',
  ],
  doesNotProve: [
    "Conduit's locked peer-emitter path: the emitter here is an EOA, not RWACVASettlementAdapter or SettlementCoordinator",
    'deployment ID, protocol version, message type, settlement ID, intent hash, or replay consumption, all of which are enforced in WormholeTransport rather than in the Core contract',
    'settlement latency: these timings are transport latency at a non-final consistency level',
  ],
  emitter: account.address,
  emitterKind: 'EOA',
  consistencyLevel: CONSISTENCY_INSTANT,
  consistencyNote:
    "Instant (200): guardians sign on observation, before the source state is irreversible. Conduit refuses this level for anything that authorizes value and enforces FINALIZED on chain per message class (ADR-0013). Base's finalized path is 512 blocks at ~2s, roughly eighteen minutes.",
  directions: results,
  allVerified: results.every((r) => r.verifiedOnDestination && r.payloadIntact && r.emitterMatches),
};

const path = join(ROOT, 'docs', 'evidence', 'phase-02-wormhole-seam.json');
writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);

console.log(`\n${evidence.allVerified ? 'both directions verified on chain' : 'SEAM TEST FAILED'}`);
console.log(`written ${path}`);
process.exitCode = evidence.allVerified ? 0 : 1;

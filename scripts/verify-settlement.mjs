#!/usr/bin/env node
/**
 * The public verifier. PRD FR-014, PRD 15.2.
 *
 *   node --env-file=.env scripts/verify-settlement.mjs <settlementId> [--from-monad N] [--from-base N]
 *
 * Input: a settlement ID and two RPC URLs. That is the whole trust root, plus
 * the committed deployment manifests and the Wormhole guardian set. It reads no
 * application database, and there is no database for it to read — every value
 * in the report comes from contract state, a producer's own event, or a
 * guardian signature.
 *
 * What it prints is deliberately two things. `SETTLED` is the coordinator's own
 * enum, read off chain and never widened. `SETTLED_FINAL` is this verifier's
 * classification and exists nowhere in Solidity: it means the coordinator says
 * SETTLED *and* every fact that state rests on has been checked independently.
 * Conflating them would be claiming the state machine stores something it does
 * not.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';

import { DeploymentGeneration, verifySettlement } from '../packages/verifier/dist/index.js';

import { createLog, unbufferStdout } from './lib/observe.mjs';
import { ROOT } from './lib/run.mjs';

unbufferStdout();

const settlementId = process.argv[2];
if (settlementId === undefined || !/^0x[0-9a-fA-F]{64}$/.test(settlementId)) {
  console.error(
    'usage: verify-settlement.mjs <settlementId> ' +
      '[--from-monad N] [--to-monad N] [--from-base N] [--to-base N]',
  );
  process.exit(2);
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : BigInt(process.argv[index + 1]);
}

const log = createLog(join(ROOT, 'docs', 'evidence', 'artifacts', 'verify-settlement.log'));

// ── The deployment, from committed manifests only ───────────────────────────

const dir = join(ROOT, 'contracts', 'deployments');
const manifests = readdirSync(dir)
  .filter((file) => file.endsWith('.json') && !file.includes('schema'))
  .map((file) => ({ name: file, manifest: JSON.parse(readFileSync(join(dir, file), 'utf8')) }));

/**
 * Which generation this settlement belongs to, asked rather than assumed.
 *
 * Every redeployment is a new generation with its own deployment ID, and the
 * superseded contracts stay on chain holding the settlements they decided. The
 * verifier tries each generation's coordinator and uses the one that knows this
 * settlement — so a settlement from an earlier generation stays verifiable
 * forever, and a later generation cannot answer for it.
 */
const generations = DeploymentGeneration.allFrom(manifests);
log.step(`${generations.length} deployment generation(s) in contracts/deployments`);

// ── Two chains, keyed by chain ID and never by name ─────────────────────────

const RPC_BY_CHAIN = {
  10143: process.env['MONAD_TESTNET_RPC_URL'],
  84532: process.env['BASE_SEPOLIA_RPC_URL'],
};

const clients = new Map();
function clientFor(chainId) {
  const existing = clients.get(chainId);
  if (existing !== undefined) return existing;
  const url = RPC_BY_CHAIN[chainId];
  if (url === undefined) throw new Error(`no RPC configured for chain ${chainId}`);
  const created = createPublicClient({ transport: http(url, { retryCount: 2, timeout: 20_000 }) });
  clients.set(chainId, created);
  return created;
}

const READ_ABI = parseAbi([
  'function settlementOf(bytes32) view returns ((uint8,uint8,bool,bool,uint8,uint8,bytes32,uint64))',
  'function legOf(bytes32) view returns ((address,address,uint256,bytes32,uint8))',
  'function reservationOf(bytes32) view returns ((address,uint256,bytes32,uint64,bool,bool,bool,bool))',
  'function reservedBalanceOf(address) view returns (uint256)',
  'function totalEscrowed() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function consumedVaa(bytes32) view returns (bool)',
]);

const MESSAGE_PUBLISHED = parseAbiItem(
  'event MessagePublished(uint64 indexed sequence, uint8 indexed messageType, bytes32 indexed settlementId)',
);

/**
 * Chunked log scan that discovers each provider's range cap instead of guessing.
 *
 * Base Sepolia refuses ranges over roughly a thousand blocks with
 * `InvalidParamsRpcError`; Monad Testnet refuses over roughly a hundred with a
 * bare `RpcRequestError`. Neither says what the limit is. The first version of
 * this verifier used one chunk size for both, logged the refusals as warnings,
 * and certified SETTLED_FINAL having read one message of three — the scan
 * failed and the report could not tell the difference between "nothing was
 * published here" and "nothing was read here".
 *
 * So a chunk that fails is halved and retried, and a range that cannot be read
 * even at the floor is returned as an explicit gap. The verifier turns any gap
 * into a failing finding, because an absent message only means something if the
 * place it would have been was actually looked at.
 */
const FLOOR = 25n;

async function logsInChunks(client, chainId, addresses, settlement, fromBlock, toBlock) {
  const found = [];
  const unscanned = [];
  let chunk = 1_000n;
  let requests = 0;
  const started = Date.now();

  let from = fromBlock;
  while (from <= toBlock) {
    const to = from + chunk - 1n > toBlock ? toBlock : from + chunk - 1n;
    try {
      requests += 1;
      const logs = await client.getLogs({
        address: addresses,
        event: MESSAGE_PUBLISHED,
        args: { settlementId: settlement },
        fromBlock: from,
        toBlock: to,
      });
      for (const entry of logs) {
        found.push({
          producer: { chainId, address: entry.address },
          sequence: entry.args.sequence,
          messageType: Number(entry.args.messageType),
          blockNumber: entry.blockNumber,
        });
      }
      if (requests % 50 === 0) {
        const done = Number(from - fromBlock);
        const total = Number(toBlock - fromBlock) || 1;
        log.step(
          `chain ${chainId}: ${Math.round((done / total) * 100)}% of ${total} blocks, ` +
            `${requests} requests, chunk ${chunk}, ${found.length} found, ` +
            `${Math.round((Date.now() - started) / 1000)}s`,
        );
      }
      from = to + 1n;
    } catch (error) {
      if (chunk > FLOOR) {
        chunk /= 2n;
        continue;
      }
      unscanned.push({
        from: String(from),
        to: String(to),
        reason: String(error).split('\n')[0].slice(0, 120),
      });
      from = to + 1n;
    }
  }

  log.step(
    `chain ${chainId}: scanned ${toBlock - fromBlock} blocks in ${requests} requests ` +
      `(chunk settled at ${chunk}), ${found.length} messages, ${unscanned.length} gaps`,
  );
  return { found, unscanned };
}

const chain = {
  getChainId: (chainId) => clientFor(chainId).getChainId(),
  getCode: ({ chainId, address }) => clientFor(chainId).getCode({ address }),
  read: ({ chainId, address }, functionName, args) =>
    clientFor(chainId).readContract({ address, abi: READ_ABI, functionName, args }),
  latestBlock: (chainId) => clientFor(chainId).getBlockNumber(),
  publishedMessages: (chainId, producers, settlement, { fromBlock, toBlock }) =>
    logsInChunks(
      clientFor(chainId),
      chainId,
      producers.map((producer) => producer.address),
      settlement,
      fromBlock,
      toBlock,
    ),
};

const guardians = {
  signedVaa: async (wormholeChainId, emitter, sequence) => {
    const url = `https://api.testnet.wormholescan.io/v1/signed_vaa/${wormholeChainId}/${emitter.slice(2)}/${sequence}`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) return undefined;
      const body = await response.json();
      if (typeof body.vaaBytes !== 'string') return undefined;
      return { vaa: `0x${Buffer.from(body.vaaBytes, 'base64').toString('hex')}` };
    } catch (error) {
      log.warn(`guardians unreachable for ${wormholeChainId}/${sequence}: ${String(error)}`);
      return undefined;
    }
  },
};

// ── Verify ──────────────────────────────────────────────────────────────────

log.stage(`verifying ${settlementId}`);

let generation;
for (const candidate of generations) {
  try {
    const coordinator = candidate
      .contracts()
      .find((contract) => contract.role === 'SettlementCoordinator');
    if (coordinator === undefined) continue;
    const state = await chain.read(coordinator.identity, 'settlementOf', [settlementId]);
    const known = Number(state[0]) !== 0;
    log.step(
      `generation ${candidate.deploymentId.slice(0, 10)} coordinator ` +
        `eip155:${coordinator.identity.chainId}:${coordinator.identity.address} ` +
        `${known ? 'knows this settlement' : 'does not know it'}`,
    );
    if (known) generation = candidate;
  } catch (error) {
    log.warn(`generation ${candidate.deploymentId.slice(0, 10)}: ${String(error).split('\n')[0]}`);
  }
}

if (generation === undefined) {
  log.fail('no deployment generation knows this settlement');
  process.exit(1);
}

log.step(`deployment ${generation.deploymentId}, protocol v${generation.protocolVersion}`);
for (const contract of generation.contracts()) {
  log.step(
    `  ${contract.role.padEnd(28)} eip155:${contract.identity.chainId}:${contract.identity.address}`,
  );
}

const fromBlock = {};
const toBlock = {};
for (const [chainId, from, to] of [
  [10143, '--from-monad', '--to-monad'],
  [84532, '--from-base', '--to-base'],
]) {
  const start = flag(from);
  const end = flag(to);
  if (start !== undefined) fromBlock[chainId] = start;
  if (end !== undefined) toBlock[chainId] = end;
}

const result = await verifySettlement(settlementId, generation, chain, guardians, {
  fromBlock,
  toBlock,
  blockWindow: 20_000n,
});

// ── Human-readable ──────────────────────────────────────────────────────────

log.stage('findings');
for (const finding of result.findings) {
  (finding.ok ? log.ok : log.fail)(`${finding.check} — ${finding.detail}`);
}

log.stage('messages');
for (const message of result.messages) {
  const consumer =
    message.consumer === undefined
      ? 'no consumer'
      : `→ ${message.consumerRole} eip155:${message.consumer.chainId}:${message.consumer.address}`;
  const line =
    `${message.messageType.padEnd(16)} seq ${message.sequence.padEnd(3)} ` +
    `${message.emitterKey} ${message.finality} ${consumer} ` +
    `consumed=${String(message.consumedAtDestination)}`;
  (message.problems.length === 0 ? log.ok : log.fail)(line);
  for (const problem of message.problems) log.fail(`    ${problem}`);
}

if (result.addressCollisions.length > 0) {
  log.stage('cross-chain address collisions in this deployment');
  for (const group of result.addressCollisions) {
    log.warn(group.map((entry) => `${entry.role} at ${entry.key}`).join('  vs  '));
  }
  log.step('the same twenty bytes, different chains, different contracts — identified apart');
}

log.stage('result');
log.step(`canonical on-chain state   ${result.canonicalState}`);
log.step(`decision                   ${result.decision}`);
log.step(`cash outcome               ${result.cashOutcome}`);
log.step(`asset outcome              ${result.assetOutcome}`);
(result.derived === 'SETTLED_FINAL' ? log.ok : log.fail)(
  `derived classification     ${result.derived}`,
);
log.step(`trust root                 ${result.trustRoot}`);

// ── Machine-readable ────────────────────────────────────────────────────────

const path = join(ROOT, 'docs', 'evidence', `verification-${settlementId.slice(2, 12)}.json`);
writeFileSync(
  path,
  `${JSON.stringify(
    { verifiedAt: new Date().toISOString(), ...result },
    (_key, value) => (typeof value === 'bigint' ? String(value) : value),
    2,
  )}\n`,
);
log.step(`written ${path}`);

process.exitCode = result.derived === 'SETTLED_FINAL' ? 0 : 1;

/**
 * Cross-chain messages: recorded from the transaction that published them, and
 * followed until the guardian set signs them at the finality the peer demands.
 *
 * ## Why the browser cannot just remember the sequence
 *
 * Wormhole puts a message's sequence in an event, not in contract state. A
 * settlement that has prepared its asset leg therefore carries a number that
 * cannot be read back from any contract — so a reloaded page, or the
 * counterparty's browser, has no way to find the message that the whole
 * settlement is now waiting on. Scanning logs from a browser is not an option
 * either: public endpoints cap ranges at a hundred blocks, which is the same
 * constraint that once had the verifier certify a terminal state having read one
 * message of three.
 *
 * So the sequence is recorded here, from a transaction hash, and the record is
 * *verified* rather than believed: the receipt is fetched, the publishing log is
 * read out of it, the sender is checked against this deployment's own contracts,
 * and the payload is decoded and required to name this deployment and this
 * settlement. A caller who posts someone else's transaction hash gets a refusal,
 * not a row.
 *
 * The row is still only a projection. It is where to look, never what is true —
 * every consumer re-verifies the signed VAA on chain, which is what
 * `parseAndVerifyVM` is for.
 */

import { parseEventLogs, type Address, type Hex } from 'viem';

import { readClient } from './attestations.js';
import { deploymentConfig, type DeploymentConfig } from './deployment.js';
import {
  BASE_SEPOLIA,
  CORE_ABI,
  COORDINATOR_ABI,
  MONAD_TESTNET,
  WORMHOLE_CHAIN_OF,
  decodeMessageHeader,
  padEmitter,
  readVaaHeader,
} from './onchain.js';
import { withDb, type Env } from './data.js';

const WORMHOLESCAN = 'https://api.testnet.wormholescan.io';

export interface MessageRecord {
  readonly messageType: string;
  readonly sequence: string;
  readonly emitter: Address;
  readonly emitterChainId: number;
  readonly txHash: Hex;
  readonly block: string;
  readonly includedAt: string | undefined;
  readonly consistencyLevel: number;
  readonly finality: string;
  readonly finalized: boolean;
  readonly finalizedAt: string | undefined;
  readonly finalitySeconds: number | undefined;
  /** Present only once the guardian set has signed. */
  readonly vaa: Hex | undefined;
}

export interface MessageFailure {
  readonly status: number;
  readonly body: unknown;
}

function fail(status: number, code: string, message: string, detail?: string): MessageFailure {
  return {
    status,
    body: { error: { code, message, ...(detail === undefined ? {} : { detail }) } },
  };
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** Which of this deployment's contracts may legitimately publish, per chain. */
function publishersFor(config: DeploymentConfig, chainId: number): readonly string[] {
  return chainId === MONAD_TESTNET
    ? [config.coordinator.toLowerCase(), config.cashEscrow.toLowerCase()]
    : [config.rwaAdapter.toLowerCase()];
}

/** Wormhole's own classification. 200 is instant, 201 safe, everything else finalized. */
export function finalityOf(consistencyLevel: number): string {
  if (consistencyLevel === 200) return 'INSTANT';
  if (consistencyLevel === 201) return 'SAFE';
  return 'FINALIZED';
}

/**
 * Records a published message from the transaction that published it.
 *
 * Idempotent by (chain, emitter, sequence): re-posting the same hash rewrites
 * the same row with the same facts.
 */
export async function recordMessage(
  env: Env,
  settlementId: string,
  body: unknown,
): Promise<{ recorded: readonly MessageRecord[] } | MessageFailure> {
  const config = deploymentConfig(env);
  if (config === undefined) {
    return fail(503, 'not_configured', 'no deployment addresses are configured');
  }
  if (!HEX32.test(settlementId)) {
    return fail(400, 'invalid_request', 'settlementId must be a 32-byte hex value');
  }

  const parsed = body as { chainId?: unknown; txHash?: unknown };
  const chainId = Number(parsed.chainId);
  if (chainId !== MONAD_TESTNET && chainId !== BASE_SEPOLIA) {
    return fail(400, 'invalid_request', 'chainId must be one of this deployment’s two chains');
  }
  const txHash = typeof parsed.txHash === 'string' ? parsed.txHash : '';
  if (!HEX32.test(txHash)) {
    return fail(400, 'invalid_request', 'txHash must be a 32-byte hex value');
  }

  const client = readClient(env, chainId);
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as Hex });
  } catch {
    return fail(
      404,
      'receipt_unavailable',
      'that transaction is not visible on this chain yet',
      'A receipt proves inclusion at a block; the node answering this call may not have reached it. ' +
        'Nothing was recorded, and nothing about the settlement changed.',
    );
  }
  if (receipt.status !== 'success') {
    return fail(400, 'transaction_reverted', 'that transaction reverted and published nothing');
  }

  const logs = parseEventLogs({
    abi: CORE_ABI,
    eventName: 'LogMessagePublished',
    logs: receipt.logs,
  });
  if (logs.length === 0) {
    return fail(400, 'no_message', 'that transaction published no Wormhole message');
  }

  const allowed = publishersFor(config, chainId);
  const wormholeChainId = WORMHOLE_CHAIN_OF[chainId] ?? 0;
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const includedAt = new Date(Number(block.timestamp) * 1000).toISOString();

  const recorded: MessageRecord[] = [];
  for (const log of logs) {
    const sender = log.args.sender.toLowerCase();
    if (!allowed.includes(sender)) continue;

    let header;
    try {
      header = decodeMessageHeader(log.args.payload);
    } catch {
      continue;
    }
    if (header.deploymentId.toLowerCase() !== env.DEPLOYMENT_ID.toLowerCase()) continue;
    if (header.settlementId.toLowerCase() !== settlementId.toLowerCase()) {
      return fail(
        400,
        'wrong_settlement',
        'that transaction published a message for a different settlement',
      );
    }

    const consistencyLevel = log.args.consistencyLevel;
    await withDb(env, async (sql) => {
      await sql`
        INSERT INTO conduit.messages (
          wormhole_chain_id, emitter, sequence, settlement_id, deployment_id, message_type,
          intent_hash, source_chain_id, destination_chain_id, state_version, consistency_level,
          finality, published_at_block, published_tx_hash
        ) VALUES (
          ${wormholeChainId}, ${sender}, ${Number(log.args.sequence)},
          ${settlementId.toLowerCase()}, ${header.deploymentId.toLowerCase()},
          ${header.messageType}, ${header.intentHash.toLowerCase()},
          ${Number(header.sourceChainId)}, ${Number(header.destinationChainId)},
          ${Number(header.stateVersion)}, ${consistencyLevel},
          ${finalityOf(consistencyLevel)}, ${Number(receipt.blockNumber)}, ${txHash.toLowerCase()}
        )
        ON CONFLICT (wormhole_chain_id, emitter, sequence) DO UPDATE SET
          published_tx_hash = EXCLUDED.published_tx_hash,
          published_at_block = EXCLUDED.published_at_block
      `;
    });

    recorded.push({
      messageType: header.messageType,
      sequence: String(log.args.sequence),
      emitter: sender as Address,
      emitterChainId: wormholeChainId,
      txHash: txHash as Hex,
      block: receipt.blockNumber.toString(),
      includedAt,
      consistencyLevel,
      finality: finalityOf(consistencyLevel),
      finalized: false,
      finalizedAt: undefined,
      finalitySeconds: undefined,
      vaa: undefined,
    });
  }

  if (recorded.length === 0) {
    return fail(
      400,
      'not_this_deployment',
      'that transaction published no message from this deployment’s contracts',
    );
  }
  return { recorded };
}

interface SignedVaa {
  readonly vaa: Hex;
  readonly consistencyLevel: number;
}

/**
 * Asks the guardian API whether a message has been signed yet.
 *
 * A miss is not an error. Before economic finality the VAA genuinely does not
 * exist, and that absence is the thing the workspace is displaying.
 */
export async function fetchSignedVaa(
  emitterChainId: number,
  emitter: string,
  sequence: string,
): Promise<SignedVaa | undefined> {
  const url = `${WORMHOLESCAN}/v1/signed_vaa/${String(emitterChainId)}/${padEmitter(emitter).slice(2)}/${sequence}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;
  const body = (await response.json()) as { vaaBytes?: unknown };
  if (typeof body.vaaBytes !== 'string') return undefined;

  const binary = atob(body.vaaBytes);
  let hex = '';
  for (let index = 0; index < binary.length; index += 1) {
    hex += binary.charCodeAt(index).toString(16).padStart(2, '0');
  }
  const vaa: Hex = `0x${hex}`;
  return { vaa, consistencyLevel: readVaaHeader(vaa).consistencyLevel };
}

/**
 * Every message this settlement has published, with its current finality.
 *
 * The first time a VAA is seen the observation is written down, because the
 * interval between publication and signature is the number ADR-0013 publishes
 * and it cannot be recovered afterwards.
 */
export async function messagesFor(
  env: Env,
  settlementId: string,
): Promise<readonly MessageRecord[]> {
  const rows = await withDb(env, async (sql) => {
    return await sql`
      SELECT m.message_type, m.sequence, m.emitter, m.wormhole_chain_id, m.consistency_level,
             m.finality, m.published_at_block, m.published_tx_hash,
             v.signed_vaa, v.observed_at, v.finality_seconds
        FROM conduit.messages m
        LEFT JOIN conduit.vaas v
               ON v.wormhole_chain_id = m.wormhole_chain_id
              AND v.emitter = m.emitter
              AND v.sequence = m.sequence
       WHERE m.settlement_id = ${settlementId.toLowerCase()}
       ORDER BY m.wormhole_chain_id, m.sequence
    `;
  });

  const out: MessageRecord[] = [];
  for (const row of rows) {
    const emitter = String(row['emitter']);
    const emitterChainId = Number(row['wormhole_chain_id']);
    const sequence = String(row['sequence']);
    const stored: unknown = row['signed_vaa'];
    const includedAt = await blockTime(
      env,
      evmChainOf(emitterChainId),
      Number(row['published_at_block']),
    );

    let vaa = typeof stored === 'string' && stored !== '' ? (stored as Hex) : undefined;
    let finalizedAt = row['observed_at'] === null ? undefined : String(row['observed_at']);
    let finalitySeconds =
      row['finality_seconds'] === null ? undefined : Number(row['finality_seconds']);

    if (vaa === undefined) {
      const signed = await fetchSignedVaa(emitterChainId, emitter, sequence);
      if (signed !== undefined) {
        vaa = signed.vaa;
        finalizedAt = new Date().toISOString();
        finalitySeconds = await persistVaa(env, {
          emitterChainId,
          emitter,
          sequence,
          vaa: signed.vaa,
          block: Number(row['published_at_block']),
        });
      }
    }

    out.push({
      messageType: String(row['message_type']),
      sequence,
      emitter: emitter as Address,
      emitterChainId,
      txHash: String(row['published_tx_hash']) as Hex,
      block: String(row['published_at_block']),
      includedAt,
      consistencyLevel: Number(row['consistency_level']),
      finality: String(row['finality']),
      finalized: vaa !== undefined,
      finalizedAt,
      finalitySeconds,
      vaa,
    });
  }
  return out;
}

function evmChainOf(wormholeChainId: number): number {
  return wormholeChainId === WORMHOLE_CHAIN_OF[MONAD_TESTNET] ? MONAD_TESTNET : BASE_SEPOLIA;
}

/** When a block was mined, or nothing. An unknown time is never a guessed one. */
async function blockTime(
  env: Env,
  chainId: number,
  blockNumber: number,
): Promise<string | undefined> {
  try {
    const block = await readClient(env, chainId).getBlock({ blockNumber: BigInt(blockNumber) });
    return new Date(Number(block.timestamp) * 1000).toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Writes down the first sighting, and how long it took.
 *
 * Per observation, never averaged. The spread between 999 and 1485 seconds is
 * the finding: an average would hide the one that matters, which is the slowest.
 */
async function persistVaa(
  env: Env,
  record: {
    emitterChainId: number;
    emitter: string;
    sequence: string;
    vaa: Hex;
    block: number;
  },
): Promise<number | undefined> {
  const published = await blockTime(env, evmChainOf(record.emitterChainId), record.block);
  // A block we cannot read leaves the interval unknown rather than wrong.
  const seconds =
    published === undefined
      ? undefined
      : Math.max(0, Math.round((Date.now() - Date.parse(published)) / 1000));

  const bytes = record.vaa.slice(2);
  const guardianSetIndex = Number.parseInt(bytes.slice(2, 10), 16);
  const signatureCount = Number.parseInt(bytes.slice(10, 12), 16);
  // Keyed by the message it signs. The canonical VAA hash is a digest of the
  // body; the coordinator computes it itself and this row is only a cache.
  const vaaHash = `${String(record.emitterChainId)}/${record.emitter}/${record.sequence}`;

  await withDb(env, async (sql) => {
    await sql`
      INSERT INTO conduit.vaas (
        vaa_hash, wormhole_chain_id, emitter, sequence, guardian_set_index,
        signature_count, signed_vaa, finality_seconds
      ) VALUES (
        ${vaaHash}, ${record.emitterChainId}, ${record.emitter}, ${Number(record.sequence)},
        ${guardianSetIndex}, ${signatureCount}, ${record.vaa},
        ${seconds ?? null}
      )
      ON CONFLICT (vaa_hash) DO NOTHING
    `;
  });
  return seconds;
}

/**
 * Whether the coordinator has already burned a VAA.
 *
 * Read from the destination contract rather than inferred, because "consumed"
 * is the property that makes replay impossible and it is only true if the
 * contract says so.
 */
export async function vaaConsumed(env: Env, chainId: number, vaaHash: Hex): Promise<boolean> {
  const config = deploymentConfig(env);
  if (config === undefined) return false;
  const address = chainId === MONAD_TESTNET ? config.coordinator : config.rwaAdapter;
  try {
    return await readClient(env, chainId).readContract({
      address,
      abi: COORDINATOR_ABI,
      functionName: 'consumedVaa',
      args: [vaaHash],
    });
  } catch {
    return false;
  }
}

export function isMessageFailure(
  value: { recorded: readonly MessageRecord[] } | MessageFailure,
): value is MessageFailure {
  return 'status' in value;
}

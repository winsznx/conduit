import {
  addressToEmitter,
  contractKey,
  emitterKey,
  emitterToAddress,
} from '@conduit-protocol/domain';

import type { ChainScopedAddress, WormholeEmitter } from '@conduit-protocol/domain';
import type { Address, Hex } from 'viem';

import { outcomeOfCases, reconstructDisposition } from './disposition.js';

import type { ReconstructedDisposition } from './disposition.js';
import type { DeploymentGeneration, RegisteredContract } from './registry.js';

/**
 * Independent reconstruction of a settlement. PRD FR-014, PRD 15.2.
 *
 * The input is a settlement ID and enough RPC configuration to reach two
 * chains. Everything else is derived: the contracts from the deployment
 * manifests, the messages from the producers' own events, the VAAs from the
 * guardians, and the outcome from contract state. No application database is
 * consulted, and there is nothing in here that could consult one.
 *
 * ## SETTLED and SETTLED_FINAL are different things
 *
 * `SETTLED` is a value of `SettlementCoordinator.SettlementState`. It is stored
 * on chain, it is what the state machine reaches when both legs report, and it
 * is the only one of the two that a contract knows about.
 *
 * `SETTLED_FINAL` is not on chain and is not an enum anywhere. It is this
 * verifier's classification, and it holds only when every one of these is true:
 *
 * ```text
 *   the coordinator's own state is SETTLED
 *   both leg outcomes are RELEASED or RETURNED, and neither is HELD
 *   the cash leg's local state agrees with the coordinator's outcome for it
 *   the asset leg's reservation agrees with the coordinator's outcome for it
 *   every cross-chain fact the decision rests on arrived at FINALIZED
 *   every one of those VAAs is recorded consumed on its destination contract
 *   every contract involved matches the code hash its manifest pins
 *   every contract belongs to the same deployment generation
 *   conservation holds: the escrow's books equal its balance, nothing reserved
 * ```
 *
 * A settlement can be `SETTLED` on chain and not `SETTLED_FINAL` here — most
 * obviously if a leg reached its outcome through a message that was authentic
 * but not final. The contracts refuse that today, and the verifier checks it
 * anyway, because the point of an independent verifier is not to trust the
 * thing it is verifying.
 *
 * The reverse cannot happen: `SETTLED_FINAL` requires `SETTLED`.
 */

export const SETTLEMENT_STATE = [
  'NONE',
  'CASH_PREPARED',
  'ASSET_PREPARED',
  'READY',
  'COMMIT_ISSUED',
  'ABORT_ISSUED',
  'SETTLED',
  'ABORTED',
  'HELD',
  'CONTESTED',
] as const;

export const DECISION = ['NONE', 'COMMIT', 'ABORT'] as const;
/**
 * `SettlementCoordinator.LegOutcome`. `DISPOSED` is appended, never inserted.
 *
 * It is its own outcome rather than a flavour of `RELEASED` because the two are
 * different claims: a release delivered to the party the intent named, a
 * disposition delivered where an authority chose under PRD FR-012 — possibly the
 * same party, possibly a rebound wallet, possibly restricted custody.
 */
export const LEG_OUTCOME = ['NONE', 'RELEASED', 'RETURNED', 'HELD', 'DISPOSED'] as const;
export const CASH_LEG_STATE = [
  'NONE',
  'PREPARED',
  'COMMITTED',
  'RELEASED',
  'RETURNED',
  'HELD',
  'DISPOSED',
] as const;

export const MESSAGE_TYPE = [
  'CASH_PREPARED',
  'ASSET_PREPARED',
  'COMMIT',
  'ABORT',
  'CASH_RELEASED',
  'ASSET_RELEASED',
  'CASH_HELD',
  'ASSET_HELD',
  'DISPOSITION_RESOLVED',
] as const;

export type MessageTypeName = (typeof MESSAGE_TYPE)[number];

/**
 * Wormhole's EVM encoding, classified rather than compared.
 *
 * 200 is instant and 201 is safe; everything else is finalized. Comparing the
 * raw byte ranks instant above finalized, which is the substitution ADR-0013
 * exists to refuse, and a verifier that got this backwards would certify
 * exactly the settlements it should reject.
 */
export function finalityOf(consistencyLevel: number): 'INSTANT' | 'SAFE' | 'FINALIZED' {
  if (consistencyLevel === 200) return 'INSTANT';
  if (consistencyLevel === 201) return 'SAFE';
  return 'FINALIZED';
}

/** Every message class Conduit defines authorizes value. ADR-0013. */
export function authorizesValue(messageType: MessageTypeName): boolean {
  return messageType !== ('__none__' as MessageTypeName);
}

export interface VerifiedMessage {
  readonly messageType: MessageTypeName;
  readonly sequence: string;
  readonly producer: ChainScopedAddress;
  readonly producerRole: string;
  readonly emitterKey: string;
  readonly consumer: ChainScopedAddress | undefined;
  readonly consumerRole: string | undefined;
  readonly consistencyLevel: number;
  readonly finality: 'INSTANT' | 'SAFE' | 'FINALIZED';
  readonly vaaHash: Hex;
  readonly consumedAtDestination: boolean | undefined;
  readonly deploymentId: Hex;
  readonly settlementId: Hex;
  readonly intentHash: Hex;
  readonly destinationChainId: string;
  readonly problems: readonly string[];
}

export interface Finding {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface VerificationResult {
  readonly settlementId: Hex;
  readonly deploymentId: Hex;
  /** The on-chain enum. Never invented, never widened. */
  readonly canonicalState: (typeof SETTLEMENT_STATE)[number];
  readonly decision: (typeof DECISION)[number];
  readonly cashOutcome: (typeof LEG_OUTCOME)[number];
  readonly assetOutcome: (typeof LEG_OUTCOME)[number];
  /**
   * This verifier's classification. None of these is an on-chain state.
   *
   * ```text
   *   SETTLED_FINAL                the intent's own parties received the value
   *   DISPOSITION_FINAL            an authority redirected it under PRD FR-012
   *   RESTRICTED_HOLD_FINAL        it ended in registered restricted custody
   *   CONTESTED                    two authorities disagree; nothing may move
   *   HELD_PENDING_DISPOSITION     committed, undelivered, no case resolved it
   *   SETTLED_PENDING_VERIFICATION SETTLED on chain, a check did not pass here
   *   NOT_SETTLED                  the coordinator's own state is not SETTLED
   * ```
   *
   * `HELD_PENDING_DISPOSITION` and `RESTRICTED_HOLD_FINAL` are deliberately not
   * collapsed. The first is an unresolved case — value a canonical decision
   * spoke for that nothing has yet freed. The second is an authorized outcome
   * that a policy chose and a custodian received. They look alike from a
   * distance and mean opposite things about whether anyone is still owed an
   * answer.
   */
  readonly derived:
    | 'SETTLED_FINAL'
    | 'DISPOSITION_FINAL'
    | 'RESTRICTED_HOLD_FINAL'
    | 'CONTESTED'
    | 'HELD_PENDING_DISPOSITION'
    | 'SETTLED_PENDING_VERIFICATION'
    | 'NOT_SETTLED';
  /** One per leg, absent where the generation has no Disposition Kernel. */
  readonly dispositions: readonly ReconstructedDisposition[];
  readonly messages: readonly VerifiedMessage[];
  readonly findings: readonly Finding[];
  readonly addressCollisions: readonly (readonly { role: string; key: string }[])[];
  readonly searchedBlockRanges: Readonly<Record<number, { from: string; to: string }>>;
  readonly trustRoot: string;
}

/** Everything the verifier is allowed to read. There is no database here. */
export interface ChainReader {
  getChainId(chainId: number): Promise<number>;
  getCode(identity: ChainScopedAddress): Promise<Hex>;
  read(
    identity: ChainScopedAddress,
    functionName: string,
    args: readonly unknown[],
  ): Promise<unknown>;
  /**
   * `MessagePublished(sequence, messageType, settlementId)` on a producer.
   *
   * Returns what it found *and* what it could not scan. A public endpoint caps
   * its log range — Base Sepolia at roughly a thousand blocks, Monad Testnet at
   * roughly a hundred — and a scan that quietly skips the ranges it could not
   * read reports "no messages" for a settlement whose messages are simply
   * outside what it managed to look at. The first version of this verifier did
   * exactly that and certified SETTLED_FINAL having seen one message of three.
   */
  publishedMessages(
    chainId: number,
    producers: readonly ChainScopedAddress[],
    settlementId: Hex,
    range: { fromBlock: bigint; toBlock: bigint },
  ): Promise<{
    readonly found: readonly {
      producer: ChainScopedAddress;
      sequence: bigint;
      messageType: number;
      blockNumber: bigint;
    }[];
    readonly unscanned: readonly { from: string; to: string; reason: string }[];
  }>;
  latestBlock(chainId: number): Promise<bigint>;
}

/** The guardian network, reached without trusting any Conduit component. */
export interface GuardianReader {
  signedVaa(
    wormholeChainId: number,
    emitter: Hex,
    sequence: string,
  ): Promise<{ vaa: Hex } | undefined>;
}

export interface VerifyOptions {
  /**
   * How far back to look for this settlement's messages, per EVM chain ID.
   *
   * A settlement ID carries no timestamp, so a verifier cannot know where to
   * start without being told. The window that was actually searched is reported
   * in the result, so "no messages found" is never mistaken for "no messages
   * exist" — the difference matters and only one of them is a finding.
   */
  readonly fromBlock?: Readonly<Record<number, bigint>>;
  /**
   * Where to stop, per chain. Defaults to the head.
   *
   * Scanning to a moving head is the difference between a verifier that
   * finishes and one that does not: Monad Testnet caps `eth_getLogs` at roughly
   * a hundred blocks and produces three a second, so an unbounded scan chases
   * the chain. A settlement's messages all sit between its first and last
   * transaction, and bounding the window is the same kind of input as starting
   * one — reported either way, so a reader can see what was covered.
   */
  readonly toBlock?: Readonly<Record<number, bigint>>;
  readonly blockWindow?: bigint;
}

const DEFAULT_WINDOW = 200_000n;

function name<T extends readonly string[]>(table: T, value: unknown): T[number] {
  const index = Number(value);
  return table[index] ?? `UNKNOWN(${String(value)})`;
}

/** Decodes the Conduit header out of a signed VAA, without a Conduit contract. */
export function decodeVaa(vaaHex: Hex): {
  emitterChainId: number;
  emitterAddress: Hex;
  sequence: bigint;
  consistencyLevel: number;
  header: {
    protocolVersion: number;
    messageType: MessageTypeName;
    deploymentId: Hex;
    settlementId: Hex;
    intentHash: Hex;
    sourceChainId: bigint;
    destinationChainId: bigint;
    stateVersion: bigint;
  };
} {
  const bytes = Buffer.from(vaaHex.slice(2), 'hex');
  const signatureCount = bytes[5] ?? 0;
  const body = 6 + signatureCount * 66;

  const emitterChainId = bytes.readUInt16BE(body + 8);
  const emitterAddress: Hex = `0x${bytes.subarray(body + 10, body + 42).toString('hex')}`;
  const sequence = bytes.readBigUInt64BE(body + 42);
  const consistencyLevel = bytes[body + 50] ?? 0;

  const payload = bytes.subarray(body + 51);
  if (payload.length < 173)
    throw new Error(`payload is ${String(payload.length)} bytes, expected 173`);

  const messageTypeIndex = payload[4] ?? -1;
  const messageType = MESSAGE_TYPE[messageTypeIndex];
  if (messageType === undefined)
    throw new Error(`unknown message type ${String(messageTypeIndex)}`);

  return {
    emitterChainId,
    emitterAddress,
    sequence,
    consistencyLevel,
    header: {
      protocolVersion: payload.readUInt32BE(0),
      messageType,
      deploymentId: `0x${payload.subarray(5, 37).toString('hex')}`,
      settlementId: `0x${payload.subarray(37, 69).toString('hex')}`,
      intentHash: `0x${payload.subarray(69, 101).toString('hex')}`,
      sourceChainId: BigInt(`0x${payload.subarray(101, 133).toString('hex')}`),
      destinationChainId: BigInt(`0x${payload.subarray(133, 165).toString('hex')}`),
      stateVersion: BigInt(`0x${payload.subarray(165, 173).toString('hex')}`),
    },
  };
}

/**
 * Which contract consumes a given message class, and on which chain.
 *
 * Keyed by message type rather than by emitter address, because the emitter
 * address is exactly the thing that collides across chains in this deployment.
 */
const CONSUMER_ROLE: Partial<Record<MessageTypeName, string>> = {
  ASSET_PREPARED: 'SettlementCoordinator',
  ASSET_RELEASED: 'SettlementCoordinator',
  ASSET_HELD: 'SettlementCoordinator',
  COMMIT: 'RWACVASettlementAdapter',
  ABORT: 'RWACVASettlementAdapter',
};

export async function verifySettlement(
  settlementId: Hex,
  generation: DeploymentGeneration,
  chain: ChainReader,
  guardians: GuardianReader,
  options: VerifyOptions = {},
): Promise<VerificationResult> {
  const findings: Finding[] = [];
  const record = (check: string, ok: boolean, detail: string): void => {
    findings.push({ check, ok, detail });
  };

  // ── The deployment itself ─────────────────────────────────────────────────

  for (const contract of generation.contracts()) {
    const reported = await chain.getChainId(contract.identity.chainId);
    if (reported !== contract.identity.chainId) {
      record(
        `chain identity for ${contract.role}`,
        false,
        `RPC for chain ${String(contract.identity.chainId)} reports ${String(reported)}`,
      );
      continue;
    }
    const code = await chain.getCode(contract.identity);
    const { keccak256 } = await import('viem');
    const liveHash = keccak256(code);
    record(
      `${contract.role} code hash on chain ${String(contract.identity.chainId)}`,
      liveHash === contract.expectedCodeHash,
      liveHash === contract.expectedCodeHash
        ? `${contractKey(contract.identity)} matches the manifest`
        : `${contractKey(contract.identity)}: live ${liveHash}, manifest ${contract.expectedCodeHash}`,
    );
  }

  const collisions = generation.addressCollisions();
  record(
    'cross-chain address collisions',
    true,
    collisions.length === 0
      ? 'none'
      : collisions
          .map((group) => group.map((entry) => `${entry.role} at ${entry.key}`).join(' vs '))
          .join('; '),
  );

  // ── Canonical state ───────────────────────────────────────────────────────

  const coordinator = generation.role(coordinatorChainId(generation), 'SettlementCoordinator');
  const settlement = (await chain.read(coordinator.identity, 'settlementOf', [
    settlementId,
  ])) as readonly unknown[];

  const canonicalState = name(SETTLEMENT_STATE, settlement[0]);
  const decision = name(DECISION, settlement[1]);
  const cashPrepared = settlement[2] === true;
  const assetPrepared = settlement[3] === true;
  const cashOutcome = name(LEG_OUTCOME, settlement[4]);
  const assetOutcome = name(LEG_OUTCOME, settlement[5]);
  const boundIntentHash = settlement[6] as Hex;

  record('coordinator knows this settlement', canonicalState !== 'NONE', canonicalState);
  record(
    'both legs were prepared',
    cashPrepared && assetPrepared,
    `cash ${String(cashPrepared)}, asset ${String(assetPrepared)}`,
  );

  // ── The legs, each read from its own chain ────────────────────────────────

  const escrow = generation.role(coordinator.identity.chainId, 'CashEscrow');
  const leg = (await chain.read(escrow.identity, 'legOf', [settlementId])) as readonly unknown[];
  const legState = name(CASH_LEG_STATE, leg[4]);

  record(
    'the escrow agrees with the coordinator about the cash leg',
    legAgrees(legState, cashOutcome),
    `escrow ${legState}, coordinator ${cashOutcome}`,
  );
  record(
    'the cash leg binds the same intent',
    (leg[3] as Hex).toLowerCase() === boundIntentHash.toLowerCase(),
    `${String(leg[3])} vs ${boundIntentHash}`,
  );

  const adapter = generation.role(assetChainId(generation), 'RWACVASettlementAdapter');
  const token = generation.role(adapter.identity.chainId, 'ConduitRWACVA');
  const reservation = (await chain.read(token.identity, 'reservationOf', [
    settlementId,
  ])) as readonly unknown[];
  const reserved = {
    owner: reservation[0] as Address,
    amount: reservation[1] as bigint,
    announced: reservation[4] === true,
    committed: reservation[5] === true,
    released: reservation[6] === true,
    cancelled: reservation[7] === true,
  };

  record(
    'the token agrees with the coordinator about the asset leg',
    reservationAgrees(reserved, assetOutcome),
    `released ${String(reserved.released)}, cancelled ${String(reserved.cancelled)}, coordinator ${assetOutcome}`,
  );

  // ── Conservation, in terms that hold whenever they are read ───────────────

  const totalEscrowed = (await chain.read(escrow.identity, 'totalEscrowed', [])) as bigint;
  const cashToken = generation.role(coordinator.identity.chainId, 'ConduitSandboxSettlementCVA');
  const escrowBalance = (await chain.read(cashToken.identity, 'balanceOf', [
    escrow.identity.address,
  ])) as bigint;
  record(
    'the escrow accounts for exactly what it holds',
    totalEscrowed === escrowBalance,
    `accounted ${String(totalEscrowed)}, held ${String(escrowBalance)}`,
  );

  // Per settlement, never per wallet.
  //
  // `reservedBalanceOf` aggregates every open reservation the owner has, and one
  // seller can be party to many settlements at once. Asserting it is zero fails
  // a settlement that released perfectly because a *different* one is still
  // held — which is exactly what happened the first time this ran: the
  // generation-1 bond is legitimately held on the same token and the same
  // seller, and this settlement had nothing to do with it. It is the address
  // collision mistake in another costume, keying a claim to the wrong identity.
  //
  // What this settlement can be held to is its own reservation being closed.
  // The aggregate is reported as context, because a reader who sees a non-zero
  // reserved balance deserves to know it is accounted for elsewhere.
  const stillReserved = (await chain.read(token.identity, 'reservedBalanceOf', [
    reserved.owner,
  ])) as bigint;
  record(
    'this settlement holds no reservation open',
    assetOutcome === 'NONE' || reserved.released || reserved.cancelled,
    `released ${String(reserved.released)}, cancelled ${String(reserved.cancelled)}; ` +
      `${String(stillReserved)} reserved against ${reserved.owner} across all of its settlements`,
  );

  // ── The messages, found from the producers' own events ────────────────────

  const searchedBlockRanges: Record<number, { from: string; to: string }> = {};
  const messages: VerifiedMessage[] = [];
  const unscanned: string[] = [];

  // Every contract that publishes, grouped by chain so each range is read once.
  // The escrow's CASH_PREPARED has no consumer and is included anyway: a message
  // class nothing reads is still part of the record, and leaving it out would
  // make the report's silence about it indistinguishable from its absence.
  //
  // One pass per chain rather than one per producer is not only faster. Two
  // passes over the same range can disagree if the chain advances between them,
  // and a verifier whose answer depends on how many contracts it happened to
  // ask about is not reading a fixed history.
  const producersByChain = new Map<number, RegisteredContract[]>();
  for (const producer of [adapter, coordinator, escrow]) {
    const group = producersByChain.get(producer.identity.chainId) ?? [];
    group.push(producer);
    producersByChain.set(producer.identity.chainId, group);
  }

  for (const [chainId, producers] of producersByChain) {
    const head = await chain.latestBlock(chainId);
    const window = options.blockWindow ?? DEFAULT_WINDOW;
    const configured = options.fromBlock?.[chainId];
    const fromBlock = configured ?? (head > window ? head - window : 0n);
    const toBlock = options.toBlock?.[chainId] ?? head;
    searchedBlockRanges[chainId] = { from: String(fromBlock), to: String(toBlock) };

    const published = await chain.publishedMessages(
      chainId,
      producers.map((entry) => entry.identity),
      settlementId,
      { fromBlock, toBlock },
    );

    if (published.unscanned.length > 0) {
      unscanned.push(
        ...published.unscanned.map(
          (gap) => `chain ${String(chainId)} ${gap.from}-${gap.to}: ${gap.reason}`,
        ),
      );
    }

    for (const entry of published.found) {
      const producer = producers.find(
        (candidate) =>
          candidate.identity.address.toLowerCase() === entry.producer.address.toLowerCase(),
      );
      if (producer === undefined) continue;
      const messageType = MESSAGE_TYPE[entry.messageType];
      if (messageType === undefined) continue;

      const emitter: WormholeEmitter = {
        wormholeChainId: producer.wormholeChainId,
        emitter: addressToEmitter(producer.identity.address),
      };

      const problems: string[] = [];
      const signed = await guardians.signedVaa(
        emitter.wormholeChainId,
        emitter.emitter,
        String(entry.sequence),
      );

      if (signed === undefined) {
        messages.push({
          messageType,
          sequence: String(entry.sequence),
          producer: producer.identity,
          producerRole: producer.role,
          emitterKey: emitterKey(emitter),
          consumer: undefined,
          consumerRole: undefined,
          consistencyLevel: -1,
          finality: 'INSTANT',
          vaaHash: '0x',
          consumedAtDestination: undefined,
          deploymentId: producer.deploymentId,
          settlementId,
          intentHash: '0x',
          destinationChainId: '0',
          problems: ['the guardians have not signed this message'],
        });
        continue;
      }

      const decoded = decodeVaa(signed.vaa);
      const { keccak256 } = await import('viem');
      // The VAA hash Wormhole records is the double keccak of the body; the
      // consuming contract stores whatever `parseAndVerifyVM` returned, so this
      // is recomputed from the same bytes rather than taken from an indexer.
      const bytes = Buffer.from(signed.vaa.slice(2), 'hex');
      const bodyOffset = 6 + (bytes[5] ?? 0) * 66;
      const vaaHash = keccak256(keccak256(`0x${bytes.subarray(bodyOffset).toString('hex')}`));

      if (decoded.emitterChainId !== emitter.wormholeChainId) {
        problems.push(
          `emitter chain ${String(decoded.emitterChainId)}, expected ${String(emitter.wormholeChainId)}`,
        );
      }
      if (decoded.emitterAddress.toLowerCase() !== emitter.emitter.toLowerCase()) {
        problems.push(`emitter ${decoded.emitterAddress}, expected ${emitter.emitter}`);
      }
      if (
        emitterToAddress(decoded.emitterAddress).toLowerCase() !==
        producer.identity.address.toLowerCase()
      ) {
        problems.push('the emitter does not unpad to the producer this deployment names');
      }
      if (decoded.header.deploymentId.toLowerCase() !== generation.deploymentId.toLowerCase()) {
        problems.push(
          `deployment ${decoded.header.deploymentId}, expected ${generation.deploymentId}`,
        );
      }
      if (decoded.header.settlementId.toLowerCase() !== settlementId.toLowerCase()) {
        problems.push(`settlement ${decoded.header.settlementId}`);
      }
      if (decoded.header.protocolVersion !== generation.protocolVersion) {
        problems.push(`protocol version ${String(decoded.header.protocolVersion)}`);
      }
      const finality = finalityOf(decoded.consistencyLevel);
      if (authorizesValue(messageType) && finality !== 'FINALIZED') {
        problems.push(`carried at ${finality} while authorizing value`);
      }

      const consumerRole = CONSUMER_ROLE[messageType];
      let consumer: ChainScopedAddress | undefined;
      let consumedAtDestination: boolean | undefined;

      if (consumerRole !== undefined) {
        const destinationChainId = Number(decoded.header.destinationChainId);
        try {
          const registered = generation.role(destinationChainId, consumerRole);
          consumer = registered.identity;
          consumedAtDestination = (await chain.read(registered.identity, 'consumedVaa', [
            vaaHash,
          ])) as boolean;
          if (!consumedAtDestination) {
            problems.push('the destination has no record of consuming this VAA');
          }
        } catch (error) {
          problems.push(
            `no ${consumerRole} on destination chain ${String(destinationChainId)}: ${String(error)}`,
          );
        }
      }

      messages.push({
        messageType,
        sequence: String(entry.sequence),
        producer: producer.identity,
        producerRole: producer.role,
        emitterKey: emitterKey(emitter),
        consumer,
        consumerRole,
        consistencyLevel: decoded.consistencyLevel,
        finality,
        vaaHash,
        consumedAtDestination,
        deploymentId: decoded.header.deploymentId,
        settlementId: decoded.header.settlementId,
        intentHash: decoded.header.intentHash,
        destinationChainId: String(decoded.header.destinationChainId),
        problems,
      });
    }
  }

  record(
    'every block range this settlement could span was actually read',
    unscanned.length === 0,
    unscanned.length === 0
      ? 'no gaps'
      : `unread ranges, so an absent message proves nothing: ${unscanned.join('; ')}`,
  );

  const messageProblems = messages.flatMap((message) =>
    message.problems.map((problem) => `${message.messageType}/${message.sequence}: ${problem}`),
  );
  record(
    'every message found is authentic, final, and consumed once',
    messages.length > 0 && messageProblems.length === 0,
    messages.length === 0
      ? 'no messages found in the searched block range'
      : messageProblems.length === 0
        ? `${String(messages.length)} messages, all FINALIZED and consumed`
        : messageProblems.join('; '),
  );

  // The message set the canonical state implies. A settled COMMIT rests on a
  // remote preparation, a decision, and a remote resolution; finding fewer than
  // that means the reconstruction is incomplete, whatever the contracts say.
  const seen = new Set(messages.map((message) => message.messageType));
  const required: MessageTypeName[] = [];
  if (canonicalState !== 'NONE') required.push('CASH_PREPARED', 'ASSET_PREPARED');
  if (decision === 'COMMIT') required.push('COMMIT');
  if (decision === 'ABORT') required.push('ABORT');
  const assetResolved = assetOutcome !== 'NONE';
  const missing: string[] = required.filter((type) => !seen.has(type));
  if (assetResolved && !seen.has('ASSET_RELEASED') && !seen.has('ASSET_HELD')) {
    missing.push('ASSET_RELEASED or ASSET_HELD');
  }
  // A missing message names the window it was looked for in. Without that, a
  // report saying "no gaps" and "missing CASH_PREPARED" reads as proof the
  // message does not exist, when the honest reading is that the search started
  // after it was published. The window is an input and the report says so.
  const windows = Object.entries(searchedBlockRanges)
    .map(([chainId, range]) => `chain ${chainId} ${range.from}-${range.to}`)
    .join(', ');
  record(
    'every message the canonical state implies was found',
    missing.length === 0,
    missing.length === 0
      ? `found ${[...seen].join(', ')}`
      : `missing ${missing.join(', ')} within ${windows}; found ${[...seen].join(', ') || 'nothing'}. ` +
          'Widen the search window before concluding these were never published.',
  );

  // ── The Disposition Kernel, one case per leg ──────────────────────────────
  //
  // Read before the classification because a contested case outranks everything
  // else a settlement could be: it means two authorities disagree and nothing
  // may move until a resolver decides, whatever the coordinator's state says.

  const cashCase = await reconstructDisposition(
    settlementId,
    'CASH',
    coordinator.identity.chainId,
    generation,
    chain,
  );
  const assetCase = await reconstructDisposition(
    settlementId,
    'ASSET',
    adapter.identity.chainId,
    generation,
    chain,
  );
  const dispositions = [cashCase, assetCase].filter(
    (entry): entry is ReconstructedDisposition => entry !== undefined,
  );
  const dispositionOutcome = outcomeOfCases([cashCase, assetCase]);

  for (const reconstructed of dispositions) {
    record(
      `the ${reconstructed.leg.toLowerCase()} leg's disposition case`,
      reconstructed.state !== 'CONTESTED',
      reconstructed.state === 'EXECUTED'
        ? `${String(reconstructed.executedType)} to ${String(reconstructed.executedDestination)}, ` +
            `${String(reconstructed.signatures)} signature(s) under policy ${reconstructed.policyId}`
        : `case is ${reconstructed.state}`,
    );
    record(
      `the ${reconstructed.leg.toLowerCase()} leg's authorities are registered`,
      reconstructed.authorities.every((authority) => authority.authorityType !== undefined),
      reconstructed.authorities
        .map(
          (authority) =>
            `${authority.address} as ${authority.authorityType ?? 'UNREGISTERED'}` +
            (authority.stillActive ? '' : ' (since revoked)'),
        )
        .join(', ') || 'none',
    );
    record(
      `the ${reconstructed.leg.toLowerCase()} leg's policy is unchanged since filing`,
      reconstructed.policyUnchangedSinceFiling,
      reconstructed.policyUnchangedSinceFiling
        ? reconstructed.policyHash
        : `orders bound ${reconstructed.policyHash}; the registry now hashes to something else`,
    );
  }

  // A leg the coordinator records as DISPOSED must have a kernel case that
  // executed. Without this, a coordinator reporting a disposition nobody
  // authorized would pass every other check in this file.
  const disposedLegs: string[] = [];
  if (cashOutcome === 'DISPOSED') disposedLegs.push('CASH');
  if (assetOutcome === 'DISPOSED') disposedLegs.push('ASSET');
  for (const legName of disposedLegs) {
    const reconstructed = dispositions.find((entry) => entry.leg === legName);
    record(
      `the ${legName.toLowerCase()} leg's disposition was authorized`,
      reconstructed?.state === 'EXECUTED',
      reconstructed === undefined
        ? 'the coordinator reports DISPOSED and no kernel case exists for it'
        : `case ${reconstructed.state}, order ${String(reconstructed.executedOrderHash)}`,
    );
  }

  // ── The classification ────────────────────────────────────────────────────

  const allChecksPass = findings.every((finding) => finding.ok);
  const derived: VerificationResult['derived'] = (() => {
    if (dispositionOutcome === 'CONTESTED') return 'CONTESTED';
    if (canonicalState === 'HELD') return 'HELD_PENDING_DISPOSITION';
    if (canonicalState !== 'SETTLED') return 'NOT_SETTLED';
    if (!allChecksPass) return 'SETTLED_PENDING_VERIFICATION';
    if (dispositionOutcome === 'RESTRICTED_HOLD_FINAL') return 'RESTRICTED_HOLD_FINAL';
    if (dispositionOutcome === 'DISPOSITION_FINAL') return 'DISPOSITION_FINAL';
    return 'SETTLED_FINAL';
  })();

  const terminal =
    derived === 'SETTLED_FINAL' ||
    derived === 'DISPOSITION_FINAL' ||
    derived === 'RESTRICTED_HOLD_FINAL';

  record(
    'derived classification',
    terminal,
    derived === 'SETTLED_FINAL'
      ? 'the coordinator says SETTLED and every fact it rests on checks out'
      : derived === 'DISPOSITION_FINAL'
        ? 'terminal through an authorized disposition, not through delivery to the named parties'
        : derived === 'RESTRICTED_HOLD_FINAL'
          ? 'terminal in registered restricted custody; no party to the trade received the value'
          : derived === 'CONTESTED'
            ? 'two authorized orders disagree; nothing may move until the policy resolves it'
            : derived === 'HELD_PENDING_DISPOSITION'
              ? 'committed and undelivered, with no disposition case resolving it'
              : derived === 'NOT_SETTLED'
                ? `the coordinator's own state is ${canonicalState}`
                : 'the coordinator says SETTLED but at least one check did not pass',
  );

  return {
    settlementId,
    deploymentId: generation.deploymentId,
    canonicalState,
    decision,
    cashOutcome,
    assetOutcome,
    derived,
    dispositions,
    messages,
    findings,
    addressCollisions: collisions,
    searchedBlockRanges,
    trustRoot:
      'deployment manifests, two chain RPCs, and the Wormhole guardian set. No application database.',
  };
}

function legAgrees(
  legState: (typeof CASH_LEG_STATE)[number],
  outcome: (typeof LEG_OUTCOME)[number],
): boolean {
  if (outcome === 'RELEASED') return legState === 'RELEASED';
  if (outcome === 'RETURNED') return legState === 'RETURNED';
  if (outcome === 'HELD') return legState === 'HELD';
  if (outcome === 'DISPOSED') return legState === 'DISPOSED';
  return true;
}

function reservationAgrees(
  reserved: { released: boolean; cancelled: boolean; committed: boolean },
  outcome: (typeof LEG_OUTCOME)[number],
): boolean {
  if (outcome === 'RELEASED') return reserved.released;
  if (outcome === 'RETURNED') return reserved.cancelled;
  // A disposition releases the reservation to wherever the order named, so the
  // token reads the same as an ordinary delivery. What separates them is the
  // kernel case, which the disposition checks above assert independently.
  if (outcome === 'DISPOSED') return reserved.released;
  if (outcome === 'HELD') return reserved.committed && !reserved.released && !reserved.cancelled;
  // NONE: the leg has not resolved, and neither should the reservation have.
  return true;
}

function coordinatorChainId(generation: DeploymentGeneration): number {
  const found = generation
    .contracts()
    .find((contract) => contract.role === 'SettlementCoordinator');
  if (found === undefined) throw new Error('no SettlementCoordinator in this deployment');
  return found.identity.chainId;
}

function assetChainId(generation: DeploymentGeneration): number {
  const found = generation
    .contracts()
    .find((contract) => contract.role === 'RWACVASettlementAdapter');
  if (found === undefined) throw new Error('no RWACVASettlementAdapter in this deployment');
  return found.identity.chainId;
}

export type { RegisteredContract };

/**
 * The settlement workspace.
 *
 * Reads both chains, decides what the settlement needs next, and runs it from
 * the connected wallet. Every button on this page corresponds to a real call on
 * a deployed contract, and every one of them is gated on canonical state rather
 * than on a step this page thinks it is at.
 *
 * ## The terms are re-derived, not trusted
 *
 * The server hands over the stored terms. Before anything is offered, the intent
 * digest is recomputed here and compared with the settlement id in the URL. They
 * are the same value by construction — the id *is* the EIP-712 digest — so a
 * mismatch means the projection disagrees with itself, and the workspace refuses
 * to act rather than preparing a leg against terms nobody signed.
 *
 * ## Compliance comes from the authority, not from here
 *
 * `issueCommit`, `releaseCash` and `releaseAsset` each demand a quorum of
 * attestations signed by a registered compliance signer. The browser cannot
 * produce one and should not be able to. It asks the Worker, which asks
 * Cleanverse live and signs the answer, and then it asks the *contract* whether
 * it accepts that proof before a wallet is ever prompted.
 */

import {
  history,
  nextAction,
  rolesOf,
  type Fact,
  type MessageObservation,
  type NextAction,
  type Snapshot,
  type Terms,
} from '../actions.js';
import {
  ADAPTER_ABI,
  BASE_SEPOLIA,
  COORDINATOR_ABI,
  CORE_ABI,
  ERC20_ABI,
  ESCROW_ABI,
  MONAD_TESTNET,
  RWA_ABI,
  ZERO_ADDRESS,
  readCashLeg,
  readReservation,
  readSettlement,
  type AttestationTuple,
  type ComplianceProof,
  type IntentTuple,
  type CashLegRecord,
  type ReservationRecord,
  type SettlementRecord,
} from '../onchain.js';
import { createSettlementIntent, DOMAIN_NAME, DOMAIN_VERSION } from '@conduit-protocol/domain';
import type { Address, Hex } from 'viem';

import { mountDisposition, readDispositionCase, type DispositionContext } from './disposition.js';
import { fromBaseUnits, type Deployment } from './protocol.js';
import { session } from './session.js';
import { PrerequisiteMissing, runSequence, type TxState, type WriteStep } from './tx.js';
import { publicClient, wallet } from './wallet.js';

export interface WorkspacePayload {
  readonly settlementId: Hex;
  readonly deployment: Deployment;
  readonly disposition?: {
    controller: Address;
    registry: Address;
    policyId: Hex;
    contestWindowSeconds: number;
    chainId: number;
  };
  readonly terms: Record<string, string>;
  readonly signatures: {
    payer: boolean;
    seller: boolean;
    payerSignature?: Hex;
    sellerSignature?: Hex;
  };
  readonly termsSource: string;
  readonly verifierClass?: string;
  readonly canonicalState: string;
  readonly attestationsAvailable: boolean;
}

function node(tag: string, className?: string, text?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function big(value: string | undefined): bigint {
  return BigInt(value ?? '0');
}

function addressOf(value: string | undefined): Address {
  return (value ?? ZERO_ADDRESS).toLowerCase() as Address;
}

/** The nineteen fields, in `SettlementIntentLib.SettlementIntent` order. */
function termsTuple(terms: Record<string, string>): IntentTuple {
  return [
    Number(terms['version'] ?? '1'),
    big(terms['cashChainId']),
    addressOf(terms['cashEscrow']),
    addressOf(terms['cashAsset']),
    big(terms['cashAmount']),
    addressOf(terms['cashPayer']),
    addressOf(terms['cashReceiver']),
    big(terms['assetChainId']),
    addressOf(terms['assetEscrow']),
    addressOf(terms['assetToken']),
    big(terms['assetAmount']),
    addressOf(terms['assetSeller']),
    addressOf(terms['assetReceiver']),
    terms['cashPolicyHash'] as Hex,
    terms['assetPolicyHash'] as Hex,
    big(terms['prepareDeadline']),
    big(terms['commitDeadline']),
    big(terms['releaseDeadline']),
    big(terms['nonce']),
  ];
}

function readableTerms(terms: Record<string, string>): Terms {
  return {
    cashAmount: big(terms['cashAmount']),
    cashPayer: addressOf(terms['cashPayer']),
    cashReceiver: addressOf(terms['cashReceiver']),
    assetAmount: big(terms['assetAmount']),
    assetSeller: addressOf(terms['assetSeller']),
    assetReceiver: addressOf(terms['assetReceiver']),
    prepareDeadline: big(terms['prepareDeadline']),
    commitDeadline: big(terms['commitDeadline']),
    releaseDeadline: big(terms['releaseDeadline']),
  };
}

/**
 * The digest the coordinator will compute, computed here first.
 *
 * Returns the recomputed id so the caller can compare it with the one the URL
 * claims. Equality is the whole point: the settlement id is the EIP-712 digest
 * of these exact terms under this exact domain, so any difference means the
 * terms on this page are not the terms that id refers to.
 */
function recomputeId(payload: WorkspacePayload): Hex {
  const terms = payload.terms;
  return createSettlementIntent(
    {
      version: Number(terms['version'] ?? '1'),
      cashChainId: big(terms['cashChainId']),
      cashEscrow: addressOf(terms['cashEscrow']),
      cashAsset: addressOf(terms['cashAsset']),
      cashAmount: big(terms['cashAmount']),
      cashPayer: addressOf(terms['cashPayer']),
      cashReceiver: addressOf(terms['cashReceiver']),
      assetChainId: big(terms['assetChainId']),
      assetEscrow: addressOf(terms['assetEscrow']),
      assetToken: addressOf(terms['assetToken']),
      assetAmount: big(terms['assetAmount']),
      assetSeller: addressOf(terms['assetSeller']),
      assetReceiver: addressOf(terms['assetReceiver']),
      cashPolicyHash: terms['cashPolicyHash'] as Hex,
      assetPolicyHash: terms['assetPolicyHash'] as Hex,
      prepareDeadline: big(terms['prepareDeadline']),
      commitDeadline: big(terms['commitDeadline']),
      releaseDeadline: big(terms['releaseDeadline']),
      nonce: big(terms['nonce']),
    },
    {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: big(terms['cashChainId']),
      verifyingContract: payload.deployment.coordinator,
    },
  ).settlementId;
}

// ── Compliance proofs ───────────────────────────────────────────────────────

interface MintedProof {
  readonly ok: boolean;
  readonly unavailable: boolean;
  readonly checkedAt: string;
  readonly expiresAt: number;
  readonly eligibility: readonly {
    subject: string;
    status: string;
    reason: string;
    detail: string;
    checkedAt: string;
  }[];
  /** The `ComplianceProof` tuple the ABI takes: attestations, then signatures. */
  readonly proof: ComplianceProof;
}

async function mintProof(
  settlementId: Hex,
  intentHash: Hex,
  purpose: string,
  subjects: readonly Address[],
): Promise<MintedProof> {
  const response = await fetch('/api/attestations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settlementId, intentHash, purpose, subjects }),
  });
  const body = (await response.json()) as {
    ok?: boolean;
    unavailable?: boolean;
    attestations?: {
      settlementId: Hex;
      intentHash: Hex;
      subject: Address;
      eligible: boolean;
      issuedAt: string;
      expiresAt: string;
      evidenceHash: Hex;
      signature: Hex;
    }[];
    eligibility?: MintedProof['eligibility'];
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(body.error?.message ?? 'the compliance authority could not be reached');
  }

  const attestations = body.attestations ?? [];
  const expiresAt = attestations.reduce(
    (soonest, attestation) => Math.min(soonest, Number(attestation.expiresAt)),
    Number.MAX_SAFE_INTEGER,
  );

  return {
    ok: body.ok === true,
    unavailable: body.unavailable === true,
    checkedAt: body.eligibility?.[0]?.checkedAt ?? new Date().toISOString(),
    expiresAt: attestations.length === 0 ? 0 : expiresAt,
    eligibility: body.eligibility ?? [],
    proof: [
      attestations.map((attestation): AttestationTuple => [
        attestation.settlementId,
        attestation.intentHash,
        attestation.subject,
        attestation.eligible,
        BigInt(attestation.issuedAt),
        BigInt(attestation.expiresAt),
        attestation.evidenceHash,
      ]),
      attestations.map((attestation) => attestation.signature),
    ],
  };
}

// ── The workspace ───────────────────────────────────────────────────────────

/**
 * What this workspace has done in this visit, as distinct from the participant
 * session.
 *
 * These live for as long as the page does and mean nothing anywhere else: a
 * minted proof expires in fifteen minutes, and a simulated commit is a claim
 * about one browser at one moment. The participant's identity, balances and
 * activity are the global session's, and this holds none of them.
 */
interface ActionState {
  /** The commit proof this visit holds, minted after finality and short-lived. */
  commit?: MintedProof;
  /** The prepare-time answer, for the side-by-side the workspace shows at commit. */
  prepare?: MintedProof;
  commitSimulated: boolean;
  busy: boolean;
}

export function mountWorkspace(): void {
  const root = document.querySelector<HTMLElement>('[data-workspace]');
  if (root === null) return;

  const payload = JSON.parse(root.dataset['workspace'] ?? '{}') as WorkspacePayload;
  const actionHost = root.querySelector<HTMLElement>('[data-action-host]');
  const finalityHost = root.querySelector<HTMLElement>('[data-finality-host]');
  const complianceHost = root.querySelector<HTMLElement>('[data-compliance-host]');
  const dispositionHost = root.querySelector<HTMLElement>('[data-disposition-host]');
  if (actionHost === null || finalityHost === null) return;

  const terms = readableTerms(payload.terms);
  const actionState: ActionState = { commitSimulated: false, busy: false };

  const recomputed = recomputeId(payload);
  const idMatches = recomputed.toLowerCase() === payload.settlementId.toLowerCase();

  let messages: readonly MessageRow[] = [];
  let snapshot: Snapshot | undefined;

  const render = (): void => {
    if (snapshot === undefined) return;
    const action = nextAction(snapshot);
    paintAction(actionHost, action, snapshot, payload, actionState, idMatches, recomputed, run);
    paintFinality(finalityHost, messages);
    if (complianceHost !== null) paintCompliance(complianceHost, actionState);
    const state = snapshot.settlement?.state;
    if (dispositionHost !== null && (state === 'HELD' || state === 'CONTESTED')) {
      mountDisposition(dispositionHost, dispositionContext(payload, snapshot), refresh);
    }
  };

  const refresh = async (): Promise<void> => {
    messages = await loadMessages(payload.settlementId);
    snapshot = await readSnapshot(payload, terms, messages, actionState);
    render();
  };

  const run = (action: NextAction): void => {
    if (actionState.busy || snapshot === undefined) return;
    actionState.busy = true;
    const host = actionHost.querySelector<HTMLElement>('[data-tx]') ?? actionHost;
    void execute(action, payload, terms, snapshot, actionState, host)
      .catch((error: unknown) => {
        const message = node('div', 't-caption tx-error', errorText(error));
        host.append(message);
      })
      .finally(() => {
        actionState.busy = false;
        // Announced whether the action succeeded or not: a reverted commit still
        // moves nothing, but a failed release can leave a settlement HELD, and
        // the surfaces that list this settlement should re-read either way
        // rather than infer from an outcome this page has not confirmed.
        session.protocolChanged(payload.settlementId);
        void refresh();
      });
  };

  // The session owns the connection; this page re-reads whenever it changes,
  // including a change of account, which changes which action is even offered.
  session.subscribe(() => {
    void refresh();
  });

  // Finality is minutes, so the page keeps looking without being reloaded. Reads
  // only — nothing here sends anything on a timer. Ten seconds is chosen against
  // the thing being watched: a guardian signature appears at a moment nobody
  // controls, and a minute of stale "waiting" after it lands is a page that has
  // stopped telling the truth.
  window.setInterval(() => {
    if (!actionState.busy) void refresh();
  }, 10_000);
}

function errorText(error: unknown): string {
  const shortMessage = (error as { shortMessage?: string }).shortMessage;
  if (typeof shortMessage === 'string' && shortMessage !== '') return shortMessage;
  return error instanceof Error ? error.message : String(error);
}

function dispositionContext(payload: WorkspacePayload, snapshot: Snapshot): DispositionContext {
  return {
    settlementId: payload.settlementId,
    deployment: payload.deployment,
    ...(payload.disposition === undefined ? {} : { kernel: payload.disposition }),
    terms: snapshot.terms,
    intendedReceiver: snapshot.intendedReceiver ?? snapshot.terms.assetReceiver,
    stateVersion: snapshot.settlement?.stateVersion ?? 0n,
  };
}

// ── Reading ─────────────────────────────────────────────────────────────────

interface MessageRow {
  readonly messageType: string;
  readonly sequence: string;
  readonly emitter: Address;
  readonly emitterChainId: number;
  readonly txHash: Hex;
  readonly includedAt?: string;
  readonly finalized: boolean;
  readonly finalizedAt?: string;
  readonly finalitySeconds?: number;
  readonly vaa?: Hex;
}

async function loadMessages(settlementId: Hex): Promise<readonly MessageRow[]> {
  try {
    const response = await fetch(`/api/settlements/${settlementId}/messages`);
    if (!response.ok) return [];
    const body = (await response.json()) as { messages?: MessageRow[] };
    return body.messages ?? [];
  } catch {
    // A projection we cannot read is a projection, not a settlement. The action
    // panel still resolves from chain state.
    return [];
  }
}

/**
 * Tells the projection where a message lives, having proved it from the receipt.
 *
 * Retried, because the browser and the server do not read the same node. This
 * runs the moment the browser's RPC returns a receipt, and the Worker's RPC may
 * be a few seconds behind — which comes back as `receipt_unavailable`, is
 * entirely transient, and cost a live run its ASSET_PREPARED sequence. The
 * endpoint is idempotent by (chain, emitter, sequence), so a retry rewrites one
 * row with the same facts.
 */
async function recordMessage(settlementId: Hex, chainId: number, txHash: Hex): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const response = await fetch(`/api/settlements/${settlementId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chainId, txHash }),
      });
      if (response.ok) return;
    } catch {
      // A request that did not complete is the same as one that failed: try
      // again. Nothing about the settlement depends on this succeeding now.
    }
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
}

function observationOf(rows: readonly MessageRow[], type: string): MessageObservation | undefined {
  const found = rows.find((row) => row.messageType === type);
  if (found === undefined) return undefined;
  return {
    messageType: found.messageType,
    sequence: found.sequence,
    emitter: found.emitter,
    emitterChainId: found.emitterChainId,
    txHash: found.txHash,
    ...(found.includedAt === undefined ? {} : { includedAt: found.includedAt }),
    finalized: found.finalized,
    ...(found.finalizedAt === undefined ? {} : { finalizedAt: found.finalizedAt }),
    consumed: false,
  };
}

async function readSnapshot(
  payload: WorkspacePayload,
  terms: Terms,
  messages: readonly MessageRow[],
  actionState: ActionState,
): Promise<Snapshot> {
  const monad = publicClient(MONAD_TESTNET);
  const base = publicClient(BASE_SEPOLIA);
  const id = payload.settlementId;
  const account = wallet.current.address;

  const [settlement, cashLeg, reservation, intendedReceiver] = await Promise.all([
    monad
      .readContract({
        address: payload.deployment.coordinator,
        abi: COORDINATOR_ABI,
        functionName: 'settlementOf',
        args: [id],
      })
      .then((tuple) => readSettlement(tuple as Parameters<typeof readSettlement>[0]))
      .catch(() => undefined as SettlementRecord | undefined),
    monad
      .readContract({
        address: payload.deployment.cashEscrow,
        abi: ESCROW_ABI,
        functionName: 'legOf',
        args: [id],
      })
      .then((tuple) => readCashLeg(tuple))
      .catch(() => undefined as CashLegRecord | undefined),
    base
      .readContract({
        address: payload.deployment.rwaToken,
        abi: RWA_ABI,
        functionName: 'reservationOf',
        args: [id],
      })
      .then((tuple) => readReservation(tuple as Parameters<typeof readReservation>[0]))
      .catch(() => undefined as ReservationRecord | undefined),
    base
      .readContract({
        address: payload.deployment.rwaAdapter,
        abi: ADAPTER_ABI,
        functionName: 'intendedReceiver',
        args: [id],
      })
      .then((value) => value)
      .catch(() => undefined),
  ]);

  const holdings = account === undefined ? {} : await readHoldings(payload, terms);
  // Both states, not just HELD. A case that went CONTESTED drove the settlement
  // to CONTESTED, and reading the case only in the first state would report the
  // second one as "no case filed" — which is the opposite of what happened.
  const held = settlement?.state === 'HELD' || settlement?.state === 'CONTESTED';
  const dispositionCase =
    payload.disposition === undefined || !held
      ? undefined
      : await readDispositionCase(payload.disposition, payload.deployment, id);

  return {
    terms,
    signatures: { payer: payload.signatures.payer, seller: payload.signatures.seller },
    settlement,
    cashLeg,
    reservation,
    intendedReceiver,
    messages: seen(messages),
    holdings,
    fresh:
      actionState.commit === undefined
        ? undefined
        : {
            eligible: actionState.commit.ok,
            checkedAt: actionState.commit.checkedAt,
            expiresAt: actionState.commit.expiresAt,
            unavailable: actionState.commit.unavailable,
            refusals: actionState.commit.eligibility
              .filter((entry) => entry.status !== 'ELIGIBLE')
              .map((entry) => ({
                subject: entry.subject,
                status: entry.reason,
                detail: entry.detail,
              })),
          },
    commitSimulated: actionState.commitSimulated,
    dispositionCase,
    contestWindowSeconds: payload.disposition?.contestWindowSeconds ?? 300,
    verifierClass: payload.verifierClass,
    account,
    nowSeconds: Math.floor(Date.now() / 1000),
  };
}

/** Only the messages that exist. An absent key and an `undefined` one differ here. */
function seen(rows: readonly MessageRow[]): Snapshot['messages'] {
  const assetPrepared = observationOf(rows, 'ASSET_PREPARED');
  const commit = observationOf(rows, 'COMMIT');
  const assetResolution = resolutionOf(rows);
  return {
    ...(assetPrepared === undefined ? {} : { assetPrepared }),
    ...(commit === undefined ? {} : { commit }),
    ...(assetResolution === undefined ? {} : { assetResolution }),
  };
}

function resolutionOf(rows: readonly MessageRow[]): MessageObservation | undefined {
  return observationOf(rows, 'ASSET_RELEASED') ?? observationOf(rows, 'ASSET_HELD');
}

async function readHoldings(
  payload: WorkspacePayload,
  terms: Terms,
): Promise<Snapshot['holdings']> {
  const monad = publicClient(MONAD_TESTNET);
  const base = publicClient(BASE_SEPOLIA);
  const [availableAsset, cashBalance, cashAllowance] = await Promise.all([
    base
      .readContract({
        address: payload.deployment.rwaToken,
        abi: RWA_ABI,
        functionName: 'availableBalanceOf',
        args: [terms.assetSeller],
      })
      .then((value) => value)
      .catch(() => undefined),
    monad
      .readContract({
        address: payload.deployment.cashAsset,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [terms.cashPayer],
      })
      .then((value) => value)
      .catch(() => undefined),
    monad
      .readContract({
        address: payload.deployment.cashAsset,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [terms.cashPayer, payload.deployment.cashEscrow],
      })
      .then((value) => value)
      .catch(() => undefined),
  ]);
  return {
    ...(availableAsset === undefined ? {} : { availableAsset }),
    ...(cashBalance === undefined ? {} : { cashBalance }),
    ...(cashAllowance === undefined ? {} : { cashAllowance }),
  };
}

/** Wormhole charges per message on some chains and nothing on these. Read it. */
async function messageFee(chainId: number, transport: Address): Promise<bigint> {
  const client = publicClient(chainId);
  const core = await client.readContract({
    address: transport,
    abi: COORDINATOR_ABI,
    functionName: 'wormhole',
  });
  return await client.readContract({
    address: core,
    abi: CORE_ABI,
    functionName: 'messageFee',
  });
}

// ── Running an action ───────────────────────────────────────────────────────

async function execute(
  action: NextAction,
  payload: WorkspacePayload,
  terms: Terms,
  snapshot: Snapshot,
  actionState: ActionState,
  host: HTMLElement,
): Promise<void> {
  const account = wallet.current.address;
  if (account === undefined) throw new Error('no wallet is connected');
  const id = payload.settlementId;
  const intentHash = snapshot.settlement?.intentHash ?? id;

  /**
   * Every rung of every write, forwarded to the session.
   *
   * The workspace still paints its own ladder — that is where a participant is
   * looking while a transaction runs. This is the copy that outlives the page,
   * so leaving for the disposition case or the verifier does not lose sight of
   * a reservation made ninety seconds ago. Keyed by settlement and step, so a
   * step reports one row that advances rather than six rows that accumulate.
   */
  const report = (state: TxState): void => {
    session.track({
      id: `${id}:${state.kind}`,
      kind: state.kind,
      label: state.label,
      chainId: state.chainId,
      phase: state.phase,
      settlementId: id,
      ...(state.hash === undefined ? {} : { hash: state.hash }),
      ...(state.explorerUrl === undefined ? {} : { explorerUrl: state.explorerUrl }),
      ...(state.observed === undefined ? {} : { detail: state.observed }),
      ...(state.error === undefined ? {} : { detail: state.error }),
    });
  };
  const sequence = (steps: readonly WriteStep[]): Promise<unknown> =>
    runSequence(host, steps, report);

  switch (action.call) {
    case 'reserve-asset':
      await sequence(await reserveSteps(payload, terms, snapshot, account));
      return;

    case 'lock-cash':
      await sequence(await lockCashSteps(payload, terms, snapshot, account));
      return;

    case 'record-asset-prepared': {
      const vaa = snapshot.messages.assetPrepared;
      const bytes = await vaaFor(payload.settlementId, 'ASSET_PREPARED');
      if (vaa === undefined || bytes === undefined) {
        throw new PrerequisiteMissing('the finalized ASSET_PREPARED VAA is not available yet');
      }
      await sequence([
        {
          kind: 'record-asset-prepared',
          label: 'Consume the finalized ASSET_PREPARED',
          chainId: MONAD_TESTNET,
          target: payload.deployment.coordinator,
          expected: 'the settlement becomes READY',
          send: async () =>
            wallet.walletClient(MONAD_TESTNET).writeContract({
              chain: null,
              account,
              address: payload.deployment.coordinator,
              abi: COORDINATOR_ABI,
              functionName: 'recordAssetPrepared',
              args: [bytes],
            }),
          observe: async () => {
            const state = await readSettlementState(payload, id);
            return { ok: state?.state === 'READY', observed: state?.state ?? 'unreadable' };
          },
        },
      ]);
      return;
    }

    case 'run-fresh-compliance': {
      actionState.commit = await mintProof(id, intentHash, 'commit', [
        terms.cashPayer,
        terms.cashReceiver,
      ]);
      actionState.commitSimulated = false;
      if (!actionState.commit.ok) return;
      actionState.commitSimulated = await simulateCommit(payload, snapshot, actionState, account);
      return;
    }

    case 'issue-commit': {
      const proof = actionState.commit;
      if (!proof?.ok) {
        throw new PrerequisiteMissing('no fresh compliance proof is held for this settlement');
      }
      const buyer = payload.signatures.payerSignature;
      const seller = payload.signatures.sellerSignature;
      if (buyer === undefined || seller === undefined) {
        throw new PrerequisiteMissing(
          'the coordinator checks both intent signatures at COMMIT, and one is missing',
        );
      }
      const fee = await messageFee(MONAD_TESTNET, payload.deployment.coordinator);
      await sequence([
        {
          kind: 'issue-commit',
          label: 'COMMIT',
          chainId: MONAD_TESTNET,
          target: payload.deployment.coordinator,
          expected: 'the canonical decision becomes COMMIT',
          send: async () =>
            wallet.walletClient(MONAD_TESTNET).writeContract({
              chain: null,
              account,
              address: payload.deployment.coordinator,
              abi: COORDINATOR_ABI,
              functionName: 'issueCommit',
              args: [termsTuple(payload.terms), id, buyer, seller, proof.proof, 1],
              value: fee,
            }),
          onConfirmed: async (hash) => {
            await recordMessage(id, MONAD_TESTNET, hash);
          },
          observe: async () => {
            const state = await readSettlementState(payload, id);
            return { ok: state?.decision === 'COMMIT', observed: state?.decision ?? 'unreadable' };
          },
        },
      ]);
      return;
    }

    case 'release-cash': {
      const proof = await mintProof(id, intentHash, 'cash-release', [terms.cashReceiver]);
      if (!proof.ok) {
        throw new PrerequisiteMissing(
          proof.unavailable
            ? 'Cleanverse did not answer, so no proof exists. That is not a refusal.'
            : 'the receiver is not currently eligible, so the escrow would refuse the proof',
        );
      }
      await requireContractAccepts(
        MONAD_TESTNET,
        payload.deployment.cashEscrow,
        ESCROW_ABI,
        id,
        intentHash,
        terms.cashReceiver,
        proof.proof,
      );
      await sequence([
        {
          kind: 'release-cash',
          label: 'Execute the cash release',
          chainId: MONAD_TESTNET,
          target: payload.deployment.cashEscrow,
          expected: 'the coordinator records the cash leg RELEASED',
          send: async () =>
            wallet.walletClient(MONAD_TESTNET).writeContract({
              chain: null,
              account,
              address: payload.deployment.cashEscrow,
              abi: ESCROW_ABI,
              functionName: 'releaseCash',
              args: [id, proof.proof],
            }),
          observe: async () => {
            const state = await readSettlementState(payload, id);
            return {
              ok: state?.cashOutcome === 'RELEASED',
              observed: state?.cashOutcome ?? 'unreadable',
            };
          },
        },
      ]);
      return;
    }

    case 'release-asset': {
      const bytes = await vaaFor(id, 'COMMIT');
      if (bytes === undefined) {
        throw new PrerequisiteMissing('the finalized COMMIT VAA is not available yet');
      }
      const proof = await mintProof(id, intentHash, 'asset-release', [terms.assetReceiver]);
      if (proof.unavailable) {
        throw new PrerequisiteMissing(
          'Cleanverse did not answer, so no proof exists. That is not a refusal.',
        );
      }
      await sequence([
        {
          kind: 'release-asset',
          label: 'Execute the asset release',
          chainId: BASE_SEPOLIA,
          target: payload.deployment.rwaAdapter,
          expected: 'the reservation is committed, and released if the token permits it',
          send: async () =>
            wallet.walletClient(BASE_SEPOLIA).writeContract({
              chain: null,
              account,
              address: payload.deployment.rwaAdapter,
              abi: ADAPTER_ABI,
              functionName: 'releaseAsset',
              args: [bytes, proof.proof],
            }),
          observe: async () => {
            const reservation = await readReservationState(payload, id);
            return {
              ok: reservation?.committed === true,
              observed:
                reservation === undefined
                  ? 'unreadable'
                  : `committed=${String(reservation.committed)} released=${String(reservation.released)}`,
            };
          },
        },
      ]);
      return;
    }

    case 'report-resolution': {
      const fee = await messageFee(BASE_SEPOLIA, payload.deployment.rwaAdapter);
      await sequence([
        {
          kind: 'report-resolution',
          label: 'Report the asset outcome',
          chainId: BASE_SEPOLIA,
          target: payload.deployment.rwaAdapter,
          expected: 'an authenticated resolution message is published',
          send: async () =>
            wallet.walletClient(BASE_SEPOLIA).writeContract({
              chain: null,
              account,
              address: payload.deployment.rwaAdapter,
              abi: ADAPTER_ABI,
              functionName: 'reportResolution',
              args: [id, BigInt(MONAD_TESTNET), 1],
              value: fee,
            }),
          onConfirmed: async (hash) => {
            await recordMessage(id, BASE_SEPOLIA, hash);
          },
          observe: async () => {
            // The observable effect of a publish is the message. The server
            // re-derives it from the receipt, so this is a protocol read rather
            // than this page believing itself.
            const rows = await loadMessages(id);
            const found = resolutionOf(rows);
            return {
              ok: found !== undefined,
              observed: found === undefined ? 'no resolution message yet' : found.messageType,
            };
          },
        },
      ]);
      return;
    }

    case 'record-leg-resolved': {
      const resolution = snapshot.messages.assetResolution;
      const bytes = await vaaFor(id, resolution?.messageType ?? 'ASSET_RELEASED');
      if (resolution === undefined || bytes === undefined) {
        throw new PrerequisiteMissing('the finalized resolution VAA is not available yet');
      }
      const released = resolution.messageType === 'ASSET_RELEASED';
      await sequence([
        {
          kind: 'record-leg-resolved',
          label: 'Record the asset outcome',
          chainId: MONAD_TESTNET,
          target: payload.deployment.coordinator,
          expected: released
            ? 'the coordinator records the asset leg RELEASED'
            : 'the coordinator records the asset leg HELD',
          send: async () =>
            wallet.walletClient(MONAD_TESTNET).writeContract({
              chain: null,
              account,
              address: payload.deployment.coordinator,
              abi: COORDINATOR_ABI,
              functionName: 'recordLegResolved',
              args: [bytes, released ? 5 : 7, released ? 1 : 3],
            }),
          observe: async () => {
            const state = await readSettlementState(payload, id);
            return {
              ok: state?.assetOutcome !== 'NONE',
              observed: state?.assetOutcome ?? 'unreadable',
            };
          },
        },
      ]);
      return;
    }

    default:
      return;
  }
}

async function reserveSteps(
  payload: WorkspacePayload,
  terms: Terms,
  snapshot: Snapshot,
  account: Address,
): Promise<readonly WriteStep[]> {
  const id = payload.settlementId;
  const fee = await messageFee(BASE_SEPOLIA, payload.deployment.rwaAdapter);
  const alreadyReserved =
    snapshot.reservation !== undefined && snapshot.reservation.owner !== ZERO_ADDRESS;

  const steps: WriteStep[] = [];
  if (!alreadyReserved) {
    steps.push({
      kind: 'reserve-asset',
      label: 'Reserve the units',
      chainId: BASE_SEPOLIA,
      target: payload.deployment.rwaToken,
      expected: `${fromBaseUnits(terms.assetAmount)} reserved against this settlement id`,
      precondition: async () => {
        const available = await publicClient(BASE_SEPOLIA).readContract({
          address: payload.deployment.rwaToken,
          abi: RWA_ABI,
          functionName: 'availableBalanceOf',
          args: [terms.assetSeller],
        });
        if (available < terms.assetAmount) {
          throw new PrerequisiteMissing(
            `the seller has ${fromBaseUnits(available)} unreserved and this settlement needs ${fromBaseUnits(terms.assetAmount)}`,
          );
        }
      },
      send: async () =>
        wallet.walletClient(BASE_SEPOLIA).writeContract({
          chain: null,
          account,
          address: payload.deployment.rwaToken,
          abi: RWA_ABI,
          functionName: 'reserveForSettlement',
          args: [id, terms.assetAmount],
        }),
      observe: async () => {
        const reservation = await readReservationState(payload, id);
        return {
          ok: reservation?.owner.toLowerCase() === account.toLowerCase(),
          observed:
            reservation === undefined ? 'unreadable' : `reservation owner ${reservation.owner}`,
        };
      },
    });
  }

  steps.push({
    kind: 'reserve-asset',
    label: 'Announce the leg',
    chainId: BASE_SEPOLIA,
    target: payload.deployment.rwaAdapter,
    expected: 'the adapter binds the receiver and publishes ASSET_PREPARED',
    send: async () =>
      wallet.walletClient(BASE_SEPOLIA).writeContract({
        chain: null,
        account,
        address: payload.deployment.rwaAdapter,
        abi: ADAPTER_ABI,
        functionName: 'prepareAsset',
        args: [id, id, terms.assetReceiver, BigInt(MONAD_TESTNET), 1],
        value: fee,
      }),
    observe: async () => {
      const receiver = await publicClient(BASE_SEPOLIA).readContract({
        address: payload.deployment.rwaAdapter,
        abi: ADAPTER_ABI,
        functionName: 'intendedReceiver',
        args: [id],
      });
      return {
        ok: receiver.toLowerCase() === terms.assetReceiver.toLowerCase(),
        observed: `intended receiver ${receiver}`,
      };
    },
  });

  // The last step publishes, so its hash is where the sequence lives. Wormhole
  // keeps it in an event and no contract can give it back — and the server
  // re-derives the sequence from the receipt, so this has to wait for one.
  const announce = steps[steps.length - 1];
  if (announce !== undefined) {
    steps[steps.length - 1] = {
      ...announce,
      onConfirmed: async (hash) => {
        await recordMessage(id, BASE_SEPOLIA, hash);
      },
    };
  }
  return steps;
}

async function lockCashSteps(
  payload: WorkspacePayload,
  terms: Terms,
  snapshot: Snapshot,
  account: Address,
): Promise<readonly WriteStep[]> {
  const id = payload.settlementId;
  const fee = await messageFee(MONAD_TESTNET, payload.deployment.coordinator);
  const allowance = snapshot.holdings.cashAllowance ?? 0n;

  const steps: WriteStep[] = [];
  if (allowance < terms.cashAmount) {
    steps.push({
      kind: 'lock-cash',
      label: 'Approve the escrow',
      chainId: MONAD_TESTNET,
      target: payload.deployment.cashAsset,
      expected: `the escrow may take ${fromBaseUnits(terms.cashAmount)}`,
      send: async () =>
        wallet.walletClient(MONAD_TESTNET).writeContract({
          chain: null,
          account,
          address: payload.deployment.cashAsset,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [payload.deployment.cashEscrow, terms.cashAmount],
        }),
      observe: async () => {
        const current = await publicClient(MONAD_TESTNET).readContract({
          address: payload.deployment.cashAsset,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [terms.cashPayer, payload.deployment.cashEscrow],
        });
        return { ok: current >= terms.cashAmount, observed: `allowance ${fromBaseUnits(current)}` };
      },
    });
  }

  steps.push({
    kind: 'lock-cash',
    label: 'Lock the settlement cash',
    chainId: MONAD_TESTNET,
    target: payload.deployment.cashEscrow,
    expected: 'the coordinator records the cash leg prepared',
    send: async () =>
      wallet.walletClient(MONAD_TESTNET).writeContract({
        chain: null,
        account,
        address: payload.deployment.cashEscrow,
        abi: ESCROW_ABI,
        functionName: 'prepareCash',
        args: [id, id, terms.cashReceiver, terms.cashAmount, BigInt(BASE_SEPOLIA), 1],
        value: fee,
      }),
    onConfirmed: async (hash) => {
      await recordMessage(id, MONAD_TESTNET, hash);
    },
    observe: async () => {
      const state = await readSettlementState(payload, id);
      return {
        ok: state?.cashPrepared === true,
        observed: state === undefined ? 'unreadable' : `cashPrepared=${String(state.cashPrepared)}`,
      };
    },
  });

  return steps;
}

async function readSettlementState(
  payload: WorkspacePayload,
  id: Hex,
): Promise<SettlementRecord | undefined> {
  try {
    const tuple = await publicClient(MONAD_TESTNET).readContract({
      address: payload.deployment.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'settlementOf',
      args: [id],
    });
    return readSettlement(tuple);
  } catch {
    return undefined;
  }
}

async function readReservationState(
  payload: WorkspacePayload,
  id: Hex,
): Promise<ReservationRecord | undefined> {
  try {
    const tuple = await publicClient(BASE_SEPOLIA).readContract({
      address: payload.deployment.rwaToken,
      abi: RWA_ABI,
      functionName: 'reservationOf',
      args: [id],
    });
    return readReservation(tuple);
  } catch {
    return undefined;
  }
}

/** The finalized VAA for a message, from the Worker's guardian-API proxy. */
async function vaaFor(settlementId: Hex, messageType: string): Promise<Hex | undefined> {
  const rows = await loadMessages(settlementId);
  return rows.find((row) => row.messageType === messageType && row.finalized)?.vaa;
}

/**
 * Asks the verifying contract itself whether it accepts the proof.
 *
 * The last check before a value-moving transaction. A locally correct signature
 * over the wrong domain recovers to a stranger, and only the contract can say
 * so — which is the check a failed live run did not have.
 */
async function requireContractAccepts(
  chainId: number,
  address: Address,
  abi: typeof ESCROW_ABI | typeof COORDINATOR_ABI | typeof ADAPTER_ABI,
  settlementId: Hex,
  intentHash: Hex,
  subject: Address,
  proof: ComplianceProof,
): Promise<void> {
  const accepted = await publicClient(chainId).readContract({
    address,
    abi,
    functionName: 'verifyEligible',
    args: [settlementId, intentHash, subject, proof],
  });
  if (!accepted) {
    throw new PrerequisiteMissing(`${address} refuses the compliance proof for ${subject}`);
  }
}

/** Simulates the commit against the deployed coordinator before offering it. */
async function simulateCommit(
  payload: WorkspacePayload,
  snapshot: Snapshot,
  actionState: ActionState,
  account: Address,
): Promise<boolean> {
  const proof = actionState.commit;
  const buyer = payload.signatures.payerSignature;
  const seller = payload.signatures.sellerSignature;
  if (proof === undefined || buyer === undefined || seller === undefined) return false;
  const intentHash = snapshot.settlement?.intentHash ?? payload.settlementId;
  try {
    await requireContractAccepts(
      MONAD_TESTNET,
      payload.deployment.coordinator,
      COORDINATOR_ABI,
      payload.settlementId,
      intentHash,
      snapshot.terms.cashPayer,
      proof.proof,
    );
    await publicClient(MONAD_TESTNET).simulateContract({
      account,
      address: payload.deployment.coordinator,
      abi: COORDINATOR_ABI,
      functionName: 'issueCommit',
      args: [termsTuple(payload.terms), payload.settlementId, buyer, seller, proof.proof, 1],
    });
    return true;
  } catch {
    return false;
  }
}

// ── Painting ────────────────────────────────────────────────────────────────

function paintAction(
  host: HTMLElement,
  action: NextAction,
  snapshot: Snapshot,
  payload: WorkspacePayload,
  actionState: ActionState,
  idMatches: boolean,
  recomputed: Hex,
  run: (action: NextAction) => void,
): void {
  host.replaceChildren();

  const roleChip = document.querySelector<HTMLElement>('[data-role-chip]');
  if (roleChip !== null) {
    const roles = rolesOf(snapshot.terms, snapshot.account);
    roleChip.textContent =
      snapshot.account === undefined
        ? 'connect a wallet to see your role'
        : roles.length === 0
          ? 'you are not a party to these terms'
          : `you are the ${roles.join(' and ')}`;
  }

  const panel = document.createElement('div');
  panel.className = 'action';

  const head = document.createElement('div');
  head.className = 'action-head';
  const heading = document.createElement('div');
  heading.append(node('div', 't-caption-upper', 'Next action'));
  heading.append(node('div', 'action-title', action.title));
  head.append(heading);
  head.append(node('span', 'badge badge-outline', action.kind));
  panel.append(head);

  const body = document.createElement('div');
  body.className = 'action-body';

  if (!idMatches) {
    body.append(
      node(
        'div',
        'action-blocked',
        `These terms hash to ${recomputed}, and this page claims ${payload.settlementId}. The settlement id is the digest of the terms, so one of them is wrong. Nothing is offered here.`,
      ),
    );
    panel.append(body);
    host.append(panel);
    return;
  }

  if (action.chainId !== undefined) {
    const amount =
      action.chainId === BASE_SEPOLIA
        ? `${fromBaseUnits(snapshot.terms.assetAmount)} cBOND`
        : `${fromBaseUnits(snapshot.terms.cashAmount)} cSETTLE`;
    body.append(node('div', 'action-amount', amount));
    body.append(
      node(
        'div',
        't-caption muted',
        action.chainId === BASE_SEPOLIA ? 'Base Sepolia' : 'Monad Testnet',
      ),
    );
  }

  body.append(node('p', 'action-why', action.detail));

  if (action.kind === 'READY_TO_COMMIT') {
    const boundary = document.createElement('div');
    boundary.className = 'boundary';
    boundary.append(
      node('div', 'boundary-title', 'Commit is the irreversible settlement decision'),
    );
    boundary.append(
      node(
        'p',
        'muted t-caption',
        'After it, no refund exists. Delivery proceeds or the value enters HELD, and a compliance ' +
          'failure after this point is resolved through a disposition rather than by unwinding the trade.',
      ),
    );
    body.append(boundary);
  }

  if (action.blocked !== undefined) {
    body.append(node('div', 'action-blocked', action.blocked));
  }

  if (action.call === 'run-verifier') {
    const link = document.createElement('a');
    link.className = 'btn btn-primary';
    link.href = `/verify/${payload.settlementId}`;
    link.textContent = 'Run the verifier';
    body.append(link);
  } else if (action.call !== undefined) {
    const cta = document.createElement('button');
    cta.className = 'btn btn-primary';
    cta.type = 'button';
    cta.dataset['actionRun'] = action.call;
    cta.textContent = action.title;
    cta.disabled = !action.enabled || actionState.busy;
    cta.addEventListener('click', () => {
      cta.disabled = true;
      run(action);
    });
    body.append(cta);
  }

  if (action.kind === 'AWAITING_ASSET_PREPARATION') {
    body.append(recoverMessage(payload.settlementId, BASE_SEPOLIA));
  }

  if (!payload.attestationsAvailable) {
    body.append(
      node(
        'div',
        'action-blocked',
        'This deployment holds no compliance authority key, so COMMIT and both releases cannot be ' +
          'produced from the browser. Preparation still works, and a CLI holding the key can finish ' +
          'the settlement.',
      ),
    );
  }

  const tx = document.createElement('div');
  tx.dataset['tx'] = '';
  body.append(tx);

  panel.append(body);
  host.append(panel);
  host.append(paintHistory(history(snapshot), action.kind !== 'SETTLEMENT_COMPLETE'));
}

/**
 * The way out of a lost sequence.
 *
 * A Wormhole sequence lives in an event, so a browser that published a message
 * and then lost the tab is the one case where a settlement can stall with both
 * legs correctly on chain. The transaction hash is enough to recover it, and the
 * server re-derives every field from the receipt rather than believing the
 * number typed here — a hash for somebody else's settlement is refused, not
 * recorded.
 */
function recoverMessage(settlementId: Hex, chainId: number): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'stack-8';
  wrapper.append(
    node(
      'div',
      't-caption muted',
      'If the transaction that announced this leg is known, its hash is enough to recover the ' +
        'message. Every field is re-derived from the receipt.',
    ),
  );

  const row = document.createElement('div');
  row.className = 'row';
  const field = document.createElement('input');
  field.className = 'field field-mono';
  field.placeholder = '0x… the prepareAsset transaction';
  field.dataset['recoverHash'] = '';
  const submit = document.createElement('button');
  submit.className = 'btn btn-secondary btn-sm';
  submit.type = 'button';
  submit.textContent = 'Recover the message';
  const status = node('div', 't-caption muted');

  submit.addEventListener('click', () => {
    const hash = field.value.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      status.textContent = 'That is not a 32-byte transaction hash.';
      return;
    }
    submit.disabled = true;
    status.textContent = 'Reading the receipt…';
    void fetch(`/api/settlements/${settlementId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId, txHash: hash }),
    })
      .then(async (response) => {
        const body = (await response.json()) as { error?: { message?: string } };
        status.textContent = response.ok
          ? 'Recorded. The panel will pick it up on its next read.'
          : (body.error?.message ?? 'The message could not be recovered.');
      })
      .catch(() => {
        status.textContent = 'The request did not complete.';
      })
      .finally(() => {
        submit.disabled = false;
      });
  });

  row.append(field, submit);
  wrapper.append(row, status);
  return wrapper;
}

/**
 * The ladder of what has happened, behind a disclosure once nothing is left to do.
 *
 * While a settlement is in flight the ladder is the answer to "where are we", so
 * it is open. Once the settlement is complete it is evidence, and the outcome
 * above it has already said everything a reader came for.
 */
function paintHistory(facts: readonly Fact[], open: boolean): HTMLElement {
  const disclosure = document.createElement('details');
  disclosure.className = 'card disclosure';
  disclosure.open = open;
  disclosure.style.marginTop = 'var(--spacing-16)';
  const done = facts.filter((fact) => fact.done).length;
  disclosure.append(
    node(
      'summary',
      'disclosure-summary',
      `How it got here · ${String(done)} of ${String(facts.length)} steps confirmed`,
    ),
  );
  const timeline = document.createElement('div');
  timeline.className = 'timeline';
  for (const fact of facts) {
    const item = document.createElement('div');
    item.className = 'tl-item';
    const rail = document.createElement('div');
    rail.className = 'tl-rail';
    rail.append(node('span', fact.done ? 'tl-node done' : 'tl-node pending'));
    rail.append(node('span', 'tl-line'));
    const body = document.createElement('div');
    body.className = 'tl-body';
    body.append(node('div', fact.done ? 'tl-title' : 'tl-title muted', fact.label));
    body.append(node('div', 'tl-meta mono', fact.detail));
    item.append(rail, body);
    timeline.append(item);
  }
  disclosure.append(timeline);
  return disclosure;
}

/**
 * The finality ladder, per message.
 *
 * Five stages, and the two that matter are deliberately far apart: Conduit sees
 * a message within seconds and refuses to act on it for minutes. The seconds
 * shown are this deployment's own observations, one per message, never averaged
 * — the spread from 999 to 1485 is the finding, and a mean would hide the
 * slowest, which is the one a commit window has to survive.
 */
function paintFinality(host: HTMLElement, messages: readonly MessageRow[]): void {
  host.replaceChildren();
  if (messages.length === 0) return;

  const waiting = messages.filter((message) => !message.finalized);
  const disclosure = document.createElement('details');
  disclosure.className = 'card disclosure';
  disclosure.open = waiting.length > 0;
  disclosure.style.marginTop = 'var(--spacing-16)';
  disclosure.append(
    node(
      'summary',
      'disclosure-summary',
      waiting.length === 0
        ? `Cross-chain finality · ${String(messages.length)} messages, all finalized`
        : `Cross-chain finality · ${String(waiting.length)} of ${String(messages.length)} still waiting`,
    ),
  );

  for (const message of messages) {
    const origin = message.emitterChainId === 10_004 ? 'from Base Sepolia' : 'from Monad Testnet';
    const head = document.createElement('div');
    head.className = 'row-between';
    head.style.marginTop = 'var(--spacing-12)';
    head.append(node('span', 'mono', `${message.messageType} · sequence ${message.sequence}`));
    head.append(node('span', 'badge badge-outline', origin));
    disclosure.append(head);

    if (message.finalized) {
      disclosure.append(
        node(
          'div',
          't-caption muted',
          message.finalitySeconds === undefined
            ? 'Guardian set signed. This deployment stored no timing for it.'
            : `Guardian set signed ${String(message.finalitySeconds)} seconds after publication.`,
        ),
      );
      continue;
    }

    const stages: readonly [string, string, boolean][] = [
      ['Transaction included', message.includedAt ?? message.txHash, true],
      ['Message observed', `sequence ${message.sequence} published`, true],
      [
        'Waiting for economic finality',
        'the destination refuses this message below FINALIZED, and that threshold is an immutable in the deployed bytecode',
        false,
      ],
      ['FINALIZED', 'not yet', false],
    ];

    const flow = document.createElement('div');
    flow.className = 'flow';
    for (const [title, detail, done] of stages) {
      const stage = document.createElement('div');
      stage.className = 'flow-stage';
      const rail = document.createElement('div');
      rail.className = 'flow-rail';
      rail.append(node('span', done ? 'flow-node done' : 'flow-node'));
      rail.append(node('span', 'flow-line'));
      const body = document.createElement('div');
      body.className = 'flow-body';
      body.append(node('div', 'flow-title', title));
      body.append(node('div', 'flow-meta', detail));
      stage.append(rail, body);
      flow.append(stage);
    }
    disclosure.append(flow);
  }

  disclosure.append(
    node(
      'div',
      'note',
      'Conduit can observe settlement state earlier, but irreversible COMMIT waits for the ' +
        'configured economic finality. The seconds above are the interval from publication to the ' +
        'first time this deployment saw a signature, an upper bound on finality, not a benchmark, ' +
        'and never averaged with any other observation.',
    ),
  );
  host.append(disclosure);
}

/**
 * Prepare-time and commit-time, side by side.
 *
 * They are two different questions asked at two different moments, and the whole
 * protocol turns on the fact that the answers may differ. Showing one number
 * would make the second call look like a formality.
 */
function paintCompliance(host: HTMLElement, actionState: ActionState): void {
  host.replaceChildren();
  if (actionState.commit === undefined && actionState.prepare === undefined) return;

  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginTop = 'var(--spacing-16)';
  card.append(node('div', 't-caption-upper', 'Compliance'));

  const compare = document.createElement('div');
  compare.className = 'compare';
  compare.style.marginTop = 'var(--spacing-12)';

  for (const [label, proof] of [
    ['Prepare-time', actionState.prepare],
    ['Commit-time', actionState.commit],
  ] as const) {
    const column = document.createElement('div');
    column.append(node('div', 't-caption-upper', label));
    if (proof === undefined) {
      column.append(node('div', 'muted t-caption', 'not asked in this actionState'));
    } else {
      column.append(
        node(
          'div',
          `badge ${proof.ok ? 'badge-solid' : 'badge-soft'}`,
          proof.unavailable ? 'UNAVAILABLE' : proof.ok ? 'ELIGIBLE' : 'REFUSED',
        ),
      );
      column.append(node('div', 't-caption muted mono', proof.checkedAt));
      for (const entry of proof.eligibility) {
        column.append(
          node('div', 't-caption muted', `${entry.subject.slice(0, 10)}… ${entry.status}`),
        );
        if (entry.status !== 'ELIGIBLE') {
          column.append(node('div', 't-caption muted', entry.detail));
        }
      }
    }
    compare.append(column);
  }

  card.append(compare);
  card.append(
    node(
      'div',
      'note',
      'Attestations expire after 900 seconds, fixed in the deployed bytecode. Observed Base finality ' +
        'on this deployment has run 999 to 1485 seconds, so a prepare-time answer cannot reach a ' +
        'commit — the answer that authorises one is minted after the wait, and never before it.',
    ),
  );
  host.append(card);
}

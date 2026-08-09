/**
 * One write, and everything a person needs to know about it.
 *
 * A protocol action is never a toast. It has a chain, a wallet step, a hash, an
 * inclusion, and a state change somebody can read back — and each of those fails
 * differently. A green tick the moment a wallet returns is a lie about four of
 * them.
 *
 * ## Confirmed is not observed
 *
 * A receipt proves inclusion at block N. It says nothing about whether the node
 * answering the next call has reached N, and a dependent transaction sent
 * against a node that has not is the failure mode that cost a live run once
 * already. So every step here ends by requiring two things: that the RPC reports
 * `latest >= N`, and that the effect the step was for is present in contract
 * state. Only then is it `state-observed`, and only then may the next step run.
 *
 * ## A failure is classified before it is explained
 *
 * `RPC_STATE_LAG` and `CONTRACT_REVERT` produce the same silence at the call
 * site and mean opposite things — one is "wait", the other is "this can never
 * work". Deciding which by reading the node's own block height, rather than by
 * paraphrasing an error string, is the difference between a correct diagnosis
 * and a plausible one.
 */

import type { Address, Hex } from 'viem';

import { CHAINS, publicClient, wallet } from './wallet.js';

export type TxPhase =
  | 'needs-wallet'
  | 'switch-network'
  | 'awaiting-signature'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'state-observed'
  | 'failed';

/** Extra rungs a cross-chain action climbs after its own chain confirms. */
export type MessagePhase = 'message-observed' | 'waiting-finality' | 'finalized' | 'consumed';

export type TxErrorClass =
  | 'WALLET_REJECTED'
  | 'WRONG_NETWORK'
  | 'RPC_FAILURE'
  | 'RPC_STATE_LAG'
  | 'CONTRACT_REVERT'
  | 'PREREQUISITE_MISSING'
  | 'STATE_NOT_OBSERVED'
  | 'UNKNOWN';

export interface TxState {
  readonly phase: TxPhase;
  /** The protocol action, not the ABI function. `reserve-asset`, `issue-commit`. */
  readonly kind: string;
  readonly label: string;
  readonly chainId: number;
  readonly target?: Address;
  readonly hash?: Hex;
  readonly block?: bigint;
  readonly explorerUrl?: string;
  /** What this step is supposed to make true. Written before it runs. */
  readonly expected?: string;
  /** What the chain actually reported afterwards. */
  readonly observed?: string;
  readonly error?: string;
  readonly errorClass?: TxErrorClass;
  readonly message?: MessagePhase;
}

const PHASE_TEXT: Readonly<Record<TxPhase, string>> = Object.freeze({
  'needs-wallet': 'Connect a wallet to continue',
  'switch-network': 'Your wallet is being asked to change network',
  'awaiting-signature': 'Confirm in your wallet',
  submitted: 'Broadcast, waiting to be mined',
  confirming: 'Mined — reading the state back',
  confirmed: 'Confirmed on chain',
  'state-observed': 'State observed',
  failed: 'Failed',
});

const MESSAGE_TEXT: Readonly<Record<MessagePhase, string>> = Object.freeze({
  'message-observed': 'Wormhole observed the message',
  'waiting-finality': 'Waiting for economic finality',
  finalized: 'FINALIZED',
  consumed: 'Consumed on the remote chain',
});

const ERROR_TEXT: Readonly<Record<TxErrorClass, string>> = Object.freeze({
  WALLET_REJECTED: 'You rejected the request in your wallet. Nothing was sent.',
  WRONG_NETWORK: 'Your wallet is not on the chain this action needs, and declined to move.',
  RPC_FAILURE: 'The node could not be reached. This says nothing about the settlement.',
  RPC_STATE_LAG:
    'The transaction is mined, but the node answering reads have not reached its block yet. ' +
    'Nothing is wrong — reload in a moment.',
  CONTRACT_REVERT: 'The contract refused this call. Nothing changed on chain.',
  PREREQUISITE_MISSING: 'Something this step depends on is not in place yet.',
  STATE_NOT_OBSERVED:
    'The transaction succeeded but the effect it was for is not visible in contract state. ' +
    'Do not treat this as done.',
  UNKNOWN: 'Something went wrong.',
});

function node(tag: string, className?: string, text?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** The ladder every write climbs, so an unfinished one shows where it stopped. */
const LADDER: readonly TxPhase[] = [
  'switch-network',
  'awaiting-signature',
  'submitted',
  'confirming',
  'confirmed',
  'state-observed',
];

/** Renders a write's state into a host element, replacing what was there. */
export function paintTx(host: HTMLElement, state: TxState): void {
  host.replaceChildren();
  host.className = 'txstate';

  const head = node('div', 'row-between');
  head.append(node('span', 'tx-label', state.label));
  const chain = CHAINS[state.chainId]?.name;
  if (chain !== undefined) head.append(node('span', 't-caption muted', chain));
  host.append(head);

  const reached = LADDER.indexOf(state.phase);
  const rungs = node('div', 'tx-ladder');
  for (const [index, rung] of LADDER.entries()) {
    const done = state.phase === 'failed' ? index < reached : reached >= index && reached !== -1;
    const item = node('span', done ? 'tx-rung done' : 'tx-rung');
    item.title = PHASE_TEXT[rung];
    rungs.append(item);
  }
  host.append(rungs);

  const line = node('div', 'row');
  line.append(node('span', state.phase === 'failed' ? 'tx-dot failed' : 'tx-dot'));
  line.append(node('span', 't-caption', PHASE_TEXT[state.phase]));
  host.append(line);

  if (state.hash !== undefined) {
    const row = node('div', 'row');
    if (state.explorerUrl === undefined) {
      row.append(node('span', 'mono t-caption', state.hash));
    } else {
      const link = document.createElement('a');
      link.className = 'ext mono t-caption';
      link.href = state.explorerUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${state.hash.slice(0, 10)}…${state.hash.slice(-6)}`;
      row.append(link);
    }
    if (state.block !== undefined) {
      row.append(node('span', 't-caption muted', `block ${state.block.toString()}`));
    }
    host.append(row);
  }

  if (state.expected !== undefined) {
    host.append(
      node(
        'div',
        't-caption muted',
        state.observed === undefined
          ? `expects: ${state.expected}`
          : `expects: ${state.expected} — observed: ${state.observed}`,
      ),
    );
  }

  if (state.message !== undefined) {
    host.append(node('div', 't-caption muted', MESSAGE_TEXT[state.message]));
  }

  if (state.errorClass !== undefined) {
    host.append(node('div', 't-caption tx-error', state.errorClass));
    host.append(node('div', 't-caption muted', ERROR_TEXT[state.errorClass]));
  }
  if (state.error !== undefined) {
    host.append(node('div', 't-caption muted mono', state.error));
  }
}

/** Thrown by a step's own precondition, so the class is right without guessing. */
export class PrerequisiteMissing extends Error {}

export interface WriteStep {
  /** The protocol action this belongs to. */
  readonly kind: string;
  readonly label: string;
  readonly chainId: number;
  readonly target: Address;
  /** What must be true afterwards, in one clause a person can read. */
  readonly expected: string;
  /** Runs before the wallet is touched. Throw `PrerequisiteMissing` to refuse. */
  readonly precondition?: () => Promise<void>;
  readonly send: () => Promise<Hex>;
  /**
   * Runs once, after a successful receipt and before observation.
   *
   * This is where anything that needs a *mined* transaction belongs. A Wormhole
   * sequence lives in an event and no contract can give it back, so recording it
   * is not optional — and doing it at broadcast, before a receipt exists, means
   * the server correctly refuses and the number is lost for good. That is not
   * hypothetical: it is what the first live browser run did.
   */
  readonly onConfirmed?: (hash: Hex) => Promise<void>;
  /**
   * Reads the effect back. Returns what it saw, and whether that is the effect.
   * Called repeatedly until it agrees or the budget runs out.
   */
  readonly observe: () => Promise<{ readonly ok: boolean; readonly observed: string }>;
}

export interface WriteResult {
  readonly ok: boolean;
  readonly hash?: Hex;
  readonly block?: bigint;
  readonly errorClass?: TxErrorClass;
}

function explorerUrlFor(chainId: number, hash: Hex): string | undefined {
  const explorer = CHAINS[chainId]?.explorer;
  return explorer === undefined ? undefined : `${explorer}/tx/${hash}`;
}

/** Classifies a thrown value without paraphrasing it into the wrong bucket. */
export function classify(error: unknown): TxErrorClass {
  if (error instanceof PrerequisiteMissing) return 'PREREQUISITE_MISSING';
  const code = (error as { code?: number }).code;
  if (code === 4001) return 'WALLET_REJECTED';
  if (code === 4902) return 'WRONG_NETWORK';

  const name = (error as { name?: string }).name ?? '';
  if (name === 'ContractFunctionRevertedError' || name === 'ContractFunctionExecutionError') {
    return 'CONTRACT_REVERT';
  }
  if (name === 'HttpRequestError' || name === 'TimeoutError' || name === 'RpcRequestError') {
    return 'RPC_FAILURE';
  }

  const text = describe(error);
  if (/user rejected|user denied|rejected the request/i.test(text)) return 'WALLET_REJECTED';
  if (/revert|execution reverted|custom error/i.test(text)) return 'CONTRACT_REVERT';
  if (/fetch failed|network|timeout|econn/i.test(text)) return 'RPC_FAILURE';
  return 'UNKNOWN';
}

/** The shortest true sentence about an error. Never invents one. */
export function describe(error: unknown): string {
  const shortMessage = (error as { shortMessage?: string }).shortMessage;
  if (typeof shortMessage === 'string' && shortMessage !== '') return shortMessage;
  const details = (error as { details?: string }).details;
  if (typeof details === 'string' && details !== '') return details;
  return error instanceof Error ? error.message : String(error);
}

const OBSERVE_ATTEMPTS = 20;
const OBSERVE_INTERVAL_MS = 1_500;

/**
 * Runs one write end to end, reporting every rung.
 *
 * The chain switch is first and separate, because "your wallet is on the wrong
 * network" is a different problem from "the transaction reverted" and a user who
 * sees one when it is the other debugs the wrong thing.
 */
export async function runWrite(
  host: HTMLElement,
  step: WriteStep,
  onState?: (state: TxState) => void,
): Promise<WriteResult> {
  const base = {
    kind: step.kind,
    label: step.label,
    chainId: step.chainId,
    target: step.target,
    expected: step.expected,
  };
  const paint = (state: TxState): void => {
    paintTx(host, state);
    onState?.(state);
  };

  if (wallet.current.status !== 'connected') {
    paint({ ...base, phase: 'needs-wallet' });
    return { ok: false, errorClass: 'PREREQUISITE_MISSING' };
  }

  const client = publicClient(step.chainId);

  try {
    if (step.precondition !== undefined) await step.precondition();

    if (wallet.current.chainId !== step.chainId) {
      paint({ ...base, phase: 'switch-network' });
      await wallet.ensureChain(step.chainId);
    }

    paint({ ...base, phase: 'awaiting-signature' });
    const hash = await step.send();

    const explorerUrl = explorerUrlFor(step.chainId, hash);
    paint({
      ...base,
      phase: 'submitted',
      hash,
      ...(explorerUrl === undefined ? {} : { explorerUrl }),
    });

    const receipt = await client.waitForTransactionReceipt({ hash });
    const withHash = {
      ...base,
      hash,
      block: receipt.blockNumber,
      ...(explorerUrl === undefined ? {} : { explorerUrl }),
    };

    if (receipt.status !== 'success') {
      paint({
        ...withHash,
        phase: 'failed',
        errorClass: 'CONTRACT_REVERT',
        error: 'the transaction was mined and reverted',
      });
      return { ok: false, hash, block: receipt.blockNumber, errorClass: 'CONTRACT_REVERT' };
    }

    paint({ ...withHash, phase: 'confirmed' });

    if (step.onConfirmed !== undefined) await step.onConfirmed(hash);

    paint({ ...withHash, phase: 'confirming' });

    // Inclusion first, then effect. A read against a node that has not reached
    // this block is not evidence of anything, so it is not treated as any.
    let sawBlock = false;
    let observed = 'not read yet';
    for (let attempt = 0; attempt < OBSERVE_ATTEMPTS; attempt += 1) {
      const latest = await client.getBlockNumber().catch(() => -1n);
      if (latest >= receipt.blockNumber) {
        sawBlock = true;
        const result = await step.observe();
        observed = result.observed;
        if (result.ok) {
          paint({ ...withHash, phase: 'state-observed', observed });
          return { ok: true, hash, block: receipt.blockNumber };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, OBSERVE_INTERVAL_MS));
    }

    const errorClass: TxErrorClass = sawBlock ? 'STATE_NOT_OBSERVED' : 'RPC_STATE_LAG';
    paint({ ...withHash, phase: 'failed', errorClass, observed });
    return { ok: false, hash, block: receipt.blockNumber, errorClass };
  } catch (error) {
    const errorClass = classify(error);
    paint({ ...base, phase: 'failed', errorClass, error: describe(error) });
    return { ok: false, errorClass };
  }
}

/**
 * Several writes as one action, stopping at the first that does not observe.
 *
 * `reserve-asset` is genuinely two transactions and `lock-cash` is sometimes
 * two. Running the second before the first is visible on chain is exactly the
 * mistake this module exists to prevent, so the sequence is explicit rather than
 * left to a caller's `await`.
 */
export async function runSequence(
  host: HTMLElement,
  steps: readonly WriteStep[],
  onState?: (state: TxState) => void,
): Promise<WriteResult> {
  let last: WriteResult = { ok: true };
  for (const step of steps) {
    last = await runWrite(host, step, onState);
    if (!last.ok) return last;
  }
  return last;
}

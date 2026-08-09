/**
 * One transaction, and everything a person needs to know about it.
 *
 * A protocol action is never a toast. It has a chain, a wallet step, a hash, an
 * inclusion, and — for anything cross-chain — a message that has to be observed
 * and then finalised somewhere else. Each of those can fail differently, and a
 * green tick that appears the moment a wallet returns is a lie about four of
 * them.
 *
 * The states are deliberately explicit rather than a boolean plus a spinner,
 * because "submitted" and "confirmed" and "the other chain has accepted it" are
 * three different degrees of done and only the last one means the protocol
 * agrees with you.
 */

import { CHAINS, publicClient, wallet } from './wallet.js';
import type { Hex } from 'viem';

export type TxPhase =
  | 'needs-wallet'
  | 'switch-network'
  | 'awaiting-signature'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'observed'
  | 'failed';

/** Extra rungs a cross-chain action climbs after its own chain confirms. */
export type MessagePhase = 'message-observed' | 'waiting-finality' | 'finalized' | 'consumed';

export interface TxState {
  readonly phase: TxPhase;
  readonly chainId: number;
  readonly label: string;
  readonly hash?: Hex;
  readonly error?: string;
  readonly message?: MessagePhase;
}

const PHASE_TEXT: Readonly<Record<TxPhase, string>> = Object.freeze({
  'needs-wallet': 'Connect a wallet to continue',
  'switch-network': 'Your wallet is being asked to change network',
  'awaiting-signature': 'Confirm in your wallet',
  submitted: 'Broadcast, waiting to be mined',
  confirming: 'Mined, confirming',
  confirmed: 'Confirmed on chain',
  observed: 'State observed',
  failed: 'Failed',
});

const MESSAGE_TEXT: Readonly<Record<MessagePhase, string>> = Object.freeze({
  'message-observed': 'Wormhole observed the message',
  'waiting-finality': 'Waiting for economic finality',
  finalized: 'FINALIZED',
  consumed: 'Consumed on the remote chain',
});

function node(tag: string, className?: string, text?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Renders a transaction's state into a host element, replacing what was there. */
export function paintTx(host: HTMLElement, state: TxState): void {
  host.replaceChildren();
  host.className = 'txstate';

  const head = node('div', 'row-between');
  head.append(node('span', 'tx-label', state.label));
  const chain = CHAINS[state.chainId]?.name;
  if (chain !== undefined) head.append(node('span', 't-caption muted', chain));
  host.append(head);

  const line = node('div', 'row');
  line.append(node('span', state.phase === 'failed' ? 'tx-dot failed' : 'tx-dot'));
  line.append(node('span', 't-caption', PHASE_TEXT[state.phase]));
  host.append(line);

  if (state.hash !== undefined) {
    const explorer = CHAINS[state.chainId]?.explorer;
    const row = node('div', 'row');
    if (explorer === undefined) {
      row.append(node('span', 'mono t-caption', state.hash));
    } else {
      const link = document.createElement('a');
      link.className = 'ext mono t-caption';
      link.href = `${explorer}/tx/${state.hash}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${state.hash.slice(0, 10)}…${state.hash.slice(-6)}`;
      row.append(link);
    }
    host.append(row);
  }

  if (state.message !== undefined) {
    host.append(node('div', 't-caption muted', MESSAGE_TEXT[state.message]));
  }

  if (state.error !== undefined) {
    host.append(node('div', 't-caption tx-error', state.error));
  }
}

/**
 * Runs a write end to end, reporting every rung.
 *
 * The chain is switched first and separately, because "your wallet is on the
 * wrong network" is a different problem from "the transaction reverted" and a
 * user who sees one when it is the other will debug the wrong thing.
 */
export async function runTx(
  host: HTMLElement,
  options: {
    readonly chainId: number;
    readonly label: string;
    readonly send: () => Promise<Hex>;
    /** Reads chain state after inclusion, to prove the effect rather than the receipt. */
    readonly observe?: (hash: Hex) => Promise<void>;
  },
): Promise<Hex | undefined> {
  const base = { chainId: options.chainId, label: options.label };

  if (wallet.current.status !== 'connected') {
    paintTx(host, { ...base, phase: 'needs-wallet' });
    return undefined;
  }

  try {
    if (wallet.current.chainId !== options.chainId) {
      paintTx(host, { ...base, phase: 'switch-network' });
      await wallet.ensureChain(options.chainId);
    }

    paintTx(host, { ...base, phase: 'awaiting-signature' });
    const hash = await options.send();

    paintTx(host, { ...base, phase: 'submitted', hash });

    const receipt = await publicClient(options.chainId).waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      paintTx(host, {
        ...base,
        phase: 'failed',
        hash,
        error: 'The transaction was mined but reverted. Nothing changed on chain.',
      });
      return undefined;
    }

    paintTx(host, { ...base, phase: 'confirmed', hash });

    if (options.observe !== undefined) {
      paintTx(host, { ...base, phase: 'confirming', hash });
      await options.observe(hash);
      paintTx(host, { ...base, phase: 'observed', hash });
    }
    return hash;
  } catch (error) {
    paintTx(host, { ...base, phase: 'failed', error: describe(error) });
    return undefined;
  }
}

/** Wallet errors are mostly one of three things, and the rest is not worth paraphrasing. */
export function describe(error: unknown): string {
  const code = (error as { code?: number }).code;
  if (code === 4001) return 'You rejected the request in your wallet.';
  if (code === 4902) return 'Your wallet does not know this network and declined to add it.';
  const shortMessage = (error as { shortMessage?: string }).shortMessage;
  if (typeof shortMessage === 'string' && shortMessage !== '') return shortMessage;
  return error instanceof Error ? error.message : 'Something went wrong.';
}

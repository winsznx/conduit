/**
 * The settlement composer.
 *
 * Terms → compliance preflight → signature. Everything it does is real: the
 * eligibility calls hit Cleanverse through the server, the digest is the one
 * the deployed coordinator verifies, and the signature comes from the user's
 * own wallet. There is no step here that only moves a variable.
 *
 * Progression is gated on facts rather than on clicks. You cannot reach the
 * compliance step with terms that do not parse, and you cannot reach signing
 * while a participant is refused — not because the button is styled as
 * disabled, but because the settlement would be unsignable in a way the user
 * would only discover after locking funds.
 */

import type { SettlementIntent } from '@conduit-protocol/domain';
import type { Address } from 'viem';

import {
  buildIntent,
  encodeIntent,
  fromBaseUnits,
  rolesFor,
  signIntent,
  toBaseUnits,
  type Deployment,
  type DraftTerms,
} from './protocol.js';
import { describe } from './tx.js';
import { BASE_SEPOLIA, MONAD_TESTNET, publicClient, wallet } from './wallet.js';

interface EligibilityRow {
  readonly chain: string;
  readonly chainId: number;
  readonly status: string;
  readonly reason: string;
  readonly detail: string;
  readonly assetSymbol: string;
  readonly checkedAt: string;
  readonly answer?: string;
}

const ERC20_BALANCE = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

function q(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`missing element: ${selector}`);
  return found;
}

/** Same lookup, for the elements whose specific type the caller needs. */
function qi(root: ParentNode, selector: string): HTMLInputElement {
  return q(root, selector) as HTMLInputElement;
}
function qb(root: ParentNode, selector: string): HTMLButtonElement {
  return q(root, selector) as HTMLButtonElement;
}
function qs(root: ParentNode, selector: string): HTMLSelectElement {
  return q(root, selector) as HTMLSelectElement;
}

function node(tag: string, className?: string, text?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** The eight statuses render as three badge weights. None of them is red. */
function statusBadge(status: string): HTMLElement {
  const solid = status === 'ELIGIBLE';
  const attention = status === 'NO_APASS' || status === 'INELIGIBLE' || status === 'POLICY_REFUSAL';
  const badge = node(
    'span',
    `badge ${solid ? 'badge-solid' : attention ? 'badge-soft' : 'badge-outline'}`,
  );
  if (attention) badge.append(node('span', 'dot'));
  badge.append(document.createTextNode(status.replace(/_/g, ' ')));
  return badge;
}

export function mountComposer(): void {
  const root = document.querySelector<HTMLElement>('[data-composer]');
  if (root === null) return;

  const deployment = JSON.parse(root.dataset['composer'] ?? '{}') as Deployment;
  const steps = [...root.querySelectorAll<HTMLElement>('[data-step]')];
  const stepper = q(root, '[data-stepper]');

  let current = 0;
  let intent: SettlementIntent | undefined;

  const show = (index: number): void => {
    current = index;
    steps.forEach((step, i) => {
      step.hidden = i !== index;
    });
    [...stepper.querySelectorAll<HTMLElement>('[data-step-label]')].forEach((label, i) => {
      label.dataset['state'] = i < index ? 'done' : i === index ? 'current' : 'todo';
    });
  };
  show(0);

  // ── Step 1: terms ─────────────────────────────────────────────────────────

  const field = (name: string): HTMLInputElement => qi(root, `#f-${name}`);
  const termsError = q(root, '[data-terms-error]');
  const balances = q(root, '[data-balances]');

  /** Roles are a claim about the connected wallet, so they autofill from it. */
  const applyRole = (): void => {
    const account = wallet.current.address;
    if (account === undefined) return;
    const role = qs(root, '#f-role').value;
    if (role === 'payer' || role === 'both') field('cashPayer').value = account;
    if (role === 'seller' || role === 'both') field('assetSeller').value = account;
    if (role === 'payer') field('assetReceiver').value = account;
    if (role === 'seller') field('cashReceiver').value = account;
    if (role === 'both') {
      field('cashReceiver').value = account;
      field('assetReceiver').value = account;
    }
  };
  q(root, '#f-role').addEventListener('change', applyRole);

  const loadBalances = async (): Promise<void> => {
    const account = wallet.current.address;
    if (account === undefined) return;
    balances.replaceChildren(node('span', 't-caption muted', 'Reading balances…'));
    try {
      const [cash, bond] = await Promise.all([
        publicClient(MONAD_TESTNET).readContract({
          address: deployment.cashAsset,
          abi: ERC20_BALANCE,
          functionName: 'balanceOf',
          args: [account],
        }),
        publicClient(BASE_SEPOLIA).readContract({
          address: deployment.rwaToken,
          abi: ERC20_BALANCE,
          functionName: 'balanceOf',
          args: [account],
        }),
      ]);
      balances.replaceChildren(
        node('span', 't-caption muted', `cSETTLE ${fromBaseUnits(cash)}`),
        node('span', 't-caption muted', `cBOND ${fromBaseUnits(bond)}`),
      );
    } catch {
      // A balance we could not read is unknown, not zero.
      balances.replaceChildren(node('span', 't-caption muted', 'Balances unavailable'));
    }
  };

  wallet.subscribe((state) => {
    if (state.status === 'connected') {
      applyRole();
      void loadBalances();
    }
  });

  const readDraft = (): DraftTerms => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const address = (name: string): Address => {
      const value = field(name).value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} is not a valid address`);
      return value as Address;
    };
    // Deadlines are generous on purpose. Observed Base finality on this
    // deployment has run 999–1485 seconds, so a commit window shorter than that
    // produces a settlement that cannot legally commit.
    return {
      cashAmount: toBaseUnits(field('cashAmount').value),
      cashPayer: address('cashPayer'),
      cashReceiver: address('cashReceiver'),
      assetAmount: toBaseUnits(field('assetAmount').value),
      assetSeller: address('assetSeller'),
      assetReceiver: address('assetReceiver'),
      prepareDeadline: now + 3600n,
      commitDeadline: now + 10_800n,
      releaseDeadline: now + 14_400n,
      nonce: BigInt(Math.floor(Date.now() / 1000)),
    };
  };

  q(root, '[data-to-compliance]').addEventListener('click', () => {
    termsError.textContent = '';
    try {
      const draft = readDraft();
      if (draft.cashAmount <= 0n || draft.assetAmount <= 0n) {
        throw new Error('both legs must move a positive amount');
      }
      intent = buildIntent(deployment, draft);
      show(1);
      void runPreflight(draft);
    } catch (error) {
      termsError.textContent = describe(error);
    }
  });

  // ── Step 2: compliance preflight ──────────────────────────────────────────

  const matrix = q(root, '[data-matrix]');
  const toSign = qb(root, '[data-to-sign]');

  async function runPreflight(draft: DraftTerms): Promise<void> {
    toSign.disabled = true;
    matrix.replaceChildren(node('div', 'muted', 'Asking Cleanverse…'));

    const participants: readonly { label: string; address: Address; chainId: number }[] = [
      { label: 'Payer', address: draft.cashPayer, chainId: MONAD_TESTNET },
      { label: 'Cash receiver', address: draft.cashReceiver, chainId: MONAD_TESTNET },
      { label: 'Seller', address: draft.assetSeller, chainId: BASE_SEPOLIA },
      { label: 'Asset receiver', address: draft.assetReceiver, chainId: BASE_SEPOLIA },
    ];

    const rows = await Promise.all(
      participants.map(async (participant) => {
        const response = await fetch(
          `/api/eligibility?subject=${participant.address}&chainId=${String(participant.chainId)}`,
        );
        const body = (await response.json()) as { results?: EligibilityRow[] };
        return { participant, result: body.results?.[0] };
      }),
    );

    const table = node('table', 'table');
    const head = node('thead');
    const headRow = node('tr');
    for (const column of ['Participant', 'Chain', 'Asset', 'Result']) {
      headRow.append(node('th', undefined, column));
    }
    head.append(headRow);
    table.append(head);

    const body = node('tbody');
    for (const { participant, result } of rows) {
      const row = node('tr');
      row.append(node('td', undefined, participant.label));
      row.append(node('td', 'mono', participant.chainId === MONAD_TESTNET ? 'Monad' : 'Base'));
      row.append(node('td', 'mono', result?.assetSymbol ?? '—'));
      const cell = node('td');
      cell.append(statusBadge(result?.status ?? 'UNAVAILABLE'));
      row.append(cell);
      body.append(row);
    }
    table.append(body);
    matrix.replaceChildren(table);

    const refused = rows.filter(
      ({ result }) => result !== undefined && result.status !== 'ELIGIBLE',
    );
    if (refused.length > 0) {
      const notice = node('div', 'note');
      const outage = refused.some(({ result }) => result?.status === 'UNAVAILABLE');
      notice.textContent = outage
        ? 'At least one check did not complete. That is not a refusal — nothing can be concluded about those participants until Cleanverse answers.'
        : `${String(refused.length)} participant(s) cannot receive their leg. A settlement signed on these terms could not be delivered, so signing is not offered.`;
      matrix.append(notice);
      for (const { participant, result } of refused) {
        matrix.append(
          node('div', 't-caption muted', `${participant.label}: ${result?.detail ?? 'no answer'}`),
        );
      }
      return;
    }
    toSign.disabled = false;
  }

  q(root, '[data-back-terms]').addEventListener('click', () => {
    show(0);
  });
  toSign.addEventListener('click', () => {
    show(2);
    paintSummary();
  });

  // ── Step 3: signature ─────────────────────────────────────────────────────

  const summary = q(root, '[data-summary]');
  const signStatus = q(root, '[data-sign-status]');
  const signButton = qb(root, '[data-sign]');
  const signResult = q(root, '[data-sign-result]');

  function paintSummary(): void {
    if (intent === undefined) return;
    summary.replaceChildren();
    const rows: readonly [string, string][] = [
      ['You pay', `${fromBaseUnits(intent.cashAmount)} cSETTLE on Monad Testnet`],
      ['You receive', `${fromBaseUnits(intent.assetAmount)} cBOND on Base Sepolia`],
      ['Cash payer', intent.cashPayer],
      ['Cash receiver', intent.cashReceiver],
      ['Asset seller', intent.assetSeller],
      ['Asset receiver', intent.assetReceiver],
      ['Settlement id', intent.settlementId],
    ];
    const table = node('table', 'kv');
    for (const [key, value] of rows) {
      const row = node('tr');
      row.append(node('td', undefined, key));
      row.append(node('td', 'mono', value));
      table.append(row);
    }
    summary.append(table);

    const roles = rolesFor(intent, wallet.current.address);
    signButton.disabled = roles.length === 0;
    signStatus.textContent =
      roles.length === 0
        ? 'This wallet is neither the payer nor the seller in these terms, so it has nothing to sign here.'
        : `This wallet signs as ${roles.join(' and ')}.`;
  }

  signButton.addEventListener('click', () => {
    if (intent === undefined) return;
    signButton.disabled = true;
    signStatus.textContent = 'Awaiting your wallet…';

    void (async () => {
      try {
        const signed = await signIntent(deployment, intent);
        signStatus.textContent = `Signed, and the signature recovers to ${signed.signer}.`;

        const response = await fetch('/api/intents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            intent: encodeIntent(signed.intent),
            signer: signed.signer,
            signature: signed.signature,
          }),
        });
        if (!response.ok)
          throw new Error('the settlement could not be stored for your counterparty');

        signResult.replaceChildren();
        signResult.append(node('div', 'badge badge-solid', 'SIGNED'));
        signResult.append(
          node(
            'p',
            'muted',
            'Your signature is recorded. A bilateral settlement needs the other party to sign from their own wallet — send them this link.',
          ),
        );
        const link = `${location.origin}/app/settlements/${signed.intent.settlementId}/sign`;
        const box = node('div', 'nested mono');
        box.style.wordBreak = 'break-all';
        box.textContent = link;
        signResult.append(box);

        const copy = node('button', 'btn btn-secondary btn-sm', 'Copy signing link');
        copy.addEventListener('click', () => {
          void navigator.clipboard.writeText(link).then(() => {
            copy.textContent = 'Copied';
          });
        });
        const open = node('a', 'btn btn-primary btn-sm', 'Open settlement');
        (open as HTMLAnchorElement).href = `/app/settlements/${signed.intent.settlementId}`;

        const actions = node('div', 'row');
        actions.append(copy, open);
        signResult.append(actions);
      } catch (error) {
        signStatus.textContent = describe(error);
        signButton.disabled = false;
      }
    })();
  });

  q(root, '[data-back-compliance]').addEventListener('click', () => {
    show(1);
  });
  void current;
}

/**
 * The counterparty's signing control.
 *
 * The intent is rebuilt from the server's terms and re-hashed locally, so the
 * signer commits to a digest their own browser derived rather than to one the
 * page was handed. The connected wallet must be a party the terms name — the
 * server enforces that too, but refusing here means a wallet is never asked to
 * sign something that would be rejected anyway.
 */
export function mountSignRequest(): void {
  const root = document.querySelector<HTMLElement>('[data-sign-request]');
  if (root === null) return;

  const payload = JSON.parse(root.dataset['signRequest'] ?? '{}') as {
    deployment: Deployment;
    intent: Record<string, string>;
  };
  const status = q(root, '[data-sign-request-status]');
  const button = qb(root, '[data-sign-request-button]');
  const result = q(root, '[data-sign-request-result]');

  const terms = payload.intent;
  const draft: DraftTerms = {
    cashAmount: BigInt(terms['cashAmount'] ?? '0'),
    cashPayer: (terms['cashPayer'] ?? '0x') as Address,
    cashReceiver: (terms['cashReceiver'] ?? '0x') as Address,
    assetAmount: BigInt(terms['assetAmount'] ?? '0'),
    assetSeller: (terms['assetSeller'] ?? '0x') as Address,
    assetReceiver: (terms['assetReceiver'] ?? '0x') as Address,
    prepareDeadline: BigInt(terms['prepareDeadline'] ?? '0'),
    commitDeadline: BigInt(terms['commitDeadline'] ?? '0'),
    releaseDeadline: BigInt(terms['releaseDeadline'] ?? '0'),
    nonce: BigInt(terms['nonce'] ?? '0'),
  };
  const intent = buildIntent(payload.deployment, draft);

  wallet.subscribe((state) => {
    if (state.status !== 'connected') {
      button.disabled = true;
      status.textContent = 'Connect the wallet named in these terms to sign.';
      return;
    }
    const roles = rolesFor(intent, state.address);
    button.disabled = roles.length === 0;
    status.textContent =
      roles.length === 0
        ? 'This wallet is not a party to these terms. Only the payer or the seller can sign this settlement.'
        : `This wallet signs as ${roles.join(' and ')}.`;
  });

  button.addEventListener('click', () => {
    button.disabled = true;
    status.textContent = 'Awaiting your wallet…';
    void (async () => {
      try {
        const signed = await signIntent(payload.deployment, intent);
        const response = await fetch('/api/intents', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            intent: encodeIntent(signed.intent),
            signer: signed.signer,
            signature: signed.signature,
          }),
        });
        if (!response.ok) throw new Error('the signature was rejected by the server');
        status.textContent = `Signed, and the signature recovers to ${signed.signer}.`;
        result.replaceChildren(node('div', 'badge badge-solid', 'SIGNED'));
        const open = node('a', 'btn btn-primary btn-sm', 'Open settlement');
        (open as HTMLAnchorElement).href = `/app/settlements/${signed.intent.settlementId}`;
        result.append(open);
      } catch (error) {
        status.textContent = describe(error);
        button.disabled = false;
      }
    })();
  });
}

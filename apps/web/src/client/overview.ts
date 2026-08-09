/**
 * The console's front page, written for the person looking at it.
 *
 * Before this, `/app` opened with four counters and the newest rows in the
 * projection. That is a fair summary of a database and a poor answer to the
 * only question a participant arrives with: where am I in this, and what is
 * waiting on me. A connected buyer could see somebody else's settlement first
 * and their own further down, or not at all.
 *
 * So the deployment-wide numbers stay, below, and this goes above them: the
 * participant's own position, their own settlements, and the one thing they can
 * do next. Disconnected, it says what the console is for and offers the routes
 * that need no wallet — a judge reading the proof should never be asked to
 * install anything.
 *
 * Nothing here authorises anything. `/api/participant` decides what this page
 * lists and the settlement itself is always read back from both chains.
 */

import { session, type SessionState } from './session.js';

interface ParticipantSettlement {
  readonly settlementId: string;
  readonly canonicalState: string;
  readonly verifierClass?: string;
  readonly generation: number;
  readonly roles: readonly string[];
  readonly cashAmount: string;
  readonly assetAmount: string;
  readonly termsKnown: boolean;
}

/** Settlement states where the participant is the one being waited on. */
const OPEN_STATES = new Set(['NONE', 'INITIATED', 'CASH_PREPARED', 'ASSET_PREPARED', 'PREPARED']);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function anchor(href: string, label: string, className: string): HTMLAnchorElement {
  const node = document.createElement('a');
  node.className = className;
  node.href = href;
  node.textContent = label;
  return node;
}

function units(value: bigint | undefined, decimals = 6): string {
  if (value === undefined) return '—';
  const digits = value.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}${fraction === '' ? '' : `.${fraction}`}`;
}

function figure(label: string, value: string, note?: string): HTMLElement {
  const block = el('div', 'stat stat-sm');
  block.append(el('div', 'stat-label', label));
  block.append(el('div', 'stat-value mono', value));
  if (note !== undefined) block.append(el('div', 'stat-note', note));
  return block;
}

function badge(text: string, solid: boolean): HTMLElement {
  const node = el('span', `badge ${solid ? 'badge-solid' : 'badge-soft'}`);
  if (!solid) node.append(el('span', 'dot'));
  node.append(document.createTextNode(text.replace(/_/g, ' ')));
  return node;
}

// ── Disconnected ────────────────────────────────────────────────────────────

function anonymous(host: HTMLElement): void {
  const card = el('div', 'card');
  card.append(el('div', 't-caption-upper', 'Your position'));
  card.append(
    el(
      'p',
      'muted',
      'Connect a wallet and this page leads with your settlements, your balances on both chains, ' +
        'and what each one is waiting for. Nothing below needs a wallet — every settlement here ' +
        'can be read and independently verified without one.',
    ),
  );
  const row = el('div', 'row');
  row.append(anchor('/app/verifier', 'Verify a settlement', 'btn btn-outline btn-sm'));
  card.append(row);
  host.replaceChildren(card);
}

// ── Connected ───────────────────────────────────────────────────────────────

function position(state: SessionState): HTMLElement {
  const card = el('div', 'card');

  const head = el('div', 'row-between');
  head.append(el('div', 't-caption-upper', 'Your position'));
  const summary = session.eligibilitySummary();
  if (summary !== undefined) head.append(el('span', 't-caption muted', summary));
  card.append(head);

  const grid = el('div', 'grid-4');
  grid.append(figure('cSETTLE', units(state.balances.settlementAsset), 'Monad Testnet'));
  grid.append(figure('cBOND', units(state.balances.rwa), 'Base Sepolia'));
  grid.append(figure('cBOND reserved', units(state.balances.reserved), 'held by a settlement'));
  grid.append(figure('cBOND available', units(state.balances.available), 'free to reserve'));
  card.append(grid);

  const both =
    state.identity.monad?.status === 'ELIGIBLE' && state.identity.base?.status === 'ELIGIBLE';
  if (!both) {
    const refused = [state.identity.monad, state.identity.base].find(
      (entry) => entry !== undefined && entry.status !== 'ELIGIBLE',
    );
    if (refused !== undefined) {
      card.append(el('div', 'note', refused.detail));
    }
  }

  return card;
}

function settlementRow(row: ParticipantSettlement): HTMLElement {
  const item = el('div', 'list-row');

  const top = el('div', 'row-between');
  const left = el('div', 'row');
  left.append(
    anchor(
      `/app/settlements/${row.settlementId}`,
      `${row.settlementId.slice(0, 10)}…${row.settlementId.slice(-6)}`,
      'mono',
    ),
  );
  left.append(badge(row.canonicalState, row.canonicalState === 'SETTLED'));
  top.append(left);
  top.append(anchor(`/app/settlements/${row.settlementId}`, 'Open', 'btn btn-outline btn-sm'));
  item.append(top);

  const detail = el('div', 't-caption muted');
  // Four roles means one wallet on both sides, which reads as a list of four
  // things it is rather than the one thing it is.
  const role =
    row.roles.length === 0
      ? 'party'
      : row.roles.length === 4
        ? 'party on both sides'
        : row.roles.join(' and ');
  detail.textContent = row.termsKnown
    ? `You are the ${role} · ${row.cashAmount} cSETTLE against ${row.assetAmount} cBOND · gen ${String(row.generation)}`
    : `You are the ${role} · terms not recoverable in this projection · gen ${String(row.generation)}`;
  item.append(detail);

  return item;
}

function yours(rows: readonly ParticipantSettlement[]): HTMLElement {
  const card = el('div', 'card');

  const open = rows.filter((row) => OPEN_STATES.has(row.canonicalState));
  const head = el('div', 'row-between');
  head.append(el('div', 't-caption-upper', 'Your settlements'));
  head.append(anchor('/app/settlements/new', 'New settlement', 'btn btn-primary btn-sm'));
  card.append(head);

  if (rows.length === 0) {
    card.append(
      el(
        'p',
        'muted',
        'This wallet is not a party to any settlement the indexer has read. If you composed one in ' +
          'the last minute, open it from the link you were given — the indexer trails both chains ' +
          'and an empty list is not evidence of absence.',
      ),
    );
    return card;
  }

  if (open.length > 0) {
    card.append(
      el(
        'div',
        'note',
        `${String(open.length)} settlement${open.length === 1 ? '' : 's'} still in progress. ` +
          'Open one to see the next action it is waiting for.',
      ),
    );
  }

  const list = el('div', 'stack-8');
  for (const row of rows.slice(0, 8)) list.append(settlementRow(row));
  card.append(list);

  return card;
}

function unreachable(): HTMLElement {
  const card = el('div', 'card');
  card.append(el('div', 't-caption-upper', 'Your settlements'));
  card.append(
    el(
      'p',
      'muted',
      'The projection could not be read. That says nothing about your settlements — chain state ' +
        'is unaffected by whether this index is reachable.',
    ),
  );
  card.append(anchor('/app/settlements', 'Browse all settlements', 'btn btn-outline btn-sm'));
  return card;
}

async function loadSettlements(address: string): Promise<readonly ParticipantSettlement[]> {
  const response = await fetch(`/api/participant?address=${encodeURIComponent(address)}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`participant read failed: ${String(response.status)}`);
  const body = (await response.json()) as { settlements?: readonly ParticipantSettlement[] };
  return body.settlements ?? [];
}

/**
 * Mounts the personalised half of `/app`.
 *
 * It repaints on `ACCOUNT_CHANGED` and on `PROTOCOL_STATE_CHANGED` — a
 * settlement this participant just moved should appear here without a reload,
 * and it must never show the previous account's settlements for even one frame.
 */
export function mountOverview(): void {
  const host = document.querySelector<HTMLElement>('[data-overview]');
  if (host === null) return;

  let loadedFor: string | undefined;
  let listed: HTMLElement | undefined;

  function repaint(): void {
    const children: HTMLElement[] = [position(session.current)];
    if (listed !== undefined) children.push(listed);
    host.replaceChildren(...children);
  }

  function load(account: string): void {
    void loadSettlements(account)
      .then((rows) => {
        if (session.current.account !== account) return;
        listed = yours(rows);
        repaint();
      })
      .catch(() => {
        if (session.current.account !== account) return;
        listed = unreachable();
        repaint();
      });
  }

  session.subscribe((state, event) => {
    if (state.connection !== 'connected' || state.account === undefined) {
      loadedFor = undefined;
      listed = undefined;
      if (state.hydration === 'ready') anonymous(host);
      return;
    }

    const account = state.account;

    // A new account must never inherit the previous one's list, not even for a
    // frame — so the list is dropped before the fetch that replaces it starts.
    if (loadedFor !== account) {
      loadedFor = account;
      listed = undefined;
      repaint();
      load(account);
      return;
    }

    repaint();
    if (event === 'PROTOCOL_STATE_CHANGED') load(account);
  });
}

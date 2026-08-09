/**
 * The activity centre: what this session has sent, and where it got to.
 *
 * Transaction state used to live in the panel that started it, so navigating
 * away lost the record of what was in flight. That is a bad trade in a product
 * whose central wait is twenty minutes long: a participant should be able to
 * open the disposition page, or the verifier, or close the tab, without losing
 * sight of a reservation they made ninety seconds ago.
 *
 * So the session holds the entries and this renders them, on every route, from
 * one place. It is deliberately not a toast: a notice that disappears is no use
 * for something that takes a quarter of an hour, and the workspace still carries
 * the authoritative state of the settlement itself.
 */

import { session, type ActivityEntry, type Notice, type SessionState } from './session.js';

const PHASE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  'needs-wallet': 'Waiting for a wallet',
  'switch-network': 'Asking your wallet to change network',
  'awaiting-signature': 'Confirm in your wallet',
  submitted: 'Broadcast, waiting to be mined',
  confirming: 'Mined — reading the state back',
  confirmed: 'Confirmed on chain',
  'state-observed': 'State observed',
  failed: 'Failed',
});

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

function entryRow(entry: ActivityEntry): HTMLElement {
  const row = el('div', 'activity-row');

  const head = el('div', 'row-between');
  head.append(el('span', 'activity-label', entry.label));
  head.append(
    el('span', 't-caption muted', entry.chainId === 10_143 ? 'Monad Testnet' : 'Base Sepolia'),
  );
  row.append(head);

  const line = el('div', 'row');
  line.append(el('span', entry.phase === 'failed' ? 'tx-dot failed' : 'tx-dot'));
  line.append(el('span', 't-caption', PHASE_TEXT[entry.phase] ?? entry.phase));
  row.append(line);

  if (entry.hash !== undefined) {
    const wrap = el('div', 'row');
    if (entry.explorerUrl === undefined) {
      wrap.append(el('span', 'mono t-caption', entry.hash));
    } else {
      const link = document.createElement('a');
      link.className = 'ext mono t-caption';
      link.href = entry.explorerUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `${entry.hash.slice(0, 10)}…${entry.hash.slice(-6)}`;
      wrap.append(link);
    }
    row.append(wrap);
  }

  if (entry.detail !== undefined) row.append(el('div', 't-caption muted', entry.detail));

  if (entry.settlementId !== undefined) {
    const open = document.createElement('a');
    open.className = 'ext t-caption';
    open.href = `/app/settlements/${entry.settlementId}`;
    open.textContent = 'Open settlement';
    row.append(open);
  }

  return row;
}

/**
 * Notices, in the same corner and dismissed by hand.
 *
 * They do not time out. Something worth telling a participant about here is
 * something that happened to their money, and a message about money that
 * vanishes while you are reading the page it refers to is worse than none.
 */
function noticeRow(notice: Notice): HTMLElement {
  const row = el('div', 'notice card');
  const body = el('div', 'stack-4');
  body.append(el('div', notice.tone === 'attention' ? 'notice-attention' : '', notice.text));
  body.append(el('div', 't-caption muted', notice.at.replace('T', ' ').replace(/\..*$/, ' UTC')));
  row.append(body);

  const close = el('button', 'btn btn-secondary btn-sm');
  close.type = 'button';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => {
    session.dismiss(notice.id);
  });
  row.append(close);
  return row;
}

let open = false;

function paint(host: HTMLElement, state: SessionState): void {
  host.replaceChildren();
  for (const notice of state.notifications) host.append(noticeRow(notice));
  if (state.transactions.length === 0) return;

  const inFlight = state.transactions.filter(
    (entry) => entry.phase !== 'state-observed' && entry.phase !== 'failed',
  ).length;

  const toggle = el('button', 'activity-toggle');
  toggle.type = 'button';
  toggle.dataset['activityToggle'] = '';
  toggle.textContent =
    inFlight > 0
      ? `${String(inFlight)} action${inFlight === 1 ? '' : 's'} in flight`
      : `Activity · ${String(state.transactions.length)}`;
  toggle.addEventListener('click', () => {
    open = !open;
    paint(host, session.current);
  });

  const panel = el('div', 'activity-panel card');
  panel.append(el('div', 't-caption-upper', 'This session'));
  for (const entry of state.transactions) panel.append(entryRow(entry));
  panel.append(
    el(
      'div',
      'note',
      'Kept here so you can leave the page. Conduit keeps tracking the settlement either way, ' +
        'and the settlement’s own state is always read back from the chains.',
    ),
  );

  host.append(toggle);
  if (open) host.append(panel);
}

/**
 * Mounts the drawer, creating its host if the page does not have one.
 *
 * Every application route gets it, which is the point — the drawer that only
 * exists on the page you happened to start from is the drawer that is missing
 * when you need it.
 */
export function mountActivity(): void {
  if (document.querySelector('[data-workspace], .shell') === null) return;

  let host = document.querySelector<HTMLElement>('[data-activity]');
  if (host === null) {
    host = document.createElement('div');
    host.dataset['activity'] = '';
    host.className = 'activity';
    document.body.append(host);
  }

  session.subscribe((state) => {
    paint(host, state);
  });
}

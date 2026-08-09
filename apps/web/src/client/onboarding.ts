/**
 * Orientation, twice, and never again after that.
 *
 * Conduit asks a newcomer to hold two ideas before anything makes sense: that
 * two chains are involved at once, and that eligibility is an answer rather
 * than a property. A product that leaves those to be inferred from a settlement
 * page is a product that reads as a database browser.
 *
 * So there are exactly two moments:
 *
 *   the first visit to the console, before any wallet exists;
 *   the first connection of a given account, when Cleanverse has just answered.
 *
 * Both are dismissible, both are recorded per wallet, and neither blocks
 * anything. A judge who only wants the proof should never be walked through a
 * wallet setup, so the first one offers that route explicitly.
 */

import { session, type EligibilityView, type SessionState } from './session.js';

const SEEN_WELCOME = 'conduit.welcomed';

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

function link(href: string, label: string, primary = false): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.className = `btn ${primary ? 'btn-primary' : 'btn-outline'} btn-sm`;
  anchor.href = href;
  anchor.textContent = label;
  return anchor;
}

function dismissible(host: HTMLElement, onDismiss: () => void): HTMLButtonElement {
  const close = el('button', 'btn btn-secondary btn-sm');
  close.type = 'button';
  close.textContent = 'Dismiss';
  close.addEventListener('click', () => {
    host.replaceChildren();
    onDismiss();
  });
  return close;
}

function seenWelcome(): boolean {
  try {
    return localStorage.getItem(SEEN_WELCOME) === '1';
  } catch {
    return true;
  }
}

function markWelcomed(): void {
  try {
    localStorage.setItem(SEEN_WELCOME, '1');
  } catch {
    // A browser refusing storage sees it again. Smaller failure than hiding it.
  }
}

/** The first visit: what this is, and three honest ways in. */
function welcome(host: HTMLElement): void {
  const card = el('div', 'card onboarding');
  card.append(el('div', 't-caption-upper', 'Welcome to Conduit'));
  card.append(
    el('div', 'onboarding-title', 'Cross-chain delivery versus payment for verified assets.'),
  );
  card.append(
    el(
      'p',
      'muted',
      'Two assets stay on the chains that issued them. Conduit coordinates one settlement ' +
        'decision between them, and makes that decision irreversible only after economic finality ' +
        'and a fresh compliance answer.',
    ),
  );

  const actions = el('div', 'row');
  actions.style.flexWrap = 'wrap';
  actions.append(link('/app/settlements/new', 'Start a settlement', true));

  const connect = el('button', 'btn btn-outline btn-sm');
  connect.type = 'button';
  connect.textContent = 'Connect wallet';
  connect.addEventListener('click', () => {
    document.querySelector<HTMLElement>('[data-participant] [data-connect]')?.click();
  });
  actions.append(connect);
  actions.append(link('/app/settlements', 'Explore a proven settlement'));
  card.append(actions);

  card.append(
    el(
      'p',
      't-caption muted',
      'Only the first of those needs a wallet. A settlement that already happened can be read, ' +
        'and independently verified, by anybody.',
    ),
  );

  const foot = el('div', 'row');
  foot.append(dismissible(host, markWelcomed));
  card.append(foot);

  host.replaceChildren(card);
}

function verdictLine(label: string, entry: EligibilityView | undefined): HTMLElement {
  const row = el('div', 'row-between nested');
  row.append(el('span', undefined, label));
  if (entry === undefined) {
    row.append(el('span', 't-caption muted', 'checking…'));
    return row;
  }
  const solid = entry.status === 'ELIGIBLE';
  const badge = el('span', `badge ${solid ? 'badge-solid' : 'badge-soft'}`);
  if (!solid) badge.append(el('span', 'dot'));
  badge.append(document.createTextNode(entry.status.replace(/_/g, ' ')));
  row.append(badge);
  return row;
}

/**
 * The first connection of an account: which chains, and what Cleanverse said.
 *
 * The ineligible branch is the one that matters. A judge who connects a fresh
 * wallet and is refused must not reach a dead end — the refusal is the product
 * working, and there is a whole proven settlement waiting for them to read.
 */
function connected(host: HTMLElement, state: SessionState): void {
  const card = el('div', 'card onboarding');
  card.append(el('div', 't-caption-upper', 'Wallet connected'));
  card.append(el('div', 'onboarding-title mono', state.account ?? ''));

  card.append(
    el(
      'p',
      'muted',
      'Conduit uses two networks at once. Monad Testnet carries the settlement leg; Base Sepolia ' +
        'carries the restricted asset. There is no network to choose — each action asks your ' +
        'wallet for the chain it needs.',
    ),
  );

  const chains = el('div', 'stack-8');
  chains.append(verdictLine('Monad Testnet · settlement leg', state.identity.monad));
  chains.append(verdictLine('Base Sepolia · restricted asset leg', state.identity.base));
  card.append(chains);

  const eligible =
    state.identity.monad?.status === 'ELIGIBLE' && state.identity.base?.status === 'ELIGIBLE';
  const answered = state.identity.monad !== undefined || state.identity.base !== undefined;

  if (!answered) {
    card.append(el('p', 't-caption muted', 'Asking Cleanverse about this wallet…'));
    host.replaceChildren(card);
    return;
  }

  // Cleanverse has answered, so this card has said everything it exists to say.
  // Seen from here on, whether or not the participant clicks anything.
  session.rememberOrientation();

  const actions = el('div', 'row');
  actions.style.flexWrap = 'wrap';

  if (eligible) {
    card.append(el('p', undefined, 'You are ready to create or join a settlement.'));
    actions.append(link('/app/settlements/new', 'New settlement', true));
    actions.append(link('/app/settlements', 'Open an existing settlement'));
  } else {
    const refused = [state.identity.monad, state.identity.base].find(
      (entry) => entry !== undefined && entry.status !== 'ELIGIBLE',
    );
    card.append(
      el(
        'p',
        undefined,
        refused === undefined
          ? 'This wallet is not currently eligible for the Cleanverse sandbox assets.'
          : refused.detail,
      ),
    );
    card.append(
      el(
        'p',
        'muted',
        'That is Cleanverse’s answer, not a Conduit error, and everything below still works.',
      ),
    );
    actions.append(link('/app/settlements', 'Explore a proven settlement', true));
    actions.append(link('/app/dispositions', 'View the compliance-change case'));
    actions.append(link('/app/verifier', 'Verify independently'));
  }

  actions.append(
    dismissible(host, () => {
      session.markOriented();
    }),
  );
  card.append(actions);

  host.replaceChildren(card);
}

/**
 * Mounts orientation into the slot the shell provides.
 *
 * Only on `/app`, because that is where somebody arrives to *do* something. A
 * settlement page has its own next action and does not need to be interrupted.
 */
export function mountOnboarding(): void {
  const host = document.querySelector<HTMLElement>('[data-onboarding]');
  if (host === null) return;

  let shown = false;
  session.subscribe((state) => {
    if (state.hydration !== 'ready') return;

    if (state.connection === 'connected') {
      if (state.oriented) {
        if (shown) host.replaceChildren();
        return;
      }
      shown = true;
      connected(host, state);
      return;
    }

    if (!seenWelcome()) {
      shown = true;
      welcome(host);
    }
  });
}

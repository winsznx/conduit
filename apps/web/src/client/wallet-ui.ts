/**
 * The participant control, in Conduit's own visual language.
 *
 * No connector library's UI appears anywhere in this product. `design.md` is a
 * monochrome system and the usual wallet modals are not — dropping one in would
 * import a second design system through the side door. These controls are built
 * from the same tokens as every other surface.
 *
 * ## One control, one session
 *
 * There is exactly one of these per page, in the top chrome, and it renders from
 * the session rather than from a wallet subscription of its own. The sidebar
 * shows a compact identity strip that reads the same state and offers no second
 * way to connect: two controls that can disagree about who you are is the
 * problem this replaced.
 *
 * Everything here is progressive enhancement. The pages render and are fully
 * readable server-side; this attaches the parts that need a wallet.
 */

import { session, type EligibilityView, type SessionState } from './session.js';
import { discoverWallets, type DiscoveredWallet } from './wallet.js';

const SHORT = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

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

/** Base units to a readable figure, without floating point anywhere near it. */
function units(value: bigint | undefined, decimals = 6): string {
  if (value === undefined) return '—';
  const digits = value.toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

// ── Modal ───────────────────────────────────────────────────────────────────

function closeModal(): void {
  document.querySelector('.modal-root')?.remove();
  document.removeEventListener('keydown', onEscape);
}

function onEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeModal();
}

function openModal(title: string, body: HTMLElement): void {
  closeModal();
  const root = el('div', 'modal-root');
  const backdrop = el('div', 'modal-backdrop');
  backdrop.addEventListener('click', closeModal);

  const panel = el('div', 'modal card');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', title);
  panel.tabIndex = -1;

  const head = el('div', 'row-between');
  head.append(el('div', 't-subheading', title));
  const close = el('button', 'btn btn-secondary btn-sm');
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', closeModal);
  head.append(close);

  panel.append(head, body);
  root.append(backdrop, panel);
  document.body.append(root);
  document.addEventListener('keydown', onEscape);
  panel.focus();
}

// ── Connect ─────────────────────────────────────────────────────────────────

async function openConnect(): Promise<void> {
  const body = el('div', 'stack-12');
  body.style.marginTop = 'var(--spacing-16)';
  body.append(el('div', 'muted', 'Looking for wallets…'));
  openModal('Connect a wallet', body);

  const wallets = await discoverWallets();
  body.replaceChildren();

  if (wallets.length === 0) {
    body.append(
      el(
        'p',
        'muted',
        'No wallet extension announced itself. Install an EIP-1193 wallet such as MetaMask or Rabby, then reload this page.',
      ),
    );
    return;
  }

  body.append(
    el(
      'p',
      'muted',
      'Conduit never sees your key. It asks your wallet to sign, and reads the result from the chain.',
    ),
  );

  for (const found of wallets) body.append(walletRow(found));
}

function walletRow(found: DiscoveredWallet): HTMLElement {
  const row = el('button', 'wallet-row');
  row.type = 'button';

  if (found.icon !== '') {
    const img = el('img', 'wallet-icon');
    img.src = found.icon;
    img.alt = '';
    row.append(img);
  }
  row.append(el('span', undefined, found.name));

  const status = el('span', 't-caption muted');
  row.append(status);

  row.addEventListener('click', () => {
    status.textContent = 'check your wallet…';
    void session
      .connect(found)
      .then(closeModal)
      .catch((error: unknown) => {
        // A user declining is the expected path, not a failure to shout about.
        const code = (error as { code?: number }).code;
        status.textContent = code === 4001 ? 'request rejected' : 'could not connect';
      });
  });
  return row;
}

// ── Account panel ───────────────────────────────────────────────────────────

function verdict(entry: EligibilityView | undefined): HTMLElement {
  if (entry === undefined) return el('span', 't-caption muted', 'not checked');
  const solid = entry.status === 'ELIGIBLE';
  const badge = el('span', `badge ${solid ? 'badge-solid' : 'badge-soft'}`);
  if (!solid) badge.append(el('span', 'dot'));
  badge.append(document.createTextNode(entry.status.replace(/_/g, ' ')));
  return badge;
}

function openAccount(state: SessionState): void {
  const address = state.account ?? '0x';
  const body = el('div', 'stack-16');
  body.style.marginTop = 'var(--spacing-16)';

  // Wallet
  const full = el('div', 'nested mono');
  full.style.wordBreak = 'break-all';
  full.textContent = address;
  body.append(full);

  const copy = el('button', 'btn btn-secondary btn-sm');
  copy.type = 'button';
  copy.textContent = 'Copy address';
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(address).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy address'), 1200);
    });
  });
  const actions = el('div', 'row');
  actions.append(copy);
  body.append(actions);

  // Networks. Both, always — a settlement uses both at once, and where the
  // wallet happens to point is not a mode the application is in.
  const networks = el('div', 'stack-8');
  networks.append(el('div', 't-caption-upper', 'Networks'));
  for (const chain of session.chainAccess()) {
    const row = el('div', 'row-between nested');
    const left = el('div', 'row');
    left.append(el('span', undefined, chain.name));
    if (chain.here) left.append(el('span', 'badge badge-outline', 'wallet is here'));
    row.append(left);
    row.append(el('span', 't-caption muted', chain.here ? 'connected' : 'available'));
    networks.append(row);
  }
  body.append(networks);

  // Cleanverse
  const compliance = el('div', 'stack-8');
  compliance.append(el('div', 't-caption-upper', 'Cleanverse'));
  for (const [label, entry] of [
    ['Monad Testnet', state.identity.monad],
    ['Base Sepolia', state.identity.base],
  ] as const) {
    const row = el('div', 'row-between nested');
    row.append(el('span', undefined, label));
    row.append(verdict(entry));
    compliance.append(row);
    if (entry !== undefined && entry.status !== 'ELIGIBLE') {
      compliance.append(el('div', 't-caption muted', entry.detail));
    }
  }
  if (state.identity.checkedAt !== undefined) {
    compliance.append(el('div', 't-caption muted', `checked ${state.identity.checkedAt}`));
  }
  body.append(compliance);

  // Balances
  const balances = el('div', 'stack-8');
  balances.append(el('div', 't-caption-upper', 'Balances'));
  for (const [label, value] of [
    ['cSETTLE · Monad', state.balances.settlementAsset],
    ['cBOND · Base', state.balances.rwa],
    ['cBOND reserved', state.balances.reserved],
    ['cBOND available', state.balances.available],
  ] as const) {
    const row = el('div', 'row-between nested');
    row.append(el('span', undefined, label));
    row.append(el('span', 'mono', units(value)));
    balances.append(row);
  }
  body.append(balances);

  // Actions
  const refresh = el('button', 'btn btn-secondary btn-sm');
  refresh.type = 'button';
  refresh.textContent = 'Refresh eligibility';
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    refresh.textContent = 'Asking Cleanverse…';
    void Promise.all([
      session.refreshEligibility({ force: true }),
      session.refreshBalances(),
    ]).finally(() => {
      closeModal();
      openAccount(session.current);
    });
  });

  const disconnect = el('button', 'btn btn-destructive btn-sm');
  disconnect.type = 'button';
  disconnect.textContent = 'Disconnect';
  disconnect.addEventListener('click', () => {
    session.disconnect();
    closeModal();
  });

  const row = el('div', 'row');
  row.append(refresh, disconnect);
  body.append(row);

  body.append(
    el(
      'p',
      't-caption muted',
      'Conduit holds no single active network. Each action asks your wallet for the chain that ' +
        'action needs. Eligibility shown here is informational — an irreversible COMMIT asks ' +
        'Cleanverse again, server-side, whatever this says.',
    ),
  );

  openModal('Participant', body);
}

// ── Mounting ────────────────────────────────────────────────────────────────

function paintControl(host: HTMLElement, state: SessionState): void {
  host.replaceChildren();

  if (state.connection !== 'connected' || state.account === undefined) {
    const connect = el('button', 'btn btn-primary btn-sm');
    connect.type = 'button';
    connect.dataset['connect'] = '';
    connect.textContent = state.connection === 'connecting' ? 'Connecting…' : 'Connect wallet';
    connect.disabled = state.connection === 'connecting';
    connect.addEventListener('click', () => void openConnect());
    host.append(connect);
    return;
  }

  const button = el('button', 'account-chip');
  button.type = 'button';
  button.dataset['account'] = state.account;
  button.append(el('span', 'mono', SHORT(state.account)));

  const summary = session.eligibilitySummary();
  button.append(el('span', 't-caption muted', summary ?? 'checking eligibility…'));

  button.addEventListener('click', () => {
    openAccount(session.current);
  });
  host.append(button);
}

/** The compact identity in the sidebar. It reports; it never offers a connect. */
function paintStrip(host: HTMLElement, state: SessionState): void {
  host.replaceChildren();
  if (state.connection !== 'connected' || state.account === undefined) {
    host.append(
      el('span', 't-caption muted', 'Not connected. The participant control is at the top right.'),
    );
    return;
  }
  const wrap = el('div', 'stack-4');
  wrap.append(el('div', 'mono t-caption', SHORT(state.account)));
  const summary = session.eligibilitySummary();
  if (summary !== undefined) wrap.append(el('div', 't-caption muted', summary));
  host.append(wrap);
}

export function mountParticipantControl(): void {
  const controls = [...document.querySelectorAll<HTMLElement>('[data-participant]')];
  const strips = [...document.querySelectorAll<HTMLElement>('[data-identity-strip]')];
  if (controls.length === 0 && strips.length === 0) return;

  session.subscribe((state) => {
    for (const host of controls) paintControl(host, state);
    for (const host of strips) paintStrip(host, state);
  });
}

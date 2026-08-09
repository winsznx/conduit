/**
 * The wallet controls, in Conduit's own visual language.
 *
 * No connector library's UI appears anywhere in this product. `design.md` is a
 * monochrome system and the usual wallet modals are not — dropping one in would
 * import a second design system through the side door. These controls are built
 * from the same tokens as every other surface, so the account menu looks like
 * the settlement table it sits above.
 *
 * Everything here is progressive enhancement. The pages render and are fully
 * readable server-side; this attaches the parts that need a wallet, and a
 * browser with no wallet at all still sees the whole product.
 */

import { CHAINS, wallet, type DiscoveredWallet, type WalletState } from './wallet.js';
import { discoverWallets } from './wallet.js';

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

// ── Modal ───────────────────────────────────────────────────────────────────

function closeModal(): void {
  document.querySelector('.modal-root')?.remove();
  document.removeEventListener('keydown', onEscape);
}

function onEscape(event: KeyboardEvent): void {
  if (event.key === 'Escape') closeModal();
}

/**
 * A dialog that traps nothing and blocks nothing it should not.
 *
 * Escape closes, the backdrop closes, and focus moves to the panel so a
 * keyboard user is not left behind the overlay.
 */
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

  for (const found of wallets) {
    body.append(walletRow(found));
  }
}

function walletRow(found: DiscoveredWallet): HTMLElement {
  const row = el('button', 'wallet-row');
  row.type = 'button';

  if (found.icon !== '') {
    const img = el('img', 'wallet-icon');
    // The icon is a data: URI from the wallet's own announcement. `img-src`
    // already allows `data:`, so this needs no CSP change.
    img.src = found.icon;
    img.alt = '';
    row.append(img);
  }
  row.append(el('span', undefined, found.name));

  const status = el('span', 't-caption muted');
  row.append(status);

  row.addEventListener('click', () => {
    status.textContent = 'check your wallet…';
    void wallet
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

// ── Account menu ────────────────────────────────────────────────────────────

function openAccount(state: WalletState): void {
  const address = state.address ?? '0x';
  const body = el('div', 'stack-16');
  body.style.marginTop = 'var(--spacing-16)';

  const full = el('div', 'nested mono');
  full.style.wordBreak = 'break-all';
  full.textContent = address;
  body.append(full);

  const actions = el('div', 'row');
  const copy = el('button', 'btn btn-secondary btn-sm');
  copy.type = 'button';
  copy.textContent = 'Copy address';
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(address).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy address'), 1200);
    });
  });
  actions.append(copy);
  body.append(actions);

  // Both chains are listed together because a settlement uses both at once.
  // This is where the wallet happens to be pointing, not a mode the app is in.
  const networks = el('div', 'stack-8');
  networks.append(el('div', 't-caption-upper', 'Networks'));
  for (const info of Object.values(CHAINS)) {
    const row = el('div', 'row-between nested');
    const left = el('div', 'row');
    left.append(el('span', undefined, info.name));
    if (state.chainId === info.id) left.append(el('span', 'badge badge-outline', 'wallet is here'));
    row.append(left);

    const button = el('button', 'btn btn-outline btn-sm');
    button.type = 'button';
    button.textContent = state.chainId === info.id ? 'Current' : 'Switch';
    button.disabled = state.chainId === info.id;
    button.addEventListener('click', () => {
      button.textContent = 'Check wallet…';
      void wallet
        .ensureChain(info.id)
        .then(closeModal)
        .catch(() => (button.textContent = 'Refused'));
    });
    row.append(button);
    networks.append(row);
  }
  body.append(networks);

  body.append(
    el(
      'p',
      't-caption muted',
      'Conduit does not hold a single active network. Each action asks your wallet for the chain that action needs.',
    ),
  );

  const disconnect = el('button', 'btn btn-destructive btn-sm');
  disconnect.type = 'button';
  disconnect.textContent = 'Disconnect';
  disconnect.addEventListener('click', () => {
    wallet.disconnect();
    closeModal();
  });
  body.append(disconnect);

  openModal('Account', body);
}

// ── Mounting ────────────────────────────────────────────────────────────────

/**
 * Renders whatever the wallet control should be right now.
 *
 * Every mount point gets the same treatment, so the sidebar and the top bar
 * cannot disagree about whether a wallet is connected.
 */
function paint(host: HTMLElement, state: WalletState): void {
  host.replaceChildren();

  if (state.status !== 'connected' || state.address === undefined) {
    const connect = el('button', 'btn btn-primary btn-sm');
    connect.type = 'button';
    connect.textContent = state.status === 'connecting' ? 'Connecting…' : 'Connect wallet';
    connect.disabled = state.status === 'connecting';
    connect.addEventListener('click', () => void openConnect());
    host.append(connect);
    return;
  }

  const button = el('button', 'account-chip');
  button.type = 'button';
  button.append(el('span', 'mono', SHORT(state.address)));

  const where = CHAINS[state.chainId ?? 0]?.name;
  button.append(
    el('span', 't-caption muted', where ?? `chain ${String(state.chainId ?? 0)} — unsupported`),
  );
  button.addEventListener('click', () => {
    openAccount(state);
  });
  host.append(button);
}

export function mountWalletControls(): void {
  const hosts = [...document.querySelectorAll<HTMLElement>('[data-wallet-control]')];
  if (hosts.length === 0) return;
  wallet.subscribe((state) => {
    for (const host of hosts) paint(host, state);
  });
}

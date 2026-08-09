/**
 * One participant session, for the whole application.
 *
 * Before this, every page derived the participant for itself: the composer read
 * balances one way and the workspace another, roles were computed in two
 * places, and eligibility was fetched wherever somebody happened to need it. The
 * wallet was already a singleton, so the connection was never the problem — the
 * problem was everything built on top of it.
 *
 * ## What this owns
 *
 * Connection, account, the chains that account can reach, its Cleanverse
 * eligibility per chain, its balances, the transactions it has in flight, and
 * the notices worth showing. Pages read. Pages do not recompute.
 *
 * ## Why events rather than more effects
 *
 * A page that reacts to "connected" by fetching balances, which reacts to
 * balances by deriving roles, which reacts to roles by re-rendering, is four
 * chances to be inconsistent and one guaranteed double fetch. Here the session
 * owns the side effects and announces what changed; views subscribe once and
 * render whatever the state currently is.
 *
 * ## What it deliberately does not own
 *
 * A selected chain. Conduit is two-chain and both are live at once, so an
 * app-wide "current network" would be wrong for half of every settlement. The
 * session tracks *access* to both; each action asks for the chain it needs at
 * the moment it runs. That decision predates this file and is kept.
 *
 * It also owns no authority. Cached eligibility is informational and is never
 * what authorises a commit — `POST /api/attestations` asks Cleanverse again,
 * server-side, every time, and the contract checks the signature it returns.
 */

import type { Address } from 'viem';

import {
  BASE_SEPOLIA,
  CHAINS,
  MONAD_TESTNET,
  discoverWallets,
  publicClient,
  wallet,
  type DiscoveredWallet,
} from './wallet.js';
import type { Deployment } from './protocol.js';

export type SessionEvent =
  | 'SESSION_BOOT'
  | 'WALLET_DISCOVERED'
  | 'CONNECT_REQUESTED'
  | 'ACCOUNT_CONNECTED'
  | 'ACCOUNT_CHANGED'
  | 'CHAIN_CHANGED'
  | 'ELIGIBILITY_REFRESH_REQUESTED'
  | 'ELIGIBILITY_REFRESHED'
  | 'BALANCES_REFRESHED'
  | 'SETTLEMENT_SELECTED'
  | 'TX_SUBMITTED'
  | 'TX_CONFIRMED'
  | 'PROTOCOL_STATE_CHANGED'
  | 'NOTIFIED'
  | 'DISCONNECTED';

/** One chain's answer about one account. Mirrors the server's taxonomy exactly. */
export interface EligibilityView {
  readonly status: string;
  readonly reason: string;
  readonly detail: string;
  readonly assetSymbol: string;
  readonly answer?: string;
  readonly checkedAt: string;
}

export interface ActivityEntry {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly chainId: number;
  readonly phase: string;
  readonly hash?: string;
  readonly explorerUrl?: string;
  readonly settlementId?: string;
  readonly detail?: string;
  readonly at: string;
}

export interface Notice {
  readonly id: string;
  readonly text: string;
  readonly tone: 'info' | 'attention';
  readonly at: string;
}

export interface SessionState {
  readonly hydration: 'booting' | 'restoring' | 'ready';
  readonly connection: 'disconnected' | 'connecting' | 'connected';
  readonly account?: Address;
  readonly walletName?: string;
  /** Where the wallet currently points. Not an app-wide mode. */
  readonly chainId?: number;
  readonly wallets: readonly DiscoveredWallet[];
  readonly identity: {
    readonly monad?: EligibilityView;
    readonly base?: EligibilityView;
    readonly checkedAt?: string;
    readonly checking: boolean;
  };
  readonly balances: {
    readonly settlementAsset?: bigint;
    readonly rwa?: bigint;
    readonly reserved?: bigint;
    readonly available?: bigint;
    readonly at?: string;
  };
  readonly transactions: readonly ActivityEntry[];
  readonly notifications: readonly Notice[];
  /** True once the participant has seen the orientation for this wallet. */
  readonly oriented: boolean;
}

const EMPTY: SessionState = {
  hydration: 'booting',
  connection: 'disconnected',
  wallets: [],
  identity: { checking: false },
  balances: {},
  transactions: [],
  notifications: [],
  oriented: false,
};

type Listener = (state: SessionState, event: SessionEvent) => void;

const ERC20 = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const RESERVED = [
  {
    type: 'function',
    name: 'reservedBalanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'availableBalanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** An eligibility answer older than this is stale enough to ask again. */
const ELIGIBILITY_TTL_MS = 5 * 60 * 1000;

const ORIENTED_KEY = 'conduit.oriented';
const CHANNEL = 'conduit.session';

export class ConduitSession {
  private state: SessionState = EMPTY;
  private readonly listeners = new Set<Listener>();
  private deployment: Deployment | undefined;

  /**
   * In-flight reads, keyed by what they are reading.
   *
   * Three components rendering the same account must not produce three
   * eligibility calls. The promise is shared and the answer arrives once.
   */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private channel: BroadcastChannel | undefined;

  get current(): SessionState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state, 'SESSION_BOOT');
    return () => this.listeners.delete(listener);
  }

  private emit(next: Partial<SessionState>, event: SessionEvent): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state, event);
  }

  /**
   * Starts the session.
   *
   * Discovery and silent restore run once for the whole application, not once
   * per page that happens to want a wallet. `eth_accounts` never prompts — a
   * reconnect that popped a dialog on every navigation would be a product that
   * nags.
   */
  async boot(deployment: Deployment | undefined): Promise<void> {
    this.deployment = deployment;
    this.emit({ hydration: 'restoring' }, 'SESSION_BOOT');
    this.listenAcrossTabs();

    // The wallet singleton stays the source of truth for the connection itself.
    // This layer owns everything derived from it, and nothing below it.
    wallet.subscribe((walletState) => {
      const changedAccount =
        walletState.address !== undefined && walletState.address !== this.state.account;

      if (walletState.status === 'connected' && walletState.address !== undefined) {
        this.emit(
          {
            connection: 'connected',
            account: walletState.address,
            walletName: walletState.walletName,
            chainId: walletState.chainId,
            oriented: this.hasSeenOrientation(walletState.address),
          },
          changedAccount ? 'ACCOUNT_CONNECTED' : 'CHAIN_CHANGED',
        );
        if (changedAccount) {
          this.emit({ identity: { checking: false }, balances: {} }, 'ACCOUNT_CHANGED');
          void this.refreshEligibility();
          void this.refreshBalances();
        }
        return;
      }

      if (walletState.status === 'disconnected' && this.state.connection !== 'disconnected') {
        this.state = { ...EMPTY, hydration: 'ready', wallets: this.state.wallets };
        for (const listener of this.listeners) listener(this.state, 'DISCONNECTED');
      }
    });

    const found = await discoverWallets();
    this.emit({ wallets: found }, 'WALLET_DISCOVERED');
    await wallet.restore();
    this.emit({ hydration: 'ready' }, 'SESSION_BOOT');
  }

  async connect(chosen: DiscoveredWallet): Promise<void> {
    this.emit({ connection: 'connecting' }, 'CONNECT_REQUESTED');
    try {
      await wallet.connect(chosen);
    } catch (error) {
      this.emit({ connection: 'disconnected' }, 'DISCONNECTED');
      throw error;
    }
  }

  disconnect(): void {
    wallet.disconnect();
  }

  /**
   * Cleanverse, for the connected account, on both chains.
   *
   * Coalesced and cached. `force` is what an explicit refresh and an
   * irreversible action use; everything else is happy with an answer from the
   * last five minutes, because this cache decides what to *show* and never what
   * to authorise.
   */
  async refreshEligibility(options?: { force?: boolean }): Promise<void> {
    const account = this.state.account;
    if (account === undefined) return;

    const checkedAt = this.state.identity.checkedAt;
    const fresh =
      checkedAt !== undefined && Date.now() - Date.parse(checkedAt) < ELIGIBILITY_TTL_MS;
    if (fresh && options?.force !== true) return;

    const key = `eligibility:${account}`;
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      await existing;
      return;
    }

    this.emit(
      { identity: { ...this.state.identity, checking: true } },
      'ELIGIBILITY_REFRESH_REQUESTED',
    );

    const run = (async () => {
      const ask = async (chainId: number): Promise<EligibilityView | undefined> => {
        try {
          const response = await fetch(
            `/api/eligibility?subject=${account}&chainId=${String(chainId)}`,
          );
          if (!response.ok) return undefined;
          const body = (await response.json()) as { results?: EligibilityView[] };
          return body.results?.[0];
        } catch {
          // A check that did not complete is not a refusal. Absent, not false.
          return undefined;
        }
      };
      const [monad, base] = await Promise.all([ask(MONAD_TESTNET), ask(BASE_SEPOLIA)]);
      return { monad, base };
    })();

    this.inflight.set(key, run);
    try {
      const { monad, base } = await run;
      this.emit(
        {
          identity: {
            checking: false,
            checkedAt: new Date().toISOString(),
            ...(monad === undefined ? {} : { monad }),
            ...(base === undefined ? {} : { base }),
          },
        },
        'ELIGIBILITY_REFRESHED',
      );
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Balances on both chains, coalesced the same way. */
  async refreshBalances(): Promise<void> {
    const account = this.state.account;
    const deployment = this.deployment;
    if (account === undefined || deployment === undefined) return;

    const key = `balances:${account}`;
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      await existing;
      return;
    }

    const run = (async () => {
      const monad = publicClient(MONAD_TESTNET);
      const base = publicClient(BASE_SEPOLIA);
      const [settlementAsset, rwa, reserved, available] = await Promise.all([
        monad
          .readContract({
            address: deployment.cashAsset,
            abi: ERC20,
            functionName: 'balanceOf',
            args: [account],
          })
          .catch(() => undefined),
        base
          .readContract({
            address: deployment.rwaToken,
            abi: ERC20,
            functionName: 'balanceOf',
            args: [account],
          })
          .catch(() => undefined),
        base
          .readContract({
            address: deployment.rwaToken,
            abi: RESERVED,
            functionName: 'reservedBalanceOf',
            args: [account],
          })
          .catch(() => undefined),
        base
          .readContract({
            address: deployment.rwaToken,
            abi: RESERVED,
            functionName: 'availableBalanceOf',
            args: [account],
          })
          .catch(() => undefined),
      ]);
      return { settlementAsset, rwa, reserved, available };
    })();

    this.inflight.set(key, run);
    try {
      const balances = await run;
      this.emit(
        {
          balances: {
            at: new Date().toISOString(),
            ...(balances.settlementAsset === undefined
              ? {}
              : { settlementAsset: balances.settlementAsset }),
            ...(balances.rwa === undefined ? {} : { rwa: balances.rwa }),
            ...(balances.reserved === undefined ? {} : { reserved: balances.reserved }),
            ...(balances.available === undefined ? {} : { available: balances.available }),
          },
        },
        'BALANCES_REFRESHED',
      );
    } finally {
      this.inflight.delete(key);
    }
  }

  // ── Activity ──────────────────────────────────────────────────────────────

  /**
   * Records a write so it survives navigation.
   *
   * A settlement's transactions used to live in the panel that started them, so
   * leaving the page lost the record of what was in flight. They live here now,
   * which is the point of a session: a twenty-minute finality wait should not
   * pin somebody to one tab.
   */
  track(entry: Omit<ActivityEntry, 'at'>): void {
    const at = new Date().toISOString();
    const rest = this.state.transactions.filter((existing) => existing.id !== entry.id);
    const next = [{ ...entry, at }, ...rest].slice(0, 25);
    this.emit(
      { transactions: next },
      entry.phase === 'state-observed' ? 'TX_CONFIRMED' : 'TX_SUBMITTED',
    );
    this.broadcast({ kind: 'activity' });
  }

  notify(text: string, tone: Notice['tone'] = 'info'): void {
    const notice: Notice = {
      id: `${String(this.state.notifications.length)}:${text.slice(0, 24)}`,
      text,
      tone,
      at: new Date().toISOString(),
    };
    this.emit({ notifications: [notice, ...this.state.notifications].slice(0, 8) }, 'NOTIFIED');
  }

  dismiss(id: string): void {
    this.emit(
      { notifications: this.state.notifications.filter((notice) => notice.id !== id) },
      'NOTIFIED',
    );
  }

  /** Called when protocol state moved, so every view re-reads rather than guessing. */
  protocolChanged(settlementId?: string): void {
    this.emit({}, 'PROTOCOL_STATE_CHANGED');
    this.broadcast({ kind: 'protocol', settlementId });
  }

  // ── Orientation ───────────────────────────────────────────────────────────

  private hasSeenOrientation(account: Address): boolean {
    try {
      return localStorage.getItem(`${ORIENTED_KEY}:${account.toLowerCase()}`) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Records that this account has been oriented, without closing the card.
   *
   * Orientation is marked seen the moment it is shown with a real answer, not
   * when it is dismissed. A participant who reads it and navigates on has seen
   * it; following them to every page until they click a button is the nagging
   * pattern this session exists to avoid, and the account panel carries the
   * same facts permanently anyway.
   */
  rememberOrientation(): void {
    const account = this.state.account;
    if (account === undefined) return;
    try {
      localStorage.setItem(`${ORIENTED_KEY}:${account.toLowerCase()}`, '1');
    } catch {
      // A browser refusing storage is a browser that sees the orientation
      // again. That is a smaller failure than not showing it at all.
    }
  }

  /** Dismissal: remembered, and the card goes now. */
  markOriented(): void {
    this.rememberOrientation();
    if (this.state.account !== undefined) this.emit({ oriented: true }, 'NOTIFIED');
  }

  // ── Multi-tab ─────────────────────────────────────────────────────────────

  /**
   * Enough cross-tab awareness to avoid obviously stale state, and no more.
   *
   * A counterparty signing in a second tab, or a transaction confirming there,
   * should not leave this tab showing an answer that stopped being true. This is
   * a nudge to re-read, not a replicated store.
   */
  private listenAcrossTabs(): void {
    try {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (event: MessageEvent<{ kind?: string }>) => {
        if (event.data.kind === 'protocol' || event.data.kind === 'activity') {
          this.emit({}, 'PROTOCOL_STATE_CHANGED');
        }
      };
    } catch {
      // Older browsers simply do not get cross-tab refresh.
    }
  }

  private broadcast(message: { kind: string; settlementId?: string }): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // A closed channel is not worth failing a settlement over.
    }
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  /** Which chains this account can currently reach, for the account panel. */
  chainAccess(): readonly { chainId: number; name: string; here: boolean }[] {
    return Object.values(CHAINS).map((info) => ({
      chainId: info.id,
      name: info.name,
      here: this.state.chainId === info.id,
    }));
  }

  /** One line about eligibility, or nothing when nobody has been asked. */
  eligibilitySummary(): string | undefined {
    const { monad, base, checking } = this.state.identity;
    if (checking) return 'Checking eligibility…';
    if (monad === undefined && base === undefined) return undefined;
    const good = [monad, base].filter((entry) => entry?.status === 'ELIGIBLE').length;
    if (good === 2) return 'Eligible on both chains';
    if (good === 1) return 'Eligible on one chain';
    return 'Not currently eligible';
  }
}

export const session = new ConduitSession();

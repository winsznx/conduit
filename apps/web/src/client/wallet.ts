/**
 * The wallet layer.
 *
 * Runs in the browser. It holds no secret of its own: the only credential it
 * ever touches is the user's, and that stays inside their wallet — Conduit sees
 * signatures and transaction hashes, never a key.
 *
 * ## Why there is no global "current chain"
 *
 * Conduit is inherently two-chain. A settlement's cash leg lives on Monad and
 * its asset leg on Base, and both are live at the same time. An app-wide
 * "selected network" would be wrong for half of every settlement, so nothing
 * here tracks one. Each action declares the chain it needs and asks the wallet
 * to be on that chain at the moment it runs.
 */

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Address,
  type Chain,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from 'viem';

export const MONAD_TESTNET = 10_143;
export const BASE_SEPOLIA = 84_532;

/** Everything the UI needs to name a chain and to add it to a wallet. */
export interface ChainInfo {
  readonly id: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly explorer: string;
  readonly currency: { name: string; symbol: string; decimals: number };
}

export const CHAINS: Readonly<Record<number, ChainInfo>> = Object.freeze({
  [MONAD_TESTNET]: {
    id: MONAD_TESTNET,
    name: 'Monad Testnet',
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    explorer: 'https://testnet.monadexplorer.com',
    currency: { name: 'MON', symbol: 'MON', decimals: 18 },
  },
  [BASE_SEPOLIA]: {
    id: BASE_SEPOLIA,
    name: 'Base Sepolia',
    rpcUrl: 'https://sepolia.base.org',
    explorer: 'https://sepolia.basescan.org',
    currency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  },
});

function viemChain(chainId: number): Chain {
  const info = CHAINS[chainId];
  if (info === undefined) throw new Error(`unknown chain ${String(chainId)}`);
  return {
    id: info.id,
    name: info.name,
    nativeCurrency: info.currency,
    rpcUrls: { default: { http: [info.rpcUrl] } },
    blockExplorers: { default: { name: info.name, url: info.explorer } },
  };
}

// ── Provider discovery ──────────────────────────────────────────────────────

export interface DiscoveredWallet {
  readonly uuid: string;
  readonly name: string;
  readonly icon: string;
  readonly provider: EIP1193Provider;
}

interface Eip6963Detail {
  readonly info: { readonly uuid: string; readonly name: string; readonly icon: string };
  readonly provider: EIP1193Provider;
}

/** Any script on the page can dispatch this event, so nothing about it is assumed. */
function announcedWallet(event: Event): DiscoveredWallet | undefined {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  if (typeof detail !== 'object' || detail === null) return undefined;
  const { info, provider } = detail as Partial<Eip6963Detail>;
  if (info === undefined || provider === undefined) return undefined;
  if (typeof info.uuid !== 'string' || typeof info.name !== 'string') return undefined;
  return {
    uuid: info.uuid,
    name: info.name,
    icon: typeof info.icon === 'string' ? info.icon : '',
    provider,
  };
}

/**
 * EIP-6963 discovery, with the legacy injected provider as a fallback.
 *
 * Announcement is asynchronous, so this waits briefly rather than reading
 * `window.ethereum` and calling it a day. Rabby, MetaMask and every other
 * modern extension announce themselves this way; when several are installed,
 * `window.ethereum` is whichever one won a race, which is not a choice the user
 * made.
 */
export async function discoverWallets(timeoutMs = 300): Promise<readonly DiscoveredWallet[]> {
  const found = new Map<string, DiscoveredWallet>();

  const onAnnounce = (event: Event): void => {
    const announced = announcedWallet(event);
    if (announced !== undefined) found.set(announced.uuid, announced);
  };

  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  window.removeEventListener('eip6963:announceProvider', onAnnounce);

  if (found.size === 0) {
    const legacy = (window as { ethereum?: EIP1193Provider }).ethereum;
    if (legacy !== undefined) {
      found.set('injected', {
        uuid: 'injected',
        name: 'Injected wallet',
        icon: '',
        provider: legacy,
      });
    }
  }
  return [...found.values()];
}

// ── Connection state ────────────────────────────────────────────────────────

export interface WalletState {
  readonly status: 'disconnected' | 'connecting' | 'connected';
  readonly address?: Address;
  readonly chainId?: number;
  readonly walletName?: string;
}

type Listener = (state: WalletState) => void;

const STORAGE_KEY = 'conduit.wallet';

/**
 * One connection, observable.
 *
 * Deliberately not a framework store. The pages are server-rendered and this
 * only has to tell a handful of controls when the account or chain changed.
 */
export class Wallet {
  private state: WalletState = { status: 'disconnected' };
  private provider: EIP1193Provider | undefined;
  private readonly listeners = new Set<Listener>();

  get current(): WalletState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(next: WalletState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }

  /**
   * Reconnects silently if the wallet still has this site authorised.
   *
   * `eth_accounts` never prompts — it reports an existing authorisation. A
   * reconnect that popped a dialog on every page load would be a page that
   * nags, so a refusal here is simply treated as "not connected".
   */
  async restore(): Promise<void> {
    const remembered = localStorage.getItem(STORAGE_KEY);
    if (remembered === null) return;
    const wallets = await discoverWallets();
    const match = wallets.find((wallet) => wallet.uuid === remembered) ?? wallets[0];
    if (match === undefined) return;
    try {
      const accounts = await match.provider.request({ method: 'eth_accounts' });
      const account = accounts[0];
      if (account === undefined) return;
      await this.adopt(match, account);
    } catch {
      // An unavailable or locked wallet is not an error worth showing on load.
    }
  }

  async connect(wallet: DiscoveredWallet): Promise<void> {
    this.emit({ status: 'connecting' });
    try {
      const accounts = await wallet.provider.request({ method: 'eth_requestAccounts' });
      const account = accounts[0];
      if (account === undefined) throw new Error('the wallet returned no account');
      await this.adopt(wallet, account);
      localStorage.setItem(STORAGE_KEY, wallet.uuid);
    } catch (error) {
      this.emit({ status: 'disconnected' });
      throw error;
    }
  }

  private async adopt(wallet: DiscoveredWallet, address: Address): Promise<void> {
    this.provider = wallet.provider;
    const chainId = Number(await wallet.provider.request({ method: 'eth_chainId' }));
    this.emit({ status: 'connected', address, chainId, walletName: wallet.name });

    wallet.provider.on('accountsChanged', (accounts) => {
      const next = (accounts as readonly Address[])[0];
      if (next === undefined) {
        this.disconnect();
        return;
      }
      this.emit({ ...this.state, status: 'connected', address: next });
    });
    wallet.provider.on('chainChanged', (id) => {
      this.emit({ ...this.state, chainId: Number(id) });
    });
  }

  disconnect(): void {
    this.provider = undefined;
    localStorage.removeItem(STORAGE_KEY);
    this.emit({ status: 'disconnected' });
  }

  /**
   * Puts the wallet on a specific chain, adding it first if it is unknown.
   *
   * 4902 is "unrecognised chain". Testnets are frequently absent from a fresh
   * wallet, so the add is part of the normal path rather than an error branch.
   */
  async ensureChain(chainId: number): Promise<void> {
    const provider = this.requireProvider();
    if (this.state.chainId === chainId) return;
    const info = CHAINS[chainId];
    if (info === undefined) throw new Error(`unknown chain ${String(chainId)}`);
    const hexId = `0x${chainId.toString(16)}`;
    try {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hexId }],
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 4902) throw error;
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hexId,
            chainName: info.name,
            nativeCurrency: info.currency,
            rpcUrls: [info.rpcUrl],
            blockExplorerUrls: [info.explorer],
          },
        ],
      });
    }
    this.emit({ ...this.state, chainId });
  }

  private requireProvider(): EIP1193Provider {
    if (this.provider === undefined) throw new Error('no wallet is connected');
    return this.provider;
  }

  /** A wallet client bound to one chain, for signing and sending. */
  walletClient(chainId: number): WalletClient {
    const address = this.state.address;
    if (address === undefined) throw new Error('no wallet is connected');
    return createWalletClient({
      account: address,
      chain: viemChain(chainId),
      transport: custom(this.requireProvider()),
    });
  }
}

/** Reads go over public RPC, never through the wallet: they need no permission. */
export function publicClient(chainId: number): PublicClient {
  const info = CHAINS[chainId];
  if (info === undefined) throw new Error(`unknown chain ${String(chainId)}`);
  return createPublicClient({ chain: viemChain(chainId), transport: http(info.rpcUrl) });
}

export const wallet = new Wallet();

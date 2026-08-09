/**
 * Where a reader goes to check something themselves.
 *
 * Every identifier this console prints belongs to a public record somewhere,
 * and a hash you have to copy into a search box is a hash most people will not
 * check. These build the link instead.
 *
 * The bases are the explorers this project's own run logs already point at, so
 * a link here lands on the same page the transaction receipts did.
 *
 * Links open in a new tab and carry `rel="noopener noreferrer"`. The Worker
 * already sends `referrer-policy: no-referrer`, so an explorer never learns
 * which settlement a reader came from.
 */

interface Explorer {
  readonly name: string;
  readonly base: string;
}

const EXPLORERS: Readonly<Record<number, Explorer>> = Object.freeze({
  10143: { name: 'Monad Explorer', base: 'https://testnet.monadexplorer.com' },
  84532: { name: 'BaseScan', base: 'https://sepolia.basescan.org' },
});

/** Wormhole chain ids are not EVM chain ids; this is the mapping, not a guess. */
const WORMHOLE_TO_EVM: Readonly<Record<number, number>> = Object.freeze({
  10004: 84532,
  10009: 10143,
});

export function evmChainFor(wormholeChainId: number): number | undefined {
  return WORMHOLE_TO_EVM[wormholeChainId];
}

export function explorerName(chainId: number): string | undefined {
  return EXPLORERS[chainId]?.name;
}

export function addressUrl(chainId: number, value: string): string | undefined {
  const explorer = EXPLORERS[chainId];
  return explorer === undefined ? undefined : `${explorer.base}/address/${value}`;
}

export function txUrl(chainId: number, hash: string): string | undefined {
  const explorer = EXPLORERS[chainId];
  return explorer === undefined ? undefined : `${explorer.base}/tx/${hash}`;
}

export function blockUrl(chainId: number, block: string): string | undefined {
  const explorer = EXPLORERS[chainId];
  return explorer === undefined ? undefined : `${explorer.base}/block/${block}`;
}

/**
 * The signed VAA on Wormholescan.
 *
 * Keyed by emitter chain, emitter address and sequence rather than by
 * transaction, because that triple is what identifies the message the
 * coordinator actually consumed — the transaction that emitted it is a
 * different fact.
 */
export function vaaUrl(wormholeChainId: number, emitter: string, sequence: string): string {
  const padded = emitter.replace(/^0x/, '').padStart(64, '0');
  return `https://wormholescan.io/#/tx/${String(wormholeChainId)}/${padded}/${sequence}?network=Testnet`;
}

import type { Hex } from 'viem';

/**
 * Bounded, gap-honest log scanning.
 *
 * Two things went wrong in this repository's first attempt at reading logs, and
 * both are structural rather than incidental.
 *
 * **A fixed range does not survive contact with a public endpoint.** The first
 * verifier asked for 9,000 blocks at a time. Base Sepolia caps `eth_getLogs`
 * at roughly a thousand and Monad Testnet at roughly a hundred, so most requests
 * failed. The fix is not a smaller constant — a constant is a guess about
 * somebody else's configuration. It is halving on refusal and remembering what
 * worked.
 *
 * **A range that could not be read is not a range with no events.** Those
 * failures were logged as warnings and the scan continued, so the verifier
 * reported "no messages found" for a settlement whose messages were simply
 * outside what it had managed to look at, and certified a terminal state having
 * read one message of three.
 *
 * So a gap is a first-class result here. `scanRange` returns what it read *and*
 * what it could not, the cursor never advances past a gap, and the caller
 * decides — the indexer records the gap and stops advancing, the verifier fails
 * the run. Neither is allowed to treat it as silence.
 */

export interface LogFilter {
  readonly chainId: number;
  readonly addresses: readonly Hex[];
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}

export interface RawLog {
  readonly address: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly transactionHash: Hex;
  readonly logIndex: number;
  readonly topics: readonly Hex[];
  readonly data: Hex;
}

export interface Gap {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly reason: string;
}

export interface ScanResult {
  readonly logs: readonly RawLog[];
  /** Never empty-and-ignored. A caller that discards this is the original bug. */
  readonly gaps: readonly Gap[];
  /** The largest window that actually succeeded, to seed the next scan. */
  readonly effectiveWindow: bigint;
}

export interface LogReader {
  getLogs(filter: {
    chainId: number;
    addresses: readonly Hex[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly RawLog[]>;
}

/** Below this, halving further is not going to help and the endpoint is the problem. */
const MINIMUM_WINDOW = 8n;

export interface ScanOptions {
  /** Where to start. Halved on refusal, so an optimistic value costs one retry. */
  readonly window?: bigint;
  readonly onProgress?: (scanned: bigint, total: bigint) => void;
}

/**
 * Reads a block range in windows, halving on refusal.
 *
 * Every sub-range ends in exactly one of two places: its logs are in the result,
 * or its bounds are in `gaps`. There is no third outcome and no silent one.
 */
export async function scanRange(
  reader: LogReader,
  filter: LogFilter,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const logs: RawLog[] = [];
  const gaps: Gap[] = [];

  let window = options.window ?? 1000n;
  let effectiveWindow = MINIMUM_WINDOW;
  let cursor = filter.fromBlock;

  while (cursor <= filter.toBlock) {
    const upper = min(cursor + window - 1n, filter.toBlock);

    try {
      const found = await reader.getLogs({
        chainId: filter.chainId,
        addresses: filter.addresses,
        fromBlock: cursor,
        toBlock: upper,
      });
      logs.push(...found);
      if (upper - cursor + 1n > effectiveWindow) effectiveWindow = upper - cursor + 1n;
      cursor = upper + 1n;
      options.onProgress?.(cursor - filter.fromBlock, filter.toBlock - filter.fromBlock + 1n);
      continue;
    } catch (error) {
      if (window > MINIMUM_WINDOW) {
        // The endpoint's limit is its own business and it does not publish it.
        // Halving finds it in a handful of requests and the result is reused.
        window = max(window / 2n, MINIMUM_WINDOW);
        continue;
      }

      // At the floor and still refused. This range is unread, and saying so is
      // the whole point of this function.
      gaps.push({ fromBlock: cursor, toBlock: upper, reason: messageOf(error) });
      cursor = upper + 1n;
    }
  }

  return { logs, gaps, effectiveWindow };
}

/**
 * How far behind the head a chain's cursor stays.
 *
 * Not a guess about finality — the settlement layer's finality requirement is
 * FINALIZED and is enforced on the Wormhole message, not here. This is only
 * about how deep a reorg the *projection* should tolerate without having to
 * retract rows. Base Sepolia reorgs shallowly and Monad Testnet is a fast chain
 * with short forks, so both are small and both are stated rather than shared.
 */
export const CONFIRMATIONS: Readonly<Record<number, number>> = Object.freeze({
  84_532: 12,
  10_143: 24,
});

export function confirmationsFor(chainId: number): number {
  const known = CONFIRMATIONS[chainId];
  if (known === undefined) {
    // An unknown chain gets the most conservative value in the table rather than
    // a default that happens to be small.
    return Math.max(...Object.values(CONFIRMATIONS));
  }
  return known;
}

/**
 * Whether the chain still agrees with what was indexed.
 *
 * A cursor stores the hash of the last block it scanned, not just its height.
 * If the chain now reports a different hash at that height, the fork the
 * indexer was following is gone and everything from there is suspect.
 *
 * Returns the height to rewind to: the last block whose hash still matches, or
 * the start of the search if none does.
 */
export async function findReorgDepth(
  reader: { getBlockHash(chainId: number, blockNumber: bigint): Promise<Hex | undefined> },
  chainId: number,
  known: readonly { blockNumber: bigint; blockHash: Hex }[],
): Promise<bigint | undefined> {
  // Newest first: a reorg is almost always shallow, so the first comparison
  // usually settles it.
  const descending = [...known].sort((a, b) => (a.blockNumber > b.blockNumber ? -1 : 1));

  for (const candidate of descending) {
    const live = await reader.getBlockHash(chainId, candidate.blockNumber);
    if (live === undefined) continue;
    if (live.toLowerCase() === candidate.blockHash.toLowerCase()) {
      // This block still exists as indexed, so anything above it is what moved.
      return candidate.blockNumber;
    }
  }

  return undefined;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return (error.message.split('\n')[0] ?? error.message).slice(0, 300);
  return String(error).slice(0, 300);
}

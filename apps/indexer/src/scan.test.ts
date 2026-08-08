import { describe, expect, it } from 'vitest';

import type { Hex } from 'viem';

import {
  confirmationsFor,
  findReorgDepth,
  scanRange,
  type LogReader,
  type RawLog,
} from './scan.js';

/**
 * The two failures this module was written against.
 *
 * A fixed 9,000-block window against endpoints that cap at a thousand and a
 * hundred, and unreadable ranges downgraded to warnings so a scan that read a
 * third of the history reported no gaps. The second one certified a terminal
 * settlement state having seen one message of three.
 */

const ADDRESS = '0x0AEBe99A17796325Da45E49Ef3Ba8BD13bbE5c86' as Hex;

function log(blockNumber: bigint, logIndex: number): RawLog {
  return {
    address: ADDRESS,
    blockNumber,
    blockHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as Hex,
    transactionHash: `0x${'ab'.repeat(32)}` as Hex,
    logIndex,
    topics: [`0x${'cd'.repeat(32)}` as Hex],
    data: '0x',
  };
}

/** An endpoint that refuses any range wider than `cap`, like the real ones. */
function cappedReader(cap: bigint, events: readonly RawLog[] = []): LogReader & { calls: number } {
  const reader = {
    calls: 0,
    getLogs: async (filter: { fromBlock: bigint; toBlock: bigint }) => {
      reader.calls += 1;
      const width = filter.toBlock - filter.fromBlock + 1n;
      if (width > cap) {
        throw new Error(`eth_getLogs: block range too large (${String(width)} > ${String(cap)})`);
      }
      return events.filter(
        (event) => event.blockNumber >= filter.fromBlock && event.blockNumber <= filter.toBlock,
      );
    },
  };
  return reader;
}

describe('scanRange', () => {
  it('finds the endpoint limit by halving rather than by being told it', async () => {
    // #given Monad Testnet's roughly hundred-block cap
    const reader = cappedReader(100n, [log(150n, 0), log(920n, 1)]);

    // #when a thousand-block window is attempted anyway
    const result = await scanRange(
      reader,
      { chainId: 10_143, addresses: [ADDRESS], fromBlock: 1n, toBlock: 1000n },
      { window: 1024n },
    );

    // #then everything was read, nothing was skipped, and the window that
    //       worked is reported so the next scan starts there
    expect(result.gaps).toEqual([]);
    expect(result.logs.map((entry) => entry.blockNumber)).toEqual([150n, 920n]);
    expect(result.effectiveWindow).toBeLessThanOrEqual(100n);
    expect(result.effectiveWindow).toBeGreaterThan(0n);
  });

  it('covers the whole range exactly once', async () => {
    const events = Array.from({ length: 40 }, (_, i) => log(BigInt(i * 25 + 1), i));
    const result = await scanRange(cappedReader(64n, events), {
      chainId: 84_532,
      addresses: [ADDRESS],
      fromBlock: 1n,
      toBlock: 1000n,
    });

    expect(result.gaps).toEqual([]);
    expect(result.logs).toHaveLength(40);
    // Exactly once: a window that overlapped would double-count, and the
    // indexer's idempotency key would hide it.
    expect(new Set(result.logs.map((entry) => entry.blockNumber)).size).toBe(40);
  });

  /**
   * The failure that mattered. An endpoint refusing even the smallest window
   * must produce a gap, not silence — and the earlier code logged a warning and
   * carried on, which is how "no messages found" came to mean "I could not
   * look".
   */
  it('reports an unreadable range as a gap rather than as no events', async () => {
    const reader: LogReader = {
      getLogs: async () => {
        throw new Error('HTTP 503 from the endpoint');
      },
    };

    const result = await scanRange(reader, {
      chainId: 10_143,
      addresses: [ADDRESS],
      fromBlock: 100n,
      toBlock: 200n,
    });

    expect(result.logs).toEqual([]);
    expect(result.gaps.length).toBeGreaterThan(0);
    // The bounds, so a retry knows what to retry and a report knows what was
    // never seen.
    expect(result.gaps[0]?.fromBlock).toBe(100n);
    expect(result.gaps.at(-1)?.toBlock).toBe(200n);
    expect(result.gaps[0]?.reason).toContain('503');
  });

  it('keeps reading past a gap instead of abandoning the scan', async () => {
    // #given an endpoint that refuses one specific window and answers elsewhere
    const events = [log(10n, 0), log(500n, 1)];
    const reader: LogReader = {
      getLogs: async (filter) => {
        if (filter.fromBlock <= 260n && filter.toBlock >= 250n) {
          throw new Error('transient upstream failure');
        }
        return events.filter(
          (event) => event.blockNumber >= filter.fromBlock && event.blockNumber <= filter.toBlock,
        );
      },
    };

    const result = await scanRange(
      reader,
      { chainId: 84_532, addresses: [ADDRESS], fromBlock: 1n, toBlock: 600n },
      { window: 8n },
    );

    // #then both readable events are present *and* the hole is declared. A scan
    //       that stopped at the first failure would lose the second event; one
    //       that continued quietly would lose the hole.
    expect(result.logs.map((entry) => entry.blockNumber)).toEqual([10n, 500n]);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it('reports progress against the total it was asked for', async () => {
    const seen: bigint[] = [];
    await scanRange(
      cappedReader(50n),
      { chainId: 84_532, addresses: [ADDRESS], fromBlock: 1n, toBlock: 200n },
      { window: 50n, onProgress: (scanned) => seen.push(scanned) },
    );
    expect(seen.at(-1)).toBe(200n);
  });
});

describe('confirmations', () => {
  it('states a depth per chain rather than sharing one', () => {
    expect(confirmationsFor(84_532)).toBeGreaterThan(0);
    expect(confirmationsFor(10_143)).toBeGreaterThan(0);
    expect(confirmationsFor(84_532)).not.toBe(confirmationsFor(10_143));
  });

  it('gives an unknown chain the most conservative depth, not the smallest', () => {
    const unknown = confirmationsFor(999_999);
    expect(unknown).toBe(Math.max(confirmationsFor(84_532), confirmationsFor(10_143)));
  });
});

describe('findReorgDepth', () => {
  const known = [
    { blockNumber: 100n, blockHash: `0x${'11'.repeat(32)}` as Hex },
    { blockNumber: 101n, blockHash: `0x${'22'.repeat(32)}` as Hex },
    { blockNumber: 102n, blockHash: `0x${'33'.repeat(32)}` as Hex },
  ];

  it('returns the head when the chain still agrees', async () => {
    const reader = {
      getBlockHash: async (_chainId: number, blockNumber: bigint) =>
        known.find((entry) => entry.blockNumber === blockNumber)?.blockHash,
    };
    expect(await findReorgDepth(reader, 84_532, known)).toBe(102n);
  });

  it('finds the last block that still matches after a shallow reorg', async () => {
    // #given 102 was replaced but 101 survived
    const reader = {
      getBlockHash: async (_chainId: number, blockNumber: bigint) =>
        blockNumber === 102n
          ? (`0x${'ff'.repeat(32)}` as Hex)
          : known.find((entry) => entry.blockNumber === blockNumber)?.blockHash,
    };
    expect(await findReorgDepth(reader, 84_532, known)).toBe(101n);
  });

  it('reports that nothing matches rather than guessing a depth', async () => {
    const reader = {
      getBlockHash: async () => `0x${'ee'.repeat(32)}` as Hex,
    };
    // `undefined` sends the caller further back rather than letting it resume
    // on a fork the chain has forgotten.
    expect(await findReorgDepth(reader, 84_532, known)).toBeUndefined();
  });
});

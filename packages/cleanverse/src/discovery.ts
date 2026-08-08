import type { DepositAToken } from './schemas.js';

/**
 * A-Token chain attribution. PRD 2.4.
 *
 * `query_deposit_atoken_list` accepts a `chain` argument and ignores it. The
 * live sandbox returns every token it knows about, across every chain, and no
 * entry carries a chain field. Observed on 2026-08-07: 34 entries, 26 unique
 * EVM A-Tokens, two Solana-style, and only two of the EVM tokens deployed on
 * Monad Testnet.
 *
 * PRD 2.4 requires that deployment fail if the selected cash token is not
 * returned by the sandbox API, and CLAUDE.md forbids hardcoding the address. The
 * response alone cannot satisfy both, because it cannot say which chain a token
 * is on.
 *
 * So attribution is resolved against chain state: a token is on a chain when
 * that chain's RPC reports bytecode at its address. That is evidence rather than
 * inference, and it fails closed when an RPC is unreachable.
 */

export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value);
}

/** Reads deployed bytecode. Returns the `0x`-prefixed code at an address. */
export type CodeReader = (address: string) => Promise<string>;

export interface AttributedAToken {
  /**
   * The EVM chain the bytecode was found on.
   *
   * Carried on the result rather than left implicit in the caller's head,
   * because two chains can hold the same twenty bytes and this deployment
   * actually does: `0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE` is the
   * coordinator on Monad and the asset adapter on Base. An attribution result
   * that says only "this address has code" is true of both and identifies
   * neither.
   */
  readonly chainId: number;
  readonly aTokenAddress: `0x${string}`;
  readonly symbol: string;
  readonly decimals: number;
  readonly accessCoreAddress: string;
  readonly aPassAddress: string;
  /** Every origin token that maps to this A-Token. */
  readonly originTokens: readonly { address: string; symbol: string; decimals: number }[];
}

/**
 * Returns the A-Tokens from a discovery response that are deployed on the chain
 * `readCode` points at.
 *
 * Non-EVM entries are dropped before any RPC call: a base58 address is not a
 * malformed EVM address, it belongs to a chain this function was not asked
 * about.
 *
 * Entries are deduplicated by A-Token address, because the sandbox maps several
 * origin tokens onto the same A-Token and each mapping arrives as its own entry.
 * The key is safe here and only here: every candidate in one call is attributed
 * against one `readCode`, so the map never spans two chains. `chainId` is
 * required so the *result* carries what the map could assume, and two calls'
 * results can be merged without conflating an address that exists on both.
 */
export async function aTokensDeployedOn(
  tokens: readonly DepositAToken[],
  readCode: CodeReader,
  chainId: number,
): Promise<AttributedAToken[]> {
  const byAToken = new Map<string, AttributedAToken>();

  for (const entry of tokens) {
    if (!isEvmAddress(entry.atoken.address)) continue;

    const address = entry.atoken.address as `0x${string}`;
    const existing = byAToken.get(address.toLowerCase());
    const origin = {
      address: entry.origin_token.address,
      symbol: entry.origin_token.symbol,
      decimals: entry.origin_token.decimals,
    };

    if (existing === undefined) {
      byAToken.set(address.toLowerCase(), {
        chainId,
        aTokenAddress: address,
        symbol: entry.atoken.symbol,
        decimals: entry.atoken.decimals,
        accessCoreAddress: entry.accesscore_address,
        aPassAddress: entry.apass_address,
        originTokens: [origin],
      });
    } else {
      byAToken.set(address.toLowerCase(), {
        ...existing,
        originTokens: [...existing.originTokens, origin],
      });
    }
  }

  const candidates = [...byAToken.values()];
  const deployed = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        return (await readCode(candidate.aTokenAddress)).length > 2;
      } catch {
        // An unreachable RPC is not evidence of absence, but it is not evidence
        // of presence either. Fail closed.
        return false;
      }
    }),
  );

  return candidates.filter((_, index) => deployed[index] === true);
}

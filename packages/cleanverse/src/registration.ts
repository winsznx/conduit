import { CleanverseApiError } from './errors.js';
import {
  applyStatusDataSchema,
  isApplyStatusTerminal,
  isRegistrationComplete,
  registerATokenDataSchema,
} from './schemas.js';

import type { CleanverseClient } from './client.js';
import type { z } from 'zod';

/**
 * Custom CVA registration. CCP guide Method B, v1.1 override section 6.
 *
 * Registering a contract we deployed ourselves is the step that turns
 * `ConduitRWACVA` from an ERC-20 that happens to call a policy into an asset the
 * policy will actually authorise. Until it completes, the policy answers
 * `TokenNotRegistered()` and every transfer reverts.
 *
 * The signing string is the part worth being pedantic about. Cleanverse
 * validates an EIP-191 `personal_sign` over `lowercase(chain + atoken_address)`
 * with no separator, and the chain is the Cleanverse slug (`base`), not the
 * network name (`base-sepolia`). Getting either wrong produces a signature that
 * recovers to the wrong address, and the gateway reports "chain signature
 * invalid" without saying which half was wrong.
 */

export interface RegisterATokenRequest {
  /** Cleanverse chain slug, e.g. `base`. Never a network name like `base-sepolia`. */
  readonly chain: string;
  readonly atokenAddress: string;
  /** EIP-191 personal_sign over `registrationMessage(chain, atokenAddress)`. */
  readonly ownerSignature: string;
  /**
   * Required. The newer CCP PDF marks it optional and API V5.6 marks it
   * required; the stricter contract is the safe one to satisfy.
   */
  readonly atokenIcon: string;
  readonly callbackUrl?: string;
}

/**
 * The exact bytes the owner signs.
 *
 * Lowercased as a whole rather than per-part, because a checksummed address
 * would recover to a different signer and the failure surfaces only as a
 * rejected application.
 */
export function registrationMessage(chain: string, atokenAddress: string): string {
  return `${chain}${atokenAddress}`.toLowerCase();
}

export type RegisterATokenData = z.infer<typeof registerATokenDataSchema>;
export type ApplyStatusData = z.infer<typeof applyStatusDataSchema>;

/**
 * Submits the registration application.
 *
 * A `0000` response means the application was accepted for review, not that the
 * CVA is registered. The caller must poll `queryApplyStatus` until `ISSUED`.
 */
export async function registerAToken(
  client: CleanverseClient,
  request: RegisterATokenRequest,
): Promise<RegisterATokenData> {
  const payload: Record<string, string> = {
    chain: request.chain,
    atoken_address: request.atokenAddress,
    owner_signature: request.ownerSignature,
    atoken_icon: request.atokenIcon,
  };
  if (request.callbackUrl !== undefined) payload['callback_url'] = request.callbackUrl;

  const result = await client.call('registerAToken', payload, registerATokenDataSchema);
  return result.data;
}

export interface RegistrationOutcome {
  readonly requestId: string;
  readonly applyStatus: string;
  readonly registered: boolean;
  readonly attempts: number;
  readonly data: ApplyStatusData;
}

export interface PollOptions {
  readonly maxAttempts?: number;
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Polls until the application reaches a terminal state.
 *
 * `ISSUED` is the only outcome that counts as registered. `PENDING` and
 * `APPROVED` are explicitly not success: an approved-but-not-issued CVA still
 * fails `canTransfer`, and reporting it as done would put a false capability in
 * the audit package.
 *
 * Reads may retry under PRD 9.4, and this is a read, so exhausting the attempt
 * budget returns the last observed state rather than throwing. A caller that
 * needs certainty checks `registered`.
 */
export async function pollApplyStatus(
  client: CleanverseClient,
  requestId: string,
  options: PollOptions = {},
): Promise<RegistrationOutcome> {
  const maxAttempts = options.maxAttempts ?? 30;
  const intervalMs = options.intervalMs ?? 5_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let last: ApplyStatusData = { applyStatus: 'UNKNOWN' };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      last = await client.getJson(
        `/atoken/query_apply_status/${encodeURIComponent(requestId)}`,
        applyStatusDataSchema,
      );
    } catch (error) {
      // A business failure here is an answer about the application, not a
      // transport fault, so it ends the poll rather than burning retries.
      if (error instanceof CleanverseApiError) {
        return {
          requestId,
          applyStatus: 'ERROR',
          registered: false,
          attempts: attempt,
          data: { applyStatus: 'ERROR', reason: error.apiMessage },
        };
      }
      throw error;
    }

    if (isApplyStatusTerminal(last.applyStatus)) {
      return {
        requestId,
        applyStatus: last.applyStatus,
        registered: isRegistrationComplete(last.applyStatus),
        attempts: attempt,
        data: last,
      };
    }

    if (attempt < maxAttempts) await sleep(intervalMs);
  }

  return {
    requestId,
    applyStatus: last.applyStatus,
    registered: false,
    attempts: maxAttempts,
    data: last,
  };
}

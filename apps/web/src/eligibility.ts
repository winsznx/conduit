/**
 * Server-side eligibility. The browser never learns how this is done.
 *
 * Cleanverse authenticates with an API id and an AES key, and both stay in
 * Worker secrets. The browser sends a chain and an address and receives a typed
 * verdict — never a key, never a raw Cleanverse body, never anything that
 * identifies a person.
 *
 * ## The distinction this file exists to preserve
 *
 * A refusal is a decision an authority made. An outage is the absence of a
 * decision. Collapsing the second into the first tells a user they are barred
 * when in fact nobody was asked, and CLAUDE.md makes that an invariant:
 * "A Cleanverse HTTP 200 is not automatically business success", and
 * "`validator/verify` with `valid:false` is non-eligible, not an API failure."
 *
 * `queryEligibility` already enforces the hard half of this — it throws on
 * transport, schema and gateway errors instead of returning `eligible: false`.
 * This module's job is to keep that distinction intact all the way to the wire,
 * so `UNAVAILABLE` can never be rendered as red.
 */

import { CleanverseClient, createCipher } from '@conduit-protocol/cleanverse';
import {
  CleanverseApiError,
  CleanverseSchemaError,
  CleanverseTransportError,
  POLICY_REFUSAL_MARKERS,
  policyRefusalIn,
  queryEligibility,
  VerifyApassCode,
} from '@conduit-protocol/cleanverse';
import type { Address } from 'viem';

import type { Env } from './data.js';

/** Every answer this endpoint can give. Nothing collapses into anything else. */
export type EligibilityStatus =
  'ELIGIBLE' | 'INELIGIBLE' | 'NO_APASS' | 'POLICY_REFUSAL' | 'UNAVAILABLE' | 'INVALID_REQUEST';

export interface EligibilityResult {
  readonly status: EligibilityStatus;
  readonly chain: string;
  readonly chainId: number;
  readonly subject: string;
  readonly asset: string;
  readonly assetSymbol: string;
  readonly checkedAt: string;
  /** Machine-readable why. Never free text a UI has to parse. */
  readonly reason: string;
  /** One line a person can read. Safe to render verbatim. */
  readonly detail: string;
  /** The endpoint's own answer where it is safe to repeat: `code 4`, `TierTooLow`. */
  readonly answer?: string | undefined;
  /** Present only when Cleanverse actually answered. */
  readonly evidenceHash?: string | undefined;
  readonly sources?: readonly { endpoint: string; answer: string }[] | undefined;
}

/** The two assets a participant can be checked against, per chain. */
export interface CheckTarget {
  readonly chain: string;
  readonly chainId: number;
  readonly asset: Address;
  readonly assetSymbol: string;
  /** A registered validator pool, where the chain has one. Monad does; Base does not. */
  readonly pool?: Address;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: string): value is Address {
  return ADDRESS.test(value);
}

async function clientFor(env: Env): Promise<CleanverseClient> {
  const baseUrl = env.CLEANVERSE_BASE_URL;
  const apiId = env.CLEANVERSE_API_ID;
  const apiKeyBase64 = env.CLEANVERSE_API_KEY_BASE64;
  if (!baseUrl || !apiId || !apiKeyBase64) {
    throw new ConfigMissing('Cleanverse credentials are not configured on this deployment');
  }
  return new CleanverseClient({
    baseUrl,
    apiId,
    cipher: await createCipher(apiKeyBase64),
    timeoutMs: Number(env.CLEANVERSE_REQUEST_TIMEOUT_MS ?? '') || 15_000,
    maxReadRetries: 1,
  });
}

class ConfigMissing extends Error {}

/**
 * Asks Cleanverse, and maps the answer without flattening it.
 *
 * The order of the catch arms matters. A policy refusal arrives inside an error
 * envelope, so it is checked *before* the generic API-error arm — otherwise a
 * real refusal would be reported as an outage, which is the same mistake in the
 * opposite direction and just as wrong.
 */
export async function checkEligibility(
  env: Env,
  target: CheckTarget,
  subject: string,
  /** Tests supply a client built on a stub fetch; production never passes this. */
  override?: CleanverseClient,
): Promise<EligibilityResult> {
  const checkedAt = new Date().toISOString();
  const base = {
    chain: target.chain,
    chainId: target.chainId,
    subject,
    asset: target.asset,
    assetSymbol: target.assetSymbol,
    checkedAt,
  };

  if (!isAddress(subject)) {
    return {
      ...base,
      status: 'INVALID_REQUEST',
      reason: 'MALFORMED_ADDRESS',
      detail: 'That is not a 20-byte address.',
    };
  }

  let client: CleanverseClient;
  try {
    client = override ?? (await clientFor(env));
  } catch {
    return {
      ...base,
      status: 'UNAVAILABLE',
      reason: 'NOT_CONFIGURED',
      detail: 'This deployment cannot reach Cleanverse. Your eligibility was not checked.',
    };
  }

  try {
    const decision = await queryEligibility(client, {
      chain: target.chain,
      subject,
      atoken: target.asset,
      poolAddress: target.pool,
    });

    const sources = decision.sources.map((source) => ({
      endpoint: source.endpoint,
      answer: source.answer,
    }));

    if (decision.eligible) {
      return {
        ...base,
        status: 'ELIGIBLE',
        reason: 'ALLOWED',
        detail: 'Cleanverse permits this participant to hold and receive this asset.',
        answer: sources[0]?.answer,
        evidenceHash: decision.evidenceHash,
        sources,
      };
    }

    // Not eligible, and Cleanverse said so. Which kind of no it was matters.
    const refusal = sources.find((source) => source.answer.startsWith('refused by policy'));
    if (refusal !== undefined) {
      const marker = POLICY_REFUSAL_MARKERS.find((name) => refusal.answer.includes(name));
      return {
        ...base,
        status: 'POLICY_REFUSAL',
        reason: marker ?? 'POLICY',
        detail: `The asset's transfer policy refuses this participant${marker === undefined ? '' : ` — ${marker}`}.`,
        answer: refusal.answer,
        evidenceHash: decision.evidenceHash,
        sources,
      };
    }

    // `verify_apass` has four codes and only one of them authorises. The other
    // three are different answers to different questions, and flattening them
    // into "ineligible" would tell a judge with no A-Pass the same thing it
    // tells a holder whose pass is frozen.
    const code = verifyApassCodeIn(sources);
    return { ...base, ...fromApassCode(code), evidenceHash: decision.evidenceHash, sources };
  } catch (error) {
    return unavailable(base, error);
  }
}

/** The numeric `verify_apass` code, from the `code N` answer it is recorded as. */
function verifyApassCodeIn(
  sources: readonly { endpoint: string; answer: string }[],
): number | undefined {
  for (const source of sources) {
    const match = /^code (\d+)$/.exec(source.answer);
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

function fromApassCode(code: number | undefined): {
  status: EligibilityStatus;
  reason: string;
  detail: string;
  answer?: string | undefined;
} {
  const answer = code === undefined ? undefined : `code ${String(code)}`;
  switch (code) {
    case VerifyApassCode.NO_APASS:
      return {
        status: 'NO_APASS',
        reason: 'NO_APASS',
        detail:
          'This wallet holds no A-Pass for this asset. Cleanverse cannot permit a transfer to a participant it does not know.',
        answer,
      };
    case VerifyApassCode.TRANSFER_DISALLOWED:
      return {
        status: 'INELIGIBLE',
        reason: 'TRANSFER_DISALLOWED',
        detail:
          'An A-Pass exists but does not currently permit transfer — it is expired or frozen.',
        answer,
      };
    case VerifyApassCode.ATOKEN_NOT_FOUND:
      // Not a statement about the participant at all: the token was not found,
      // so nobody was asked about anybody.
      return {
        status: 'UNAVAILABLE',
        reason: 'ATOKEN_NOT_FOUND',
        detail:
          'Cleanverse does not recognise this asset, so no eligibility question was answered. This is not a refusal.',
        answer,
      };
    default:
      return {
        status: 'INELIGIBLE',
        reason: 'REFUSED',
        detail: 'Cleanverse does not currently permit this participant to receive this asset.',
        answer,
      };
  }
}

/**
 * Anything that is not a decision.
 *
 * Every branch returns `UNAVAILABLE`. The `reason` says which failure it was so
 * an operator can act on it, and the `detail` says the one thing a user needs
 * to know: nobody refused them.
 */
function unavailable(
  base: Omit<EligibilityResult, 'status' | 'reason' | 'detail'>,
  error: unknown,
): EligibilityResult {
  const notRefused = 'This is a check that did not complete, not a refusal.';

  if (error instanceof CleanverseTransportError) {
    return {
      ...base,
      status: 'UNAVAILABLE',
      reason: 'TRANSPORT',
      detail: `Cleanverse could not be reached. ${notRefused}`,
    };
  }
  if (error instanceof CleanverseSchemaError) {
    return {
      ...base,
      status: 'UNAVAILABLE',
      reason: 'SCHEMA',
      detail: `Cleanverse answered in a shape this build does not recognise. ${notRefused}`,
    };
  }
  if (error instanceof CleanverseApiError) {
    // A refusal marker here would already have been handled as a decision, so
    // reaching this arm means the gateway itself failed.
    const marker = policyRefusalIn(error.apiMessage);
    if (marker !== undefined) {
      return {
        ...base,
        status: 'POLICY_REFUSAL',
        reason: marker,
        detail: `The asset's transfer policy refuses this participant — ${marker}.`,
        answer: `refused by policy: ${marker}`,
      };
    }
    return {
      ...base,
      status: 'UNAVAILABLE',
      reason: `GATEWAY_${error.code}`,
      detail: `Cleanverse returned an error rather than a decision. ${notRefused}`,
    };
  }
  return {
    ...base,
    status: 'UNAVAILABLE',
    reason: 'UNKNOWN',
    detail: `The eligibility check failed for an unrecognised reason. ${notRefused}`,
  };
}

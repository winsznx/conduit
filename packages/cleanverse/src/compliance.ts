import { keccak256, toHex, type Address, type Hex } from 'viem';

import { CleanverseApiError } from './errors.js';
import { validatorVerifyDataSchema } from './schemas.js';

import type { CleanverseClient } from './client.js';

/**
 * The compliance attestation service. PRD FR-006, threat T-07.
 *
 * Turns a real Cleanverse eligibility answer into a signed statement the
 * settlement contracts will accept. It replaces the `bool` that `issueCommit`
 * and both release paths used to take from their caller — a boolean that said a
 * decision existed and nothing about who made it, when, about whom, or on what
 * basis.
 *
 * Four rules, and the first two are the ones worth being pedantic about:
 *
 * **An API failure is never a compliance answer.** A timeout, a 5xx, or a schema
 * mismatch throws. It does not become `eligible: false`, because a refusal is a
 * decision the authority made and an outage is not, and quietly converting one
 * into the other would put a fabricated decision into the audit package.
 *
 * **`valid: false` is a decision, not a failure.** PRD 2.2 is explicit that a
 * Cleanverse `valid: false` is legitimate non-eligibility. It is signed as an
 * explicit refusal, so the settlement's evidence contains the refusal rather
 * than the absence of an approval.
 *
 * **The evidence hash covers the raw response.** `evidenceHash` is the hash the
 * client computed over the raw bytes before redaction, so the audit package can
 * prove the stored record is the one the decision came from. No raw response and
 * no PII goes on chain.
 *
 * **The signing key never enters this module.** The caller supplies a `sign`
 * function, so a KMS, a hardware signer, and a local key are all the same shape
 * here and none of them can be logged from inside this package.
 */

export interface AttestationSubject {
  readonly address: Address;
  /** The registered pool the eligibility question is asked against. */
  readonly poolAddress: Address;
  /** Cleanverse chain slug, e.g. `monad`. Never a network name. */
  readonly chain: string;
}

export interface AttestationRequest {
  readonly settlementId: Hex;
  readonly intentHash: Hex;
  readonly subject: AttestationSubject;
  /**
   * Seconds. Must not exceed the verifying contract's `maxAttestationValidity`,
   * which is immutable in its bytecode; the contract rejects a longer window
   * regardless of what is requested here.
   */
  readonly validitySeconds: number;
}

export interface SignedAttestation {
  readonly settlementId: Hex;
  readonly intentHash: Hex;
  readonly subject: Address;
  readonly eligible: boolean;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly evidenceHash: Hex;
  readonly signature: Hex;
  /** Safe to persist and to show in the audit package. */
  readonly evidence: {
    readonly endpoint: string;
    readonly requestId: string;
    readonly code: string;
    readonly responseHash: Hex;
    readonly redactedBody: unknown;
    readonly reason: string | undefined;
  };
}

export interface AttestationSigner {
  readonly address: Address;
  /** Signs the EIP-712 digest. The key never crosses this boundary. */
  readonly signDigest: (digest: Hex) => Promise<Hex>;
}

export interface AttestationClock {
  readonly now: () => number;
}

/**
 * Asks Cleanverse, then signs what it answered.
 *
 * PRD 9.4 and CLAUDE.md both require commit-time checks to bypass the
 * application cache, which is why this always calls the API rather than reading
 * a stored eligibility. The freshness that matters is the answer's, not the
 * record's.
 */
export async function attestEligibility(
  client: CleanverseClient,
  signer: AttestationSigner,
  request: AttestationRequest,
  hashDigest: (attestation: {
    settlementId: Hex;
    intentHash: Hex;
    subject: Address;
    eligible: boolean;
    issuedAt: bigint;
    expiresAt: bigint;
    evidenceHash: Hex;
  }) => Hex,
  clock: AttestationClock = { now: () => Date.now() },
): Promise<SignedAttestation> {
  const result = await client.call(
    'validatorVerify',
    {
      chain: request.subject.chain,
      contract_address: request.subject.poolAddress,
      user_address: request.subject.address,
    },
    validatorVerifyDataSchema,
  );

  // Reaching here means the envelope was `0000`. A non-ok code has already
  // thrown as a CleanverseApiError and never becomes a signed refusal.
  const issuedAt = BigInt(Math.floor(clock.now() / 1000));
  const attestation = {
    settlementId: request.settlementId,
    intentHash: request.intentHash,
    subject: request.subject.address,
    eligible: result.data.valid,
    issuedAt,
    expiresAt: issuedAt + BigInt(request.validitySeconds),
    evidenceHash: result.responseHash,
  };

  const signature = await signer.signDigest(hashDigest(attestation));

  return {
    ...attestation,
    signature,
    evidence: {
      endpoint: result.path,
      requestId: result.requestId,
      code: result.code,
      responseHash: result.responseHash,
      redactedBody: result.redactedBody,
      reason: result.data.reason,
    },
  };
}

/**
 * Whether a thrown error was a Cleanverse decision or an operational failure.
 *
 * Callers use this to decide whether to retry. Retrying a decision is pointless
 * and retrying it until it changes is the shape of a compliance bypass.
 */
export function isComplianceDecision(error: unknown): boolean {
  return error instanceof CleanverseApiError;
}

/**
 * The evidence hash to use when the authority's answer came from somewhere other
 * than `validator/verify`.
 *
 * @dev Deliberately requires the raw text rather than a parsed object. Hashing a
 *      re-serialized object hashes whatever the serializer produced, and a
 *      record that cannot be proven identical to what arrived is not evidence.
 */
export function evidenceHashOf(rawResponseBody: string): Hex {
  return keccak256(toHex(rawResponseBody));
}

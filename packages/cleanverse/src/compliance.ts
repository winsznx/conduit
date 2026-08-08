import { concatHex, keccak256, toHex, type Address, type Hex } from 'viem';

import { policyRefusalIn, VerifyApassCode } from './codes.js';
import { CleanverseApiError } from './errors.js';
import { validatorVerifyDataSchema, verifyApassDataSchema } from './schemas.js';

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
 * One eligibility answer from one Cleanverse endpoint.
 *
 * Kept separate rather than merged into a boolean, because which endpoint said
 * what is the part an auditor needs and the part a boolean discards.
 */
export interface EligibilitySource {
  readonly endpoint: string;
  readonly requestId: string;
  readonly eligible: boolean;
  /** The endpoint's own answer, verbatim: `code: 4`, `valid: true`. */
  readonly answer: string;
  readonly responseHash: Hex;
  readonly redactedBody: unknown;
}

export interface EligibilityDecision {
  readonly subject: Address;
  readonly chain: string;
  readonly eligible: boolean;
  readonly sources: readonly EligibilitySource[];
  /**
   * keccak256 over the source response hashes, in the order they were asked.
   *
   * The single-source case is *not* the bare response hash. A fixed
   * construction means the on-chain `evidenceHash` always means the same thing,
   * and a verifier recomputing it does not need to know how many endpoints
   * happened to be available for that chain.
   */
  readonly evidenceHash: Hex;
}

/**
 * The commit-time eligibility question, asked of every endpoint that can answer
 * it for this chain.
 *
 * Two endpoints answer it and they are not interchangeable:
 *
 * **`verify_apass`** is asked against the A-Token and answers for any chain the
 * token is issued on. Result code 4 is the only value that permits a transfer;
 * CLAUDE.md states that as an invariant and 1, 2, and 3 are all refusals with
 * different reasons. This is the only source available on the asset chain,
 * because `validator/grant` on Base was refused for this credential and so no
 * Conduit pool is registered there (ASM-037).
 *
 * **`validator/verify`** is asked against a *registered pool*, not a token. On
 * Monad the pool is `CashEscrow`, registered through `ConduitVaultRegistrar`.
 * Asking it about a token address returns `12027 Validator verify returned no
 * data`, which reads as an outage and is a wrong argument — it cost a preflight
 * run to tell those apart.
 *
 * Where both answer, both must say yes. An `AND` is the only safe combination:
 * either endpoint refusing is a refusal, and requiring agreement cannot be
 * weaker than trusting one of them.
 *
 * An API failure from any source throws. It never becomes `eligible: false`,
 * because a refusal is a decision the authority made and an outage is not.
 */
export async function queryEligibility(
  client: CleanverseClient,
  request: {
    readonly chain: string;
    readonly subject: Address;
    /** The A-Token the transfer is in. `verify_apass` is asked against this. */
    readonly atoken: Address;
    /** A registered validator pool, when this chain has one. */
    readonly poolAddress?: Address | undefined;
  },
): Promise<EligibilityDecision> {
  const sources: EligibilitySource[] = [];

  try {
    const apass = await client.call(
      'verifyApass',
      { chain: request.chain, address: request.subject, atoken: request.atoken },
      verifyApassDataSchema,
    );
    sources.push({
      endpoint: apass.path,
      requestId: apass.requestId,
      eligible: apass.data.code === VerifyApassCode.ALLOWED,
      answer: `code ${String(apass.data.code)}`,
      responseHash: apass.responseHash,
      redactedBody: apass.redactedBody,
    });
  } catch (error) {
    // A policy refusal arrives through the error envelope. It is a decision and
    // is recorded as one; anything else is an outage and still throws.
    if (!(error instanceof CleanverseApiError)) throw error;
    const marker = policyRefusalIn(error.apiMessage);
    if (marker === undefined) throw error;
    sources.push({
      endpoint: '/verify_apass',
      requestId: error.requestId ?? 'unknown',
      eligible: false,
      answer: `refused by policy: ${marker}`,
      responseHash: keccak256(toHex(error.apiMessage)),
      redactedBody: { code: error.code, refusal: marker },
    });
  }

  if (request.poolAddress !== undefined) {
    const validator = await client.call(
      'validatorVerify',
      {
        chain: request.chain,
        contract_address: request.poolAddress,
        user_address: request.subject,
      },
      validatorVerifyDataSchema,
    );
    sources.push({
      endpoint: validator.path,
      requestId: validator.requestId,
      eligible: validator.data.valid,
      answer: `valid ${String(validator.data.valid)}`,
      responseHash: validator.responseHash,
      redactedBody: validator.redactedBody,
    });
  }

  return {
    subject: request.subject,
    chain: request.chain,
    eligible: sources.every((source) => source.eligible),
    sources,
    evidenceHash: keccak256(concatHex(sources.map((source) => source.responseHash))),
  };
}

/**
 * Signs a decision that has already been obtained.
 *
 * Split from `attestEligibility` so the caller controls *when* the question is
 * asked. On a cross-chain settlement that matters: the commit proofs have to be
 * minted after the source chain reaches finality, because the contract's
 * `maxAttestationValidity` is shorter than the wait and an earlier answer is
 * expired by the time it would be presented.
 */
export async function attestDecision(
  signer: AttestationSigner,
  request: Omit<AttestationRequest, 'subject'> & { readonly subject: Address },
  decision: EligibilityDecision,
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
  const issuedAt = BigInt(Math.floor(clock.now() / 1000));
  const attestation = {
    settlementId: request.settlementId,
    intentHash: request.intentHash,
    subject: request.subject,
    eligible: decision.eligible,
    issuedAt,
    expiresAt: issuedAt + BigInt(request.validitySeconds),
    evidenceHash: decision.evidenceHash,
  };

  const signature = await signer.signDigest(hashDigest(attestation));
  const last = decision.sources[decision.sources.length - 1];

  return {
    ...attestation,
    signature,
    evidence: {
      endpoint: decision.sources.map((source) => source.endpoint).join(' + '),
      requestId: decision.sources.map((source) => source.requestId).join(' '),
      code: decision.sources.map((source) => source.answer).join(' '),
      responseHash: decision.evidenceHash,
      redactedBody: decision.sources.map((source) => source.redactedBody),
      reason: last === undefined ? undefined : last.answer,
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

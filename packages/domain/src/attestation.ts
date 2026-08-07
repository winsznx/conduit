import { hashTypedData, type Address, type Hex, type TypedDataDomain } from 'viem';

/**
 * Compliance attestation hashing. PRD FR-006.
 *
 * The off-chain half of `contracts/src/libraries/ComplianceAttestationLib.sol`.
 * Written independently and cross-checked against fixed vectors in
 * `attestation.test.ts` and `ComplianceAttestation.t.sol`, because a divergence
 * here produces a signature the service emits and the contract rejects — or, far
 * worse, one the contract accepts for a subject the signer never approved.
 *
 * This replaces a `bool` that used to be passed to `issueCommit` and to both
 * release paths. A boolean says a decision was made and nothing about who made
 * it, when, about whom, or on what evidence, so any caller could assert
 * eligibility and the contract had no basis to disagree. CLAUDE.md states the
 * rule plainly: application database state never authorizes value movement.
 */

export const COMPLIANCE_ATTESTATION_TYPE = {
  ComplianceAttestation: [
    { name: 'settlementId', type: 'bytes32' },
    { name: 'intentHash', type: 'bytes32' },
    { name: 'subject', type: 'address' },
    { name: 'eligible', type: 'bool' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'evidenceHash', type: 'bytes32' },
  ],
} as const;

export interface ComplianceAttestation {
  readonly settlementId: Hex;
  readonly intentHash: Hex;
  /** The party being attested, not the signer. */
  readonly subject: Address;
  /**
   * A signed refusal is a first-class outcome. `validator/verify` answering
   * `valid: false` is a legitimate non-eligibility decision under PRD 2.2, and
   * it is signed as explicitly as an approval so the audit package records the
   * refusal rather than an absence.
   */
  readonly eligible: boolean;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  /**
   * keccak256 of the normalized Cleanverse response behind the decision. Never
   * the response: PRD forbids raw PII on chain, and a hash is enough to prove
   * the off-chain record was not swapped afterwards.
   */
  readonly evidenceHash: Hex;
}

/**
 * The domain a verifying contract expects.
 *
 * `verifyingContract` is the contract that will check the signature, so an
 * attestation minted for the Monad coordinator is not valid at the Base adapter
 * even with the same signer, subject, and settlement. Getting this wrong is
 * indistinguishable from a wrong signer at the call site, which is why it takes
 * the address explicitly rather than defaulting to anything.
 */
export interface AttestationDomain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Address;
}

export function domainOf(domain: AttestationDomain): TypedDataDomain {
  return {
    name: domain.name,
    version: domain.version,
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract,
  };
}

export function hashComplianceAttestation(
  domain: AttestationDomain,
  attestation: ComplianceAttestation,
): Hex {
  return hashTypedData({
    domain: domainOf(domain),
    types: COMPLIANCE_ATTESTATION_TYPE,
    primaryType: 'ComplianceAttestation',
    message: {
      settlementId: attestation.settlementId,
      intentHash: attestation.intentHash,
      subject: attestation.subject,
      eligible: attestation.eligible,
      issuedAt: attestation.issuedAt,
      expiresAt: attestation.expiresAt,
      evidenceHash: attestation.evidenceHash,
    },
  });
}

export const AttestationProblem = {
  WINDOW_INVERTED: 'WINDOW_INVERTED',
  WINDOW_TOO_LONG: 'WINDOW_TOO_LONG',
  NOT_YET_VALID: 'NOT_YET_VALID',
  EXPIRED: 'EXPIRED',
  WRONG_SETTLEMENT: 'WRONG_SETTLEMENT',
  WRONG_INTENT: 'WRONG_INTENT',
} as const;

export type AttestationProblemValue = (typeof AttestationProblem)[keyof typeof AttestationProblem];

export interface AttestationBinding {
  readonly settlementId: Hex;
  readonly intentHash: Hex;
  readonly maxValidity: bigint;
  readonly now: bigint;
}

/**
 * The same checks the contract performs, run before a signature is produced.
 *
 * Not a substitute for the on-chain check, and not trusted by it. It exists so a
 * service does not sign an attestation that is guaranteed to be rejected, which
 * is a wasted signature and a confusing failure at the settlement rather than at
 * the point of the mistake.
 */
export function checkAttestation(
  attestation: ComplianceAttestation,
  binding: AttestationBinding,
): readonly AttestationProblemValue[] {
  const problems: AttestationProblemValue[] = [];

  if (attestation.settlementId !== binding.settlementId) {
    problems.push(AttestationProblem.WRONG_SETTLEMENT);
  }
  if (attestation.intentHash !== binding.intentHash) {
    problems.push(AttestationProblem.WRONG_INTENT);
  }
  if (attestation.expiresAt < attestation.issuedAt) {
    problems.push(AttestationProblem.WINDOW_INVERTED);
  } else if (attestation.expiresAt - attestation.issuedAt > binding.maxValidity) {
    problems.push(AttestationProblem.WINDOW_TOO_LONG);
  }
  if (binding.now > attestation.expiresAt) {
    problems.push(AttestationProblem.EXPIRED);
  }
  if (binding.now < attestation.issuedAt) {
    problems.push(AttestationProblem.NOT_YET_VALID);
  }

  return problems;
}

import { encodeAbiParameters, hashDomain, hashTypedData, keccak256, toHex } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  AttestationProblem,
  checkAttestation,
  COMPLIANCE_ATTESTATION_TYPE,
  hashComplianceAttestation,
  type AttestationDomain,
  type ComplianceAttestation,
} from './attestation.js';

/**
 * The fixed vector below is the whole point of this file.
 *
 * `ComplianceAttestation.t.sol` asserts the identical digest from the Solidity
 * side. Two independent implementations agreeing on a constant is evidence; one
 * implementation agreeing with itself is not, and a divergence here means the
 * service signs something the contract will not accept.
 */
const DOMAIN: AttestationDomain = {
  name: 'Conduit',
  version: '1',
  chainId: 10143,
  verifyingContract: '0x1491A25Fc93778ECcb69BCec96495c6f12c686d1',
};

const ATTESTATION: ComplianceAttestation = {
  settlementId: '0x1111111111111111111111111111111111111111111111111111111111111111',
  intentHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
  subject: '0x83C130ed9fb92830F09ea2b30E49009EF03065Bb',
  eligible: true,
  issuedAt: 1_786_000_000n,
  expiresAt: 1_786_000_300n,
  evidenceHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
};

describe('compliance attestation hashing (PRD FR-006)', () => {
  it('produces a stable digest', () => {
    expect(hashComplianceAttestation(DOMAIN, ATTESTATION)).toMatchInlineSnapshot(
      `"0x4a31393a4953e7e12fa930c32075640385d3d73a7e1753962432db4c7ed32063"`,
    );
  });

  it('binds the verifying contract', () => {
    // An attestation for the Monad coordinator must not verify at the Base
    // adapter. Same signer, same subject, same settlement, different contract.
    const elsewhere = hashComplianceAttestation(
      { ...DOMAIN, verifyingContract: '0xC0A9Eb5F9D1fd0D4264564B1C7A1ed69946E3170' },
      ATTESTATION,
    );
    expect(elsewhere).not.toBe(hashComplianceAttestation(DOMAIN, ATTESTATION));
  });

  it('binds the chain', () => {
    const otherChain = hashComplianceAttestation({ ...DOMAIN, chainId: 84_532 }, ATTESTATION);
    expect(otherChain).not.toBe(hashComplianceAttestation(DOMAIN, ATTESTATION));
  });

  it('distinguishes an approval from a refusal', () => {
    // If these collided, a signed refusal would authorize a release.
    const refusal = hashComplianceAttestation(DOMAIN, { ...ATTESTATION, eligible: false });
    expect(refusal).not.toBe(hashComplianceAttestation(DOMAIN, ATTESTATION));
  });

  it.each([
    ['settlementId', { settlementId: '0x' + '99'.repeat(32) }],
    ['intentHash', { intentHash: '0x' + '99'.repeat(32) }],
    ['subject', { subject: '0x000000000000000000000000000000000000dEaD' }],
    ['issuedAt', { issuedAt: 1_786_000_001n }],
    ['expiresAt', { expiresAt: 1_786_000_301n }],
    ['evidenceHash', { evidenceHash: '0x' + '99'.repeat(32) }],
  ])('changes when %s changes', (_field, override) => {
    const changed = hashComplianceAttestation(DOMAIN, {
      ...ATTESTATION,
      ...(override as Partial<ComplianceAttestation>),
    });
    expect(changed).not.toBe(hashComplianceAttestation(DOMAIN, ATTESTATION));
  });
});

describe('the domain that ended a live settlement', () => {
  /**
   * Attempt 3 called `signTypedData` with `domain: undefined` and kept a
   * catch-based fallback that would have built the correct digest. The first
   * path did not throw. viem accepts an absent domain, builds an EIP-712 domain
   * with no fields at all, and signs over the resulting separator — so the
   * fallback never ran and the signature covered a domain no contract uses.
   *
   * The coordinator recovered an unauthorised address and refused, which is the
   * protocol behaving correctly. What is pinned here is that the two digests
   * differ, so the mistake cannot be silent again: anything signing an
   * attestation goes through `hashComplianceAttestation` with an explicit
   * domain, and there is no path that treats a missing one as acceptable.
   */
  it('an absent domain is a different digest, not an error', () => {
    const withoutDomain = hashTypedData({
      types: COMPLIANCE_ATTESTATION_TYPE,
      primaryType: 'ComplianceAttestation',
      message: { ...ATTESTATION },
    });

    expect(withoutDomain).not.toBe(hashComplianceAttestation(DOMAIN, ATTESTATION));
    // And it is well formed, which is exactly why nothing threw.
    expect(withoutDomain).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('the empty domain separator is the one Solidity pins as a stranger', () => {
    // `ComplianceVerification.t.sol` recovers over this same separator and
    // asserts the recovered address is not an authorized signer.
    expect(
      keccak256(encodeAbiParameters([{ type: 'bytes32' }], [keccak256(toHex('EIP712Domain()'))])),
    ).toBe(hashDomain({ domain: {}, types: { EIP712Domain: [] } }));
  });
});

describe('pre-signature checks', () => {
  const binding = {
    settlementId: ATTESTATION.settlementId,
    intentHash: ATTESTATION.intentHash,
    maxValidity: 900n,
    now: 1_786_000_100n,
  };

  it('accepts a well-formed attestation', () => {
    expect(checkAttestation(ATTESTATION, binding)).toEqual([]);
  });

  it('rejects a window longer than the contract allows', () => {
    const problems = checkAttestation(
      { ...ATTESTATION, expiresAt: ATTESTATION.issuedAt + 86_400n },
      binding,
    );
    expect(problems).toContain(AttestationProblem.WINDOW_TOO_LONG);
  });

  it('reports an inverted window as inverted rather than as too long', () => {
    const problems = checkAttestation(
      { ...ATTESTATION, expiresAt: ATTESTATION.issuedAt - 1n },
      binding,
    );
    expect(problems).toContain(AttestationProblem.WINDOW_INVERTED);
    expect(problems).not.toContain(AttestationProblem.WINDOW_TOO_LONG);
  });

  it('rejects an expired attestation', () => {
    const problems = checkAttestation(ATTESTATION, { ...binding, now: 1_786_001_000n });
    expect(problems).toContain(AttestationProblem.EXPIRED);
  });

  it('rejects one that is not yet valid', () => {
    const problems = checkAttestation(ATTESTATION, { ...binding, now: 1n });
    expect(problems).toContain(AttestationProblem.NOT_YET_VALID);
  });

  it('rejects an attestation bound to another settlement', () => {
    const problems = checkAttestation(ATTESTATION, {
      ...binding,
      settlementId: `0x${'77'.repeat(32)}`,
    });
    expect(problems).toContain(AttestationProblem.WRONG_SETTLEMENT);
  });

  it('rejects an attestation bound to other terms', () => {
    // Same settlement, renegotiated intent. The attestation covered the terms
    // the authority saw, and it does not carry over.
    const problems = checkAttestation(ATTESTATION, {
      ...binding,
      intentHash: `0x${'77'.repeat(32)}`,
    });
    expect(problems).toContain(AttestationProblem.WRONG_INTENT);
  });
});

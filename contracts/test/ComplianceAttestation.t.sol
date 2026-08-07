// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {ComplianceAttestationLib} from "../src/libraries/ComplianceAttestationLib.sol";

/// @notice Cross-implementation vectors for the compliance attestation digest.
///
/// `packages/domain/src/attestation.test.ts` asserts the identical constant from
/// the TypeScript side. Two independently written implementations agreeing on a
/// fixed value is evidence; one implementation agreeing with itself is not.
///
/// A divergence here is not a cosmetic mismatch. The service would sign a digest
/// the contract never checks, and every settlement would fail at the commit with
/// an error pointing at the signer set rather than at the encoding.
contract ComplianceAttestationTest is Test {
    /// @dev Monad Testnet and the deployed SettlementCoordinator, so the vector
    ///      is anchored to a real domain rather than to a placeholder.
    uint256 private constant CHAIN_ID = 10_143;
    address private constant VERIFYING_CONTRACT = 0x1491A25Fc93778ECcb69BCec96495c6f12c686d1;

    function _attestation()
        private
        pure
        returns (ComplianceAttestationLib.ComplianceAttestation memory)
    {
        return ComplianceAttestationLib.ComplianceAttestation({
            settlementId: 0x1111111111111111111111111111111111111111111111111111111111111111,
            intentHash: 0x2222222222222222222222222222222222222222222222222222222222222222,
            subject: 0x83C130ed9fb92830F09ea2b30E49009EF03065Bb,
            eligible: true,
            issuedAt: 1_786_000_000,
            expiresAt: 1_786_000_300,
            evidenceHash: 0x3333333333333333333333333333333333333333333333333333333333333333
        });
    }

    function _domain() private pure returns (bytes32) {
        return
            ComplianceAttestationLib.domainSeparator("Conduit", "1", CHAIN_ID, VERIFYING_CONTRACT);
    }

    function test_TypeHashMatchesTheDeclaredSignature() public pure {
        assertEq(
            ComplianceAttestationLib.COMPLIANCE_ATTESTATION_TYPEHASH,
            keccak256(
                "ComplianceAttestation(bytes32 settlementId,bytes32 intentHash,address subject,bool eligible,uint64 issuedAt,uint64 expiresAt,bytes32 evidenceHash)"
            )
        );
    }

    function test_DigestMatchesTheTypeScriptVector() public pure {
        assertEq(
            ComplianceAttestationLib.digest(_domain(), _attestation()),
            0x4a31393a4953e7e12fa930c32075640385d3d73a7e1753962432db4c7ed32063
        );
    }

    function test_TheVerifyingContractIsBound() public pure {
        // An attestation minted for the Monad coordinator must not verify at the
        // Base adapter, same signer and subject notwithstanding.
        bytes32 elsewhere = ComplianceAttestationLib.domainSeparator(
            "Conduit", "1", CHAIN_ID, 0xC0A9Eb5F9D1fd0D4264564B1C7A1ed69946E3170
        );
        assertNotEq(
            ComplianceAttestationLib.digest(elsewhere, _attestation()),
            ComplianceAttestationLib.digest(_domain(), _attestation())
        );
    }

    function test_TheChainIsBound() public pure {
        bytes32 baseDomain =
            ComplianceAttestationLib.domainSeparator("Conduit", "1", 84_532, VERIFYING_CONTRACT);
        assertNotEq(
            ComplianceAttestationLib.digest(baseDomain, _attestation()),
            ComplianceAttestationLib.digest(_domain(), _attestation())
        );
    }

    function test_AnApprovalAndARefusalHashDifferently() public pure {
        // If these collided, a signed refusal would authorize a release.
        ComplianceAttestationLib.ComplianceAttestation memory refusal = _attestation();
        refusal.eligible = false;
        assertNotEq(
            ComplianceAttestationLib.digest(_domain(), refusal),
            ComplianceAttestationLib.digest(_domain(), _attestation())
        );
    }

    function testFuzz_EveryFieldIsCovered(
        bytes32 settlementId,
        bytes32 intentHash,
        address subject,
        uint64 issuedAt,
        uint64 expiresAt,
        bytes32 evidenceHash
    ) public pure {
        ComplianceAttestationLib.ComplianceAttestation memory base = _attestation();
        ComplianceAttestationLib.ComplianceAttestation memory other =
            ComplianceAttestationLib.ComplianceAttestation({
                settlementId: settlementId,
                intentHash: intentHash,
                subject: subject,
                eligible: true,
                issuedAt: issuedAt,
                expiresAt: expiresAt,
                evidenceHash: evidenceHash
            });

        bool identical = settlementId == base.settlementId && intentHash == base.intentHash
            && subject == base.subject && issuedAt == base.issuedAt && expiresAt == base.expiresAt
            && evidenceHash == base.evidenceHash;

        // Any field differing must change the digest. A field silently excluded
        // from the preimage is a field an attacker can choose freely.
        if (identical) {
            assertEq(
                ComplianceAttestationLib.digest(_domain(), other),
                ComplianceAttestationLib.digest(_domain(), base)
            );
        } else {
            assertNotEq(
                ComplianceAttestationLib.digest(_domain(), other),
                ComplianceAttestationLib.digest(_domain(), base)
            );
        }
    }
}

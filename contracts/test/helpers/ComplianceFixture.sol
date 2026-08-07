// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {ComplianceAttestationLib} from "../../src/libraries/ComplianceAttestationLib.sol";

/// @notice Builds signed compliance attestations for tests.
///
/// Shared rather than copied into each suite: three call sites building their
/// own EIP-712 digests is three chances for one of them to sign something the
/// contract does not check, and a test that signs the wrong struct passes for
/// the wrong reason.
abstract contract ComplianceFixture is Test {
    uint256 internal constant SIGNER_A_KEY = 0xC0117A;
    uint256 internal constant SIGNER_B_KEY = 0xC0117B;
    uint256 internal constant SIGNER_C_KEY = 0xC0117C;
    uint256 internal constant ROGUE_SIGNER_KEY = 0xBADC0DE;

    /// @dev Well inside any sane `maxAttestationValidity`, so a test that means
    ///      to exercise expiry has to say so.
    uint64 internal constant ATTESTATION_WINDOW = 5 minutes;

    function _signerA() internal pure returns (address) {
        return vm.addr(SIGNER_A_KEY);
    }

    function _signerB() internal pure returns (address) {
        return vm.addr(SIGNER_B_KEY);
    }

    function _signerC() internal pure returns (address) {
        return vm.addr(SIGNER_C_KEY);
    }

    function _attestation(bytes32 settlementId, bytes32 intentHash, address subject, bool eligible)
        internal
        view
        returns (ComplianceAttestationLib.ComplianceAttestation memory)
    {
        return ComplianceAttestationLib.ComplianceAttestation({
            settlementId: settlementId,
            intentHash: intentHash,
            subject: subject,
            eligible: eligible,
            issuedAt: uint64(block.timestamp),
            expiresAt: uint64(block.timestamp) + ATTESTATION_WINDOW,
            evidenceHash: keccak256(abi.encodePacked("cleanverse-response", subject, eligible))
        });
    }

    function _signAttestation(
        bytes32 domainSeparator,
        uint256 signerKey,
        ComplianceAttestationLib.ComplianceAttestation memory attestation
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(signerKey, ComplianceAttestationLib.digest(domainSeparator, attestation));
        return abi.encodePacked(r, s, v);
    }

    /// @notice One attestation per (signer, subject) pair, all eligible.
    ///
    /// @dev The shape a passing settlement uses: every subject attested by every
    ///      signer in the quorum.
    function _attestAll(
        bytes32 domainSeparator,
        uint256[] memory signerKeys,
        bytes32 settlementId,
        bytes32 intentHash,
        address[] memory subjects,
        bool eligible
    )
        internal
        view
        returns (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        )
    {
        uint256 count = signerKeys.length * subjects.length;
        attestations = new ComplianceAttestationLib.ComplianceAttestation[](count);
        signatures = new bytes[](count);

        uint256 i = 0;
        for (uint256 s = 0; s < subjects.length; s += 1) {
            for (uint256 k = 0; k < signerKeys.length; k += 1) {
                attestations[i] = _attestation(settlementId, intentHash, subjects[s], eligible);
                signatures[i] = _signAttestation(domainSeparator, signerKeys[k], attestations[i]);
                i += 1;
            }
        }
    }

    function _keys(uint256 a) internal pure returns (uint256[] memory keys) {
        keys = new uint256[](1);
        keys[0] = a;
    }

    function _keys(uint256 a, uint256 b) internal pure returns (uint256[] memory keys) {
        keys = new uint256[](2);
        keys[0] = a;
        keys[1] = b;
    }

    function _subjects(address a) internal pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = a;
    }

    function _subjects(address a, address b) internal pure returns (address[] memory list) {
        list = new address[](2);
        list[0] = a;
        list[1] = b;
    }

    function _noAttestations()
        internal
        pure
        returns (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        )
    {
        attestations = new ComplianceAttestationLib.ComplianceAttestation[](0);
        signatures = new bytes[](0);
    }
}

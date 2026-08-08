// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {ComplianceAuthority} from "../src/ComplianceAuthority.sol";
import {SettlementCoordinator} from "../src/SettlementCoordinator.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";
import {ComplianceAttestationLib} from "../src/libraries/ComplianceAttestationLib.sol";
import {ComplianceFixture} from "./helpers/ComplianceFixture.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";

/// @notice The verifier, called the way a preflight calls it.
///
/// `verifyEligible` exists so a proof can be checked against the deployed
/// contract's own domain separator and signer set before a transaction is sent.
/// The alternative is what attempt 3 did: build the proof locally, believe it,
/// and discover twenty-five minutes into a live settlement that the signature
/// covered a domain no contract uses.
///
/// That failure is the last test in this file, reproduced exactly. It is worth
/// pinning as a regression rather than describing in a commit message, because
/// the symptom — `AttestationSignerNotAuthorized` naming an address nobody has
/// ever seen — reads as a signer-set problem and is an encoding problem.
contract ComplianceVerificationTest is ComplianceFixture {
    SettlementCoordinator private coordinator;
    MockWormhole private wormhole;

    address private constant OWNER = address(0x0E7E4);
    address private constant SUBJECT = address(0x5B1EC7);

    bytes32 private constant SETTLEMENT_ID = keccak256("settlement-verify");
    bytes32 private constant INTENT_HASH = keccak256("intent-verify");
    uint64 private constant MAX_VALIDITY = 15 minutes;

    bytes32 private domain;

    function setUp() public {
        wormhole = new MockWormhole(10_009);
        coordinator = new SettlementCoordinator(
            address(wormhole),
            keccak256("deployment-verify"),
            10_009,
            10_004,
            bytes32(uint256(uint160(address(0xC0FFEE)))),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            MAX_VALIDITY,
            OWNER,
            "Conduit",
            "1"
        );
        domain = coordinator.attestationDomainSeparator();

        vm.startPrank(OWNER);
        coordinator.addComplianceSigner(_signerA());
        coordinator.setComplianceQuorum(1);
        vm.stopPrank();
    }

    function _proofOver(bytes32 signingDomain, bool eligible)
        private
        view
        returns (ComplianceAuthority.ComplianceProof memory)
    {
        ComplianceAttestationLib.ComplianceAttestation[] memory attestations =
            new ComplianceAttestationLib.ComplianceAttestation[](1);
        bytes[] memory signatures = new bytes[](1);

        attestations[0] = _attestation(SETTLEMENT_ID, INTENT_HASH, SUBJECT, eligible);
        signatures[0] = _signAttestation(signingDomain, SIGNER_A_KEY, attestations[0]);

        return ComplianceAuthority.ComplianceProof(attestations, signatures);
    }

    function test_TheViewAgreesWithTheContractsOwnDomain() public view {
        assertTrue(
            coordinator.verifyEligible(
                SETTLEMENT_ID, INTENT_HASH, SUBJECT, _proofOver(domain, true)
            )
        );
    }

    function test_TheViewReportsARefusalAsARefusalRatherThanSilence() public view {
        ComplianceAuthority.ComplianceProof memory refusal = _proofOver(domain, false);
        assertFalse(coordinator.verifyEligible(SETTLEMENT_ID, INTENT_HASH, SUBJECT, refusal));
        assertTrue(coordinator.verifyRefused(SETTLEMENT_ID, INTENT_HASH, SUBJECT, refusal));
    }

    function test_SilenceIsNotARefusalThroughTheView() public view {
        ComplianceAuthority.ComplianceProof memory approval = _proofOver(domain, true);
        assertFalse(coordinator.verifyRefused(SETTLEMENT_ID, INTENT_HASH, SUBJECT, approval));
    }

    function test_TheViewRefusesAnAttestationForAnotherSubject() public view {
        assertFalse(
            coordinator.verifyEligible(
                SETTLEMENT_ID, INTENT_HASH, address(0xDEAD), _proofOver(domain, true)
            )
        );
    }

    function test_TheViewRefusesAnAttestationForAnotherSettlement() public {
        ComplianceAuthority.ComplianceProof memory proof = _proofOver(domain, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.AttestationForWrongSettlement.selector,
                keccak256("another"),
                SETTLEMENT_ID
            )
        );
        coordinator.verifyEligible(keccak256("another"), INTENT_HASH, SUBJECT, proof);
    }

    function test_TheViewRefusesAnExpiredAttestation() public {
        ComplianceAuthority.ComplianceProof memory proof = _proofOver(domain, true);
        vm.warp(block.timestamp + ATTESTATION_WINDOW + 1);
        vm.expectRevert();
        coordinator.verifyEligible(SETTLEMENT_ID, INTENT_HASH, SUBJECT, proof);
    }

    /// @notice The attempt-3 defect, as a test.
    ///
    /// @dev The runner called viem's `signTypedData` with `domain: undefined`.
    ///      That does not throw. It builds an EIP-712 domain with no fields —
    ///      typehash `EIP712Domain()`, no members — and signs over the resulting
    ///      separator, which no Conduit contract uses. The catch-based fallback
    ///      that would have produced the correct digest never ran, because the
    ///      first path succeeded incorrectly rather than failing.
    ///
    ///      The coordinator's answer was right: it recovered an address nobody
    ///      authorised and refused. This pins that answer, and it pins the shape
    ///      of the mistake — a signature over a well-formed domain that happens
    ///      to be the wrong one recovers to a stranger, so the error names the
    ///      signer set and the fault is in the encoding.
    function test_ASignatureOverTheEmptyDomainRecoversToAStranger() public {
        bytes32 emptyDomain = keccak256(abi.encode(keccak256("EIP712Domain()")));
        assertNotEq(emptyDomain, domain);

        ComplianceAuthority.ComplianceProof memory proof = _proofOver(emptyDomain, true);

        // Recovered over the coordinator's domain, because that is the digest the
        // coordinator will hash. The same signature over the domain it was made
        // for recovers to the real signer, which is exactly why the mistake is
        // invisible on the signing side.
        assertEq(_recovered(emptyDomain, proof), _signerA());
        address stranger = _recovered(domain, proof);
        assertNotEq(stranger, _signerA(), "the wrong domain recovers to a different address");
        assertFalse(coordinator.isComplianceSigner(stranger));

        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.AttestationSignerNotAuthorized.selector, stranger
            )
        );
        coordinator.verifyEligible(SETTLEMENT_ID, INTENT_HASH, SUBJECT, proof);
    }

    function test_ASignatureForTheBaseAdapterDoesNotVerifyHere() public {
        // Same signer, same subject, same settlement, different verifying
        // contract. EIP-712 binds `verifyingContract`, and this is the check
        // that makes one signer safe to use on both chains.
        bytes32 elsewhere = ComplianceAttestationLib.domainSeparator(
            "Conduit", "1", block.chainid, address(0xADAB7E4)
        );
        ComplianceAuthority.ComplianceProof memory proof = _proofOver(elsewhere, true);
        vm.expectRevert();
        coordinator.verifyEligible(SETTLEMENT_ID, INTENT_HASH, SUBJECT, proof);
    }

    function test_ASignatureForAnotherChainDoesNotVerifyHere() public {
        bytes32 otherChain = ComplianceAttestationLib.domainSeparator(
            "Conduit", "1", block.chainid + 1, address(coordinator)
        );
        ComplianceAuthority.ComplianceProof memory proof = _proofOver(otherChain, true);
        vm.expectRevert();
        coordinator.verifyEligible(SETTLEMENT_ID, INTENT_HASH, SUBJECT, proof);
    }

    /// @dev Recovers the way the contract does, so the test's expectation comes
    ///      from the same arithmetic rather than from a hardcoded address.
    function _recovered(bytes32 signingDomain, ComplianceAuthority.ComplianceProof memory proof)
        private
        pure
        returns (address)
    {
        bytes32 digest = ComplianceAttestationLib.digest(signingDomain, proof.attestations[0]);
        bytes memory signature = proof.signatures[0];
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        return ecrecover(digest, v, r, s);
    }
}

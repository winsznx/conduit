// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {ComplianceAuthority} from "../src/ComplianceAuthority.sol";
import {SettlementCoordinator} from "../src/SettlementCoordinator.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {ComplianceAttestationLib} from "../src/libraries/ComplianceAttestationLib.sol";
import {MessageCodec} from "../src/libraries/MessageCodec.sol";
import {SettlementIntentLib} from "../src/libraries/SettlementIntentLib.sol";
import {ComplianceFixture} from "./helpers/ComplianceFixture.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";

/// @notice The canonical decision. PRD FR-007, FR-008, FR-011.
///
/// The property under test throughout is invariant I3: a settlement receives at
/// most one COMMIT or one ABORT. Everything else exists to keep that true when
/// the caller is hostile, the VAA is stale, and the signatures belong to
/// somebody else.
contract SettlementCoordinatorTest is ComplianceFixture {
    SettlementCoordinator private coordinator;
    MockWormhole private wormhole;

    uint256 private buyerKey = 0xB0FFEE;
    uint256 private sellerKey = 0x5E11E4;
    address private buyer;
    address private seller;

    address private constant OWNER = address(0x0E7E4);
    address private constant RELAYER = address(0x4E1A4);

    uint16 private constant LOCAL_WH_CHAIN = 10_009;
    uint16 private constant REMOTE_WH_CHAIN = 10_003;
    bytes32 private constant DEPLOYMENT_ID = keccak256("deployment-1");
    bytes32 private constant REMOTE_EMITTER = bytes32(uint256(uint160(address(0xC0FFEE))));

    uint256 private constant ASSET_CHAIN = 421_614;
    uint64 private constant MAX_ATTESTATION_VALIDITY = 15 minutes;

    /// @dev Cached in setUp rather than read per call. `vm.expectRevert` applies
    ///      to the next external call, and reading the separator off the
    ///      coordinator inside a helper would consume the expectation on a call
    ///      that succeeds — the same trap that produced nine false failures when
    ///      the VAA encoder was not `pure`.
    bytes32 private attestationDomain;

    function setUp() public {
        buyer = vm.addr(buyerKey);
        seller = vm.addr(sellerKey);

        wormhole = new MockWormhole(LOCAL_WH_CHAIN);
        coordinator = new SettlementCoordinator(
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            MAX_ATTESTATION_VALIDITY,
            OWNER,
            "Conduit",
            "1"
        );

        attestationDomain = coordinator.attestationDomainSeparator();

        vm.startPrank(OWNER);
        coordinator.addComplianceSigner(_signerA());
        coordinator.addComplianceSigner(_signerB());
        coordinator.setComplianceQuorum(2);
        vm.stopPrank();
    }

    function _intent() private view returns (SettlementIntentLib.SettlementIntent memory) {
        return SettlementIntentLib.SettlementIntent({
            version: 1,
            cashChainId: block.chainid,
            cashEscrow: address(0x1111),
            cashAsset: address(0x2222),
            cashAmount: 1000e6,
            cashPayer: buyer,
            cashReceiver: address(0x4444),
            assetChainId: ASSET_CHAIN,
            assetEscrow: address(0x5555),
            assetToken: address(0x6666),
            assetAmount: 50,
            assetSeller: seller,
            assetReceiver: address(0x8888),
            cashPolicyHash: keccak256("cash-policy"),
            assetPolicyHash: keccak256("asset-policy"),
            prepareDeadline: uint64(block.timestamp + 1 hours),
            commitDeadline: uint64(block.timestamp + 2 hours),
            releaseDeadline: uint64(block.timestamp + 3 hours),
            nonce: 42
        });
    }

    function _settlementId() private view returns (bytes32) {
        return SettlementIntentLib.digest(_intent(), coordinator.domainSeparator());
    }

    function _sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _assetPreparedVaa(bytes32 settlementId, string memory seed)
        private
        pure
        returns (bytes memory)
    {
        bytes memory payload = MessageCodec.encode(
            MessageCodec.Header({
                protocolVersion: MessageCodec.PROTOCOL_VERSION,
                messageType: MessageCodec.MessageType.ASSET_PREPARED,
                deploymentId: DEPLOYMENT_ID,
                settlementId: settlementId,
                intentHash: settlementId,
                sourceChainId: ASSET_CHAIN,
                destinationChainId: 31_337, // foundry's default chain id
                stateVersion: 1
            })
        );
        return _encodeVaa(REMOTE_WH_CHAIN, REMOTE_EMITTER, payload, keccak256(bytes(seed)));
    }

    function _encodeVaa(
        uint16 emitterChainId,
        bytes32 emitterAddress,
        bytes memory payload,
        bytes32 hash
    ) private pure returns (bytes memory) {
        IWormhole.VM memory vaa = IWormhole.VM({
            version: 1,
            timestamp: 0,
            nonce: 0,
            emitterChainId: emitterChainId,
            emitterAddress: emitterAddress,
            sequence: 1,
            consistencyLevel: 1,
            payload: payload,
            guardianSetIndex: 0,
            signatures: new IWormhole.Signature[](0),
            hash: hash
        });
        return abi.encode(vaa);
    }

    function _becomeReady() private returns (bytes32 settlementId) {
        settlementId = _settlementId();
        coordinator.recordCashPrepared(settlementId, settlementId);
        coordinator.recordAssetPrepared(_assetPreparedVaa(settlementId, "asset-prepared"));
    }

    /// @dev The quorum attests both cash-side parties eligible. `compliant`
    ///      flips the signed answer rather than omitting the attestations,
    ///      because a signed refusal and a missing attestation are different
    ///      failures and the tests below distinguish them.
    function _attestations(bytes32 settlementId, bool compliant)
        private
        view
        returns (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        )
    {
        return _attestAll(
            attestationDomain,
            _keys(SIGNER_A_KEY, SIGNER_B_KEY),
            settlementId,
            settlementId,
            _subjects(_intent().cashPayer, _intent().cashReceiver),
            compliant
        );
    }

    /// @dev A cancellation carrying nothing. Every abort ground now needs its
    ///      own proof, so a caller supplying this can only abort on a deadline
    ///      the chain agrees has passed.
    function _noCancellation() private pure returns (SettlementCoordinator.Cancellation memory) {
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory none,
            bytes[] memory noSignatures
        ) = _noAttestations();
        return SettlementCoordinator.Cancellation({
            compliance: ComplianceAuthority.ComplianceProof(none, noSignatures),
            buyer: "",
            seller: ""
        });
    }

    /// @dev The quorum's signed refusal of the payer, which is what makes a
    ///      compliance abort legitimate rather than merely asserted.
    function _refusal(bytes32 settlementId)
        private
        view
        returns (SettlementCoordinator.Cancellation memory)
    {
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            attestationDomain,
            _keys(SIGNER_A_KEY, SIGNER_B_KEY),
            settlementId,
            settlementId,
            _subjects(_intent().cashPayer),
            false
        );
        return SettlementCoordinator.Cancellation({
            compliance: ComplianceAuthority.ComplianceProof(attestations, signatures),
            buyer: "",
            seller: ""
        });
    }

    /// @dev Both parties signing a cancellation bound to these exact terms.
    function _bilateral(bytes32 settlementId)
        private
        view
        returns (SettlementCoordinator.Cancellation memory)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                hex"1901",
                coordinator.domainSeparator(),
                keccak256(
                    abi.encode(coordinator.CANCELLATION_TYPEHASH(), settlementId, settlementId)
                )
            )
        );
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory none,
            bytes[] memory noSignatures
        ) = _noAttestations();
        return SettlementCoordinator.Cancellation({
            compliance: ComplianceAuthority.ComplianceProof(none, noSignatures),
            buyer: _sign(buyerKey, digest),
            seller: _sign(sellerKey, digest)
        });
    }

    function _commit(bytes32 settlementId, bool complianceFresh) private {
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestations(settlementId, complianceFresh);

        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(attestations, signatures),
            1
        );
    }

    // ── Reaching READY ───────────────────────────────────────────────────────

    function test_BothLegsPreparedReachesReady() public {
        bytes32 settlementId = _becomeReady();

        SettlementCoordinator.Settlement memory s = coordinator.settlementOf(settlementId);
        assertEq(uint8(s.state), uint8(SettlementCoordinator.SettlementState.READY));
        assertTrue(s.cashPrepared);
        assertTrue(s.assetPrepared);
    }

    function test_OneLegAloneIsNotReady() public {
        bytes32 settlementId = _settlementId();
        coordinator.recordCashPrepared(settlementId, settlementId);

        SettlementCoordinator.Settlement memory s = coordinator.settlementOf(settlementId);
        assertEq(uint8(s.state), uint8(SettlementCoordinator.SettlementState.CASH_PREPARED));
    }

    function test_LegsMustBindTheSameIntentHash() public {
        // Invariant I7. Two legs describing different trades are not one trade.
        bytes32 settlementId = _settlementId();
        coordinator.recordCashPrepared(settlementId, keccak256("a-different-intent"));

        vm.expectRevert();
        coordinator.recordAssetPrepared(_assetPreparedVaa(settlementId, "mismatch"));
    }

    function test_ALegMayNotBePreparedTwice() public {
        bytes32 settlementId = _settlementId();
        coordinator.recordCashPrepared(settlementId, settlementId);

        vm.expectRevert(
            abi.encodeWithSelector(SettlementCoordinator.LegAlreadyPrepared.selector, settlementId)
        );
        coordinator.recordCashPrepared(settlementId, settlementId);
    }

    // ── Invariant I3: at most one decision ───────────────────────────────────

    function test_CommitIsIssuedOnceAndPublished() public {
        bytes32 settlementId = _becomeReady();
        uint256 publishedBefore = wormhole.publishedCount();

        _commit(settlementId, true);

        SettlementCoordinator.Settlement memory s = coordinator.settlementOf(settlementId);
        assertEq(uint8(s.decision), uint8(SettlementCoordinator.Decision.COMMIT));
        assertEq(uint8(s.state), uint8(SettlementCoordinator.SettlementState.COMMIT_ISSUED));
        assertEq(wormhole.publishedCount(), publishedBefore + 1);

        MessageCodec.Header memory header =
            MessageCodec.decode(wormhole.publishedAt(publishedBefore).payload);
        assertEq(uint8(header.messageType), uint8(MessageCodec.MessageType.COMMIT));
        assertEq(header.settlementId, settlementId);
        assertEq(header.destinationChainId, ASSET_CHAIN);
    }

    function test_SecondCommitIsRefused() public {
        bytes32 settlementId = _becomeReady();
        _commit(settlementId, true);

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.AlreadyDecided.selector,
                settlementId,
                SettlementCoordinator.Decision.COMMIT
            )
        );
        _commit(settlementId, true);
    }

    function test_AbortAfterCommitIsForbidden() public {
        // Invariant I4, at the point of decision rather than the point of payment.
        bytes32 settlementId = _becomeReady();
        _commit(settlementId, true);

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.AbortAfterCommitForbidden.selector, settlementId
            )
        );
        coordinator.issueAbort(
            _intent(),
            settlementId,
            SettlementCoordinator.AbortGround.COMPLIANCE,
            _refusal(settlementId),
            1
        );
    }

    function test_CommitAfterAbortIsRefused() public {
        bytes32 settlementId = _becomeReady();
        coordinator.issueAbort(
            _intent(),
            settlementId,
            SettlementCoordinator.AbortGround.COMPLIANCE,
            _refusal(settlementId),
            1
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.AlreadyDecided.selector,
                settlementId,
                SettlementCoordinator.Decision.ABORT
            )
        );
        _commit(settlementId, true);
    }

    function test_PreparationAfterADecisionIsRefused() public {
        bytes32 settlementId = _becomeReady();
        _commit(settlementId, true);

        vm.expectRevert();
        coordinator.recordAssetPrepared(_assetPreparedVaa(settlementId, "late-prepare"));
    }

    // ── FR-007 conditions ────────────────────────────────────────────────────

    function test_CommitRequiresBothLegsPrepared() public {
        bytes32 settlementId = _settlementId();
        coordinator.recordCashPrepared(settlementId, settlementId);

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.NotReady.selector,
                settlementId,
                SettlementCoordinator.SettlementState.CASH_PREPARED
            )
        );
        _commit(settlementId, true);
    }

    function test_CommitRequiresAValidBuyerSignature() public {
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory eligibleAttestations,
            bytes[] memory eligibleSignatures
        ) = _attestations(settlementId, true);

        vm.expectRevert(SettlementCoordinator.InvalidBuyerSignature.selector);
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(sellerKey, settlementId), // seller signing in the buyer's slot
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(eligibleAttestations, eligibleSignatures),
            1
        );
    }

    function test_CommitRequiresAValidSellerSignature() public {
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory eligibleAttestations,
            bytes[] memory eligibleSignatures
        ) = _attestations(settlementId, true);

        vm.expectRevert(SettlementCoordinator.InvalidSellerSignature.selector);
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(buyerKey, settlementId),
            ComplianceAuthority.ComplianceProof(eligibleAttestations, eligibleSignatures),
            1
        );
    }

    function test_SignatureOverADifferentDigestIsRejected() public {
        // Threat T-20: a signature is only valid for the exact terms it covered.
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory eligibleAttestations,
            bytes[] memory eligibleSignatures
        ) = _attestations(settlementId, true);
        bytes32 otherDigest = keccak256("some-other-settlement");

        vm.expectRevert(SettlementCoordinator.InvalidBuyerSignature.selector);
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, otherDigest),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(eligibleAttestations, eligibleSignatures),
            1
        );
    }

    function test_IntentMustHashToTheSettlementId() public {
        // Without this, a caller could present terms nobody signed alongside an
        // ID that somebody did.
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory eligibleAttestations,
            bytes[] memory eligibleSignatures
        ) = _attestations(settlementId, true);

        SettlementIntentLib.SettlementIntent memory tampered = _intent();
        tampered.cashAmount += 1;

        vm.expectRevert();
        coordinator.issueCommit(
            tampered,
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(eligibleAttestations, eligibleSignatures),
            1
        );
    }

    function test_CommitAfterTheDeadlineIsRefused() public {
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory eligibleAttestations,
            bytes[] memory eligibleSignatures
        ) = _attestations(settlementId, true);
        SettlementIntentLib.SettlementIntent memory intent = _intent();

        vm.warp(intent.commitDeadline + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.DeadlinePassed.selector,
                intent.commitDeadline,
                block.timestamp
            )
        );
        coordinator.issueCommit(
            intent,
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(eligibleAttestations, eligibleSignatures),
            1
        );
    }

    function test_ASignedRefusalBlocksCommit() public {
        // PRD FR-006 and threat T-07. The quorum signs `eligible: false`, which
        // is a decision with evidence attached rather than an absent record. The
        // settlement stays READY, so a later eligible attestation can commit it.
        bytes32 settlementId = _becomeReady();

        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.ComplianceQuorumNotMet.selector,
                _intent().cashPayer,
                uint256(0),
                uint256(2)
            )
        );
        _commit(settlementId, false);

        SettlementCoordinator.Settlement memory s = coordinator.settlementOf(settlementId);
        assertEq(uint8(s.decision), uint8(SettlementCoordinator.Decision.NONE));
        assertEq(uint8(s.state), uint8(SettlementCoordinator.SettlementState.READY));

        _commit(settlementId, true);
        s = coordinator.settlementOf(settlementId);
        assertEq(uint8(s.decision), uint8(SettlementCoordinator.Decision.COMMIT));
    }

    function test_NoAttestationsAtAllBlocksCommit() public {
        // The absence of an answer must not read as a positive one.
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory none,
            bytes[] memory noSignatures
        ) = _noAttestations();

        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.ComplianceQuorumNotMet.selector,
                _intent().cashPayer,
                uint256(0),
                uint256(2)
            )
        );
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(none, noSignatures),
            1
        );
    }

    function test_OneSignerCannotMeetATwoSignerQuorum() public {
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            attestationDomain,
            _keys(SIGNER_A_KEY),
            settlementId,
            settlementId,
            _subjects(_intent().cashPayer, _intent().cashReceiver),
            true
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.ComplianceQuorumNotMet.selector,
                _intent().cashPayer,
                uint256(1),
                uint256(2)
            )
        );
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(attestations, signatures),
            1
        );
    }

    function test_OneSignerCannotReachQuorumByAttestingTwice() public {
        // The check that separates a quorum from a loop counter.
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            attestationDomain,
            _keys(SIGNER_A_KEY, SIGNER_A_KEY),
            settlementId,
            settlementId,
            _subjects(_intent().cashPayer, _intent().cashReceiver),
            true
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.AttestationSignersNotDistinct.selector, _signerA()
            )
        );
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(attestations, signatures),
            1
        );
    }

    function test_AnUnauthorizedSignerIsRejected() public {
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            attestationDomain,
            _keys(SIGNER_A_KEY, ROGUE_SIGNER_KEY),
            settlementId,
            settlementId,
            _subjects(_intent().cashPayer, _intent().cashReceiver),
            true
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.AttestationSignerNotAuthorized.selector,
                vm.addr(ROGUE_SIGNER_KEY)
            )
        );
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(attestations, signatures),
            1
        );
    }

    function test_AnAttestationForAnotherSettlementDoesNotTransfer() public {
        // Threat T-07 in its replay form: a real, correctly signed, unexpired
        // attestation is still only valid for the settlement it names.
        bytes32 settlementId = _becomeReady();
        bytes32 otherSettlement = keccak256("a-different-settlement");

        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            attestationDomain,
            _keys(SIGNER_A_KEY, SIGNER_B_KEY),
            otherSettlement,
            otherSettlement,
            _subjects(_intent().cashPayer, _intent().cashReceiver),
            true
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.AttestationForWrongSettlement.selector,
                settlementId,
                otherSettlement
            )
        );
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(attestations, signatures),
            1
        );
    }

    function test_AnExpiredAttestationIsRefused() public {
        // The intent is captured before the warp: its deadlines derive from
        // block.timestamp, so a later _intent() hashes to a different
        // settlement and the test would fail for the wrong reason.
        SettlementIntentLib.SettlementIntent memory intent = _intent();
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestations(settlementId, true);

        vm.warp(block.timestamp + ATTESTATION_WINDOW + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.AttestationExpired.selector,
                attestations[0].expiresAt,
                block.timestamp
            )
        );
        coordinator.issueCommit(
            intent,
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(attestations, signatures),
            1
        );
    }

    function test_ASignerCannotGrantItselfAnUnboundedWindow() public {
        // `expiresAt` is inside the signed struct, so a signer could set it a
        // year out and hand a compromised key a year of authority.
        // `maxAttestationValidity` is immutable and caps it independently.
        bytes32 settlementId = _becomeReady();

        ComplianceAttestationLib.ComplianceAttestation[] memory attestations =
            new ComplianceAttestationLib.ComplianceAttestation[](2);
        bytes[] memory signatures = new bytes[](2);
        address[] memory parties = _subjects(_intent().cashPayer, _intent().cashReceiver);

        for (uint256 i = 0; i < 2; i += 1) {
            attestations[i] = _attestation(settlementId, settlementId, parties[i], true);
            attestations[i].expiresAt = uint64(block.timestamp) + 365 days;
            signatures[i] = _signAttestation(attestationDomain, SIGNER_A_KEY, attestations[i]);
        }

        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.AttestationValidityTooLong.selector,
                uint64(365 days),
                MAX_ATTESTATION_VALIDITY
            )
        );
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(attestations, signatures),
            1
        );
    }

    function test_BothPartiesMustBeAttested() public {
        // Attesting only the receiver would let an ineligible payer fund a
        // settlement; only the payer, and value reaches someone refused.
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            attestationDomain,
            _keys(SIGNER_A_KEY, SIGNER_B_KEY),
            settlementId,
            settlementId,
            _subjects(_intent().cashPayer),
            true
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.ComplianceQuorumNotMet.selector,
                _intent().cashReceiver,
                uint256(0),
                uint256(2)
            )
        );
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(attestations, signatures),
            1
        );
    }

    function test_RemovingASignerCannotStrandTheQuorum() public {
        vm.startPrank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.QuorumExceedsSignerCount.selector, uint256(2), uint256(1)
            )
        );
        coordinator.removeComplianceSigner(_signerB());
        vm.stopPrank();

        assertTrue(coordinator.isComplianceSigner(_signerB()));
        assertEq(coordinator.complianceQuorum(), 2);
    }

    function test_AnUnconfiguredAuthorityRefusesEveryCommit() public {
        // The quorum starts at zero, and `attesting >= 0` holds for an empty
        // array. Without the explicit zero check a freshly deployed coordinator
        // would accept any commit with no compliance evidence at all, which is
        // worse than no check because the check looks present.
        SettlementCoordinator fresh = new SettlementCoordinator(
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            MAX_ATTESTATION_VALIDITY,
            OWNER,
            "Conduit",
            "1"
        );
        assertEq(fresh.complianceQuorum(), 0);

        bytes32 settlementId = SettlementIntentLib.digest(_intent(), fresh.domainSeparator());
        fresh.recordCashPrepared(settlementId, settlementId);
        fresh.recordAssetPrepared(_assetPreparedVaa(settlementId, "asset-prepared"));

        (
            ComplianceAttestationLib.ComplianceAttestation[] memory none,
            bytes[] memory noSignatures
        ) = _noAttestations();

        vm.expectRevert(ComplianceAuthority.ComplianceNotConfigured.selector);
        fresh.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(none, noSignatures),
            1
        );
    }

    function test_OnlyTheOwnerManagesTheSignerSet() public {
        vm.prank(RELAYER);
        vm.expectRevert();
        coordinator.addComplianceSigner(_signerC());
    }

    function test_IntentForAnotherCashChainIsRefused() public {
        bytes32 settlementId = _settlementId();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory eligibleAttestations,
            bytes[] memory eligibleSignatures
        ) = _attestations(settlementId, true);
        coordinator.recordCashPrepared(settlementId, settlementId);
        coordinator.recordAssetPrepared(_assetPreparedVaa(settlementId, "asset-prepared"));

        SettlementIntentLib.SettlementIntent memory foreign = _intent();
        foreign.cashChainId = 1;

        vm.expectRevert();
        coordinator.issueCommit(
            foreign,
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            ComplianceAuthority.ComplianceProof(eligibleAttestations, eligibleSignatures),
            1
        );
    }

    // ── Abort grounds ────────────────────────────────────────────────────────

    function test_AbortOnComplianceFailure() public {
        bytes32 settlementId = _becomeReady();
        coordinator.issueAbort(
            _intent(),
            settlementId,
            SettlementCoordinator.AbortGround.COMPLIANCE,
            _refusal(settlementId),
            1
        );

        SettlementCoordinator.Settlement memory s = coordinator.settlementOf(settlementId);
        assertEq(uint8(s.decision), uint8(SettlementCoordinator.Decision.ABORT));
    }

    function test_AbortWithNoGroundsIsRefused() public {
        // A caller cannot abort a healthy, in-window settlement on request.
        bytes32 settlementId = _becomeReady();

        vm.expectRevert();
        coordinator.issueAbort(
            _intent(),
            settlementId,
            SettlementCoordinator.AbortGround.BILATERAL,
            _noCancellation(),
            1
        );
    }

    function test_ClaimedDeadlineIsCheckedAgainstTheChainClock() public {
        // A relayer asserting "the deadline passed" proves nothing on its own.
        bytes32 settlementId = _becomeReady();

        vm.expectRevert();
        coordinator.issueAbort(
            _intent(),
            settlementId,
            SettlementCoordinator.AbortGround.DEADLINE,
            _noCancellation(),
            1
        );
    }

    function test_AbortOnGenuinelyMissedDeadline() public {
        bytes32 settlementId = _becomeReady();

        // `_intent()` derives its deadlines from block.timestamp, so it must be
        // captured before warping. Rebuilding it afterwards produces different
        // terms and therefore a different digest, which the coordinator
        // correctly refuses.
        SettlementIntentLib.SettlementIntent memory intent = _intent();
        vm.warp(intent.commitDeadline + 1);

        coordinator.issueAbort(
            intent, settlementId, SettlementCoordinator.AbortGround.DEADLINE, _noCancellation(), 1
        );

        assertEq(
            uint8(coordinator.settlementOf(settlementId).decision),
            uint8(SettlementCoordinator.Decision.ABORT)
        );
    }

    // ── Completion, FR-011 ───────────────────────────────────────────────────

    function test_SettledOnlyAfterBothLegsReport() public {
        bytes32 settlementId = _becomeReady();
        _commit(settlementId, true);

        coordinator.recordLocalCashResolved(settlementId, SettlementCoordinator.LegOutcome.RELEASED);
        assertEq(
            uint8(coordinator.settlementOf(settlementId).state),
            uint8(SettlementCoordinator.SettlementState.COMMIT_ISSUED),
            "one leg is not a settlement"
        );

        bytes memory releasedVaa =
            _legVaa(settlementId, MessageCodec.MessageType.ASSET_RELEASED, "asset-released");
        coordinator.recordLegResolved(
            releasedVaa,
            MessageCodec.MessageType.ASSET_RELEASED,
            SettlementCoordinator.LegOutcome.RELEASED
        );

        assertEq(
            uint8(coordinator.settlementOf(settlementId).state),
            uint8(SettlementCoordinator.SettlementState.SETTLED)
        );
    }

    function test_AHeldLegMakesTheSettlementHeld() public {
        bytes32 settlementId = _becomeReady();
        _commit(settlementId, true);

        coordinator.recordLocalCashResolved(settlementId, SettlementCoordinator.LegOutcome.RELEASED);
        coordinator.recordLegResolved(
            _legVaa(settlementId, MessageCodec.MessageType.ASSET_HELD, "asset-held"),
            MessageCodec.MessageType.ASSET_HELD,
            SettlementCoordinator.LegOutcome.HELD
        );

        assertEq(
            uint8(coordinator.settlementOf(settlementId).state),
            uint8(SettlementCoordinator.SettlementState.HELD),
            "a settlement with a held leg is not settled"
        );
    }

    function _legVaa(bytes32 settlementId, MessageCodec.MessageType messageType, string memory seed)
        private
        view
        returns (bytes memory)
    {
        bytes memory payload = MessageCodec.encode(
            MessageCodec.Header({
                protocolVersion: MessageCodec.PROTOCOL_VERSION,
                messageType: messageType,
                deploymentId: DEPLOYMENT_ID,
                settlementId: settlementId,
                intentHash: settlementId,
                sourceChainId: ASSET_CHAIN,
                destinationChainId: block.chainid,
                stateVersion: 3
            })
        );
        return _encodeVaa(REMOTE_WH_CHAIN, REMOTE_EMITTER, payload, keccak256(bytes(seed)));
    }

    // ── Transport checks still apply here ────────────────────────────────────

    function test_RejectsAssetPreparedFromTheWrongEmitter() public {
        bytes32 settlementId = _settlementId();
        bytes32 impostor = bytes32(uint256(uint160(address(0xBADBEEF))));

        bytes memory payload = MessageCodec.encode(
            MessageCodec.Header({
                protocolVersion: MessageCodec.PROTOCOL_VERSION,
                messageType: MessageCodec.MessageType.ASSET_PREPARED,
                deploymentId: DEPLOYMENT_ID,
                settlementId: settlementId,
                intentHash: settlementId,
                sourceChainId: ASSET_CHAIN,
                destinationChainId: block.chainid,
                stateVersion: 1
            })
        );
        bytes memory vaa = _encodeVaa(REMOTE_WH_CHAIN, impostor, payload, keccak256("impostor"));

        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.UnexpectedEmitter.selector, impostor, REMOTE_EMITTER
            )
        );
        coordinator.recordAssetPrepared(vaa);
    }

    function test_RejectsReplayedAssetPrepared() public {
        bytes32 settlementId = _settlementId();
        bytes memory vaa = _assetPreparedVaa(settlementId, "replay-me");

        coordinator.recordAssetPrepared(vaa);

        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.VaaAlreadyConsumed.selector, keccak256("replay-me")
            )
        );
        coordinator.recordAssetPrepared(vaa);
    }

    function test_AnyoneCouldOnceAbortALiveSettlementByClaimingCompliance() public {
        // The regression this closes. `complianceFailed: true` used to be a
        // caller-supplied boolean, so any address could abort a healthy,
        // in-window settlement that both parties wanted to complete. It is a
        // griefing vector rather than a theft, which is exactly the kind that
        // survives review.
        bytes32 settlementId = _becomeReady();

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.AbortGroundNotProven.selector,
                SettlementCoordinator.AbortGround.COMPLIANCE
            )
        );
        coordinator.issueAbort(
            _intent(),
            settlementId,
            SettlementCoordinator.AbortGround.COMPLIANCE,
            _noCancellation(),
            1
        );

        assertEq(
            uint8(coordinator.settlementOf(settlementId).decision),
            uint8(SettlementCoordinator.Decision.NONE)
        );
    }

    function test_SilenceIsNotARefusal() public {
        // An eligible attestation is not grounds for a compliance abort, and
        // neither is the absence of one. "The authority said no" and "the
        // authority has not answered" are different states.
        bytes32 settlementId = _becomeReady();
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory approvals,
            bytes[] memory signatures
        ) = _attestations(settlementId, true);

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.AbortGroundNotProven.selector,
                SettlementCoordinator.AbortGround.COMPLIANCE
            )
        );
        coordinator.issueAbort(
            _intent(),
            settlementId,
            SettlementCoordinator.AbortGround.COMPLIANCE,
            SettlementCoordinator.Cancellation(
                ComplianceAuthority.ComplianceProof(approvals, signatures), "", ""
            ),
            1
        );
    }

    function test_BilateralCancellationNeedsBothParties() public {
        bytes32 settlementId = _becomeReady();

        SettlementCoordinator.Cancellation memory onlyBuyer = _bilateral(settlementId);
        onlyBuyer.seller = "";

        vm.expectRevert();
        coordinator.issueAbort(
            _intent(), settlementId, SettlementCoordinator.AbortGround.BILATERAL, onlyBuyer, 1
        );
    }

    function test_BothPartiesCanCancelBilaterally() public {
        bytes32 settlementId = _becomeReady();

        coordinator.issueAbort(
            _intent(),
            settlementId,
            SettlementCoordinator.AbortGround.BILATERAL,
            _bilateral(settlementId),
            1
        );

        assertEq(
            uint8(coordinator.settlementOf(settlementId).decision),
            uint8(SettlementCoordinator.Decision.ABORT)
        );
    }

    function test_ACancellationForAnotherSettlementDoesNotTransfer() public {
        // Signing to abandon one trade is not signing to abandon another.
        bytes32 settlementId = _becomeReady();

        SettlementCoordinator.Cancellation memory foreign =
            _bilateral(keccak256("a-different-settlement"));

        vm.expectRevert();
        coordinator.issueAbort(
            _intent(), settlementId, SettlementCoordinator.AbortGround.BILATERAL, foreign, 1
        );
    }

    // ── Property ─────────────────────────────────────────────────────────────

    function testFuzz_AtMostOneDecisionSurvivesAnyOrdering(bool commitFirst, bool complianceFresh)
        public
    {
        bytes32 settlementId = _becomeReady();

        if (commitFirst) {
            if (complianceFresh) {
                _commit(settlementId, true);
            } else {
                vm.expectRevert(
                    abi.encodeWithSelector(
                        ComplianceAuthority.ComplianceQuorumNotMet.selector,
                        _intent().cashPayer,
                        uint256(0),
                        uint256(2)
                    )
                );
                _commit(settlementId, false);
            }
            if (complianceFresh) {
                vm.expectRevert();
                coordinator.issueAbort(
                    _intent(),
                    settlementId,
                    SettlementCoordinator.AbortGround.COMPLIANCE,
                    _refusal(settlementId),
                    1
                );
            }
        } else {
            coordinator.issueAbort(
                _intent(),
                settlementId,
                SettlementCoordinator.AbortGround.COMPLIANCE,
                _refusal(settlementId),
                1
            );
            vm.expectRevert();
            _commit(settlementId, true);
        }

        SettlementCoordinator.Settlement memory s = coordinator.settlementOf(settlementId);
        bool decided = s.decision != SettlementCoordinator.Decision.NONE;

        // I3: whatever the ordering, the settlement never holds two decisions.
        if (decided) {
            assertTrue(
                s.decision == SettlementCoordinator.Decision.COMMIT
                    || s.decision == SettlementCoordinator.Decision.ABORT
            );
        }
    }
}

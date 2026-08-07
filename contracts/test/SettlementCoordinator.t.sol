// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {SettlementCoordinator} from "../src/SettlementCoordinator.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {MessageCodec} from "../src/libraries/MessageCodec.sol";
import {SettlementIntentLib} from "../src/libraries/SettlementIntentLib.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";

/// @notice The canonical decision. PRD FR-007, FR-008, FR-011.
///
/// The property under test throughout is invariant I3: a settlement receives at
/// most one COMMIT or one ABORT. Everything else exists to keep that true when
/// the caller is hostile, the VAA is stale, and the signatures belong to
/// somebody else.
contract SettlementCoordinatorTest is Test {
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
            OWNER,
            "Conduit",
            "1"
        );
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

    function _commit(bytes32 settlementId, bool complianceFresh) private {
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            complianceFresh,
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
        coordinator.issueAbort(_intent(), settlementId, false, true, false, 1);
    }

    function test_CommitAfterAbortIsRefused() public {
        bytes32 settlementId = _becomeReady();
        coordinator.issueAbort(_intent(), settlementId, false, true, false, 1);

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

        vm.expectRevert(SettlementCoordinator.InvalidBuyerSignature.selector);
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(sellerKey, settlementId), // seller signing in the buyer's slot
            _sign(sellerKey, settlementId),
            true,
            1
        );
    }

    function test_CommitRequiresAValidSellerSignature() public {
        bytes32 settlementId = _becomeReady();

        vm.expectRevert(SettlementCoordinator.InvalidSellerSignature.selector);
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(buyerKey, settlementId),
            true,
            1
        );
    }

    function test_SignatureOverADifferentDigestIsRejected() public {
        // Threat T-20: a signature is only valid for the exact terms it covered.
        bytes32 settlementId = _becomeReady();
        bytes32 otherDigest = keccak256("some-other-settlement");

        vm.expectRevert(SettlementCoordinator.InvalidBuyerSignature.selector);
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(buyerKey, otherDigest),
            _sign(sellerKey, settlementId),
            true,
            1
        );
    }

    function test_IntentMustHashToTheSettlementId() public {
        // Without this, a caller could present terms nobody signed alongside an
        // ID that somebody did.
        bytes32 settlementId = _becomeReady();

        SettlementIntentLib.SettlementIntent memory tampered = _intent();
        tampered.cashAmount += 1;

        vm.expectRevert();
        coordinator.issueCommit(
            tampered,
            settlementId,
            _sign(buyerKey, settlementId),
            _sign(sellerKey, settlementId),
            true,
            1
        );
    }

    function test_CommitAfterTheDeadlineIsRefused() public {
        bytes32 settlementId = _becomeReady();
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
            true,
            1
        );
    }

    function test_StaleComplianceBlocksCommit() public {
        // PRD FR-006 and threat T-07. The settlement stays READY, so a fresh
        // attestation can still commit it later.
        bytes32 settlementId = _becomeReady();

        vm.expectRevert(SettlementCoordinator.ComplianceNotFresh.selector);
        _commit(settlementId, false);

        SettlementCoordinator.Settlement memory s = coordinator.settlementOf(settlementId);
        assertEq(uint8(s.decision), uint8(SettlementCoordinator.Decision.NONE));
        assertEq(uint8(s.state), uint8(SettlementCoordinator.SettlementState.READY));
    }

    function test_IntentForAnotherCashChainIsRefused() public {
        bytes32 settlementId = _settlementId();
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
            true,
            1
        );
    }

    // ── Abort grounds ────────────────────────────────────────────────────────

    function test_AbortOnComplianceFailure() public {
        bytes32 settlementId = _becomeReady();
        coordinator.issueAbort(_intent(), settlementId, false, true, false, 1);

        SettlementCoordinator.Settlement memory s = coordinator.settlementOf(settlementId);
        assertEq(uint8(s.decision), uint8(SettlementCoordinator.Decision.ABORT));
    }

    function test_AbortWithNoGroundsIsRefused() public {
        // A caller cannot abort a healthy, in-window settlement on request.
        bytes32 settlementId = _becomeReady();

        vm.expectRevert();
        coordinator.issueAbort(_intent(), settlementId, false, false, false, 1);
    }

    function test_ClaimedDeadlineIsCheckedAgainstTheChainClock() public {
        // A relayer asserting "the deadline passed" proves nothing on its own.
        bytes32 settlementId = _becomeReady();

        vm.expectRevert();
        coordinator.issueAbort(_intent(), settlementId, true, false, false, 1);
    }

    function test_AbortOnGenuinelyMissedDeadline() public {
        bytes32 settlementId = _becomeReady();

        // `_intent()` derives its deadlines from block.timestamp, so it must be
        // captured before warping. Rebuilding it afterwards produces different
        // terms and therefore a different digest, which the coordinator
        // correctly refuses.
        SettlementIntentLib.SettlementIntent memory intent = _intent();
        vm.warp(intent.commitDeadline + 1);

        coordinator.issueAbort(intent, settlementId, true, false, false, 1);

        assertEq(
            uint8(coordinator.settlementOf(settlementId).decision),
            uint8(SettlementCoordinator.Decision.ABORT)
        );
    }

    // ── Completion, FR-011 ───────────────────────────────────────────────────

    function test_SettledOnlyAfterBothLegsReport() public {
        bytes32 settlementId = _becomeReady();
        _commit(settlementId, true);

        coordinator.recordLocalCashResolved(settlementId, true);
        assertEq(
            uint8(coordinator.settlementOf(settlementId).state),
            uint8(SettlementCoordinator.SettlementState.COMMIT_ISSUED),
            "one leg is not a settlement"
        );

        bytes memory releasedVaa =
            _legVaa(settlementId, MessageCodec.MessageType.ASSET_RELEASED, "asset-released");
        coordinator.recordLegResolved(releasedVaa, MessageCodec.MessageType.ASSET_RELEASED);

        assertEq(
            uint8(coordinator.settlementOf(settlementId).state),
            uint8(SettlementCoordinator.SettlementState.SETTLED)
        );
    }

    function test_AHeldLegMakesTheSettlementHeld() public {
        bytes32 settlementId = _becomeReady();
        _commit(settlementId, true);

        coordinator.recordLocalCashResolved(settlementId, true);
        coordinator.recordLegResolved(
            _legVaa(settlementId, MessageCodec.MessageType.ASSET_HELD, "asset-held"),
            MessageCodec.MessageType.ASSET_HELD
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

    // ── Property ─────────────────────────────────────────────────────────────

    function testFuzz_AtMostOneDecisionSurvivesAnyOrdering(bool commitFirst, bool complianceFresh)
        public
    {
        bytes32 settlementId = _becomeReady();

        if (commitFirst) {
            if (complianceFresh) {
                _commit(settlementId, true);
            } else {
                vm.expectRevert(SettlementCoordinator.ComplianceNotFresh.selector);
                _commit(settlementId, false);
            }
            if (complianceFresh) {
                vm.expectRevert();
                coordinator.issueAbort(_intent(), settlementId, false, true, false, 1);
            }
        } else {
            coordinator.issueAbort(_intent(), settlementId, false, true, false, 1);
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

// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {CashEscrow} from "../src/CashEscrow.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {MessageCodec} from "../src/libraries/MessageCodec.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";
import {FeeOnTransferToken, MockAToken, RebasingToken} from "./mocks/TestTokens.sol";

/// @notice The cash leg, and the VAA checks that keep it safe.
///
/// PRD 15.3 requires adversarial cross-chain tests: duplicate VAA, wrong source
/// emitter, wrong chain, wrong deployment, and no refund after commit. Each one
/// below corresponds to a threat in the register rather than to a line of code,
/// because the question that matters is not "is this branch covered" but "can
/// this attack succeed".
contract CashEscrowTest is Test {
    CashEscrow private escrow;
    MockWormhole private wormhole;
    MockAToken private aToken;

    address private constant OWNER = address(0x0E7E4);
    address private constant PAYER = address(0x9A4E4);
    address private constant RECEIVER = address(0x4EC1E5);
    address private constant RELAYER = address(0x4E1A4);

    uint16 private constant LOCAL_WH_CHAIN = 10_009; // MonadTestnet
    uint16 private constant REMOTE_WH_CHAIN = 10_004; // BaseSepolia
    bytes32 private constant DEPLOYMENT_ID = keccak256("deployment-1");
    bytes32 private constant REMOTE_EMITTER = bytes32(uint256(uint160(address(0xC0FFEE))));
    bytes32 private constant SETTLEMENT_ID = keccak256("settlement-1");
    bytes32 private constant INTENT_HASH = keccak256("intent-1");

    uint256 private constant AMOUNT = 1000e6;

    function setUp() public {
        wormhole = new MockWormhole(LOCAL_WH_CHAIN);
        aToken = new MockAToken(6);
        escrow = new CashEscrow(
            address(aToken),
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            OWNER
        );

        aToken.mint(PAYER, AMOUNT * 10);
        vm.prank(PAYER);
        aToken.approve(address(escrow), type(uint256).max);
    }

    function _prepare() private {
        vm.prank(PAYER);
        escrow.prepareCash(SETTLEMENT_ID, INTENT_HASH, RECEIVER, AMOUNT, 84_532, 1);
    }

    function _vaa(MessageCodec.MessageType messageType) private view returns (bytes memory) {
        return
            _vaa(messageType, DEPLOYMENT_ID, REMOTE_WH_CHAIN, REMOTE_EMITTER, block.chainid, "v1");
    }

    function _vaa(
        MessageCodec.MessageType messageType,
        bytes32 deploymentId,
        uint16 emitterChain,
        bytes32 emitter,
        uint256 destinationChainId,
        string memory hashSeed
    ) private pure returns (bytes memory) {
        bytes memory payload = MessageCodec.encode(
            MessageCodec.Header({
                protocolVersion: MessageCodec.PROTOCOL_VERSION,
                messageType: messageType,
                deploymentId: deploymentId,
                settlementId: SETTLEMENT_ID,
                intentHash: INTENT_HASH,
                sourceChainId: 84_532,
                destinationChainId: destinationChainId,
                stateVersion: 2
            })
        );
        return _encodeVaa(emitterChain, emitter, payload, keccak256(abi.encodePacked(hashSeed)));
    }

    /// @dev Pure on purpose. An earlier version built VAAs through an external
    ///      call to the mock, and since Solidity evaluates arguments before the
    ///      call they belong to, that external call consumed `vm.expectRevert`
    ///      and every adversarial test reported "next call did not revert" while
    ///      the contract was behaving correctly.
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

    // ── Preparation ──────────────────────────────────────────────────────────

    function test_PrepareLocksExactAmountAndPublishes() public {
        _prepare();

        assertEq(aToken.balanceOf(address(escrow)), AMOUNT);
        assertEq(escrow.totalEscrowed(), AMOUNT);
        assertEq(wormhole.publishedCount(), 1, "CASH_PREPARED is published");

        CashEscrow.CashLeg memory leg = escrow.legOf(SETTLEMENT_ID);
        assertEq(uint8(leg.state), uint8(CashEscrow.LegState.PREPARED));
        assertEq(leg.amount, AMOUNT);
        assertEq(leg.receiver, RECEIVER);
    }

    function test_PublishedPayloadDecodesToTheExpectedHeader() public {
        _prepare();

        MessageCodec.Header memory header = MessageCodec.decode(wormhole.publishedAt(0).payload);
        assertEq(uint8(header.messageType), uint8(MessageCodec.MessageType.CASH_PREPARED));
        assertEq(header.deploymentId, DEPLOYMENT_ID);
        assertEq(header.settlementId, SETTLEMENT_ID);
        assertEq(header.intentHash, INTENT_HASH);
        assertEq(header.destinationChainId, 84_532);
    }

    function test_CashMayBePreparedOnlyOnce() public {
        _prepare();

        vm.prank(PAYER);
        vm.expectRevert(
            abi.encodeWithSelector(CashEscrow.LegAlreadyPrepared.selector, SETTLEMENT_ID)
        );
        escrow.prepareCash(SETTLEMENT_ID, INTENT_HASH, RECEIVER, AMOUNT, 84_532, 1);
    }

    function test_RejectsFeeOnTransferToken() public {
        // Escrowing 99 against an intent promising 100 would break conservation
        // for a counterparty owed the full amount, and only surface at release.
        FeeOnTransferToken fee = new FeeOnTransferToken(100); // 1%
        CashEscrow feeEscrow = new CashEscrow(
            address(fee),
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            OWNER
        );

        fee.mint(PAYER, AMOUNT);
        vm.startPrank(PAYER);
        fee.approve(address(feeEscrow), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(
                CashEscrow.InexactBalanceDelta.selector, AMOUNT, AMOUNT - (AMOUNT / 100)
            )
        );
        feeEscrow.prepareCash(SETTLEMENT_ID, INTENT_HASH, RECEIVER, AMOUNT, 84_532, 1);
        vm.stopPrank();
    }

    function test_RejectsRebasingToken() public {
        RebasingToken rebasing = new RebasingToken();
        CashEscrow rebaseEscrow = new CashEscrow(
            address(rebasing),
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            OWNER
        );

        rebasing.mint(PAYER, AMOUNT);
        rebasing.setRebaseGain(1); // credits an extra unit on receipt

        vm.startPrank(PAYER);
        rebasing.approve(address(rebaseEscrow), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(CashEscrow.InexactBalanceDelta.selector, AMOUNT, AMOUNT + 1)
        );
        rebaseEscrow.prepareCash(SETTLEMENT_ID, INTENT_HASH, RECEIVER, AMOUNT, 84_532, 1);
        vm.stopPrank();
    }

    function test_RejectsZeroAmountAndZeroReceiver() public {
        vm.startPrank(PAYER);
        vm.expectRevert(CashEscrow.AmountMustBePositive.selector);
        escrow.prepareCash(SETTLEMENT_ID, INTENT_HASH, RECEIVER, 0, 84_532, 1);

        vm.expectRevert(CashEscrow.ZeroAddress.selector);
        escrow.prepareCash(SETTLEMENT_ID, INTENT_HASH, address(0), AMOUNT, 84_532, 1);
        vm.stopPrank();
    }

    function test_PauseBlocksPreparationOnly() public {
        vm.prank(OWNER);
        escrow.setPreparationsPaused(true);

        vm.prank(PAYER);
        vm.expectRevert(CashEscrow.PreparationsArePaused.selector);
        escrow.prepareCash(SETTLEMENT_ID, INTENT_HASH, RECEIVER, AMOUNT, 84_532, 1);
    }

    function test_PauseCannotStrandCommittedValue() public {
        // PRD 8.2: an admin may pause new preparations and may never seize,
        // rewrite, or reverse an executed settlement. A pause that blocked
        // release would strand value that a canonical commit already assigned.
        _prepare();

        vm.prank(OWNER);
        escrow.setPreparationsPaused(true);

        vm.prank(RELAYER);
        escrow.releaseCash(_vaa(MessageCodec.MessageType.COMMIT), true);

        assertEq(aToken.balanceOf(RECEIVER), AMOUNT);
    }

    // ── Release, permissionless ──────────────────────────────────────────────

    function test_AnyoneMayRelayAValidCommit() public {
        _prepare();

        // PRD FR-009. The relayer is untrusted for correctness, so restricting
        // who may submit would add a liveness dependency for no safety gain.
        vm.prank(RELAYER);
        escrow.releaseCash(_vaa(MessageCodec.MessageType.COMMIT), true);

        assertEq(aToken.balanceOf(RECEIVER), AMOUNT);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(uint8(escrow.legOf(SETTLEMENT_ID).state), uint8(CashEscrow.LegState.RELEASED));
    }

    function test_IneligibleReceiverLeavesValueHeld() public {
        // PRD FR-010: the leg stays in escrow, is marked held, and no refund
        // path reopens.
        _prepare();

        vm.prank(RELAYER);
        escrow.releaseCash(_vaa(MessageCodec.MessageType.COMMIT), false);

        assertEq(aToken.balanceOf(RECEIVER), 0);
        assertEq(aToken.balanceOf(address(escrow)), AMOUNT, "value is conserved, not lost");
        assertEq(escrow.totalEscrowed(), AMOUNT);
        assertEq(uint8(escrow.legOf(SETTLEMENT_ID).state), uint8(CashEscrow.LegState.HELD));
    }

    function test_NoRefundAfterCommit() public {
        // Invariant I4, the whole point of the protocol.
        _prepare();

        vm.startPrank(RELAYER);
        escrow.releaseCash(_vaa(MessageCodec.MessageType.COMMIT), true);

        vm.expectRevert(
            abi.encodeWithSelector(
                CashEscrow.LegNotInState.selector,
                SETTLEMENT_ID,
                CashEscrow.LegState.RELEASED,
                CashEscrow.LegState.PREPARED
            )
        );
        escrow.returnCash(
            _vaa(
                MessageCodec.MessageType.ABORT,
                DEPLOYMENT_ID,
                REMOTE_WH_CHAIN,
                REMOTE_EMITTER,
                block.chainid,
                "abort-after-commit"
            ),
            true
        );
        vm.stopPrank();
    }

    function test_NoRefundAfterCommitEvenWhenHeld() public {
        _prepare();

        vm.startPrank(RELAYER);
        escrow.releaseCash(_vaa(MessageCodec.MessageType.COMMIT), false);

        vm.expectRevert();
        escrow.returnCash(
            _vaa(
                MessageCodec.MessageType.ABORT,
                DEPLOYMENT_ID,
                REMOTE_WH_CHAIN,
                REMOTE_EMITTER,
                block.chainid,
                "abort-after-held"
            ),
            true
        );
        vm.stopPrank();
    }

    // ── Abort ────────────────────────────────────────────────────────────────

    function test_AbortReturnsCashToPayer() public {
        _prepare();
        uint256 before = aToken.balanceOf(PAYER);

        vm.prank(RELAYER);
        escrow.returnCash(_vaa(MessageCodec.MessageType.ABORT), true);

        assertEq(aToken.balanceOf(PAYER) - before, AMOUNT);
        assertEq(escrow.totalEscrowed(), 0);
    }

    function test_IneligiblePayerOnAbortLeavesValueHeld() public {
        // PRD 5.2 step 7: a return recipient who is ineligible leaves the leg in
        // escrow and opens a disposition case.
        _prepare();

        vm.prank(RELAYER);
        escrow.returnCash(_vaa(MessageCodec.MessageType.ABORT), false);

        assertEq(escrow.totalEscrowed(), AMOUNT);
        assertEq(uint8(escrow.legOf(SETTLEMENT_ID).state), uint8(CashEscrow.LegState.HELD));
    }

    // ── Adversarial VAA handling (PRD 15.3) ─────────────────────────────────

    function test_RejectsReplayedVaa() public {
        // T-10. The same VAA delivered twice must move value once.
        _prepare();
        bytes memory vaa = _vaa(MessageCodec.MessageType.COMMIT);

        vm.startPrank(RELAYER);
        escrow.releaseCash(vaa, true);

        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.VaaAlreadyConsumed.selector, keccak256(abi.encodePacked("v1"))
            )
        );
        escrow.releaseCash(vaa, true);
        vm.stopPrank();

        assertEq(aToken.balanceOf(RECEIVER), AMOUNT, "value moved exactly once");
    }

    function test_RejectsWrongEmitterAddress() public {
        // T-11. An attacker who deploys identical code elsewhere still fails.
        _prepare();
        bytes32 impostor = bytes32(uint256(uint160(address(0xBADBEEF))));

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.UnexpectedEmitter.selector, impostor, REMOTE_EMITTER
            )
        );
        escrow.releaseCash(
            _vaa(
                MessageCodec.MessageType.COMMIT,
                DEPLOYMENT_ID,
                REMOTE_WH_CHAIN,
                impostor,
                block.chainid,
                "wrong-emitter"
            ),
            true
        );
    }

    function test_RejectsWrongEmitterChain() public {
        // T-12. The peer address alone is not enough: the same address exists on
        // other chains, as aUSDC on Monad and Base demonstrates.
        _prepare();

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.UnexpectedEmitterChain.selector, uint16(2), REMOTE_WH_CHAIN
            )
        );
        escrow.releaseCash(
            _vaa(
                MessageCodec.MessageType.COMMIT,
                DEPLOYMENT_ID,
                2,
                REMOTE_EMITTER,
                block.chainid,
                "wrong-chain"
            ),
            true
        );
    }

    function test_RejectsWrongDeploymentId() public {
        // T-13. A valid message from a different deployment of the same code.
        _prepare();
        bytes32 other = keccak256("deployment-2");

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.UnexpectedDeployment.selector, other, DEPLOYMENT_ID
            )
        );
        escrow.releaseCash(
            _vaa(
                MessageCodec.MessageType.COMMIT,
                other,
                REMOTE_WH_CHAIN,
                REMOTE_EMITTER,
                block.chainid,
                "wrong-deployment"
            ),
            true
        );
    }

    function test_RejectsMessageAddressedToAnotherChain() public {
        _prepare();

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.UnexpectedDestinationChain.selector, uint256(999), block.chainid
            )
        );
        escrow.releaseCash(
            _vaa(
                MessageCodec.MessageType.COMMIT,
                DEPLOYMENT_ID,
                REMOTE_WH_CHAIN,
                REMOTE_EMITTER,
                999,
                "wrong-destination"
            ),
            true
        );
    }

    function test_RejectsWrongMessageType() public {
        // An ABORT must never be consumable as a COMMIT.
        _prepare();

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.UnexpectedMessageType.selector,
                MessageCodec.MessageType.ABORT,
                MessageCodec.MessageType.COMMIT
            )
        );
        escrow.releaseCash(_vaa(MessageCodec.MessageType.ABORT), true);
    }

    function test_RejectsVaaTheCoreContractDeclaresInvalid() public {
        _prepare();
        wormhole.setValid(false, "guardian quorum not met");

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(WormholeTransport.VaaInvalid.selector, "guardian quorum not met")
        );
        escrow.releaseCash(_vaa(MessageCodec.MessageType.COMMIT), true);
    }

    function test_RejectsIntentHashMismatch() public {
        // Invariant I7: both legs bind the same intent hash.
        _prepare();

        bytes memory payload = MessageCodec.encode(
            MessageCodec.Header({
                protocolVersion: MessageCodec.PROTOCOL_VERSION,
                messageType: MessageCodec.MessageType.COMMIT,
                deploymentId: DEPLOYMENT_ID,
                settlementId: SETTLEMENT_ID,
                intentHash: keccak256("a-different-intent"),
                sourceChainId: 84_532,
                destinationChainId: block.chainid,
                stateVersion: 2
            })
        );
        bytes memory vaa =
            wormhole.encodeVaa(REMOTE_WH_CHAIN, REMOTE_EMITTER, 1, payload, keccak256("mismatch"));

        vm.prank(RELAYER);
        vm.expectRevert();
        escrow.releaseCash(vaa, true);
    }

    function test_RejectsUnknownSettlement() public {
        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSelector(CashEscrow.LegUnknown.selector, SETTLEMENT_ID));
        escrow.releaseCash(_vaa(MessageCodec.MessageType.COMMIT), true);
    }

    // ── Peer wiring ──────────────────────────────────────────────────────────

    function test_NoVaaIsConsumableBeforeThePeerIsSet() public {
        // The first side of a pair deploys without knowing its peer. Until the
        // peer is fixed, the emitter check would compare against bytes32(0) and
        // be vacuous, so consumption is refused outright.
        CashEscrow unwired = new CashEscrow(
            address(aToken),
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            bytes32(0),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            OWNER
        );

        assertFalse(unwired.remotePeerLocked());

        vm.prank(RELAYER);
        vm.expectRevert(WormholeTransport.RemotePeerNotSet.selector);
        unwired.releaseCash(_vaa(MessageCodec.MessageType.COMMIT), true);
    }

    function test_PeerMayBeSetOnceAndNeverAgain() public {
        CashEscrow unwired = new CashEscrow(
            address(aToken),
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            bytes32(0),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            OWNER
        );

        vm.prank(OWNER);
        unwired.setRemotePeer(REMOTE_EMITTER);
        assertEq(unwired.remoteEmitter(), REMOTE_EMITTER);
        assertTrue(unwired.remotePeerLocked());

        // Not even the owner can move it afterwards.
        vm.prank(OWNER);
        vm.expectRevert(WormholeTransport.RemotePeerAlreadyLocked.selector);
        unwired.setRemotePeer(bytes32(uint256(uint160(address(0xBADBEEF)))));
    }

    function test_PeerCannotBeSetToZero() public {
        CashEscrow unwired = new CashEscrow(
            address(aToken),
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            bytes32(0),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            OWNER
        );

        vm.prank(OWNER);
        vm.expectRevert(WormholeTransport.RemotePeerCannotBeZero.selector);
        unwired.setRemotePeer(bytes32(0));
    }

    function test_OnlyOwnerMaySetThePeer() public {
        CashEscrow unwired = new CashEscrow(
            address(aToken),
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            bytes32(0),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            OWNER
        );

        vm.prank(RELAYER);
        vm.expectRevert();
        unwired.setRemotePeer(REMOTE_EMITTER);
    }

    function test_AConstructedPeerIsAlreadyLocked() public {
        // The second side of the pair knows its peer at construction and must
        // not be re-settable.
        assertTrue(escrow.remotePeerLocked());

        vm.prank(OWNER);
        vm.expectRevert(WormholeTransport.RemotePeerAlreadyLocked.selector);
        escrow.setRemotePeer(bytes32(uint256(uint160(address(0xBADBEEF)))));
    }

    // ── Rescue ───────────────────────────────────────────────────────────────

    function test_RescueCannotTouchTheSettlementAsset() public {
        // PRD 8.5 permits rescue only for unsupported tokens sent by accident.
        _prepare();

        vm.prank(OWNER);
        vm.expectRevert();
        escrow.rescueUnsupportedToken(address(aToken), OWNER, AMOUNT);
    }

    function test_RescueRecoversAnUnrelatedToken() public {
        MockAToken stray = new MockAToken(18);
        stray.mint(address(escrow), 5e18);

        vm.prank(OWNER);
        escrow.rescueUnsupportedToken(address(stray), OWNER, 5e18);

        assertEq(stray.balanceOf(OWNER), 5e18);
    }

    // ── Conservation ─────────────────────────────────────────────────────────

    function testFuzz_EscrowBalanceAlwaysCoversAccountedValue(uint96 amount, bool eligible) public {
        uint256 locked = bound(uint256(amount), 1, AMOUNT * 5);

        vm.prank(PAYER);
        escrow.prepareCash(SETTLEMENT_ID, INTENT_HASH, RECEIVER, locked, 84_532, 1);

        assertEq(escrow.totalEscrowed(), locked);
        assertGe(aToken.balanceOf(address(escrow)), escrow.totalEscrowed());

        vm.prank(RELAYER);
        escrow.releaseCash(_vaa(MessageCodec.MessageType.COMMIT), eligible);

        // Invariant I1: whether released or held, the token balance never falls
        // below what the contract says it is accounting for.
        assertGe(
            aToken.balanceOf(address(escrow)),
            escrow.totalEscrowed(),
            "I1: accounted value is always backed"
        );
        assertEq(aToken.balanceOf(RECEIVER), eligible ? locked : 0);
    }
}

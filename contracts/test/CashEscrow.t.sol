// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {CashEscrow} from "../src/CashEscrow.sol";
import {ComplianceAuthority} from "../src/ComplianceAuthority.sol";
import {SettlementCoordinator} from "../src/SettlementCoordinator.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {ComplianceAttestationLib} from "../src/libraries/ComplianceAttestationLib.sol";
import {MessageCodec} from "../src/libraries/MessageCodec.sol";
import {ComplianceFixture} from "./helpers/ComplianceFixture.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";
import {FeeOnTransferToken, MockAToken, RebasingToken} from "./mocks/TestTokens.sol";

/// @notice The cash leg, and the VAA checks that keep it safe.
///
/// PRD 15.3 requires adversarial cross-chain tests: duplicate VAA, wrong source
/// emitter, wrong chain, wrong deployment, and no refund after commit. Each one
/// below corresponds to a threat in the register rather than to a line of code,
/// because the question that matters is not "is this branch covered" but "can
/// this attack succeed".
contract CashEscrowTest is ComplianceFixture {
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
    uint64 private constant MAX_ATTESTATION_VALIDITY = 15 minutes;

    /// @dev The canonical decision lives on the coordinator, and these are unit
    ///      tests for the escrow. Mocking it keeps each test about one contract
    ///      and makes the dependency visible at the call site rather than buried
    ///      in a fixture. The real seam — a decision the coordinator actually
    ///      reached, driving a release — is `CashSettlementSeam.t.sol`, and it
    ///      exists because fabricating the coordinator's output here is what hid
    ///      a release path that could never have run.
    address private constant COORDINATOR = address(0xC00D);

    /// @dev Cached so a helper cannot consume a pending `vm.expectRevert` by
    ///      reading it off the escrow.
    bytes32 private attestationDomain;

    function setUp() public {
        wormhole = new MockWormhole(LOCAL_WH_CHAIN);
        aToken = new MockAToken(6);
        escrow = new CashEscrow(
            address(aToken),
            COORDINATOR,
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            MAX_ATTESTATION_VALIDITY,
            OWNER
        );

        attestationDomain = escrow.attestationDomainSeparator();

        // `prepareCash` now reports the preparation to the coordinator in the
        // same transaction that takes the cash, so the stand-in needs code for
        // the call to land. A bare STOP is enough: these are unit tests for the
        // escrow, and what the coordinator does with the report is proven
        // against the real contract in `CrossChainSettlementSeam.t.sol`.
        vm.etch(COORDINATOR, hex"00");

        vm.startPrank(OWNER);
        escrow.addComplianceSigner(_signerA());
        escrow.addComplianceSigner(_signerB());
        escrow.setComplianceQuorum(2);
        vm.stopPrank();

        aToken.mint(PAYER, AMOUNT * 10);
        vm.prank(PAYER);
        aToken.approve(address(escrow), type(uint256).max);
    }

    /// @dev The quorum's answer about one subject for this settlement. A
    ///      shortfall is what drives the held path; a forged proof still reverts.
    function _proofFor(address subject, bool eligible)
        private
        view
        returns (ComplianceAuthority.ComplianceProof memory)
    {
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            attestationDomain,
            _keys(SIGNER_A_KEY, SIGNER_B_KEY),
            SETTLEMENT_ID,
            INTENT_HASH,
            _subjects(subject),
            eligible
        );
        return ComplianceAuthority.ComplianceProof(attestations, signatures);
    }

    function test_AnUnconfiguredAuthorityHoldsRatherThanReleases() public {
        // Fails closed, and closed here means held rather than reverted: after a
        // COMMIT there is no refund, so a revert would strand the cash instead of
        // sending it down the disposition path.
        CashEscrow fresh = new CashEscrow(
            address(aToken),
            COORDINATOR,
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            MAX_ATTESTATION_VALIDITY,
            OWNER
        );
        assertEq(fresh.complianceQuorum(), 0);

        vm.startPrank(PAYER);
        aToken.approve(address(fresh), type(uint256).max);
        fresh.prepareCash(SETTLEMENT_ID, INTENT_HASH, RECEIVER, AMOUNT, 84_532, 1);
        vm.stopPrank();

        _committed();

        (
            ComplianceAttestationLib.ComplianceAttestation[] memory none,
            bytes[] memory noSignatures
        ) = _noAttestations();

        vm.prank(RELAYER);
        fresh.releaseCash(SETTLEMENT_ID, ComplianceAuthority.ComplianceProof(none, noSignatures));

        assertEq(aToken.balanceOf(RECEIVER), 0);
        assertEq(uint8(fresh.legOf(SETTLEMENT_ID).state), uint8(CashEscrow.LegState.HELD));
    }

    function _decide(SettlementCoordinator.Decision decision, bytes32 intentHash) private {
        SettlementCoordinator.Settlement memory settlement;
        settlement.decision = decision;
        settlement.intentHash = intentHash;
        vm.mockCall(
            COORDINATOR,
            abi.encodeWithSelector(SettlementCoordinator.settlementOf.selector, SETTLEMENT_ID),
            abi.encode(settlement)
        );
    }

    function _committed() private {
        _decide(SettlementCoordinator.Decision.COMMIT, INTENT_HASH);
    }

    function _aborted() private {
        _decide(SettlementCoordinator.Decision.ABORT, INTENT_HASH);
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
            COORDINATOR,
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            MAX_ATTESTATION_VALIDITY,
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
            COORDINATOR,
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            MAX_ATTESTATION_VALIDITY,
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
        _committed();

        vm.prank(OWNER);
        escrow.setPreparationsPaused(true);

        vm.prank(RELAYER);
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, true));

        assertEq(aToken.balanceOf(RECEIVER), AMOUNT);
    }

    // ── Release, permissionless ──────────────────────────────────────────────

    function test_AnyoneMayRelayAValidCommit() public {
        _prepare();
        _committed();

        // PRD FR-009. The relayer is untrusted for correctness, so restricting
        // who may submit would add a liveness dependency for no safety gain.
        vm.prank(RELAYER);
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, true));

        assertEq(aToken.balanceOf(RECEIVER), AMOUNT);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(uint8(escrow.legOf(SETTLEMENT_ID).state), uint8(CashEscrow.LegState.RELEASED));
    }

    function test_IneligibleReceiverLeavesValueHeld() public {
        // PRD FR-010: the leg stays in escrow, is marked held, and no refund
        // path reopens.
        _prepare();
        _committed();

        vm.prank(RELAYER);
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, false));

        assertEq(aToken.balanceOf(RECEIVER), 0);
        assertEq(aToken.balanceOf(address(escrow)), AMOUNT, "value is conserved, not lost");
        assertEq(escrow.totalEscrowed(), AMOUNT);
        assertEq(uint8(escrow.legOf(SETTLEMENT_ID).state), uint8(CashEscrow.LegState.HELD));
    }

    function test_NoRefundAfterCommit() public {
        // Invariant I4, the whole point of the protocol.
        _prepare();
        _committed();

        vm.startPrank(RELAYER);
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, true));

        vm.expectRevert(
            abi.encodeWithSelector(
                CashEscrow.LegNotInState.selector,
                SETTLEMENT_ID,
                CashEscrow.LegState.RELEASED,
                CashEscrow.LegState.PREPARED
            )
        );
        escrow.returnCash(SETTLEMENT_ID, _proofFor(PAYER, true));
        vm.stopPrank();
    }

    function test_NoRefundAfterCommitEvenWhenHeld() public {
        _prepare();
        _committed();

        vm.startPrank(RELAYER);
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, false));

        vm.expectRevert();
        escrow.returnCash(SETTLEMENT_ID, _proofFor(PAYER, true));
        vm.stopPrank();
    }

    // ── Abort ────────────────────────────────────────────────────────────────

    function test_AbortReturnsCashToPayer() public {
        _prepare();
        _aborted();
        uint256 before = aToken.balanceOf(PAYER);

        vm.prank(RELAYER);
        escrow.returnCash(SETTLEMENT_ID, _proofFor(PAYER, true));

        assertEq(aToken.balanceOf(PAYER) - before, AMOUNT);
        assertEq(escrow.totalEscrowed(), 0);
    }

    function test_IneligiblePayerOnAbortLeavesValueHeld() public {
        // PRD 5.2 step 7: a return recipient who is ineligible leaves the leg in
        // escrow and opens a disposition case.
        _prepare();
        _aborted();

        vm.prank(RELAYER);
        escrow.returnCash(SETTLEMENT_ID, _proofFor(PAYER, false));

        assertEq(escrow.totalEscrowed(), AMOUNT);
        assertEq(uint8(escrow.legOf(SETTLEMENT_ID).state), uint8(CashEscrow.LegState.HELD));
    }

    // ── Adversarial VAA handling (PRD 15.3) ─────────────────────────────────

    function test_ReleasingTwiceMovesValueOnce() public {
        // T-10 in its current form. Replay used to be prevented by burning the
        // VAA; the release path no longer consumes one, so the leg's own state
        // is what stops the second attempt. Same property, enforced closer to
        // the value it protects.
        _prepare();
        _committed();

        vm.startPrank(RELAYER);
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, true));

        vm.expectRevert(
            abi.encodeWithSelector(
                CashEscrow.LegNotInState.selector,
                SETTLEMENT_ID,
                CashEscrow.LegState.RELEASED,
                CashEscrow.LegState.PREPARED
            )
        );
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, true));
        vm.stopPrank();

        assertEq(aToken.balanceOf(RECEIVER), AMOUNT, "value moved exactly once");
    }

    function test_AnAbortDecisionCannotDriveARelease() public {
        // Was "rejects the wrong message type", a property of the wire format.
        // The release no longer reads a message, so the question becomes whether
        // the canonical decision permits this direction — which is the thing
        // that actually mattered all along.
        _prepare();
        _aborted();

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(CashEscrow.ReleaseRequiresCommit.selector, SETTLEMENT_ID)
        );
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, true));
    }

    function test_ACommitDecisionCannotDriveAReturn() public {
        // Invariant I4 at the point of payment: no refund after COMMIT.
        _prepare();
        _committed();

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(CashEscrow.ReturnRequiresAbort.selector, SETTLEMENT_ID)
        );
        escrow.returnCash(SETTLEMENT_ID, _proofFor(PAYER, true));
    }

    function test_AnUndecidedSettlementReleasesNothing() public {
        // The coordinator has reached no decision, so neither direction is open.
        _prepare();
        _decide(SettlementCoordinator.Decision.NONE, INTENT_HASH);

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(CashEscrow.ReleaseRequiresCommit.selector, SETTLEMENT_ID)
        );
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, true));
    }

    function test_TermsMustStillMatchWhatTheCoordinatorDecided() public {
        // The leg was prepared against one intent and the coordinator decided on
        // another. Releasing anyway would pay out on terms nobody agreed to.
        _prepare();
        _decide(SettlementCoordinator.Decision.COMMIT, keccak256("some-other-intent"));

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                CashEscrow.IntentHashMismatch.selector, keccak256("some-other-intent"), INTENT_HASH
            )
        );
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, true));
    }

    function test_TermsAreCheckedAgainstTheDecision() public {
        // Was a header-mismatch test against a hand-built VAA. The release reads
        // the coordinator now, so the equivalent question is whether the terms
        // the leg was prepared under still match the ones that were decided.
        _prepare();
        _decide(SettlementCoordinator.Decision.COMMIT, keccak256("renegotiated"));

        vm.prank(RELAYER);
        vm.expectRevert();
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, true));
    }

    function test_RejectsUnknownSettlement() public {
        vm.prank(RELAYER);
        vm.expectRevert(abi.encodeWithSelector(CashEscrow.LegUnknown.selector, SETTLEMENT_ID));
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, true));
    }

    // ── Peer wiring ──────────────────────────────────────────────────────────

    function test_PeerMayBeSetOnceAndNeverAgain() public {
        CashEscrow unwired = new CashEscrow(
            address(aToken),
            COORDINATOR,
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            bytes32(0),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            MAX_ATTESTATION_VALIDITY,
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
            COORDINATOR,
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            bytes32(0),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            MAX_ATTESTATION_VALIDITY,
            OWNER
        );

        vm.prank(OWNER);
        vm.expectRevert(WormholeTransport.RemotePeerCannotBeZero.selector);
        unwired.setRemotePeer(bytes32(0));
    }

    function test_OnlyOwnerMaySetThePeer() public {
        CashEscrow unwired = new CashEscrow(
            address(aToken),
            COORDINATOR,
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            bytes32(0),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            MAX_ATTESTATION_VALIDITY,
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
        _committed();

        assertEq(escrow.totalEscrowed(), locked);
        assertGe(aToken.balanceOf(address(escrow)), escrow.totalEscrowed());

        vm.prank(RELAYER);
        escrow.releaseCash(SETTLEMENT_ID, _proofFor(RECEIVER, eligible));

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

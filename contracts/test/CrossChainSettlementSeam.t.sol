// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {CashEscrow} from "../src/CashEscrow.sol";
import {ComplianceAuthority} from "../src/ComplianceAuthority.sol";
import {ConduitRWACVA} from "../src/ConduitRWACVA.sol";
import {RWACVASettlementAdapter} from "../src/RWACVASettlementAdapter.sol";
import {SettlementCoordinator} from "../src/SettlementCoordinator.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {ComplianceAttestationLib} from "../src/libraries/ComplianceAttestationLib.sol";
import {MessageCodec} from "../src/libraries/MessageCodec.sol";
import {SettlementIntentLib} from "../src/libraries/SettlementIntentLib.sol";
import {ComplianceFixture} from "./helpers/ComplianceFixture.sol";
import {MockATokenPolicy} from "./mocks/MockATokenPolicy.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";
import {MockAToken} from "./mocks/TestTokens.sol";

/// @notice Both legs, both chains, one settlement, and nothing invented.
///
/// `CashSettlementSeam.t.sol` did this for the cash leg and found three defects
/// in an hour that ninety unit tests had missed. ADR-0015 recorded why: a unit
/// test's fixture is written by the same person, at the same time, with the same
/// wrong belief about what the other side emits, so the class of defect where two
/// contracts each behave correctly against an imagined counterparty is invisible
/// to it by construction. It also recorded that the asset leg had not had the
/// equivalent scrutiny and must be assumed to carry the same class of defect
/// until a producer-originated test says otherwise.
///
/// This is that test. Every protocol message here is the exact payload a
/// production contract emitted, captured from its core contract and carried
/// across unchanged:
///
/// ```text
///   CashEscrow.prepareCash          → coordinator, same chain, no VAA
///   RWACVASettlementAdapter         → ASSET_PREPARED  → SettlementCoordinator
///   SettlementCoordinator           → COMMIT / ABORT  → RWACVASettlementAdapter
///   RWACVASettlementAdapter         → ASSET_RELEASED  → SettlementCoordinator
///                                   → ASSET_HELD
/// ```
///
/// The two chains are real chain IDs, switched with `vm.chainId`, because the
/// destination check and both EIP-712 domains are bound to `block.chainid` and a
/// single-chain harness would make three of the seven transport checks vacuous.
/// Each chain has its own core contract. `_relay` is plumbing: it copies the
/// producer's bytes and the producer's consistency level, and authors neither.
///
/// Hostile payloads appear only where the payload itself is the subject, and
/// those tests say so in their names.
contract CrossChainSettlementSeamTest is ComplianceFixture {
    // ── The two chains ───────────────────────────────────────────────────────

    uint256 private constant MONAD = 10_143;
    uint256 private constant BASE = 84_532;
    uint16 private constant MONAD_WH = 10_009;
    uint16 private constant BASE_WH = 10_004;

    bytes32 private constant DEPLOYMENT_ID = keccak256("conduit-cross-chain-seam");

    MockWormhole private monadCore;
    MockWormhole private baseCore;

    SettlementCoordinator private coordinator;
    CashEscrow private escrow;
    MockAToken private cash;

    ConduitRWACVA private rwa;
    RWACVASettlementAdapter private adapter;
    MockATokenPolicy private policy;

    uint256 private constant BUYER_KEY = 0xB0FFEE;
    uint256 private constant SELLER_KEY = 0x5E11E4;
    address private buyer;
    address private seller;

    address private constant OWNER = address(0x0E7E4);
    address private constant RELAYER = address(0x4E1A4);
    address private constant ATTACKER = address(0xBAD);

    uint256 private constant CASH_AMOUNT = 25_000e6;
    uint256 private constant ASSET_AMOUNT = 500e3;
    uint256 private constant ASSET_SUPPLY = 2000e3;

    bytes32 private coordinatorDomain;
    bytes32 private escrowDomain;
    bytes32 private adapterDomain;

    /// @dev Fixed at construction rather than derived from `block.timestamp` in
    ///      `_intent()`. A test that warps past the commit deadline would
    ///      otherwise recompute a different intent, and therefore a different
    ///      settlement ID, and fail with `IntentDoesNotMatchSettlementId` — which
    ///      looks like a binding defect and is the test moving the goalposts.
    uint64 private prepareDeadline;
    uint64 private commitDeadline;
    uint64 private releaseDeadline;

    function setUp() public {
        buyer = vm.addr(BUYER_KEY);
        seller = vm.addr(SELLER_KEY);
        prepareDeadline = uint64(block.timestamp + 1 hours);
        commitDeadline = uint64(block.timestamp + 2 hours);
        releaseDeadline = uint64(block.timestamp + 3 hours);

        // ── Monad: the cash leg and the canonical decision ───────────────────
        vm.chainId(MONAD);
        monadCore = new MockWormhole(MONAD_WH);
        cash = new MockAToken(6);

        // Deployed with a zero peer, exactly as production does: the two sides
        // reference each other and the first cannot know the second.
        coordinator = new SettlementCoordinator(
            address(monadCore),
            DEPLOYMENT_ID,
            MONAD_WH,
            BASE_WH,
            bytes32(0),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            15 minutes,
            OWNER,
            "Conduit",
            "1"
        );
        escrow = new CashEscrow(
            address(cash),
            address(coordinator),
            address(monadCore),
            DEPLOYMENT_ID,
            MONAD_WH,
            BASE_WH,
            bytes32(0),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            15 minutes,
            OWNER
        );

        // ── Base: the restricted asset ───────────────────────────────────────
        vm.chainId(BASE);
        baseCore = new MockWormhole(BASE_WH);
        policy = new MockATokenPolicy();
        rwa = new ConduitRWACVA("Conduit Bond", "cBOND", 6, address(policy), OWNER);
        adapter = new RWACVASettlementAdapter(
            address(rwa),
            address(baseCore),
            DEPLOYMENT_ID,
            BASE_WH,
            MONAD_WH,
            _emitter(address(coordinator)),
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            15 minutes,
            OWNER
        );

        adapterDomain = adapter.attestationDomainSeparator();

        vm.startPrank(OWNER);
        rwa.grantRole(rwa.MINTER_ROLE(), OWNER);
        rwa.grantRole(rwa.SETTLEMENT_ROLE(), address(adapter));
        rwa.mint(seller, ASSET_SUPPLY);
        adapter.addComplianceSigner(_signerA());
        adapter.setComplianceQuorum(1);
        vm.stopPrank();

        // ── Back to Monad to close the peer loop ─────────────────────────────
        vm.chainId(MONAD);
        coordinatorDomain = coordinator.attestationDomainSeparator();
        escrowDomain = escrow.attestationDomainSeparator();

        vm.startPrank(OWNER);
        coordinator.setRemotePeer(_emitter(address(adapter)));
        escrow.setRemotePeer(_emitter(address(adapter)));
        coordinator.setCashEscrow(address(escrow));
        coordinator.addComplianceSigner(_signerA());
        coordinator.setComplianceQuorum(1);
        escrow.addComplianceSigner(_signerA());
        escrow.setComplianceQuorum(1);
        vm.stopPrank();

        cash.mint(buyer, CASH_AMOUNT * 4);
        vm.prank(buyer);
        cash.approve(address(escrow), type(uint256).max);
    }

    // ── Transport plumbing, and nothing more ─────────────────────────────────

    function _emitter(address account) private pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    /// @notice Wraps a message a production contract actually published.
    ///
    /// @dev The payload and the consistency level are copied from the producer's
    ///      core contract. This function chooses neither, which is the whole
    ///      point of ADR-0015: a helper that authored a "valid COMMIT" would be
    ///      the invented message with fewer copies of it.
    function _relay(MockWormhole core, uint16 emitterChain, address emitterAddress, uint256 index)
        private
        view
        returns (bytes memory)
    {
        MockWormhole.Published memory published = core.publishedAt(index);
        IWormhole.VM memory vaa = IWormhole.VM({
            version: 1,
            timestamp: 0,
            nonce: published.nonce,
            emitterChainId: emitterChain,
            emitterAddress: _emitter(emitterAddress),
            // casting to 'uint64' is safe because the index is a position in a
            // test's own publication log, bounded by the messages it sent
            // forge-lint: disable-next-line(unsafe-typecast)
            sequence: uint64(index),
            consistencyLevel: published.consistencyLevel,
            payload: published.payload,
            guardianSetIndex: 0,
            signatures: new IWormhole.Signature[](0),
            hash: keccak256(abi.encodePacked(emitterAddress, index, published.payload))
        });
        return abi.encode(vaa);
    }

    function _fromBase(uint256 index) private view returns (bytes memory) {
        return _relay(baseCore, BASE_WH, address(adapter), index);
    }

    function _fromMonad(uint256 index) private view returns (bytes memory) {
        return _relay(monadCore, MONAD_WH, address(coordinator), index);
    }

    // ── The intent both chains agree on ──────────────────────────────────────

    function _intent() private view returns (SettlementIntentLib.SettlementIntent memory) {
        return SettlementIntentLib.SettlementIntent({
            version: 1,
            cashChainId: MONAD,
            cashEscrow: address(escrow),
            cashAsset: address(cash),
            cashAmount: CASH_AMOUNT,
            cashPayer: buyer,
            cashReceiver: seller,
            assetChainId: BASE,
            assetEscrow: address(rwa),
            assetToken: address(rwa),
            assetAmount: ASSET_AMOUNT,
            assetSeller: seller,
            assetReceiver: buyer,
            cashPolicyHash: keccak256("cash-policy"),
            assetPolicyHash: keccak256("asset-policy"),
            prepareDeadline: prepareDeadline,
            commitDeadline: commitDeadline,
            releaseDeadline: releaseDeadline,
            nonce: 7
        });
    }

    function _settlementId() private view returns (bytes32) {
        return SettlementIntentLib.digest(_intent(), coordinator.domainSeparator());
    }

    function _sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _proof(bytes32 domain, bytes32 settlementId, address subject, bool eligible)
        private
        view
        returns (ComplianceAuthority.ComplianceProof memory)
    {
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            domain, _keys(SIGNER_A_KEY), settlementId, settlementId, _subjects(subject), eligible
        );
        return ComplianceAuthority.ComplianceProof(attestations, signatures);
    }

    function _commitProof(bytes32 settlementId)
        private
        view
        returns (ComplianceAuthority.ComplianceProof memory)
    {
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            coordinatorDomain,
            _keys(SIGNER_A_KEY),
            settlementId,
            settlementId,
            _subjects(buyer, seller),
            true
        );
        return ComplianceAuthority.ComplianceProof(attestations, signatures);
    }

    // ── The stages, each driven by the real producer ─────────────────────────

    /// @dev Base: the seller reserves and the adapter announces. Returns the
    ///      index of the ASSET_PREPARED message in Base's core contract.
    function _prepareAssetLeg(bytes32 settlementId) private returns (uint256 index) {
        vm.chainId(BASE);
        index = baseCore.publishedCount();
        vm.startPrank(seller);
        rwa.reserveForSettlement(settlementId, ASSET_AMOUNT);
        adapter.prepareAsset(settlementId, settlementId, buyer, MONAD, 1);
        vm.stopPrank();
    }

    /// @dev Monad: the buyer funds the escrow. The coordinator learns about the
    ///      cash leg from the escrow, not from whoever calls next.
    function _prepareCashLeg(bytes32 settlementId) private {
        vm.chainId(MONAD);
        vm.prank(buyer);
        escrow.prepareCash(settlementId, settlementId, seller, CASH_AMOUNT, BASE, 1);
    }

    function _deliverAssetPrepared(uint256 index) private {
        vm.chainId(MONAD);
        vm.prank(RELAYER);
        coordinator.recordAssetPrepared(_fromBase(index));
    }

    function _issueCommit(bytes32 settlementId) private returns (uint256 index) {
        vm.chainId(MONAD);
        index = monadCore.publishedCount();
        vm.prank(RELAYER);
        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(BUYER_KEY, settlementId),
            _sign(SELLER_KEY, settlementId),
            _commitProof(settlementId),
            1
        );
    }

    /// @dev Both legs prepared, both recorded, READY.
    function _ready() private returns (bytes32 settlementId, uint256 preparedIndex) {
        settlementId = _settlementId();
        preparedIndex = _prepareAssetLeg(settlementId);
        _prepareCashLeg(settlementId);
        _deliverAssetPrepared(preparedIndex);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1–4. Preparation through the canonical decision
    // ─────────────────────────────────────────────────────────────────────────

    function test_01_TheEscrowIsWhatTellsTheCoordinatorTheCashArrived() public {
        bytes32 settlementId = _settlementId();
        _prepareCashLeg(settlementId);

        SettlementCoordinator.Settlement memory state = coordinator.settlementOf(settlementId);
        assertTrue(
            state.cashPrepared, "the coordinator heard it from the contract holding the cash"
        );
        assertEq(uint8(state.state), uint8(SettlementCoordinator.SettlementState.CASH_PREPARED));
        assertEq(cash.balanceOf(address(escrow)), CASH_AMOUNT, "and the cash is actually there");
    }

    function test_02_TheAdaptersOwnAssetPreparedMessageReachesTheCoordinator() public {
        bytes32 settlementId = _settlementId();
        uint256 index = _prepareAssetLeg(settlementId);
        _deliverAssetPrepared(index);

        SettlementCoordinator.Settlement memory state = coordinator.settlementOf(settlementId);
        assertTrue(state.assetPrepared);
        assertEq(uint8(state.state), uint8(SettlementCoordinator.SettlementState.ASSET_PREPARED));
        assertEq(rwa.reservedBalanceOf(seller), ASSET_AMOUNT, "and the units are genuinely locked");
        assertEq(rwa.availableBalanceOf(seller), ASSET_SUPPLY - ASSET_AMOUNT);
    }

    function test_03_BothLegsPreparedReachesReady() public {
        (bytes32 settlementId,) = _ready();
        assertEq(
            uint8(coordinator.settlementOf(settlementId).state),
            uint8(SettlementCoordinator.SettlementState.READY)
        );
    }

    function test_04_ReadyReachesCommit() public {
        (bytes32 settlementId,) = _ready();
        _issueCommit(settlementId);

        SettlementCoordinator.Settlement memory state = coordinator.settlementOf(settlementId);
        assertEq(uint8(state.decision), uint8(SettlementCoordinator.Decision.COMMIT));
        assertEq(uint8(state.state), uint8(SettlementCoordinator.SettlementState.COMMIT_ISSUED));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5–7. Both legs release, and the settlement finishes
    // ─────────────────────────────────────────────────────────────────────────

    function test_05_CommitReleasesTheCash() public {
        (bytes32 settlementId,) = _ready();
        _issueCommit(settlementId);

        vm.prank(RELAYER);
        escrow.releaseCash(settlementId, _proof(escrowDomain, settlementId, seller, true));

        assertEq(cash.balanceOf(seller), CASH_AMOUNT);
        assertEq(escrow.totalEscrowed(), 0);
    }

    function test_06_TheCoordinatorsOwnCommitMessageReleasesTheAsset() public {
        (bytes32 settlementId,) = _ready();
        uint256 commitIndex = _issueCommit(settlementId);

        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.releaseAsset(
            _fromMonad(commitIndex), _proof(adapterDomain, settlementId, buyer, true)
        );

        assertEq(rwa.balanceOf(buyer), ASSET_AMOUNT, "the buyer holds the bond");
        assertEq(rwa.reservedBalanceOf(seller), 0);
        assertTrue(rwa.reservationOf(settlementId).released);
    }

    function test_07_BothLegsReportingBackReachesSettled() public {
        (bytes32 settlementId,) = _ready();
        uint256 commitIndex = _issueCommit(settlementId);

        vm.prank(RELAYER);
        escrow.releaseCash(settlementId, _proof(escrowDomain, settlementId, seller, true));

        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.releaseAsset(
            _fromMonad(commitIndex), _proof(adapterDomain, settlementId, buyer, true)
        );

        uint256 reportIndex = baseCore.publishedCount();
        vm.prank(RELAYER);
        adapter.reportResolution(settlementId, MONAD, 1);

        vm.chainId(MONAD);
        vm.prank(RELAYER);
        coordinator.recordLegResolved(
            _fromBase(reportIndex),
            MessageCodec.MessageType.ASSET_RELEASED,
            SettlementCoordinator.LegOutcome.RELEASED
        );

        SettlementCoordinator.Settlement memory state = coordinator.settlementOf(settlementId);
        assertEq(uint8(state.state), uint8(SettlementCoordinator.SettlementState.SETTLED));
        assertEq(uint8(state.cashOutcome), uint8(SettlementCoordinator.LegOutcome.RELEASED));
        assertEq(uint8(state.assetOutcome), uint8(SettlementCoordinator.LegOutcome.RELEASED));

        // Conservation, both assets, across both chains.
        assertEq(cash.balanceOf(seller), CASH_AMOUNT);
        assertEq(cash.balanceOf(address(escrow)), 0);
        assertEq(rwa.balanceOf(buyer), ASSET_AMOUNT);
        assertEq(rwa.balanceOf(seller), ASSET_SUPPLY - ASSET_AMOUNT);
        assertEq(rwa.totalSupply(), ASSET_SUPPLY, "no unit was created or destroyed");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8–10. The paths that must not exist
    // ─────────────────────────────────────────────────────────────────────────

    function test_08_PreCommitAbortUnwindsBothLegs() public {
        (bytes32 settlementId,) = _ready();

        vm.chainId(MONAD);
        vm.warp(block.timestamp + 3 hours); // past the commit deadline
        uint256 abortIndex = monadCore.publishedCount();

        SettlementCoordinator.Cancellation memory nothing;
        vm.prank(RELAYER);
        coordinator.issueAbort(
            _intent(), settlementId, SettlementCoordinator.AbortGround.DEADLINE, nothing, 1
        );

        vm.prank(RELAYER);
        escrow.returnCash(settlementId, _proof(escrowDomain, settlementId, buyer, true));
        assertEq(cash.balanceOf(buyer), CASH_AMOUNT * 4, "the payer has every unit back");

        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.returnAsset(_fromMonad(abortIndex));
        assertEq(rwa.reservedBalanceOf(seller), 0, "and the seller's units are free again");
        assertEq(rwa.availableBalanceOf(seller), ASSET_SUPPLY);

        vm.chainId(MONAD);
        assertEq(
            uint8(coordinator.settlementOf(settlementId).cashOutcome),
            uint8(SettlementCoordinator.LegOutcome.RETURNED)
        );
    }

    function test_09_NoCashRefundAfterCommit() public {
        (bytes32 settlementId,) = _ready();
        _issueCommit(settlementId);

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(CashEscrow.ReturnRequiresAbort.selector, settlementId)
        );
        escrow.returnCash(settlementId, _proof(escrowDomain, settlementId, buyer, true));

        assertEq(cash.balanceOf(address(escrow)), CASH_AMOUNT, "invariant I4, at the escrow");
    }

    function test_10_NoReservationCancellationAfterCommit() public {
        (bytes32 settlementId,) = _ready();
        uint256 commitIndex = _issueCommit(settlementId);

        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.releaseAsset(
            _fromMonad(commitIndex), _proof(adapterDomain, settlementId, buyer, false)
        );

        // Held, so the units are still reserved — and still not the seller's to
        // reclaim, because a COMMIT exists. Invariants R2 and R4.
        assertEq(rwa.reservedBalanceOf(seller), ASSET_AMOUNT);
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(ConduitRWACVA.ReservationAlreadyCommitted.selector, settlementId)
        );
        rwa.cancelReservation(settlementId);
    }

    /// @notice The window between a COMMIT existing and the asset chain hearing
    ///         about it is not a window in which the seller may walk away.
    ///
    /// @dev The canonical COMMIT is issued on Monad and the cash releases against
    ///      it immediately — same chain, no VAA, nothing to wait for. Base learns
    ///      about it only when a relayer delivers the VAA, and the relayer is
    ///      untrusted for liveness by design. If `cancelReservation` stayed open
    ///      to the reservation owner during that gap, a seller watching the
    ///      coordinator could take the cash and keep the bond, and the later
    ///      `releaseAsset` would revert on a closed reservation rather than
    ///      reaching the held state — leaving the VAA unconsumed and the asset
    ///      leg permanently unresolvable.
    function test_10b_TheSellerCannotCancelInTheGapBeforeTheCommitVaaArrives() public {
        (bytes32 settlementId,) = _ready();
        _issueCommit(settlementId);

        vm.prank(RELAYER);
        escrow.releaseCash(settlementId, _proof(escrowDomain, settlementId, seller, true));
        assertEq(cash.balanceOf(seller), CASH_AMOUNT, "the seller has been paid");

        // The COMMIT VAA has not been relayed to Base. The reservation is not
        // locally marked committed, and it must still be uncancellable.
        vm.chainId(BASE);
        assertFalse(rwa.reservationOf(settlementId).committed);

        vm.prank(seller);
        vm.expectRevert();
        rwa.cancelReservation(settlementId);

        assertEq(rwa.reservedBalanceOf(seller), ASSET_AMOUNT, "the bond is still spoken for");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 11. A receiver who stops being eligible after the point of no return
    // ─────────────────────────────────────────────────────────────────────────

    function test_11_AnIneligibleReceiverAfterCommitHoldsRatherThanRefunds() public {
        (bytes32 settlementId,) = _ready();
        uint256 commitIndex = _issueCommit(settlementId);

        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.releaseAsset(
            _fromMonad(commitIndex), _proof(adapterDomain, settlementId, buyer, false)
        );

        assertEq(rwa.balanceOf(buyer), 0, "nothing delivered");
        assertEq(rwa.reservedBalanceOf(seller), ASSET_AMOUNT, "and nothing refunded either");

        uint256 reportIndex = baseCore.publishedCount();
        vm.prank(RELAYER);
        adapter.reportResolution(settlementId, MONAD, 1);

        vm.chainId(MONAD);
        vm.prank(RELAYER);
        coordinator.recordLegResolved(
            _fromBase(reportIndex),
            MessageCodec.MessageType.ASSET_HELD,
            SettlementCoordinator.LegOutcome.HELD
        );

        assertEq(
            uint8(coordinator.settlementOf(settlementId).state),
            uint8(SettlementCoordinator.SettlementState.HELD)
        );
    }

    /// @notice The token's own policy refusing is the same outcome as the
    ///         quorum's, and it is reported as such.
    function test_11b_APolicyRefusalAtTheMomentOfTransferAlsoHolds() public {
        (bytes32 settlementId,) = _ready();
        uint256 commitIndex = _issueCommit(settlementId);

        vm.chainId(BASE);
        policy.setDenied(buyer, true);

        vm.prank(RELAYER);
        adapter.releaseAsset(
            _fromMonad(commitIndex), _proof(adapterDomain, settlementId, buyer, true)
        );

        assertEq(rwa.balanceOf(buyer), 0, "Cleanverse refused, so nothing moved");
        assertFalse(rwa.reservationOf(settlementId).released);

        uint256 reportIndex = baseCore.publishedCount();
        vm.prank(RELAYER);
        adapter.reportResolution(settlementId, MONAD, 1);

        MessageCodec.Header memory header =
            MessageCodec.decode(baseCore.publishedAt(reportIndex).payload);
        assertEq(
            uint8(header.messageType),
            uint8(MessageCodec.MessageType.ASSET_HELD),
            "the report follows the token, not the caller"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 12. A held settlement reaching a terminal state
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Both legs held after COMMIT, then both resolved, then SETTLED.
    ///
    /// @dev PRD 7.1 lists HELD -> SETTLED and invariant I9 says held value stays
    ///      claimable through the Disposition Kernel. Neither was reachable: the
    ///      escrow's release path requires PREPARED, and the adapter's requires a
    ///      COMMIT VAA that `_consume` has already burned. A leg that was held was
    ///      held forever, which is not "claimable through the kernel", it is not
    ///      claimable.
    ///
    ///      This is `REVERIFY_AND_RESUME` and nothing else. The destination is the
    ///      one the intent named, in both contracts, and is not a parameter — so
    ///      the five order types that change where value goes stay unreachable
    ///      until the authority registry exists. That is why this one can ship now
    ///      and they cannot.
    function test_12_AHeldSettlementReachesTerminalThroughDisposition() public {
        (bytes32 settlementId,) = _ready();
        uint256 commitIndex = _issueCommit(settlementId);

        // Both legs refused at release time. Nothing refunds; both hold.
        vm.prank(RELAYER);
        escrow.releaseCash(settlementId, _proof(escrowDomain, settlementId, seller, false));

        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.releaseAsset(
            _fromMonad(commitIndex), _proof(adapterDomain, settlementId, buyer, false)
        );

        vm.chainId(MONAD);
        assertEq(
            uint8(coordinator.settlementOf(settlementId).state),
            uint8(SettlementCoordinator.SettlementState.HELD)
        );
        assertEq(cash.balanceOf(address(escrow)), CASH_AMOUNT, "the cash is still here");
        vm.chainId(BASE);
        assertEq(rwa.reservedBalanceOf(seller), ASSET_AMOUNT, "and so is the bond");

        // The authority revises its answer. Nothing else changes.
        vm.chainId(MONAD);
        vm.prank(RELAYER);
        escrow.resolveHeldCash(settlementId, _proof(escrowDomain, settlementId, seller, true));
        assertEq(cash.balanceOf(seller), CASH_AMOUNT, "the receiver is paid");
        assertEq(escrow.totalEscrowed(), 0);

        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.resolveHeldAsset(settlementId, _proof(adapterDomain, settlementId, buyer, true));
        assertEq(rwa.balanceOf(buyer), ASSET_AMOUNT, "the buyer holds the bond");
        assertEq(rwa.reservedBalanceOf(seller), 0);

        // And the asset leg reports its new state, which is what makes the
        // settlement terminal rather than merely resolved locally.
        uint256 reportIndex = baseCore.publishedCount();
        vm.prank(RELAYER);
        adapter.reportResolution(settlementId, MONAD, 1);

        vm.chainId(MONAD);
        vm.prank(RELAYER);
        coordinator.recordLegResolved(
            _fromBase(reportIndex),
            MessageCodec.MessageType.ASSET_RELEASED,
            SettlementCoordinator.LegOutcome.RELEASED
        );

        SettlementCoordinator.Settlement memory state = coordinator.settlementOf(settlementId);
        assertEq(uint8(state.state), uint8(SettlementCoordinator.SettlementState.SETTLED));
        assertEq(uint8(state.cashOutcome), uint8(SettlementCoordinator.LegOutcome.RELEASED));
        assertEq(uint8(state.assetOutcome), uint8(SettlementCoordinator.LegOutcome.RELEASED));

        vm.chainId(BASE);
        assertEq(rwa.totalSupply(), ASSET_SUPPLY, "conservation across the hold and the recovery");
        assertEq(rwa.balanceOf(seller) + rwa.balanceOf(buyer), ASSET_SUPPLY);
    }

    function test_12b_ADispositionThatStillFailsLeavesTheLegHeld() public {
        (bytes32 settlementId,) = _ready();
        uint256 commitIndex = _issueCommit(settlementId);

        vm.prank(RELAYER);
        escrow.releaseCash(settlementId, _proof(escrowDomain, settlementId, seller, false));

        // The authority has not changed its mind. Retrying must not move value
        // and must not revert either: reverting would strand a committed leg.
        vm.prank(RELAYER);
        escrow.resolveHeldCash(settlementId, _proof(escrowDomain, settlementId, seller, false));
        assertEq(cash.balanceOf(seller), 0, "still nothing delivered");
        assertEq(cash.balanceOf(address(escrow)), CASH_AMOUNT, "and still nothing lost");
        assertEq(uint8(escrow.legOf(settlementId).state), uint8(CashEscrow.LegState.HELD));

        commitIndex; // the asset leg is not part of this case
    }

    function test_12c_ADispositionCannotTouchALegThatWasNeverHeld() public {
        (bytes32 settlementId,) = _ready();
        _issueCommit(settlementId);

        vm.prank(ATTACKER);
        vm.expectRevert();
        escrow.resolveHeldCash(settlementId, _proof(escrowDomain, settlementId, seller, true));

        vm.chainId(BASE);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(RWACVASettlementAdapter.LegNotHeld.selector, settlementId)
        );
        adapter.resolveHeldAsset(settlementId, _proof(adapterDomain, settlementId, buyer, true));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 13–15. Hostile input. Constructed deliberately, and named as such.
    // ─────────────────────────────────────────────────────────────────────────

    function test_13_AReplayedAssetPreparedVaaIsRejected() public {
        bytes32 settlementId = _settlementId();
        uint256 index = _prepareAssetLeg(settlementId);
        _deliverAssetPrepared(index);

        vm.chainId(MONAD);
        bytes memory replayed = _fromBase(index);
        vm.prank(ATTACKER);
        vm.expectRevert();
        coordinator.recordAssetPrepared(replayed);
    }

    function test_14_AnAuthenticMessageFromTheWrongEmitterIsRejected() public {
        bytes32 settlementId = _settlementId();
        uint256 index = _prepareAssetLeg(settlementId);

        // The adapter's exact bytes, re-emitted by an address nobody locked.
        vm.chainId(MONAD);
        bytes memory forged = _relay(baseCore, BASE_WH, ATTACKER, index);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.UnexpectedEmitter.selector,
                _emitter(ATTACKER),
                _emitter(address(adapter))
            )
        );
        coordinator.recordAssetPrepared(forged);
        assertFalse(coordinator.settlementOf(settlementId).assetPrepared);
    }

    function test_15_AnAuthenticCommitTheStateMachineCannotAcceptIsRejected() public {
        // A genuine COMMIT for settlement A, delivered to the adapter which has
        // never been told about A. Every transport check passes; the state
        // machine refuses it.
        (bytes32 settlementId,) = _ready();
        uint256 commitIndex = _issueCommit(settlementId);

        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.releaseAsset(
            _fromMonad(commitIndex), _proof(adapterDomain, settlementId, buyer, true)
        );

        // Same settlement, second delivery: the VAA is spent. Both arguments are
        // built before `expectRevert`, because `_fromMonad` reads the producer's
        // core contract and an expectation armed above it would catch that read
        // instead of the call under test.
        bytes memory spent = _fromMonad(commitIndex);
        ComplianceAuthority.ComplianceProof memory proof =
            _proof(adapterDomain, settlementId, buyer, true);
        vm.prank(ATTACKER);
        vm.expectRevert();
        adapter.releaseAsset(spent, proof);
    }

    function test_15b_AnAbortArrivingAfterACommitCannotUnwindTheAsset() public {
        (bytes32 settlementId,) = _ready();
        uint256 commitIndex = _issueCommit(settlementId);

        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.releaseAsset(
            _fromMonad(commitIndex), _proof(adapterDomain, settlementId, buyer, false)
        );

        // No ABORT VAA can exist, because the coordinator refuses to issue one
        // after a COMMIT. That is invariant I3 at the point of decision, and it
        // is the only reason the adapter never sees a conflicting instruction.
        vm.chainId(MONAD);
        vm.warp(block.timestamp + 3 hours);
        SettlementCoordinator.Cancellation memory nothing;
        vm.prank(seller);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.AbortAfterCommitForbidden.selector, settlementId
            )
        );
        coordinator.issueAbort(
            _intent(), settlementId, SettlementCoordinator.AbortGround.DEADLINE, nothing, 1
        );

        // And the reservation stays committed, so even a hand-built ABORT could
        // not free it: `cancelReservation` refuses a committed reservation.
        vm.chainId(BASE);
        assertTrue(rwa.reservationOf(settlementId).committed);
        assertEq(rwa.reservedBalanceOf(seller), ASSET_AMOUNT);
    }

    /// @notice One party on both sides of the cash leg commits with one
    ///         attestation, and refuses two copies of it.
    ///
    /// @dev `issueCommit` asks about `cashPayer` and `cashReceiver` separately,
    ///      and a caller that builds one attestation per *party* rather than per
    ///      *subject* presents one signer's opinion about one address twice when
    ///      they are the same address. `_countAttestations` refuses that, which
    ///      is right — two copies of one opinion are not a quorum of two — and
    ///      the live deployment has exactly that shape, because the demo buyer
    ///      and seller are one key.
    ///
    ///      Every other test here uses distinct parties, so none of them can see
    ///      it. It cost a resumed live run at the commit, with both Cleanverse
    ///      queries answering eligible and the contract still refusing.
    function test_OneAttestationCoversAPartyOnBothSidesAndTwoDoNot() public {
        bytes32 settlementId = _selfSettlementId();
        _prepareAssetLeg(settlementId);
        vm.chainId(MONAD);
        vm.prank(buyer);
        escrow.prepareCash(settlementId, settlementId, buyer, CASH_AMOUNT, BASE, 1);
        vm.prank(RELAYER);
        coordinator.recordAssetPrepared(_fromBase(baseCore.publishedCount() - 1));

        (
            ComplianceAttestationLib.ComplianceAttestation[] memory doubled,
            bytes[] memory doubledSignatures
        ) = _attestAll(
            coordinatorDomain,
            _keys(SIGNER_A_KEY),
            settlementId,
            settlementId,
            _subjects(buyer, buyer),
            true
        );

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ComplianceAuthority.AttestationSignersNotDistinct.selector, _signerA()
            )
        );
        coordinator.issueCommit(
            _selfIntent(),
            settlementId,
            _sign(BUYER_KEY, settlementId),
            _sign(SELLER_KEY, settlementId),
            ComplianceAuthority.ComplianceProof(doubled, doubledSignatures),
            1
        );

        (
            ComplianceAttestationLib.ComplianceAttestation[] memory single,
            bytes[] memory singleSignature
        ) = _attestAll(
            coordinatorDomain,
            _keys(SIGNER_A_KEY),
            settlementId,
            settlementId,
            _subjects(buyer),
            true
        );

        vm.prank(RELAYER);
        coordinator.issueCommit(
            _selfIntent(),
            settlementId,
            _sign(BUYER_KEY, settlementId),
            _sign(SELLER_KEY, settlementId),
            ComplianceAuthority.ComplianceProof(single, singleSignature),
            1
        );

        assertEq(
            uint8(coordinator.settlementOf(settlementId).decision),
            uint8(SettlementCoordinator.Decision.COMMIT),
            "one attestation answers for a party on both sides"
        );
    }

    /// @dev The demo's shape: the same key pays and is paid, sells and receives.
    function _selfIntent() private view returns (SettlementIntentLib.SettlementIntent memory) {
        SettlementIntentLib.SettlementIntent memory intent = _intent();
        intent.cashPayer = buyer;
        intent.cashReceiver = buyer;
        intent.assetSeller = seller;
        intent.assetReceiver = buyer;
        intent.nonce = 8;
        return intent;
    }

    function _selfSettlementId() private view returns (bytes32) {
        return SettlementIntentLib.digest(_selfIntent(), coordinator.domainSeparator());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The asset-side analogues of the three cash-seam defects
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Nobody but the escrow may tell the coordinator that cash arrived.
    ///
    /// @dev The asset-side mirror of this was found and fixed
    ///      (`recordLocalCashResolved`); the preparation side was not. If anyone
    ///      may declare the cash leg prepared, a buyer who never funds the escrow
    ///      can drive a settlement whose asset leg is genuinely prepared to READY
    ///      and then to COMMIT, and take delivery of the bond. The seller's
    ///      signature is one they already produced to enter the trade, and the
    ///      quorum will attest two parties who are both genuinely eligible. Every
    ///      check passes. No cash was ever escrowed.
    function test_OnlyTheEscrowMayReportTheCashLegPrepared() public {
        bytes32 settlementId = _settlementId();
        _prepareAssetLeg(settlementId);

        vm.chainId(MONAD);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.NotTheCashEscrow.selector, buyer, address(escrow)
            )
        );
        coordinator.recordCashPrepared(settlementId, settlementId);

        assertFalse(
            coordinator.settlementOf(settlementId).cashPrepared,
            "canonical state does not claim cash that is not there"
        );
        assertEq(cash.balanceOf(address(escrow)), 0);
    }

    /// @notice A leg reports what the token did, not what the caller says it did.
    ///
    /// @dev `reportResolution` took a `bool released` from whoever called it,
    ///      unrestricted. After a genuine hold, anyone could publish
    ///      ASSET_RELEASED; the coordinator's checks all pass, because releasing
    ///      after a COMMIT is exactly what is supposed to happen. Canonical state
    ///      would then read SETTLED while the bond sat reserved and undelivered,
    ///      and the true ASSET_HELD report would afterwards be refused with
    ///      `LegAlreadyResolved` — the correct state permanently locked out by
    ///      the false one. Nobody's balance changes, which is why it reads as
    ///      harmless; what it destroys is the correspondence between canonical
    ///      state and where the value is, and every conservation claim rests on
    ///      that.
    function test_AHeldAssetLegCannotBeReportedAsReleased() public {
        (bytes32 settlementId,) = _ready();
        uint256 commitIndex = _issueCommit(settlementId);

        vm.chainId(BASE);
        vm.prank(RELAYER);
        adapter.releaseAsset(
            _fromMonad(commitIndex), _proof(adapterDomain, settlementId, buyer, false)
        );
        assertEq(rwa.balanceOf(buyer), 0, "the bond was not delivered");

        uint256 reportIndex = baseCore.publishedCount();
        vm.prank(ATTACKER);
        adapter.reportResolution(settlementId, MONAD, 1);

        MessageCodec.Header memory header =
            MessageCodec.decode(baseCore.publishedAt(reportIndex).payload);
        assertEq(
            uint8(header.messageType),
            uint8(MessageCodec.MessageType.ASSET_HELD),
            "an attacker cannot publish a delivery that did not happen"
        );

        vm.chainId(MONAD);
        bytes memory truthful = _fromBase(reportIndex);
        vm.prank(ATTACKER);
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.UnexpectedMessageType.selector,
                MessageCodec.MessageType.ASSET_HELD,
                MessageCodec.MessageType.ASSET_RELEASED
            )
        );
        coordinator.recordLegResolved(
            truthful,
            MessageCodec.MessageType.ASSET_RELEASED,
            SettlementCoordinator.LegOutcome.RELEASED
        );

        assertEq(
            uint8(coordinator.settlementOf(settlementId).assetOutcome),
            uint8(SettlementCoordinator.LegOutcome.NONE),
            "and canonical state is still open, which is the truth"
        );
    }

    /// @notice A reservation that has been closed cannot be announced again.
    ///
    /// @dev Otherwise a seller cancels, announces anyway, and the coordinator
    ///      reaches READY on a leg with nothing behind it. The COMMIT that
    ///      follows releases the cash and then strands: `releaseAsset` reverts on
    ///      the closed reservation, so the VAA is never consumed and the asset
    ///      leg can never resolve.
    function test_AClosedReservationCannotBeAnnounced() public {
        bytes32 settlementId = _settlementId();

        vm.chainId(BASE);
        vm.startPrank(seller);
        rwa.reserveForSettlement(settlementId, ASSET_AMOUNT);
        rwa.cancelReservation(settlementId);

        vm.expectRevert();
        adapter.prepareAsset(settlementId, settlementId, buyer, MONAD, 1);
        vm.stopPrank();
    }
}

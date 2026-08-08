// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {CashEscrow} from "../src/CashEscrow.sol";
import {ComplianceAuthority} from "../src/ComplianceAuthority.sol";
import {SettlementCoordinator} from "../src/SettlementCoordinator.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {ComplianceAttestationLib} from "../src/libraries/ComplianceAttestationLib.sol";
import {MessageCodec} from "../src/libraries/MessageCodec.sol";
import {SettlementIntentLib} from "../src/libraries/SettlementIntentLib.sol";
import {ComplianceFixture} from "./helpers/ComplianceFixture.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";
import {MockAToken} from "./mocks/TestTokens.sol";

/// @notice The seam between the coordinator's decision and the cash it moves.
///
/// This file exists because of what its absence cost. Every contract was unit
/// tested and every unit test passed, and the release path was still impossible:
/// `CashEscrow.releaseCash` consumed a COMMIT VAA, `_consume` requires the
/// emitter to be the remote peer on the remote chain, and the coordinator that
/// issues COMMIT is on *this* chain. The message was also addressed to
/// `intent.assetChainId`, so the destination check rejected it a second time.
/// Two independent refusals, on the one path that pays the receiver.
///
/// It stayed invisible because the escrow's tests built their own COMMIT VAAs —
/// well formed, with the escrow's own peer as emitter and this chain as the
/// destination. They described a message nothing in the system emits. The tests
/// were internally consistent and jointly wrong, which is the failure mode unit
/// tests cannot see by construction: each contract was checked against a fixture
/// rather than against the thing that actually calls it.
///
/// So nothing here is fabricated. The coordinator reaches its decision through
/// real signatures and a real attestation quorum, and the escrow is asked to
/// release against that decision and no other input.
contract CashSettlementSeamTest is ComplianceFixture {
    SettlementCoordinator private coordinator;
    CashEscrow private escrow;
    MockWormhole private wormhole;
    MockAToken private cash;

    uint256 private constant BUYER_KEY = 0xB0FFEE;
    uint256 private constant SELLER_KEY = 0x5E11E4;
    address private buyer;
    address private seller;

    address private constant OWNER = address(0x0E7E4);
    address private constant RELAYER = address(0x4E1A4);
    address private constant RECEIVER = address(0x4EC1E5);

    uint16 private constant LOCAL_WH_CHAIN = 10_009;
    uint16 private constant REMOTE_WH_CHAIN = 10_004;
    bytes32 private constant DEPLOYMENT_ID = keccak256("deployment-1");
    bytes32 private constant REMOTE_EMITTER = bytes32(uint256(uint160(address(0xC0FFEE))));
    uint256 private constant ASSET_CHAIN = 84_532;
    uint256 private constant AMOUNT = 1000e6;

    /// @dev Two domains, deliberately. An attestation minted for the coordinator
    ///      does not verify at the escrow even with the same signer, subject, and
    ///      settlement, because EIP-712 binds `verifyingContract`. Writing this
    ///      test with one domain for both produced exactly that rejection, which
    ///      is the binding doing its job.
    bytes32 private coordinatorDomain;
    bytes32 private escrowDomain;

    function setUp() public {
        buyer = vm.addr(BUYER_KEY);
        seller = vm.addr(SELLER_KEY);

        wormhole = new MockWormhole(LOCAL_WH_CHAIN);
        cash = new MockAToken(6);

        coordinator = new SettlementCoordinator(
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
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
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            15 minutes,
            OWNER
        );

        coordinatorDomain = coordinator.attestationDomainSeparator();
        escrowDomain = escrow.attestationDomainSeparator();

        vm.startPrank(OWNER);
        coordinator.setCashEscrow(address(escrow));
        coordinator.addComplianceSigner(_signerA());
        coordinator.setComplianceQuorum(1);
        escrow.addComplianceSigner(_signerA());
        escrow.setComplianceQuorum(1);
        vm.stopPrank();

        cash.mint(buyer, AMOUNT * 10);
        vm.prank(buyer);
        cash.approve(address(escrow), type(uint256).max);
    }

    function _intent() private view returns (SettlementIntentLib.SettlementIntent memory) {
        return SettlementIntentLib.SettlementIntent({
            version: 1,
            cashChainId: block.chainid,
            cashEscrow: address(escrow),
            cashAsset: address(cash),
            cashAmount: AMOUNT,
            cashPayer: buyer,
            cashReceiver: RECEIVER,
            assetChainId: ASSET_CHAIN,
            assetEscrow: address(0x5555),
            assetToken: address(0x6666),
            assetAmount: 50,
            assetSeller: seller,
            assetReceiver: buyer,
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

    function _assetPreparedVaa(bytes32 settlementId) private pure returns (bytes memory) {
        bytes memory payload = MessageCodec.encode(
            MessageCodec.Header({
                protocolVersion: MessageCodec.PROTOCOL_VERSION,
                messageType: MessageCodec.MessageType.ASSET_PREPARED,
                deploymentId: DEPLOYMENT_ID,
                settlementId: settlementId,
                intentHash: settlementId,
                sourceChainId: ASSET_CHAIN,
                destinationChainId: 31_337,
                stateVersion: 1
            })
        );
        IWormhole.VM memory vaa = IWormhole.VM({
            version: 1,
            timestamp: 0,
            nonce: 0,
            emitterChainId: REMOTE_WH_CHAIN,
            emitterAddress: REMOTE_EMITTER,
            sequence: 1,
            consistencyLevel: 1,
            payload: payload,
            guardianSetIndex: 0,
            signatures: new IWormhole.Signature[](0),
            hash: keccak256("asset-prepared")
        });
        return abi.encode(vaa);
    }

    function _proof(bytes32 settlementId, address subject, bool eligible)
        private
        view
        returns (ComplianceAuthority.ComplianceProof memory)
    {
        (
            ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
            bytes[] memory signatures
        ) = _attestAll(
            escrowDomain,
            _keys(SIGNER_A_KEY),
            settlementId,
            settlementId,
            _subjects(subject),
            eligible
        );
        return ComplianceAuthority.ComplianceProof(attestations, signatures);
    }

    /// @dev Both cash-side parties attested, which is what `issueCommit` requires.
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
            _subjects(buyer, RECEIVER),
            true
        );
        return ComplianceAuthority.ComplianceProof(attestations, signatures);
    }

    function _prepareAndCommit() private returns (bytes32 settlementId) {
        settlementId = _settlementId();

        vm.prank(buyer);
        escrow.prepareCash(settlementId, settlementId, RECEIVER, AMOUNT, ASSET_CHAIN, 1);

        // No `recordCashPrepared` here. The escrow makes that call itself, inside
        // the transaction that took the cash, and the coordinator accepts it from
        // nobody else.
        coordinator.recordAssetPrepared(_assetPreparedVaa(settlementId));

        coordinator.issueCommit(
            _intent(),
            settlementId,
            _sign(BUYER_KEY, settlementId),
            _sign(SELLER_KEY, settlementId),
            _commitProof(settlementId),
            1
        );
    }

    function test_ACommitTheCoordinatorActuallyIssuedReleasesTheCash() public {
        // The test that did not exist. Everything the escrow reads comes from a
        // decision the coordinator reached on its own terms.
        bytes32 settlementId = _prepareAndCommit();

        assertEq(
            uint8(coordinator.settlementOf(settlementId).decision),
            uint8(SettlementCoordinator.Decision.COMMIT)
        );

        vm.prank(RELAYER);
        escrow.releaseCash(settlementId, _proof(settlementId, RECEIVER, true));

        assertEq(cash.balanceOf(RECEIVER), AMOUNT, "the receiver was paid");
        assertEq(escrow.totalEscrowed(), 0, "and the escrow accounts for nothing further");
        assertEq(uint8(escrow.legOf(settlementId).state), uint8(CashEscrow.LegState.RELEASED));
    }

    function test_TheCashLegReportsItselfSoTheSettlementCanFinish() public {
        // Restricting recordLocalCashResolved to the escrow made it unreachable
        // until the escrow actually called it: nobody else may, so a cash leg
        // that never reports leaves the settlement unable to reach a terminal
        // state at all. The coordinator is the only place the two legs are
        // compared, so a leg that resolves silently is invisible to every
        // conservation check that matters.
        bytes32 settlementId = _prepareAndCommit();

        vm.prank(RELAYER);
        escrow.releaseCash(settlementId, _proof(settlementId, RECEIVER, true));

        assertEq(
            uint8(coordinator.settlementOf(settlementId).cashOutcome),
            uint8(SettlementCoordinator.LegOutcome.RELEASED),
            "canonical state knows the cash moved"
        );
    }

    function test_AHeldCashLegIsReportedAsHeldNotAsSilence() public {
        // A compliance shortfall after COMMIT holds the value, and the
        // coordinator has to hear about that too — otherwise a held leg and an
        // unreported one look identical from the only place they are compared.
        bytes32 settlementId = _prepareAndCommit();

        vm.prank(RELAYER);
        escrow.releaseCash(settlementId, _proof(settlementId, RECEIVER, false));

        assertEq(
            uint8(coordinator.settlementOf(settlementId).cashOutcome),
            uint8(SettlementCoordinator.LegOutcome.HELD)
        );
        assertEq(cash.balanceOf(address(escrow)), AMOUNT, "and the value is still there");
    }

    function test_ConservationHoldsAcrossTheWholeRoundTrip() public {
        uint256 payerBefore = cash.balanceOf(buyer);
        uint256 supplyBefore = cash.totalSupply();

        bytes32 settlementId = _prepareAndCommit();
        vm.prank(RELAYER);
        escrow.releaseCash(settlementId, _proof(settlementId, RECEIVER, true));

        // Invariant I1. Nothing was minted, nothing was burned, and the escrow
        // is empty: exactly the payer's amount moved to exactly the receiver.
        assertEq(cash.totalSupply(), supplyBefore, "no cash was created or destroyed");
        assertEq(cash.balanceOf(buyer), payerBefore - AMOUNT);
        assertEq(cash.balanceOf(RECEIVER), AMOUNT);
        assertEq(cash.balanceOf(address(escrow)), 0);
    }

    function test_NoReleaseBeforeTheCoordinatorDecides() public {
        bytes32 settlementId = _settlementId();

        vm.prank(buyer);
        escrow.prepareCash(settlementId, settlementId, RECEIVER, AMOUNT, ASSET_CHAIN, 1);
        // No `recordCashPrepared` here. The escrow makes that call itself, inside
        // the transaction that took the cash, and the coordinator accepts it from
        // nobody else.
        coordinator.recordAssetPrepared(_assetPreparedVaa(settlementId));

        // READY, both legs prepared, and still no decision. The cash does not move.
        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(CashEscrow.ReleaseRequiresCommit.selector, settlementId)
        );
        escrow.releaseCash(settlementId, _proof(settlementId, RECEIVER, true));

        assertEq(cash.balanceOf(RECEIVER), 0);
    }

    function test_OnlyTheEscrowMayReportTheCashLegResolved() public {
        // The other half of the seam. This was permissionless, so anyone could
        // declare the cash leg RELEASED the moment a COMMIT existed — both of the
        // coordinator's checks pass at that point, because releasing after a
        // commit is precisely what should happen. The coordinator would then
        // report a settled cash leg while the cash sat in escrow, and every
        // conservation claim rests on that correspondence holding.
        bytes32 settlementId = _prepareAndCommit();

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.NotTheCashEscrow.selector, RELAYER, address(escrow)
            )
        );
        coordinator.recordLocalCashResolved(settlementId, SettlementCoordinator.LegOutcome.RELEASED);

        assertEq(
            uint8(coordinator.settlementOf(settlementId).cashOutcome),
            uint8(SettlementCoordinator.LegOutcome.NONE),
            "canonical state still says the cash leg is unresolved, which is true"
        );
    }

    function test_TheCashEscrowBindingIsSetOnceAndFixed() public {
        vm.prank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.CashEscrowAlreadySet.selector, address(escrow)
            )
        );
        coordinator.setCashEscrow(address(0xBEEF));
    }
}

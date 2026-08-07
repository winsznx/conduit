// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {ConduitRWACVA} from "../src/ConduitRWACVA.sol";
import {RWACVASettlementAdapter} from "../src/RWACVASettlementAdapter.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {MessageCodec} from "../src/libraries/MessageCodec.sol";
import {MockATokenPolicy} from "./mocks/MockATokenPolicy.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";

/// @notice The asset leg end to end: reservation, commit, release, hold, abort.
///
/// The separation under test is that the token enforces reservation accounting
/// and CCP policy while the adapter enforces that a release is backed by a
/// canonical COMMIT. Neither should be able to do the other's job, and the tests
/// below try to make each of them do exactly that.
contract RWACVASettlementAdapterTest is Test {
    ConduitRWACVA private token;
    MockATokenPolicy private policy;
    RWACVASettlementAdapter private adapter;
    MockWormhole private wormhole;

    address private constant ADMIN = address(0xA11CE);
    address private constant SELLER = address(0x5E11E4);
    address private constant BUYER = address(0xB0B);
    address private constant RELAYER = address(0x4E1A4);
    address private constant OUTSIDER = address(0x0417);

    uint16 private constant LOCAL_WH_CHAIN = 10_004; // BaseSepolia
    uint16 private constant REMOTE_WH_CHAIN = 10_009; // MonadTestnet
    bytes32 private constant DEPLOYMENT_ID = keccak256("deployment-1");
    bytes32 private constant REMOTE_EMITTER = bytes32(uint256(uint160(address(0xC0FFEE))));
    bytes32 private constant SETTLEMENT_ID = keccak256("settlement-1");
    bytes32 private constant INTENT_HASH = keccak256("intent-1");

    uint256 private constant SUPPLY = 1000e6;
    uint256 private constant RESERVED = 400e6;

    function setUp() public {
        policy = new MockATokenPolicy();
        wormhole = new MockWormhole(LOCAL_WH_CHAIN);
        token = new ConduitRWACVA("Conduit Bond", "cBOND", 6, address(policy), ADMIN);
        adapter = new RWACVASettlementAdapter(
            address(token),
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            ADMIN
        );

        vm.startPrank(ADMIN);
        token.grantRole(token.MINTER_ROLE(), ADMIN);
        token.grantRole(token.SETTLEMENT_ROLE(), address(adapter));
        token.mint(SELLER, SUPPLY);
        vm.stopPrank();
    }

    function _reserveAndPrepare() private {
        vm.startPrank(SELLER);
        token.reserveForSettlement(SETTLEMENT_ID, RESERVED);
        adapter.prepareAsset(SETTLEMENT_ID, INTENT_HASH, BUYER, 10_143, 1);
        vm.stopPrank();
    }

    function _vaa(MessageCodec.MessageType messageType, bytes32 intentHash, string memory seed)
        private
        view
        returns (bytes memory)
    {
        bytes memory payload = MessageCodec.encode(
            MessageCodec.Header({
                protocolVersion: MessageCodec.PROTOCOL_VERSION,
                messageType: messageType,
                deploymentId: DEPLOYMENT_ID,
                settlementId: SETTLEMENT_ID,
                intentHash: intentHash,
                sourceChainId: 10_143,
                destinationChainId: block.chainid,
                stateVersion: 2
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
            hash: keccak256(bytes(seed))
        });
        return abi.encode(vaa);
    }

    // ── Preparation ──────────────────────────────────────────────────────────

    function test_PrepareRegistersReceiverAndPublishes() public {
        _reserveAndPrepare();

        assertEq(adapter.intendedReceiver(SETTLEMENT_ID), BUYER);
        assertEq(adapter.boundIntentHash(SETTLEMENT_ID), INTENT_HASH);
        assertEq(wormhole.publishedCount(), 1);

        MessageCodec.Header memory header = MessageCodec.decode(wormhole.publishedAt(0).payload);
        assertEq(uint8(header.messageType), uint8(MessageCodec.MessageType.ASSET_PREPARED));
        assertEq(header.destinationChainId, 10_143);
    }

    function test_TheAssetNeverLeavesTheSellerBeforeCommit() public {
        // The override's central claim: nominal ownership stays put, only
        // spendability changes.
        _reserveAndPrepare();

        assertEq(token.balanceOf(SELLER), SUPPLY);
        assertEq(token.balanceOf(address(adapter)), 0, "the adapter never custodies");
        assertEq(token.reservedBalanceOf(SELLER), RESERVED);
        assertEq(token.availableBalanceOf(SELLER), SUPPLY - RESERVED);
    }

    function test_OnlyTheReservationOwnerMayPrepare() public {
        // Otherwise a third party could bind someone else's reservation to a
        // receiver of their choosing.
        vm.prank(SELLER);
        token.reserveForSettlement(SETTLEMENT_ID, RESERVED);

        vm.prank(OUTSIDER);
        vm.expectRevert(RWACVASettlementAdapter.NotReservationOwner.selector);
        adapter.prepareAsset(SETTLEMENT_ID, INTENT_HASH, OUTSIDER, 10_143, 1);
    }

    function test_PrepareRequiresAnExistingReservation() public {
        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(
                RWACVASettlementAdapter.ReceiverNotRegistered.selector, SETTLEMENT_ID
            )
        );
        adapter.prepareAsset(SETTLEMENT_ID, INTENT_HASH, BUYER, 10_143, 1);
    }

    // ── Release ──────────────────────────────────────────────────────────────

    function test_CommitDeliversToTheRegisteredReceiver() public {
        _reserveAndPrepare();

        vm.prank(RELAYER);
        adapter.releaseAsset(_vaa(MessageCodec.MessageType.COMMIT, INTENT_HASH, "commit"), true);

        assertEq(token.balanceOf(BUYER), RESERVED);
        assertEq(token.balanceOf(SELLER), SUPPLY - RESERVED);
        assertEq(token.reservedBalanceOf(SELLER), 0);
    }

    function test_IneligibleReceiverHoldsTheLegWithoutMovingUnits() public {
        _reserveAndPrepare();

        vm.prank(RELAYER);
        adapter.releaseAsset(_vaa(MessageCodec.MessageType.COMMIT, INTENT_HASH, "commit"), false);

        assertEq(token.balanceOf(BUYER), 0);
        assertEq(token.reservedBalanceOf(SELLER), RESERVED, "units stay reserved, not lost");

        // R2 and R4: the reservation is committed, so it can never be cancelled
        // back into spendable balance.
        vm.prank(SELLER);
        vm.expectRevert();
        token.cancelReservation(SETTLEMENT_ID);
    }

    function test_PolicyRefusalHoldsTheLegRatherThanRevertingTheWholeCall() public {
        // A revert would leave the VAA unconsumed and the settlement stuck. The
        // policy is authoritative, so its refusal is an outcome, not an error.
        _reserveAndPrepare();
        policy.setDenied(BUYER, true);

        vm.prank(RELAYER);
        adapter.releaseAsset(_vaa(MessageCodec.MessageType.COMMIT, INTENT_HASH, "commit"), true);

        assertEq(token.balanceOf(BUYER), 0);
        assertEq(token.reservedBalanceOf(SELLER), RESERVED);
        assertTrue(adapter.consumedVaa(keccak256("commit")), "the VAA is still consumed");
    }

    function test_ReleaseIsRefusedWithoutAPreparedLeg() public {
        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                RWACVASettlementAdapter.ReceiverNotRegistered.selector, SETTLEMENT_ID
            )
        );
        adapter.releaseAsset(_vaa(MessageCodec.MessageType.COMMIT, INTENT_HASH, "commit"), true);
    }

    function test_ReleaseRequiresTheBoundIntentHash() public {
        // Invariant I7: a COMMIT for different terms is not this settlement's.
        _reserveAndPrepare();

        vm.prank(RELAYER);
        vm.expectRevert();
        adapter.releaseAsset(
            _vaa(MessageCodec.MessageType.COMMIT, keccak256("other-intent"), "wrong-intent"), true
        );
    }

    function test_ReplayedCommitCannotDeliverTwice() public {
        _reserveAndPrepare();
        bytes memory commitVaa = _vaa(MessageCodec.MessageType.COMMIT, INTENT_HASH, "commit");

        vm.startPrank(RELAYER);
        adapter.releaseAsset(commitVaa, true);
        vm.expectRevert();
        adapter.releaseAsset(commitVaa, true);
        vm.stopPrank();

        assertEq(token.balanceOf(BUYER), RESERVED, "delivered exactly once");
    }

    // ── Abort ────────────────────────────────────────────────────────────────

    function test_AbortCancelsTheReservation() public {
        _reserveAndPrepare();

        vm.prank(RELAYER);
        adapter.returnAsset(_vaa(MessageCodec.MessageType.ABORT, INTENT_HASH, "abort"));

        assertEq(token.reservedBalanceOf(SELLER), 0);
        assertEq(token.availableBalanceOf(SELLER), SUPPLY, "fully spendable again");
    }

    function test_AbortAfterCommitCannotUnwindTheAssetLeg() public {
        // Even if a relayer delivers a valid ABORT after a COMMIT, the token
        // refuses: R2 and R4 live in the token, not in the adapter's ordering.
        _reserveAndPrepare();

        vm.startPrank(RELAYER);
        adapter.releaseAsset(_vaa(MessageCodec.MessageType.COMMIT, INTENT_HASH, "commit"), false);

        vm.expectRevert();
        adapter.returnAsset(_vaa(MessageCodec.MessageType.ABORT, INTENT_HASH, "late-abort"));
        vm.stopPrank();

        assertEq(token.reservedBalanceOf(SELLER), RESERVED);
    }

    // ── Role separation ──────────────────────────────────────────────────────

    function test_AdapterCannotMint() public {
        // It holds SETTLEMENT_ROLE and nothing else.
        vm.prank(address(adapter));
        vm.expectRevert();
        token.mint(BUYER, 1);
    }

    function test_AdapterCannotManageRules() public {
        vm.prank(address(adapter));
        vm.expectRevert();
        token.removeRuleV2(0);
    }

    function test_AdapterCannotMoveAnUnreservedBalance() public {
        vm.prank(address(adapter));
        vm.expectRevert();
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transfer(BUYER, 1);
    }

    // ── Reporting ────────────────────────────────────────────────────────────

    function test_ReportsTerminalStateBackToTheCoordinator() public {
        _reserveAndPrepare();

        vm.prank(RELAYER);
        adapter.releaseAsset(_vaa(MessageCodec.MessageType.COMMIT, INTENT_HASH, "commit"), true);

        uint256 before = wormhole.publishedCount();
        adapter.reportResolution(SETTLEMENT_ID, true, 10_143, 1);

        MessageCodec.Header memory header =
            MessageCodec.decode(wormhole.publishedAt(before).payload);
        assertEq(uint8(header.messageType), uint8(MessageCodec.MessageType.ASSET_RELEASED));
        assertEq(header.settlementId, SETTLEMENT_ID);
    }

    function test_ReportsHeldWhenTheLegWasNotDelivered() public {
        _reserveAndPrepare();

        vm.prank(RELAYER);
        adapter.releaseAsset(_vaa(MessageCodec.MessageType.COMMIT, INTENT_HASH, "commit"), false);

        uint256 before = wormhole.publishedCount();
        adapter.reportResolution(SETTLEMENT_ID, false, 10_143, 1);

        MessageCodec.Header memory header =
            MessageCodec.decode(wormhole.publishedAt(before).payload);
        assertEq(uint8(header.messageType), uint8(MessageCodec.MessageType.ASSET_HELD));
    }

    // ── Conservation ─────────────────────────────────────────────────────────

    function testFuzz_SupplyIsConservedThroughEveryOutcome(uint96 amount, bool eligible) public {
        uint256 reserved = bound(uint256(amount), 1, SUPPLY);
        uint256 before = token.totalSupply();

        vm.startPrank(SELLER);
        token.reserveForSettlement(SETTLEMENT_ID, reserved);
        adapter.prepareAsset(SETTLEMENT_ID, INTENT_HASH, BUYER, 10_143, 1);
        vm.stopPrank();

        vm.prank(RELAYER);
        adapter.releaseAsset(_vaa(MessageCodec.MessageType.COMMIT, INTENT_HASH, "commit"), eligible);

        // Invariant I2: released plus still-held equals what was locked.
        assertEq(token.totalSupply(), before, "settlement never mints or burns");
        assertEq(token.balanceOf(SELLER) + token.balanceOf(BUYER), before);
        assertEq(token.balanceOf(BUYER), eligible ? reserved : 0);
        assertEq(token.reservedBalanceOf(SELLER), eligible ? 0 : reserved);
    }
}

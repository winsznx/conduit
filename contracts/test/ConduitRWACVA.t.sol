// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {ConduitRWACVA} from "../src/ConduitRWACVA.sol";
import {IATokenPolicy, IComplianceRule} from "../src/interfaces/IATokenPolicy.sol";
import {MockATokenPolicy} from "./mocks/MockATokenPolicy.sol";

/// @notice Reservation accounting and compliance gating for the RWA CVA.
///
/// The v1.1 override replaces escrow custody with a token-native reservation, so
/// the property that matters is no longer "the escrow holds the balance" but
/// "reserved units are unspendable through every path". These tests attack that
/// from each direction: transfer, transferFrom, burn, and a second reservation.
contract ConduitRWACVATest is Test {
    ConduitRWACVA private token;
    MockATokenPolicy private policy;

    address private constant ADMIN = address(0xA11CE);
    address private constant SELLER = address(0x5E11E4);
    address private constant BUYER = address(0xB0B);
    address private constant SETTLEMENT = address(0x5E7);
    address private constant OUTSIDER = address(0x0417);

    bytes32 private constant SETTLEMENT_ID = keccak256("settlement-1");
    uint256 private constant SUPPLY = 1000e6;

    function setUp() public {
        policy = new MockATokenPolicy();
        token = new ConduitRWACVA("Conduit Bond", "cBOND", 6, address(policy), ADMIN);

        vm.startPrank(ADMIN);
        token.grantRole(token.MINTER_ROLE(), ADMIN);
        token.grantRole(token.SETTLEMENT_ROLE(), SETTLEMENT);
        token.mint(SELLER, SUPPLY);
        vm.stopPrank();
    }

    function _reserve(uint256 amount) private {
        vm.prank(SELLER);
        token.reserveForSettlement(SETTLEMENT_ID, amount);
    }

    // ── R1: transferable balance = balanceOf - totalReserved ─────────────────

    function test_ReservationReducesAvailableBalanceButNotBalance() public {
        _reserve(400e6);

        assertEq(token.balanceOf(SELLER), SUPPLY, "nominal ownership is unchanged");
        assertEq(token.reservedBalanceOf(SELLER), 400e6);
        assertEq(token.availableBalanceOf(SELLER), 600e6);
    }

    function test_TransferOfAvailableBalanceSucceeds() public {
        _reserve(400e6);

        vm.prank(SELLER);
        assertTrue(token.transfer(OUTSIDER, 600e6));

        assertEq(token.balanceOf(OUTSIDER), 600e6);
        assertEq(token.availableBalanceOf(SELLER), 0);
    }

    function test_TransferCannotSpendReservedUnits() public {
        _reserve(400e6);

        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConduitRWACVA.InsufficientAvailableBalance.selector, 600e6, 601e6
            )
        );
        // The call below is asserted to revert, so it never returns a value to
        // check. Not a silenced finding: provably inapplicable here.
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transfer(OUTSIDER, 601e6);
    }

    function test_TransferFromCannotSpendReservedUnits() public {
        // The approval path is a separate route out of a balance and has to
        // respect the reservation too.
        _reserve(400e6);

        vm.prank(SELLER);
        token.approve(OUTSIDER, SUPPLY);

        vm.prank(OUTSIDER);
        vm.expectRevert();
        // The call below is asserted to revert, so it never returns a value to
        // check. Not a silenced finding: provably inapplicable here.
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transferFrom(SELLER, OUTSIDER, 601e6);
    }

    function test_BurnCannotDestroyReservedUnits() public {
        // Burning reserved units would satisfy "the seller no longer has them"
        // while leaving the buyer with nothing to receive.
        _reserve(400e6);

        vm.prank(ADMIN);
        vm.expectRevert();
        token.burn(SELLER, 700e6);
    }

    function test_SecondReservationCannotOverCommitTheSameUnits() public {
        _reserve(600e6);

        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConduitRWACVA.InsufficientAvailableBalance.selector, 400e6, 500e6
            )
        );
        token.reserveForSettlement(keccak256("settlement-2"), 500e6);
    }

    function test_RejectsDuplicateSettlementId() public {
        _reserve(100e6);

        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(ConduitRWACVA.ReservationExists.selector, SETTLEMENT_ID)
        );
        token.reserveForSettlement(SETTLEMENT_ID, 100e6);
    }

    function test_RejectsZeroAmountReservation() public {
        vm.prank(SELLER);
        vm.expectRevert(ConduitRWACVA.AmountMustBePositive.selector);
        token.reserveForSettlement(SETTLEMENT_ID, 0);
    }

    // ── R2 and R4: cancellable only before COMMIT ────────────────────────────

    function test_CancelBeforeCommitRestoresAvailability() public {
        _reserve(400e6);

        vm.prank(SELLER);
        token.cancelReservation(SETTLEMENT_ID);

        assertEq(token.reservedBalanceOf(SELLER), 0);
        assertEq(token.availableBalanceOf(SELLER), SUPPLY);
    }

    function test_CancelAfterCommitReverts() public {
        // The asset-side mirror of "no refund after COMMIT". Returning units to
        // freely spendable balance after commit is exactly the double-payout
        // window the protocol exists to close.
        _reserve(400e6);

        vm.prank(SETTLEMENT);
        token.markCommitted(SETTLEMENT_ID);

        vm.prank(SELLER);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConduitRWACVA.ReservationAlreadyCommitted.selector, SETTLEMENT_ID
            )
        );
        token.cancelReservation(SETTLEMENT_ID);
    }

    function test_OutsiderCannotCancel() public {
        _reserve(400e6);

        vm.prank(OUTSIDER);
        vm.expectRevert(
            abi.encodeWithSelector(ConduitRWACVA.NotReservationOwner.selector, OUTSIDER, SELLER)
        );
        token.cancelReservation(SETTLEMENT_ID);
    }

    // ── R3: releasable only after COMMIT ─────────────────────────────────────

    function test_ReleaseBeforeCommitReverts() public {
        _reserve(400e6);

        vm.prank(SETTLEMENT);
        vm.expectRevert(
            abi.encodeWithSelector(ConduitRWACVA.ReservationNotCommitted.selector, SETTLEMENT_ID)
        );
        token.releaseReservation(SETTLEMENT_ID, BUYER);
    }

    function test_ReleaseAfterCommitMovesExactAmount() public {
        _reserve(400e6);

        vm.prank(SETTLEMENT);
        token.markCommitted(SETTLEMENT_ID);

        vm.prank(SETTLEMENT);
        token.releaseReservation(SETTLEMENT_ID, BUYER);

        assertEq(token.balanceOf(BUYER), 400e6, "buyer receives the exact reserved amount");
        assertEq(token.balanceOf(SELLER), 600e6);
        assertEq(token.reservedBalanceOf(SELLER), 0);
        assertEq(token.availableBalanceOf(SELLER), 600e6);
    }

    function test_ReleaseIsIdempotentlyRefused() public {
        _reserve(400e6);
        vm.startPrank(SETTLEMENT);
        token.markCommitted(SETTLEMENT_ID);
        token.releaseReservation(SETTLEMENT_ID, BUYER);

        vm.expectRevert(
            abi.encodeWithSelector(ConduitRWACVA.ReservationClosed.selector, SETTLEMENT_ID)
        );
        token.releaseReservation(SETTLEMENT_ID, BUYER);
        vm.stopPrank();
    }

    function test_OnlySettlementRoleMayReleaseOrCommit() public {
        _reserve(400e6);

        vm.prank(OUTSIDER);
        vm.expectRevert();
        token.markCommitted(SETTLEMENT_ID);

        vm.prank(SELLER);
        vm.expectRevert();
        token.releaseReservation(SETTLEMENT_ID, BUYER);
    }

    function test_ReleaseGuardDoesNotLeakToOtherTransfers() public {
        // The guard is transient and scoped to one release. If it leaked, the
        // seller could spend a second reservation immediately afterwards.
        _reserve(400e6);
        vm.prank(SELLER);
        token.reserveForSettlement(keccak256("settlement-2"), 500e6);

        vm.startPrank(SETTLEMENT);
        token.markCommitted(SETTLEMENT_ID);
        token.releaseReservation(SETTLEMENT_ID, BUYER);
        vm.stopPrank();

        // 1000 - 400 released = 600 held, of which 500 is still reserved.
        assertEq(token.availableBalanceOf(SELLER), 100e6);

        vm.prank(SELLER);
        vm.expectRevert();
        // The call below is asserted to revert, so it never returns a value to
        // check. Not a silenced finding: provably inapplicable here.
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transfer(OUTSIDER, 101e6);
    }

    // ── R5: policy.canTransfer on every actual transfer ──────────────────────

    function test_PolicyDenialBlocksOrdinaryTransfer() public {
        policy.setDenied(OUTSIDER, true);

        vm.prank(SELLER);
        vm.expectRevert(IATokenPolicy.TransferNotAllowed.selector);
        // The call below is asserted to revert, so it never returns a value to
        // check. Not a silenced finding: provably inapplicable here.
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transfer(OUTSIDER, 1e6);
    }

    function test_PolicyDenialBlocksSettlementRelease() public {
        // A recipient that became ineligible between prepare and release must
        // not receive, even with a valid commit. The units stay reserved and the
        // settlement is held.
        _reserve(400e6);
        vm.prank(SETTLEMENT);
        token.markCommitted(SETTLEMENT_ID);

        policy.setDenied(BUYER, true);

        vm.prank(SETTLEMENT);
        vm.expectRevert(IATokenPolicy.TransferNotAllowed.selector);
        token.releaseReservation(SETTLEMENT_ID, BUYER);

        assertEq(token.balanceOf(BUYER), 0);
        assertEq(token.reservedBalanceOf(SELLER), 400e6, "units remain reserved, not lost");
    }

    function test_PolicyIsConsultedForEveryTransfer() public {
        policy.setAllowAll(false);

        vm.prank(SELLER);
        vm.expectRevert(IATokenPolicy.TransferNotAllowed.selector);
        // The call below is asserted to revert, so it never returns a value to
        // check. Not a silenced finding: provably inapplicable here.
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        token.transfer(BUYER, 1);
    }

    // ── RuleV2 wrappers ──────────────────────────────────────────────────────

    function test_RuleV2WrappersRouteThroughTheToken() public {
        IComplianceRule.RuleV2 memory rule = IComplianceRule.RuleV2({
            allowedGroup: bytes2(0),
            allowedSubGroup: bytes2(0),
            minTier: 30,
            minSubTier: 0,
            // ASM-025: the country encoding is unresolved, so this is always 0
            // and no country enforcement is claimed.
            poolCountryBitmap: 0
        });

        vm.prank(ADMIN);
        token.setRuleV2(rule);

        IComplianceRule.RuleV2[] memory rules = token.getRulesV2();
        assertEq(rules.length, 1);
        assertEq(rules[0].minTier, 30);
        assertEq(rules[0].poolCountryBitmap, 0, "country bitmap stays unrestricted");
    }

    function test_OnlyAdminMayManageRules() public {
        IComplianceRule.RuleV2 memory rule;

        vm.prank(OUTSIDER);
        vm.expectRevert();
        token.setRuleV2(rule);
    }

    // ── Properties ───────────────────────────────────────────────────────────

    function testFuzz_ReservedNeverExceedsBalance(uint96 reserveAmount, uint96 transferAmount)
        public
    {
        uint256 reserved = bound(uint256(reserveAmount), 1, SUPPLY);
        vm.prank(SELLER);
        token.reserveForSettlement(SETTLEMENT_ID, reserved);

        uint256 moved = bound(uint256(transferAmount), 0, SUPPLY);
        vm.prank(SELLER);
        try token.transfer(OUTSIDER, moved) {
            // A transfer that succeeded must have left every reserved unit behind.
            assertGe(token.balanceOf(SELLER), token.reservedBalanceOf(SELLER));
        } catch {
            // Rejected transfers must not have moved anything.
            assertEq(token.balanceOf(OUTSIDER), 0);
        }

        assertLe(
            token.reservedBalanceOf(SELLER),
            token.balanceOf(SELLER),
            "R1: reserved can never exceed the balance backing it"
        );
    }

    function testFuzz_AvailablePlusReservedEqualsBalance(uint96 amount) public {
        uint256 reserved = bound(uint256(amount), 1, SUPPLY);
        vm.prank(SELLER);
        token.reserveForSettlement(SETTLEMENT_ID, reserved);

        assertEq(
            token.availableBalanceOf(SELLER) + token.reservedBalanceOf(SELLER),
            token.balanceOf(SELLER),
            "R1 stated as an identity"
        );
    }

    function testFuzz_ReleaseConservesSupply(uint96 amount) public {
        uint256 reserved = bound(uint256(amount), 1, SUPPLY);
        uint256 before = token.totalSupply();

        vm.prank(SELLER);
        token.reserveForSettlement(SETTLEMENT_ID, reserved);
        vm.startPrank(SETTLEMENT);
        token.markCommitted(SETTLEMENT_ID);
        token.releaseReservation(SETTLEMENT_ID, BUYER);
        vm.stopPrank();

        assertEq(token.totalSupply(), before, "a release moves units, it never creates them");
        assertEq(token.balanceOf(SELLER) + token.balanceOf(BUYER), before);
    }
}

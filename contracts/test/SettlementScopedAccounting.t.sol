// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {ConduitRWACVA} from "../src/ConduitRWACVA.sol";
import {DispositionOrderLib} from "../src/libraries/DispositionOrderLib.sol";
import {DispositionTypes} from "../src/libraries/DispositionTypes.sol";
import {DispositionFixture} from "./helpers/DispositionFixture.sol";

/// @notice One wallet, two settlements, and the difference between them.
///
/// This is a regression suite for a verifier finding, and the finding was a
/// false negative on a settlement that had behaved perfectly. The check asked
/// `reservedBalanceOf(seller) == 0` and treated a non-zero answer as "this
/// settlement still holds units". It does not mean that. It is an aggregate over
/// every open reservation the wallet has, and the seller had another settlement
/// legitimately held on an older generation — so a correct settlement was
/// reported as incomplete because a different one was still open.
///
/// The mistake is the cross-chain address collision in another costume: a claim
/// keyed to the wrong identity. There, one address meant two contracts because
/// the chain was missing from the key. Here, one balance meant two settlements
/// because the settlement was missing from the key. Both read as a fact about
/// the thing you were asking about, and both are facts about a larger set that
/// contains it.
///
/// The live shape is preserved deliberately: generation 1 still holds
/// `0x2b8ff0a7…` with 500,000 reserved and has no disposition path, and
/// generation 2 settled `0x30aa1b73…` against the same token and the same
/// seller. Nothing in this repository should ever again infer one settlement's
/// state from a wallet aggregate, and these tests fail if something does.
contract SettlementScopedAccountingTest is DispositionFixture {
    bytes32 private constant OTHER_SETTLEMENT = keccak256("a second settlement, same seller");
    uint256 private constant OTHER_AMOUNT = 300e3;

    /// @dev The seller opens a second reservation that nothing in this test ever
    ///      resolves. It stands for the generation-1 hold: a real, correct,
    ///      permanently open position against the same wallet and token.
    function _openASecondReservation() private {
        vm.chainId(BASE);
        vm.prank(seller);
        rwa.reserveForSettlement(OTHER_SETTLEMENT, OTHER_AMOUNT);
    }

    function test_ReservedBalanceIsAnAggregateAcrossSettlements() public {
        _openASecondReservation();
        bytes32 settlementId = _holdBothLegs();

        vm.chainId(BASE);
        // #then the wallet aggregate is the sum, and belongs to neither
        assertEq(rwa.reservedBalanceOf(seller), ASSET_AMOUNT + OTHER_AMOUNT);

        // #and each settlement's own reservation is exactly its own
        assertEq(rwa.reservationOf(settlementId).amount, ASSET_AMOUNT);
        assertEq(rwa.reservationOf(OTHER_SETTLEMENT).amount, OTHER_AMOUNT);
        assertEq(rwa.reservationOf(settlementId).settlementId, settlementId);
    }

    /// @notice The exact false negative, reproduced and then refuted.
    ///
    /// @dev The first assertion is the check as it was written, and it is the
    ///      one that must not come back. The second is the check as it is now:
    ///      it asks about this settlement and answers correctly while the other
    ///      one is still open.
    function test_ASettledLegIsNotUnsettledByAnotherSettlementsOpenReservation() public {
        _openASecondReservation();
        bytes32 settlementId = _holdBothLegs();
        _disposeAssetToCustody(settlementId);

        vm.chainId(BASE);

        // The old check. It reads as "this settlement still holds units" and it
        // is false: what remains belongs to the other settlement entirely.
        assertTrue(
            rwa.reservedBalanceOf(seller) != 0,
            "the aggregate is non-zero, and says nothing about this settlement"
        );
        assertEq(rwa.reservedBalanceOf(seller), OTHER_AMOUNT, "and it is the other one's, exactly");

        // The correct check, keyed by settlement.
        ConduitRWACVA.Reservation memory disposed = rwa.reservationOf(settlementId);
        assertTrue(disposed.released, "this settlement released");
        assertFalse(disposed.cancelled);

        ConduitRWACVA.Reservation memory other = rwa.reservationOf(OTHER_SETTLEMENT);
        assertFalse(other.released, "and the other is still open, correctly");
        assertFalse(other.cancelled);
    }

    /// @dev The mirror failure: an aggregate that reads as clean while a
    ///      settlement is still stuck. A wallet whose only open reservation was
    ///      just released reports zero, and a check keyed on the aggregate would
    ///      call a held settlement finished.
    function test_AZeroAggregateDoesNotProveASettlementIsResolved() public {
        bytes32 settlementId = _holdBothLegs();

        // #given a second seller with nothing reserved at all
        address quietSeller = address(0x9017E7);
        vm.chainId(BASE);
        assertEq(rwa.reservedBalanceOf(quietSeller), 0);

        // #then the aggregate for that wallet is zero and proves nothing about
        //     this settlement, which is held against a different seller
        assertEq(rwa.reservationOf(settlementId).owner, seller);
        assertTrue(rwa.reservationOf(settlementId).committed);
        assertFalse(rwa.reservationOf(settlementId).released);
    }

    /// @dev Conservation stated the only way it is true: per settlement, summed.
    ///      The aggregate is a consequence of the per-settlement facts and never
    ///      a substitute for them.
    function test_TheAggregateIsTheSumOfTheOpenSettlementsAndOnlyThat() public {
        _openASecondReservation();
        bytes32 settlementId = _holdBothLegs();

        vm.chainId(BASE);
        assertEq(
            rwa.reservedBalanceOf(seller), _openAmount(settlementId) + _openAmount(OTHER_SETTLEMENT)
        );

        _disposeAssetToCustody(settlementId);

        vm.chainId(BASE);
        assertEq(_openAmount(settlementId), 0);
        assertEq(
            rwa.reservedBalanceOf(seller), _openAmount(settlementId) + _openAmount(OTHER_SETTLEMENT)
        );
        assertEq(rwa.availableBalanceOf(seller), rwa.balanceOf(seller) - OTHER_AMOUNT);
    }

    /// @notice D-06. A second open reservation made the first one unreleasable.
    ///
    /// @dev The defect this suite found, pinned by its arithmetic rather than by
    ///      its symptom, so a regression cannot pass by producing a different
    ///      panic.
    ///
    ///      `releaseReservation` decrements `_reservedOf[owner]` and then
    ///      transfers. `_update` then subtracted the releasing reservation's
    ///      amount from `_reservedOf` a second time. With one reservation the
    ///      subtraction is unreachable — the decrement leaves the mapping at
    ///      zero and the guard is skipped — which is why ninety tests and two
    ///      live settlements never touched it. It needs the shape below:
    ///
    /// ```text
    ///        this settlement    500,000    being released
    ///        another one        300,000    open, unrelated, correct
    ///
    ///        _reservedOf after the decrement      300,000
    ///        _update subtracted this one again  - 500,000   → underflow
    /// ```
    ///
    ///      The panic reverts the release, and there is no other way out of a
    ///      held leg: the value is stuck permanently, on a settlement whose
    ///      disposition was authorized, signed, uncontested and rested. The
    ///      other direction is quieter and worse in kind — with a larger second
    ///      reservation there is no panic, and the guard under-counts what is
    ///      still reserved for the duration of the transfer, which is invariant
    ///      R1 relaxed rather than enforced.
    ///
    ///      The deployed seller is one settlement away from this: generation 1
    ///      holds 500,000 against the same token with no disposition path.
    function test_D06_ASecondOpenReservationDoesNotBlockReleasingTheFirst() public {
        // #given a smaller unrelated reservation, which is what makes the old
        //        double-subtraction underflow rather than merely over-permit
        _openASecondReservation();
        assertLt(OTHER_AMOUNT, ASSET_AMOUNT, "the shape the defect needs");

        bytes32 settlementId = _holdBothLegs();
        vm.chainId(BASE);
        assertEq(rwa.reservedBalanceOf(seller), ASSET_AMOUNT + OTHER_AMOUNT);

        // #when the larger one is disposed
        _disposeAssetToCustody(settlementId);

        // #then it moved, rather than reverting on an underflow
        vm.chainId(BASE);
        assertEq(rwa.balanceOf(custodyAccount), ASSET_AMOUNT);

        // #and the guard still holds exactly the other settlement's units
        assertEq(rwa.reservedBalanceOf(seller), OTHER_AMOUNT);
        uint256 sellerBalance = rwa.balanceOf(seller);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConduitRWACVA.InsufficientAvailableBalance.selector,
                sellerBalance - OTHER_AMOUNT,
                sellerBalance
            )
        );
        vm.prank(seller);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        rwa.transfer(stranger, sellerBalance);
    }

    function _openAmount(bytes32 settlementId) private view returns (uint256) {
        ConduitRWACVA.Reservation memory reservation = rwa.reservationOf(settlementId);
        if (reservation.owner == address(0) || reservation.released || reservation.cancelled) {
            return 0;
        }
        return reservation.amount;
    }

    function _disposeAssetToCustody(bytes32 settlementId) private {
        vm.chainId(BASE);
        DispositionTypes.Leg leg = DispositionTypes.Leg.ASSET;
        _fileOrder(
            baseKernel,
            _order(
                baseKernel,
                baseRegistry,
                leg,
                DispositionTypes.DispositionType.RESTRICTED_HOLD,
                custodyAccount,
                agent,
                DispositionTypes.AuthorityType.TRANSFER_AGENT
            ),
            AGENT_KEY
        );
        vm.warp(block.timestamp + CONTEST_WINDOW + 1);
        vm.prank(RELAYER);
        baseKernel.executeOrder(
            DispositionOrderLib.caseIdFor(DEPLOYMENT_ID, settlementId, leg),
            _proof(adapterDomain, settlementId, custodyAccount, true)
        );
    }
}

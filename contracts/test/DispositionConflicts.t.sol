// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {AuthorityRegistry} from "../src/AuthorityRegistry.sol";
import {ComplianceAuthority} from "../src/ComplianceAuthority.sol";
import {DispositionController} from "../src/DispositionController.sol";
import {RWACVASettlementAdapter} from "../src/RWACVASettlementAdapter.sol";
import {DispositionOrderLib} from "../src/libraries/DispositionOrderLib.sol";
import {DispositionTypes} from "../src/libraries/DispositionTypes.sol";
import {DispositionFixture} from "./helpers/DispositionFixture.sol";

/// @notice Conflicting authorized orders, and the property that makes them safe.
///
/// PRD FR-012 ends with one sentence: conflicting valid orders produce
/// `CONTESTED`, and no funds move until the conflict is resolved under the
/// configured authority policy. That sentence is only enforceable if an order
/// cannot execute the instant it arrives — otherwise the first relayer to land a
/// transaction has already decided, and the second authority's equally valid
/// order arrives to find a case that is over.
///
/// The tests below are ordered as the argument runs. First that a conflict is
/// detected at all. Then that neither submission order decides it, tried both
/// ways round. Then that a contested case moves nothing until a resolver the
/// policy names picks a winner, and that the resolver's own authority is
/// checked as hard as the order signer's was.
contract DispositionConflictsTest is DispositionFixture {
    /// @dev Both parties genuinely disagree about where a held bond should go.
    ///      The issuer wants it substituted to an approved wallet; the transfer
    ///      agent wants it rebound to a replacement wallet for the same
    ///      identity. Both are authorized, both are within policy, and they
    ///      cannot both happen.
    function _twoValidDisagreeingOrders()
        private
        returns (
            DispositionOrderLib.DispositionOrder memory substitution,
            DispositionOrderLib.DispositionOrder memory rebind
        )
    {
        substitution = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION,
            substituteWallet,
            issuer,
            DispositionTypes.AuthorityType.ISSUER
        );
        rebind = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Detection
    // ─────────────────────────────────────────────────────────────────────────

    function test_TwoValidDisagreeingOrdersContestTheCase() public {
        _holdBothLegs();
        (
            DispositionOrderLib.DispositionOrder memory substitution,
            DispositionOrderLib.DispositionOrder memory rebind
        ) = _twoValidDisagreeingOrders();

        vm.chainId(BASE);
        _fileOrder(baseKernel, substitution, ISSUER_KEY);
        assertEq(
            uint8(baseKernel.caseOf(substitution.caseId).state),
            uint8(DispositionController.CaseState.OPEN)
        );

        _fileOrder(baseKernel, rebind, AGENT_KEY);
        assertEq(
            uint8(baseKernel.caseOf(rebind.caseId).state),
            uint8(DispositionController.CaseState.CONTESTED),
            "PRD FR-012: conflicting valid orders produce CONTESTED"
        );
        assertEq(substitution.caseId, rebind.caseId, "and they meet in one case by construction");
    }

    /// @dev Two orders of the same type pointing at different destinations are
    ///      still a conflict. Compatibility is about where the value ends up,
    ///      not about which paragraph of the PRD authorized it.
    function test_SameTypeDifferentDestinationIsStillAConflict() public {
        _holdBothLegs();

        vm.chainId(BASE);
        vm.startPrank(OWNER);
        baseRegistry.proposeSubstitute(buyer, stranger);
        vm.stopPrank();
        vm.warp(block.timestamp + GRANT_DELAY + 1);
        baseRegistry.activateSubstitute(buyer, stranger);

        DispositionOrderLib.DispositionOrder memory toApproved = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION,
            substituteWallet,
            issuer,
            DispositionTypes.AuthorityType.ISSUER
        );
        DispositionOrderLib.DispositionOrder memory toOther = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION,
            stranger,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );

        _fileOrder(baseKernel, toApproved, ISSUER_KEY);
        _fileOrder(baseKernel, toOther, AGENT_KEY);

        assertEq(
            uint8(baseKernel.caseOf(toApproved.caseId).state),
            uint8(DispositionController.CaseState.CONTESTED)
        );
    }

    /// @dev Two orders that agree are not a conflict, they are a quorum. This is
    ///      the same mechanism the two-signature rebind uses, seen from the
    ///      conflict side.
    function test_TwoAgreeingOrdersAreASecondSignatureNotAConflict() public {
        _holdBothLegs();
        vm.chainId(BASE);

        DispositionOrderLib.DispositionOrder memory first = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        DispositionOrderLib.DispositionOrder memory second = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            operator,
            DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR
        );

        _fileOrder(baseKernel, first, AGENT_KEY);
        _fileOrder(baseKernel, second, OPERATOR_KEY);

        DispositionController.Case memory openCase = baseKernel.caseOf(first.caseId);
        assertEq(uint8(openCase.state), uint8(DispositionController.CaseState.OPEN));
        assertEq(openCase.signatures, 2);
    }

    function test_OneAuthorityCannotMeetItsOwnThresholdTwice() public {
        _holdBothLegs();
        vm.chainId(BASE);

        DispositionOrderLib.DispositionOrder memory first = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        DispositionOrderLib.DispositionOrder memory again = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        _fileOrder(baseKernel, first, AGENT_KEY);

        bytes memory signature = _sign(AGENT_KEY, baseKernel.orderDigest(again));
        vm.expectRevert(
            abi.encodeWithSelector(DispositionController.AuthorityAlreadySigned.selector, agent)
        );
        vm.prank(RELAYER);
        baseKernel.fileOrder(again, signature);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The property: submission order decides nothing
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The whole reason a filed order rests before it executes.
    ///
    /// @dev Run both ways round, in one test, so the assertion is about the
    ///      absence of an ordering effect rather than about one particular
    ///      ordering. Whichever relayer wins the race, the case ends CONTESTED
    ///      and the bond has not moved. Without the contest window the first
    ///      order would simply execute and the second authority's equally valid
    ///      order would arrive at a finished settlement — the legal outcome
    ///      decided by gas price.
    function test_ARelayerRaceCannotDecideTheOutcome() public {
        _holdBothLegs();
        vm.chainId(BASE);
        (
            DispositionOrderLib.DispositionOrder memory substitution,
            DispositionOrderLib.DispositionOrder memory rebind
        ) = _twoValidDisagreeingOrders();

        uint256 snapshot = vm.snapshotState();

        // #when the substitution lands first
        vm.prank(RELAYER);
        baseKernel.fileOrder(substitution, _sign(ISSUER_KEY, baseKernel.orderDigest(substitution)));
        vm.prank(OTHER_RELAYER);
        baseKernel.fileOrder(rebind, _sign(AGENT_KEY, baseKernel.orderDigest(rebind)));

        DispositionController.CaseState substitutionFirst =
        baseKernel.caseOf(substitution.caseId).state;
        uint256 substituteBalance = rwa.balanceOf(substituteWallet);
        uint256 rebindBalance = rwa.balanceOf(rebindWallet);

        vm.revertToState(snapshot);
        vm.chainId(BASE);

        // #and when the rebind lands first instead
        vm.prank(OTHER_RELAYER);
        baseKernel.fileOrder(rebind, _sign(AGENT_KEY, baseKernel.orderDigest(rebind)));
        vm.prank(RELAYER);
        baseKernel.fileOrder(substitution, _sign(ISSUER_KEY, baseKernel.orderDigest(substitution)));

        // #then both orderings reach the same place, and it is not an outcome
        assertEq(
            uint8(baseKernel.caseOf(rebind.caseId).state),
            uint8(substitutionFirst),
            "the arrival order changed nothing"
        );
        assertEq(
            uint8(baseKernel.caseOf(rebind.caseId).state),
            uint8(DispositionController.CaseState.CONTESTED)
        );
        assertEq(rwa.balanceOf(substituteWallet), substituteBalance);
        assertEq(rwa.balanceOf(rebindWallet), rebindBalance);
        assertEq(rwa.balanceOf(substituteWallet), 0, "and nothing moved either way");
        assertEq(rwa.balanceOf(rebindWallet), 0);
        assertEq(rwa.reservedBalanceOf(seller), ASSET_AMOUNT, "the bond is still held");
    }

    /// @dev The other half of the same property. An order that could execute
    ///      immediately would make the contest window decorative, so the window
    ///      is enforced rather than advisory.
    function test_AnOrderCannotExecuteInsideItsContestWindow() public {
        bytes32 settlementId = _holdBothLegs();
        vm.chainId(BASE);

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION,
            substituteWallet,
            issuer,
            DispositionTypes.AuthorityType.ISSUER
        );
        _fileOrder(baseKernel, order, ISSUER_KEY);

        uint64 openUntil = uint64(block.timestamp) + CONTEST_WINDOW;
        ComplianceAuthority.ComplianceProof memory proof =
            _proof(adapterDomain, settlementId, substituteWallet, true);

        vm.expectRevert(
            abi.encodeWithSelector(
                DispositionController.ContestWindowOpen.selector, openUntil, block.timestamp
            )
        );
        vm.prank(RELAYER);
        baseKernel.executeOrder(order.caseId, proof);
    }

    /// @dev The window is not the only door. A permissionless retry that
    ///      delivered to the original receiver would pre-empt a resting rebind
    ///      just as effectively as an early execution would, so it stands down
    ///      while a case is live.
    function test_ThePermissionlessRetryStandsDownWhileACaseIsOpen() public {
        bytes32 settlementId = _holdBothLegs();
        vm.chainId(BASE);

        DispositionOrderLib.DispositionOrder memory rebind = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        _fileOrder(baseKernel, rebind, AGENT_KEY);

        ComplianceAuthority.ComplianceProof memory proof =
            _proof(adapterDomain, settlementId, buyer, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                RWACVASettlementAdapter.LegClaimedByDisposition.selector, settlementId
            )
        );
        vm.prank(RELAYER);
        adapter.resolveHeldAsset(settlementId, proof);

        assertEq(rwa.balanceOf(buyer), 0, "and the original receiver got nothing");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Resolution under the policy
    // ─────────────────────────────────────────────────────────────────────────

    function test_AContestedCaseExecutesNothing() public {
        bytes32 settlementId = _holdBothLegs();
        vm.chainId(BASE);
        (
            DispositionOrderLib.DispositionOrder memory substitution,
            DispositionOrderLib.DispositionOrder memory rebind
        ) = _twoValidDisagreeingOrders();
        _fileOrder(baseKernel, substitution, ISSUER_KEY);
        _fileOrder(baseKernel, rebind, AGENT_KEY);

        vm.warp(block.timestamp + CONTEST_WINDOW + 1);
        ComplianceAuthority.ComplianceProof memory proof =
            _proof(adapterDomain, settlementId, substituteWallet, true);

        vm.expectRevert(
            abi.encodeWithSelector(
                DispositionController.CaseNotOpen.selector,
                substitution.caseId,
                DispositionController.CaseState.CONTESTED
            )
        );
        vm.prank(RELAYER);
        baseKernel.executeOrder(substitution.caseId, proof);
    }

    function test_TheResolverPicksAWinnerAndOnlyThatWinnerExecutes() public {
        bytes32 settlementId = _holdBothLegs();
        vm.chainId(BASE);
        (
            DispositionOrderLib.DispositionOrder memory substitution,
            DispositionOrderLib.DispositionOrder memory rebind
        ) = _twoValidDisagreeingOrders();
        _fileOrder(baseKernel, substitution, ISSUER_KEY);
        bytes32 rebindHash = _fileOrder(baseKernel, rebind, AGENT_KEY);

        // #when the transfer agent, who the policy names as the resolver, picks
        //     the rebind
        _adjudicate(rebind.caseId, rebindHash);

        assertEq(
            uint8(baseKernel.caseOf(rebind.caseId).state),
            uint8(DispositionController.CaseState.ADJUDICATED)
        );

        // #then the case executes the winner without a further wait, and the
        //     loser's destination receives nothing
        vm.prank(RELAYER);
        baseKernel.executeOrder(
            rebind.caseId, _proof(adapterDomain, settlementId, rebindWallet, true)
        );

        assertEq(rwa.balanceOf(rebindWallet), ASSET_AMOUNT);
        assertEq(rwa.balanceOf(substituteWallet), 0, "the losing order moved nothing");
    }

    function test_AnAdjudicatedCaseRefusesFurtherFilings() public {
        _holdBothLegs();
        vm.chainId(BASE);
        (
            DispositionOrderLib.DispositionOrder memory substitution,
            DispositionOrderLib.DispositionOrder memory rebind
        ) = _twoValidDisagreeingOrders();
        _fileOrder(baseKernel, substitution, ISSUER_KEY);
        bytes32 rebindHash = _fileOrder(baseKernel, rebind, AGENT_KEY);
        _adjudicate(rebind.caseId, rebindHash);

        // #when a third authority tries to reopen the argument
        DispositionOrderLib.DispositionOrder memory late = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            operator,
            DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR
        );
        bytes memory signature = _sign(OPERATOR_KEY, baseKernel.orderDigest(late));

        vm.expectRevert(
            abi.encodeWithSelector(DispositionController.CaseIsTerminal.selector, late.caseId)
        );
        vm.prank(RELAYER);
        baseKernel.fileOrder(late, signature);
    }

    /// @dev The policy names TRANSFER_AGENT and nothing else as the resolver
    ///      class. An ISSUER may sign orders and may not decide who wins.
    function test_AnAuthorityThePolicyDoesNotNameCannotResolveAConflict() public {
        _holdBothLegs();
        vm.chainId(BASE);
        (
            DispositionOrderLib.DispositionOrder memory substitution,
            DispositionOrderLib.DispositionOrder memory rebind
        ) = _twoValidDisagreeingOrders();
        bytes32 substitutionHash = _fileOrder(baseKernel, substitution, ISSUER_KEY);
        _fileOrder(baseKernel, rebind, AGENT_KEY);

        DispositionOrderLib.ConflictResolution[] memory resolutions =
            new DispositionOrderLib.ConflictResolution[](1);
        resolutions[0] = _resolution(
            baseRegistry,
            substitution.caseId,
            substitutionHash,
            issuer,
            DispositionTypes.AuthorityType.ISSUER
        );
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _sign(ISSUER_KEY, baseKernel.resolutionDigest(resolutions[0]));

        vm.expectRevert(
            abi.encodeWithSelector(
                DispositionController.AuthorityTypeNotPermitted.selector,
                DispositionTypes.AuthorityType.ISSUER
            )
        );
        vm.prank(RELAYER);
        baseKernel.resolveConflict(substitution.caseId, resolutions, signatures);
    }

    /// @dev The winner has to be an order somebody actually filed. Otherwise a
    ///      resolver could adjudicate in favour of terms no authority signed,
    ///      which is a resolver authoring an order rather than choosing between
    ///      them.
    function test_AResolverCannotPickAnOrderNobodyFiled() public {
        _holdBothLegs();
        vm.chainId(BASE);
        (
            DispositionOrderLib.DispositionOrder memory substitution,
            DispositionOrderLib.DispositionOrder memory rebind
        ) = _twoValidDisagreeingOrders();
        _fileOrder(baseKernel, substitution, ISSUER_KEY);
        _fileOrder(baseKernel, rebind, AGENT_KEY);

        bytes32 invented = keccak256("an order nobody signed");
        DispositionOrderLib.ConflictResolution[] memory resolutions =
            new DispositionOrderLib.ConflictResolution[](1);
        resolutions[0] = _resolution(
            baseRegistry,
            substitution.caseId,
            invented,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _sign(AGENT_KEY, baseKernel.resolutionDigest(resolutions[0]));

        vm.expectRevert(
            abi.encodeWithSelector(
                DispositionController.OrderNotFiled.selector, substitution.caseId, invented
            )
        );
        vm.prank(RELAYER);
        baseKernel.resolveConflict(substitution.caseId, resolutions, signatures);
    }

    function test_ResolvingAnUncontestedCaseIsRefused() public {
        _holdBothLegs();
        vm.chainId(BASE);
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION,
            substituteWallet,
            issuer,
            DispositionTypes.AuthorityType.ISSUER
        );
        bytes32 orderHash = _fileOrder(baseKernel, order, ISSUER_KEY);

        DispositionOrderLib.ConflictResolution[] memory resolutions =
            new DispositionOrderLib.ConflictResolution[](1);
        resolutions[0] = _resolution(
            baseRegistry,
            order.caseId,
            orderHash,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _sign(AGENT_KEY, baseKernel.resolutionDigest(resolutions[0]));

        vm.expectRevert(
            abi.encodeWithSelector(
                DispositionController.CaseNotContested.selector,
                order.caseId,
                DispositionController.CaseState.OPEN
            )
        );
        vm.prank(RELAYER);
        baseKernel.resolveConflict(order.caseId, resolutions, signatures);
    }

    /// @dev A policy with no resolver class turns any conflict into permanent
    ///      loss of the held value: CONTESTED with no exit. PRD 7.1 lists
    ///      CONTESTED -> SETTLED as a transition that has to exist, so the
    ///      registry refuses to store a policy that cannot reach it.
    function test_APolicyThatCannotResolveAConflictIsRefused() public {
        AuthorityRegistry.AuthorityPolicy memory broken = _policy();
        broken.resolverAuthorityTypes = 0;

        vm.chainId(BASE);
        vm.expectRevert(
            abi.encodeWithSelector(
                AuthorityRegistry.PolicyResolverUnsatisfiable.selector, keccak256("broken")
            )
        );
        vm.prank(OWNER);
        baseRegistry.setPolicy(keccak256("broken"), broken);
    }

    function _adjudicate(bytes32 caseId, bytes32 winner) private {
        DispositionOrderLib.ConflictResolution[] memory resolutions =
            new DispositionOrderLib.ConflictResolution[](1);
        resolutions[0] = _resolution(
            baseRegistry, caseId, winner, agent, DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = _sign(AGENT_KEY, baseKernel.resolutionDigest(resolutions[0]));

        vm.prank(RELAYER);
        baseKernel.resolveConflict(caseId, resolutions, signatures);
    }
}

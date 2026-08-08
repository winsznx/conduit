// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {AuthorityRegistry} from "../src/AuthorityRegistry.sol";
import {CashEscrow} from "../src/CashEscrow.sol";
import {ComplianceAuthority} from "../src/ComplianceAuthority.sol";
import {DispositionController} from "../src/DispositionController.sol";
import {RWACVASettlementAdapter} from "../src/RWACVASettlementAdapter.sol";
import {SettlementCoordinator} from "../src/SettlementCoordinator.sol";
import {IDispositionExecutor} from "../src/interfaces/IDispositionExecutor.sol";
import {DispositionOrderLib} from "../src/libraries/DispositionOrderLib.sol";
import {DispositionTypes} from "../src/libraries/DispositionTypes.sol";
import {MessageCodec} from "../src/libraries/MessageCodec.sol";
import {DispositionFixture} from "./helpers/DispositionFixture.sol";

/// @notice All six of PRD FR-012's order types, each end to end on a real hold.
///
/// Six order types is six different answers to one question — where may
/// committed, undeliverable value go — and the whole safety argument is that
/// they are not interchangeable. Each test below therefore proves two things:
/// that the type does what the PRD says, and that the destination it used is
/// permissible for that type and for no other.
///
/// Nothing here asserts a hold into existence. `_holdBothLegs` reaches it the
/// way a settlement does, and every message crossing chains is one a production
/// contract emitted.
contract DispositionKernelTest is DispositionFixture {
    using DispositionTypes for DispositionTypes.DispositionType;

    // ─────────────────────────────────────────────────────────────────────────
    // The hold itself
    // ─────────────────────────────────────────────────────────────────────────

    function test_TheFixtureReachesAGenuineHoldOnBothLegs() public {
        bytes32 settlementId = _holdBothLegs();

        SettlementCoordinator.Settlement memory state = coordinator.settlementOf(settlementId);
        assertEq(uint8(state.decision), uint8(SettlementCoordinator.Decision.COMMIT));
        assertEq(uint8(state.state), uint8(SettlementCoordinator.SettlementState.HELD));

        // #then the cash is in the escrow and nobody can take it
        assertEq(cash.balanceOf(address(escrow)), CASH_AMOUNT);
        assertEq(escrow.totalEscrowed(), CASH_AMOUNT);

        // #and the bond is reserved against the seller and undelivered
        vm.chainId(BASE);
        assertEq(rwa.reservedBalanceOf(seller), ASSET_AMOUNT);
        assertEq(rwa.balanceOf(buyer), 0);

        (IDispositionExecutor.HeldLeg memory cashLeg,) =
            _heldLeg(monadKernel, DispositionTypes.Leg.CASH, settlementId);
        (IDispositionExecutor.HeldLeg memory assetLeg,) =
            _heldLeg(baseKernel, DispositionTypes.Leg.ASSET, settlementId);
        assertTrue(cashLeg.held, "cash held");
        assertTrue(assetLeg.held, "asset held");
        assertTrue(cashLeg.committed, "under a COMMIT, which is why there is no refund");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. REVERIFY_AND_RESUME
    // ─────────────────────────────────────────────────────────────────────────

    function test_ReverifyAndResumeDeliversToThePartyTheIntentNamed() public {
        bytes32 settlementId = _holdBothLegs();

        // #given the receiver is eligible again and the subject files a resume
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REVERIFY_AND_RESUME,
            buyer,
            buyer,
            DispositionTypes.AuthorityType.SUBJECT
        );
        vm.chainId(BASE);
        _fileOrder(baseKernel, order, SUBJECT_KEY);

        // #when the contest window closes and anyone executes
        _executeAsset(order.caseId, settlementId, buyer);

        // #then the bond reached the buyer the intent named, and nowhere else
        assertEq(rwa.balanceOf(buyer), ASSET_AMOUNT);
        assertEq(rwa.reservedBalanceOf(seller), 0);
        assertEq(
            uint8(adapter.dispositionOf(settlementId).dispositionType),
            uint8(DispositionTypes.DispositionType.REVERIFY_AND_RESUME)
        );
    }

    function test_AResumeCannotNameADestinationTheIntentDidNot() public {
        _holdBothLegs();

        // #given a resume order pointed at a wallet that is not the receiver
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REVERIFY_AND_RESUME,
            rebindWallet,
            buyer,
            DispositionTypes.AuthorityType.SUBJECT
        );

        // #then it is refused: this type has no destination to choose
        vm.chainId(BASE);
        _expectDestinationRefused(
            baseKernel, order, SUBJECT_KEY, DispositionTypes.DispositionType.REVERIFY_AND_RESUME
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. REBIND_RECEIVER — PRD 5.4
    // ─────────────────────────────────────────────────────────────────────────

    function test_RebindReceiverDeliversToTheReplacementWalletAndNotTheOriginal() public {
        bytes32 settlementId = _holdBothLegs();

        // #given the original receiver stays refused by the policy, permanently
        vm.chainId(BASE);
        vm.prank(address(this));
        policy.setDenied(buyer, true);

        // #and the transfer agent and the compliance operator both sign a rebind
        //     to a wallet holding the same identity commitment
        DispositionOrderLib.DispositionOrder memory first = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        _fileOrder(baseKernel, first, AGENT_KEY);

        DispositionOrderLib.DispositionOrder memory second = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            operator,
            DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR
        );
        _fileOrder(baseKernel, second, OPERATOR_KEY);

        assertEq(baseKernel.caseOf(first.caseId).signatures, 2, "two distinct authorities");

        // #when the window closes and it executes
        _executeAsset(first.caseId, settlementId, rebindWallet);

        // #then the replacement holds the bond and the original holds nothing
        assertEq(rwa.balanceOf(rebindWallet), ASSET_AMOUNT);
        assertEq(rwa.balanceOf(buyer), 0, "the original receiver receives nothing");
        assertEq(rwa.reservedBalanceOf(seller), 0);
    }

    function test_ARebindNeedsBothSignaturesThePolicyRequires() public {
        _holdBothLegs();

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        vm.chainId(BASE);
        _fileOrder(baseKernel, order, AGENT_KEY);

        vm.warp(block.timestamp + CONTEST_WINDOW + 1);
        // Built before `expectRevert`, deliberately. Evaluating an argument
        // after the cheatcode makes the argument's own calls the "next call",
        // and the assertion passes or fails on something the test never meant
        // to exercise.
        ComplianceAuthority.ComplianceProof memory proof =
            _proof(adapterDomain, _settlementId(), rebindWallet, true);
        vm.expectRevert(
            abi.encodeWithSelector(DispositionController.SignaturesBelowThreshold.selector, 1, 2)
        );
        vm.prank(RELAYER);
        baseKernel.executeOrder(order.caseId, proof);
    }

    function test_ARebindToAWalletWithADifferentIdentityIsRefused() public {
        _holdBothLegs();

        // #given a wallet the transfer agent never bound to the buyer's identity
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            stranger,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );

        // #then a rebind is refused. A different identity is a substitution, and
        //     substitution is a different order type under a different authority.
        vm.chainId(BASE);
        bytes32 digest = baseKernel.orderDigest(order);
        vm.expectRevert(
            abi.encodeWithSelector(
                DispositionController.IdentityCommitmentMismatch.selector,
                bytes32(0),
                _identityOf(buyer)
            )
        );
        vm.prank(RELAYER);
        baseKernel.fileOrder(order, _sign(AGENT_KEY, digest));
    }

    function test_ARebindCannotBeChangedAfterItExecutes() public {
        bytes32 settlementId = _holdBothLegs();

        DispositionOrderLib.DispositionOrder memory first = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        vm.chainId(BASE);
        _fileOrder(baseKernel, first, AGENT_KEY);
        DispositionOrderLib.DispositionOrder memory second = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            operator,
            DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR
        );
        _fileOrder(baseKernel, second, OPERATOR_KEY);
        _executeAsset(first.caseId, settlementId, rebindWallet);

        // #when a second rebind is attempted against the same leg
        //
        // Two independent locks refuse it and the custody one refuses first: the
        // leg is no longer held, so there is nothing to dispose of. That order
        // is deliberate. The case being terminal is the kernel's own bookkeeping
        // and a kernel bug could lose it; the leg not being held is a fact about
        // where the value is, and it is checked against the executor.
        DispositionOrderLib.DispositionOrder memory again = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REBIND_RECEIVER,
            rebindWallet,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        bytes32 digest = baseKernel.orderDigest(again);
        bytes memory signature = _sign(AGENT_KEY, digest);
        vm.expectRevert(
            abi.encodeWithSelector(DispositionController.LegNotHeld.selector, settlementId)
        );
        vm.prank(RELAYER);
        baseKernel.fileOrder(again, signature);

        // #and the case lock is there too, which `executeOrder` reaches without
        //     going through the held-leg check
        assertEq(
            uint8(baseKernel.caseOf(first.caseId).state),
            uint8(DispositionController.CaseState.EXECUTED)
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. RETURN_TO_ELIGIBLE_SENDER — a post-COMMIT disposition, not a refund
    // ─────────────────────────────────────────────────────────────────────────

    function test_ReturnToEligibleSenderSendsCashBackAndTheCommitStaysHistory() public {
        bytes32 settlementId = _holdBothLegs();
        uint256 payerBefore = cash.balanceOf(buyer);

        DispositionOrderLib.DispositionOrder memory order = _order(
            monadKernel,
            monadRegistry,
            DispositionTypes.Leg.CASH,
            DispositionTypes.DispositionType.RETURN_TO_ELIGIBLE_SENDER,
            buyer,
            operator,
            DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR
        );
        vm.chainId(MONAD);
        _fileOrder(monadKernel, order, OPERATOR_KEY);

        vm.warp(block.timestamp + CONTEST_WINDOW + 1);
        vm.prank(RELAYER);
        monadKernel.executeOrder(order.caseId, _proof(escrowDomain, settlementId, buyer, true));

        // #then the cash is back with the payer
        assertEq(cash.balanceOf(buyer), payerBefore + CASH_AMOUNT);
        assertEq(escrow.totalEscrowed(), 0);

        // #and this is emphatically not a refund. The COMMIT is still the
        //     canonical decision, the settlement never becomes ABORTED, and the
        //     leg records DISPOSED rather than RETURNED.
        SettlementCoordinator.Settlement memory state = coordinator.settlementOf(settlementId);
        assertEq(uint8(state.decision), uint8(SettlementCoordinator.Decision.COMMIT));
        assertEq(uint8(state.cashOutcome), uint8(SettlementCoordinator.LegOutcome.DISPOSED));
        assertTrue(
            state.state != SettlementCoordinator.SettlementState.ABORTED, "no path back to ABORT"
        );
        assertEq(uint8(escrow.legOf(settlementId).state), uint8(CashEscrow.LegState.DISPOSED));
    }

    function test_ReturnToEligibleSenderCannotBePointedAtAnyoneElse() public {
        _holdBothLegs();

        DispositionOrderLib.DispositionOrder memory order = _order(
            monadKernel,
            monadRegistry,
            DispositionTypes.Leg.CASH,
            DispositionTypes.DispositionType.RETURN_TO_ELIGIBLE_SENDER,
            stranger,
            operator,
            DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR
        );
        vm.chainId(MONAD);
        _expectDestinationRefused(
            monadKernel,
            order,
            OPERATOR_KEY,
            DispositionTypes.DispositionType.RETURN_TO_ELIGIBLE_SENDER
        );
    }

    function test_AnIneligibleSenderCannotBeReturnedTo() public {
        bytes32 settlementId = _holdBothLegs();

        DispositionOrderLib.DispositionOrder memory order = _order(
            monadKernel,
            monadRegistry,
            DispositionTypes.Leg.CASH,
            DispositionTypes.DispositionType.RETURN_TO_ELIGIBLE_SENDER,
            buyer,
            operator,
            DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR
        );
        vm.chainId(MONAD);
        _fileOrder(monadKernel, order, OPERATOR_KEY);
        vm.warp(block.timestamp + CONTEST_WINDOW + 1);

        // #when the authority now refuses the sender at execution time
        ComplianceAuthority.ComplianceProof memory refusal =
            _proof(escrowDomain, settlementId, buyer, false);
        vm.expectRevert(
            abi.encodeWithSelector(CashEscrow.DestinationNotEligible.selector, settlementId, buyer)
        );
        vm.prank(RELAYER);
        monadKernel.executeOrder(order.caseId, refusal);

        // #then the value stays held and the case stays open to try again
        assertEq(cash.balanceOf(address(escrow)), CASH_AMOUNT);
        assertEq(
            uint8(monadKernel.caseOf(order.caseId).state),
            uint8(DispositionController.CaseState.OPEN)
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. AUTHORIZED_SUBSTITUTION — PRD 4.3
    // ─────────────────────────────────────────────────────────────────────────

    function test_AuthorizedSubstitutionDeliversToAnIssuerApprovedSubstitute() public {
        bytes32 settlementId = _holdBothLegs();

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION,
            substituteWallet,
            issuer,
            DispositionTypes.AuthorityType.ISSUER
        );
        vm.chainId(BASE);
        _fileOrder(baseKernel, order, ISSUER_KEY);
        _executeAsset(order.caseId, settlementId, substituteWallet);

        assertEq(rwa.balanceOf(substituteWallet), ASSET_AMOUNT);
        assertEq(rwa.balanceOf(buyer), 0);
        assertEq(
            uint8(adapter.dispositionOf(settlementId).dispositionType),
            uint8(DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION)
        );
    }

    function test_ASubstitutionCannotSendValueToAnUnapprovedWallet() public {
        _holdBothLegs();

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION,
            stranger,
            issuer,
            DispositionTypes.AuthorityType.ISSUER
        );
        vm.chainId(BASE);
        _expectDestinationRefused(
            baseKernel, order, ISSUER_KEY, DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION
        );
    }

    /// @dev The substitute list is keyed by the receiver being substituted, so
    ///      one approval is not an approval against every held settlement in the
    ///      system. This is the difference between a substitution order and a
    ///      generic drain authorization.
    function test_ASubstituteApprovedForOnePartyIsNotApprovedForAnother() public {
        _holdBothLegs();

        vm.chainId(BASE);
        vm.prank(OWNER);
        baseRegistry.revokeSubstitute(buyer, substituteWallet);

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION,
            substituteWallet,
            issuer,
            DispositionTypes.AuthorityType.ISSUER
        );
        // #then the approval that remains — substitute-for-seller — does not
        //     authorize substituting for the buyer
        assertTrue(baseRegistry.isApprovedSubstitute(seller, substituteWallet));
        _expectDestinationRefused(
            baseKernel, order, ISSUER_KEY, DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. OPERATOR_ASSISTED_OFFRAMP — PRD 5.5
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The on-chain half, which is all this contract can do and all it
    ///      claims. The fiat leg happens at a hosted widget outside the chain
    ///      and is recorded in `docs/evidence/asm-010-fiat-ramp.json`; nothing
    ///      here asserts that a fiat settlement occurred.
    function test_OperatorAssistedOfframpMovesCashToTheRegisteredGatewayAccount() public {
        bytes32 settlementId = _holdBothLegs();

        DispositionOrderLib.DispositionOrder memory order = _order(
            monadKernel,
            monadRegistry,
            DispositionTypes.Leg.CASH,
            DispositionTypes.DispositionType.OPERATOR_ASSISTED_OFFRAMP,
            gatewayAccount,
            gateway,
            DispositionTypes.AuthorityType.GATEWAY_OPERATOR
        );
        vm.chainId(MONAD);
        _fileOrder(monadKernel, order, GATEWAY_KEY);

        vm.warp(block.timestamp + CONTEST_WINDOW + 1);
        vm.prank(RELAYER);
        monadKernel.executeOrder(
            order.caseId, _proof(escrowDomain, settlementId, gatewayAccount, true)
        );

        assertEq(cash.balanceOf(gatewayAccount), CASH_AMOUNT);
        assertEq(escrow.totalEscrowed(), 0);
        assertEq(
            uint8(coordinator.settlementOf(settlementId).cashOutcome),
            uint8(SettlementCoordinator.LegOutcome.DISPOSED)
        );
    }

    function test_AnOfframpCannotUseAnUnregisteredDepositAddress() public {
        _holdBothLegs();

        DispositionOrderLib.DispositionOrder memory order = _order(
            monadKernel,
            monadRegistry,
            DispositionTypes.Leg.CASH,
            DispositionTypes.DispositionType.OPERATOR_ASSISTED_OFFRAMP,
            stranger,
            gateway,
            DispositionTypes.AuthorityType.GATEWAY_OPERATOR
        );
        vm.chainId(MONAD);
        _expectDestinationRefused(
            monadKernel,
            order,
            GATEWAY_KEY,
            DispositionTypes.DispositionType.OPERATOR_ASSISTED_OFFRAMP
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. RESTRICTED_HOLD — PRD 5.3's SETTLED_TO_RESTRICTED_CUSTODY
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev A deliberate terminal outcome, not the absence of one. The value
    ///      moves into a registered custodian's hands, the leg becomes DISPOSED,
    ///      and the case closes. Leaving a leg sitting in HELD is the opposite —
    ///      an unresolved case — and the verifier reports the two differently.
    function test_RestrictedHoldMovesValueIntoRegisteredCustodyAndIsTerminal() public {
        bytes32 settlementId = _holdBothLegs();

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        vm.chainId(BASE);
        _fileOrder(baseKernel, order, AGENT_KEY);
        _executeAsset(order.caseId, settlementId, custodyAccount);

        assertEq(rwa.balanceOf(custodyAccount), ASSET_AMOUNT);
        assertEq(rwa.reservedBalanceOf(seller), 0, "nothing remains held");
        assertEq(
            uint8(adapter.dispositionOf(settlementId).dispositionType),
            uint8(DispositionTypes.DispositionType.RESTRICTED_HOLD)
        );

        // #then it cannot transition again
        assertEq(
            uint8(baseKernel.caseOf(order.caseId).state),
            uint8(DispositionController.CaseState.EXECUTED)
        );
        ComplianceAuthority.ComplianceProof memory again =
            _proof(adapterDomain, settlementId, custodyAccount, true);
        vm.expectRevert(
            abi.encodeWithSelector(DispositionController.CaseIsTerminal.selector, order.caseId)
        );
        vm.prank(RELAYER);
        baseKernel.executeOrder(order.caseId, again);
    }

    function test_RestrictedHoldCannotNameAnAddressThatIsNotACustodian() public {
        _holdBothLegs();

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            gatewayAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        // #then the gateway account is a permissible off-ramp destination and
        //     not a permissible custodian. The lists are not interchangeable.
        vm.chainId(BASE);
        assertTrue(baseRegistry.isGatewayAccount(gatewayAccount));
        assertFalse(baseRegistry.isRestrictedCustodian(gatewayAccount));
        _expectDestinationRefused(
            baseKernel, order, AGENT_KEY, DispositionTypes.DispositionType.RESTRICTED_HOLD
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The settlement reaches a terminal state through the kernel
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The shape the live generation-2 run produced, now through the
    ///      authority registry rather than the permissionless retry: cash
    ///      delivered, bond held, disposition executed, DISPOSITION_RESOLVED
    ///      carried back, settlement terminal.
    function test_ADispositionOnOneLegCompletesTheWholeSettlement() public {
        (bytes32 settlementId,) = _holdAssetLegOnly();

        assertEq(
            uint8(coordinator.settlementOf(settlementId).state),
            uint8(SettlementCoordinator.SettlementState.HELD)
        );

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION,
            substituteWallet,
            issuer,
            DispositionTypes.AuthorityType.ISSUER
        );
        vm.chainId(BASE);
        _fileOrder(baseKernel, order, ISSUER_KEY);

        uint256 reportIndex = baseCore.publishedCount();
        _executeAsset(order.caseId, settlementId, substituteWallet);

        // #when the adapter reports what it did
        vm.prank(RELAYER);
        adapter.reportResolution(settlementId, MONAD, 1);

        // #then the report is DISPOSITION_RESOLVED and not ASSET_RELEASED: the
        //     bond did not reach the party the intent named
        MessageCodec.Header memory header =
            MessageCodec.decode(baseCore.publishedAt(reportIndex).payload);
        assertEq(uint8(header.messageType), uint8(MessageCodec.MessageType.DISPOSITION_RESOLVED));

        vm.chainId(MONAD);
        vm.prank(RELAYER);
        coordinator.recordLegResolved(
            _fromBase(reportIndex),
            MessageCodec.MessageType.DISPOSITION_RESOLVED,
            SettlementCoordinator.LegOutcome.DISPOSED
        );

        SettlementCoordinator.Settlement memory state = coordinator.settlementOf(settlementId);
        assertEq(uint8(state.assetOutcome), uint8(SettlementCoordinator.LegOutcome.DISPOSED));
        assertEq(uint8(state.cashOutcome), uint8(SettlementCoordinator.LegOutcome.RELEASED));
        assertEq(uint8(state.state), uint8(SettlementCoordinator.SettlementState.SETTLED));
    }

    function test_ADispositionCannotBeRelabelledAsAnOrdinaryDelivery() public {
        (bytes32 settlementId,) = _holdAssetLegOnly();

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        vm.chainId(BASE);
        _fileOrder(baseKernel, order, AGENT_KEY);
        uint256 reportIndex = baseCore.publishedCount();
        _executeAsset(order.caseId, settlementId, custodyAccount);
        vm.prank(RELAYER);
        adapter.reportResolution(settlementId, MONAD, 1);

        // #when a relayer carries the true DISPOSITION_RESOLVED message but
        //     claims it means an ordinary release
        vm.chainId(MONAD);
        bytes memory report = _fromBase(reportIndex);
        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.OutcomeDoesNotMatchMessage.selector,
                SettlementCoordinator.LegOutcome.RELEASED,
                MessageCodec.MessageType.DISPOSITION_RESOLVED
            )
        );
        vm.prank(RELAYER);
        coordinator.recordLegResolved(
            report,
            MessageCodec.MessageType.DISPOSITION_RESOLVED,
            SettlementCoordinator.LegOutcome.RELEASED
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Shared steps
    // ─────────────────────────────────────────────────────────────────────────

    function _executeAsset(bytes32 caseId, bytes32 settlementId, address destination) private {
        vm.chainId(BASE);
        vm.warp(block.timestamp + CONTEST_WINDOW + 1);
        vm.prank(RELAYER);
        baseKernel.executeOrder(caseId, _proof(adapterDomain, settlementId, destination, true));
    }

    /// @dev Asserts a refusal that reached the contract and named the type and
    ///      the destination. A test that only asserted "it reverted" would be
    ///      satisfied by a malformed order failing three checks earlier.
    function _expectDestinationRefused(
        DispositionController kernel,
        DispositionOrderLib.DispositionOrder memory order,
        uint256 authorityKey,
        DispositionTypes.DispositionType expectedType
    ) private {
        bytes32 digest = kernel.orderDigest(order);
        vm.expectRevert(
            abi.encodeWithSelector(
                DispositionController.DestinationNotPermitted.selector,
                expectedType,
                order.destination
            )
        );
        vm.prank(RELAYER);
        kernel.fileOrder(order, _sign(authorityKey, digest));
    }
}

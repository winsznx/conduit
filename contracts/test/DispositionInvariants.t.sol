// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {AuthorityRegistry} from "../src/AuthorityRegistry.sol";
import {CashEscrow} from "../src/CashEscrow.sol";
import {ComplianceAuthority} from "../src/ComplianceAuthority.sol";
import {ConduitRWACVA} from "../src/ConduitRWACVA.sol";
import {DispositionController} from "../src/DispositionController.sol";
import {RWACVASettlementAdapter} from "../src/RWACVASettlementAdapter.sol";
import {SettlementCoordinator} from "../src/SettlementCoordinator.sol";
import {IDispositionExecutor} from "../src/interfaces/IDispositionExecutor.sol";
import {DispositionOrderLib} from "../src/libraries/DispositionOrderLib.sol";
import {DispositionTypes} from "../src/libraries/DispositionTypes.sol";
import {DispositionFixture} from "./helpers/DispositionFixture.sol";
import {MockSmartWallet} from "./mocks/MockSmartWallet.sol";

/// @notice The Disposition Kernel's permanent invariants.
///
/// Each test here is one property that must hold for every disposition, forever,
/// and each is written so that removing the check it guards makes it fail. They
/// are grouped by what they protect: the ordering of the settlement lifecycle,
/// conservation of value, the binding of an order to one situation, and who is
/// allowed to authorize anything.
///
/// This suite is deliberately separate from `DispositionKernel.t.sol`. That one
/// shows the six order types working; this one shows the ways they must not.
contract DispositionInvariantsTest is DispositionFixture {
    // ─────────────────────────────────────────────────────────────────────────
    // Lifecycle: a disposition acts on held value and nothing else
    // ─────────────────────────────────────────────────────────────────────────

    function test_NoDispositionBeforeACanonicalDecision() public {
        bytes32 settlementId = _settlementId();

        // #given both legs prepared and no COMMIT
        vm.chainId(BASE);
        vm.startPrank(seller);
        rwa.reserveForSettlement(settlementId, ASSET_AMOUNT);
        adapter.prepareAsset(settlementId, settlementId, buyer, MONAD, 1);
        vm.stopPrank();

        // #then there is no held leg to file against
        (IDispositionExecutor.HeldLeg memory held,) =
            _heldLeg(baseKernel, DispositionTypes.Leg.ASSET, settlementId);
        assertFalse(held.held);
        assertFalse(held.committed);

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.REVERIFY_AND_RESUME,
            buyer,
            buyer,
            DispositionTypes.AuthorityType.SUBJECT
        );
        _expectFilingRefused(
            baseKernel,
            order,
            SUBJECT_KEY,
            abi.encodeWithSelector(DispositionController.LegNotHeld.selector, settlementId)
        );
    }

    function test_ADeliveredLegIsNotDisposable() public {
        (bytes32 settlementId,) = _holdAssetLegOnly();

        // #given the cash leg was released normally, not held
        assertEq(uint8(escrow.legOf(settlementId).state), uint8(CashEscrow.LegState.RELEASED));

        DispositionOrderLib.DispositionOrder memory order = _order(
            monadKernel,
            monadRegistry,
            DispositionTypes.Leg.CASH,
            DispositionTypes.DispositionType.RETURN_TO_ELIGIBLE_SENDER,
            buyer,
            operator,
            DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR
        );
        _expectFilingRefused(
            monadKernel,
            order,
            OPERATOR_KEY,
            abi.encodeWithSelector(DispositionController.LegNotHeld.selector, settlementId)
        );
    }

    /// @dev PRD FR-008 and invariant I4. A `RETURN_TO_ELIGIBLE_SENDER`
    ///      disposition sends value back the way it came, and it is emphatically
    ///      not a refund: the refund path stays closed throughout, and the
    ///      settlement never becomes ABORTED.
    function test_NoOrdinaryRefundExistsBeforeOrAfterADisposition() public {
        bytes32 settlementId = _holdBothLegs();
        ComplianceAuthority.ComplianceProof memory proof =
            _proof(escrowDomain, settlementId, buyer, true);

        // #before
        vm.expectRevert(
            abi.encodeWithSelector(
                CashEscrow.LegNotInState.selector,
                settlementId,
                CashEscrow.LegState.HELD,
                CashEscrow.LegState.PREPARED
            )
        );
        vm.prank(RELAYER);
        escrow.returnCash(settlementId, proof);

        _disposeCash(
            settlementId, DispositionTypes.DispositionType.RETURN_TO_ELIGIBLE_SENDER, buyer
        );

        // #after
        ComplianceAuthority.ComplianceProof memory again =
            _proof(escrowDomain, settlementId, buyer, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                CashEscrow.LegNotInState.selector,
                settlementId,
                CashEscrow.LegState.DISPOSED,
                CashEscrow.LegState.PREPARED
            )
        );
        vm.prank(RELAYER);
        escrow.returnCash(settlementId, again);

        assertTrue(
            coordinator.settlementOf(settlementId).state
                != SettlementCoordinator.SettlementState.ABORTED
        );
    }

    function test_NoCommitToAbortTransitionAfterADisposition() public {
        bytes32 settlementId = _holdBothLegs();
        _disposeCash(
            settlementId, DispositionTypes.DispositionType.RETURN_TO_ELIGIBLE_SENDER, buyer
        );

        SettlementCoordinator.Cancellation memory cancellation = SettlementCoordinator.Cancellation({
            compliance: _proof(coordinatorDomain, settlementId, buyer, false),
            buyer: _sign(BUYER_KEY, _cancellationDigest(settlementId)),
            seller: _sign(SELLER_KEY, _cancellationDigest(settlementId))
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                SettlementCoordinator.AbortAfterCommitForbidden.selector, settlementId
            )
        );
        vm.prank(RELAYER);
        coordinator.issueAbort(
            _intent(), settlementId, SettlementCoordinator.AbortGround.BILATERAL, cancellation, 1
        );
    }

    function test_ATerminalDispositionCannotTransitionAgain() public {
        bytes32 settlementId = _holdBothLegs();
        bytes32 caseId = _disposeAsset(
            settlementId, DispositionTypes.DispositionType.RESTRICTED_HOLD, custodyAccount
        );

        // Three independent refusals, and each would be sufficient alone: the
        // kernel's case is EXECUTED, the adapter's reservation is closed, and
        // the coordinator's leg outcome is DISPOSED.
        ComplianceAuthority.ComplianceProof memory proof =
            _proof(adapterDomain, settlementId, custodyAccount, true);
        vm.expectRevert(
            abi.encodeWithSelector(DispositionController.CaseIsTerminal.selector, caseId)
        );
        vm.prank(RELAYER);
        baseKernel.executeOrder(caseId, proof);

        ComplianceAuthority.ComplianceProof memory retry =
            _proof(adapterDomain, settlementId, buyer, true);
        vm.expectRevert(
            abi.encodeWithSelector(RWACVASettlementAdapter.LegNotHeld.selector, settlementId)
        );
        vm.prank(RELAYER);
        adapter.resolveHeldAsset(settlementId, retry);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Conservation
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev The whole point of a disposition is that value moves without being
    ///      created. Supply is fixed on both sides across the operation, and the
    ///      escrow's accounting matches its balance at every step.
    function test_ADispositionNeverCreatesValue() public {
        bytes32 settlementId = _holdBothLegs();

        uint256 cashSupplyBefore = cash.totalSupply();
        vm.chainId(BASE);
        uint256 assetSupplyBefore = rwa.totalSupply();
        uint256 sellerBefore = rwa.balanceOf(seller);

        _disposeAsset(
            settlementId, DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION, substituteWallet
        );
        _disposeCash(
            settlementId, DispositionTypes.DispositionType.OPERATOR_ASSISTED_OFFRAMP, gatewayAccount
        );

        vm.chainId(BASE);
        assertEq(rwa.totalSupply(), assetSupplyBefore, "no bond minted");
        assertEq(rwa.balanceOf(seller), sellerBefore - ASSET_AMOUNT, "and the seller paid it");
        assertEq(rwa.balanceOf(substituteWallet), ASSET_AMOUNT);
        assertEq(rwa.reservedBalanceOf(seller), 0);

        vm.chainId(MONAD);
        assertEq(cash.totalSupply(), cashSupplyBefore, "no cash minted");
        assertEq(cash.balanceOf(gatewayAccount), CASH_AMOUNT);
        assertEq(cash.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalEscrowed(), 0, "accounting matches the balance");
    }

    function test_TheSameCommittedValueCannotBeDisposedTwice() public {
        bytes32 settlementId = _holdBothLegs();
        _disposeAsset(
            settlementId, DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION, substituteWallet
        );

        // #when the controller is asked to execute against the same leg again,
        //     bypassing its own case bookkeeping entirely
        vm.chainId(BASE);
        ComplianceAuthority.ComplianceProof memory proof =
            _proof(adapterDomain, settlementId, custodyAccount, true);
        vm.expectRevert(
            abi.encodeWithSelector(RWACVASettlementAdapter.LegNotHeld.selector, settlementId)
        );
        vm.prank(address(baseKernel));
        adapter.executeDisposition(
            settlementId,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            ASSET_AMOUNT,
            proof
        );

        assertEq(rwa.balanceOf(custodyAccount), 0, "one final receiver, and only one");
        assertEq(rwa.balanceOf(substituteWallet), ASSET_AMOUNT);
    }

    /// @dev The reservation guard is what stops a seller spending units that are
    ///      spoken for. It has to survive the disposition path exactly as it
    ///      survives the release path.
    function test_AHeldBondStaysUnspendableUntilTheDispositionMovesIt() public {
        bytes32 settlementId = _holdBothLegs();

        vm.chainId(BASE);
        assertEq(rwa.availableBalanceOf(seller), ASSET_SUPPLY - ASSET_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                ConduitRWACVA.InsufficientAvailableBalance.selector,
                ASSET_SUPPLY - ASSET_AMOUNT,
                ASSET_SUPPLY
            )
        );
        vm.prank(seller);
        // The call is asserted to revert, so it never produces a return value
        // to check. See docs/security-waivers/README.md on inline annotations.
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        rwa.transfer(stranger, ASSET_SUPPLY);

        _disposeAsset(
            settlementId, DispositionTypes.DispositionType.RESTRICTED_HOLD, custodyAccount
        );

        vm.chainId(BASE);
        assertEq(rwa.availableBalanceOf(seller), ASSET_SUPPLY - ASSET_AMOUNT, "no units returned");
        assertEq(rwa.balanceOf(custodyAccount), ASSET_AMOUNT);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // An order is bound to one situation
    // ─────────────────────────────────────────────────────────────────────────

    function test_AStaleOrderFails() public {
        _holdBothLegs();
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        order.expiry = uint64(block.timestamp - 1);

        vm.chainId(BASE);
        _expectFilingRefused(
            baseKernel,
            order,
            AGENT_KEY,
            abi.encodeWithSelector(
                DispositionController.OrderExpired.selector, order.expiry, block.timestamp
            )
        );
    }

    function test_AnOrderThatIsNotYetValidFails() public {
        _holdBothLegs();
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        order.notBefore = uint64(block.timestamp + 1 hours);

        vm.chainId(BASE);
        _expectFilingRefused(
            baseKernel,
            order,
            AGENT_KEY,
            abi.encodeWithSelector(
                DispositionController.OrderNotYetValid.selector, order.notBefore, block.timestamp
            )
        );
    }

    function test_TheWrongDeploymentGenerationFails() public {
        _holdBothLegs();
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        bytes32 otherGeneration = keccak256("some-other-deployment");
        order.deploymentId = otherGeneration;

        vm.chainId(BASE);
        _expectFilingRefused(
            baseKernel,
            order,
            AGENT_KEY,
            abi.encodeWithSelector(
                DispositionController.WrongDeployment.selector, otherGeneration, DEPLOYMENT_ID
            )
        );
    }

    function test_TheWrongSettlementFails() public {
        _holdBothLegs();
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        order.settlementId = keccak256("a different settlement");

        // #then the derived case ID no longer matches the one the order carries,
        //     which is the check that makes the conflict rule unavoidable
        vm.chainId(BASE);
        bytes32 derived = DispositionOrderLib.caseIdFor(
            DEPLOYMENT_ID, order.settlementId, DispositionTypes.Leg.ASSET
        );
        _expectFilingRefused(
            baseKernel,
            order,
            AGENT_KEY,
            abi.encodeWithSelector(
                DispositionController.CaseIdMismatch.selector, order.caseId, derived
            )
        );
    }

    function test_TheWrongLegFails() public {
        bytes32 settlementId = _holdBothLegs();

        // #given an order written for the cash leg, submitted to the chain that
        //     holds the asset leg
        DispositionOrderLib.DispositionOrder memory order = _order(
            monadKernel,
            monadRegistry,
            DispositionTypes.Leg.CASH,
            DispositionTypes.DispositionType.RETURN_TO_ELIGIBLE_SENDER,
            buyer,
            operator,
            DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR
        );

        vm.chainId(BASE);
        _expectFilingRefused(
            baseKernel,
            order,
            OPERATOR_KEY,
            abi.encodeWithSelector(
                DispositionController.NoExecutorForLeg.selector, DispositionTypes.Leg.CASH
            )
        );
        settlementId;
    }

    /// @dev A legitimate order re-filed after the case moved on. The nonce is
    ///      consumed at filing rather than at execution, so an order that was
    ///      filed and lost a conflict has been used up.
    function test_AReplayedOrderFails() public {
        _holdBothLegs();
        vm.chainId(BASE);
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        _fileOrder(baseKernel, order, AGENT_KEY);

        bytes memory signature = _sign(AGENT_KEY, baseKernel.orderDigest(order));
        vm.expectRevert(
            abi.encodeWithSelector(
                DispositionController.NonceAlreadyUsed.selector, agent, order.nonce
            )
        );
        vm.prank(RELAYER);
        baseKernel.fileOrder(order, signature);
    }

    /// @dev The order binds the coordinator's own version counter. Anything that
    ///      moved the settlement between signing and filing means the authority
    ///      signed about a different situation.
    function test_AnOrderSignedAgainstAnEarlierHostStateFails() public {
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
        uint64 signedAgainst = order.hostStateVersion - 1;
        order.hostStateVersion = signedAgainst;

        vm.chainId(MONAD);
        uint64 actual = coordinator.settlementOf(settlementId).stateVersion;
        _expectFilingRefused(
            monadKernel,
            order,
            OPERATOR_KEY,
            abi.encodeWithSelector(
                DispositionController.HostStateVersionMismatch.selector, signedAgainst, actual
            )
        );
    }

    /// @dev The amount comes from the held leg, never from the order. Without
    ///      this an authority could sign a disposition of "the held value" and
    ///      have it mean any number.
    function test_AnOrderCannotMoveADifferentAmountThanTheOneHeld() public {
        _holdBothLegs();
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        order.amount = ASSET_AMOUNT * 2;

        vm.chainId(BASE);
        _expectFilingRefused(
            baseKernel,
            order,
            AGENT_KEY,
            abi.encodeWithSelector(
                DispositionController.AmountMismatch.selector, ASSET_AMOUNT * 2, ASSET_AMOUNT
            )
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Authority
    // ─────────────────────────────────────────────────────────────────────────

    function test_AnUnregisteredSignerCannotAuthorizeAnything() public {
        _holdBothLegs();
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            stranger,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );

        vm.chainId(BASE);
        _expectFilingRefused(
            baseKernel,
            order,
            STRANGER_KEY,
            abi.encodeWithSelector(AuthorityRegistry.NotAnAuthority.selector, stranger)
        );
    }

    /// @dev The class is checked against the registry, not read from the order.
    ///      An ISSUER claiming to be a GATEWAY_OPERATOR is named as a mismatch
    ///      rather than quietly evaluated under its registered class.
    function test_AnAuthorityCannotClaimAClassItDoesNotHold() public {
        _holdBothLegs();
        DispositionOrderLib.DispositionOrder memory order = _order(
            monadKernel,
            monadRegistry,
            DispositionTypes.Leg.CASH,
            DispositionTypes.DispositionType.OPERATOR_ASSISTED_OFFRAMP,
            gatewayAccount,
            issuer,
            DispositionTypes.AuthorityType.GATEWAY_OPERATOR
        );

        vm.chainId(MONAD);
        _expectFilingRefused(
            monadKernel,
            order,
            ISSUER_KEY,
            abi.encodeWithSelector(
                AuthorityRegistry.AuthorityTypeMismatch.selector,
                DispositionTypes.AuthorityType.GATEWAY_OPERATOR,
                DispositionTypes.AuthorityType.ISSUER
            )
        );
    }

    function test_ARevokedAuthorityCannotFileAnything() public {
        _holdBothLegs();

        vm.chainId(BASE);
        vm.prank(OWNER);
        baseRegistry.revokeAuthority(agent);

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        _expectFilingRefused(
            baseKernel,
            order,
            AGENT_KEY,
            abi.encodeWithSelector(AuthorityRegistry.NotAnAuthority.selector, agent)
        );
    }

    /// @dev A grant does not take effect the moment it is proposed. Without the
    ///      delay, the registry owner could add itself as an ISSUER, sign a
    ///      substitution and take a held bond inside a single transaction.
    function test_AnAuthorityGrantCannotBeUsedBeforeItMatures() public {
        vm.chainId(BASE);
        vm.prank(OWNER);
        baseRegistry.proposeAuthority(stranger, DispositionTypes.AuthorityType.ISSUER);

        vm.expectRevert(
            abi.encodeWithSelector(
                AuthorityRegistry.GrantNotMatured.selector,
                block.timestamp + GRANT_DELAY,
                block.timestamp
            )
        );
        baseRegistry.activateAuthority(stranger);

        vm.warp(block.timestamp + GRANT_DELAY);
        baseRegistry.activateAuthority(stranger);
        assertTrue(baseRegistry.authorityOf(stranger).active);
    }

    /// @dev An order binds the policy's content hash, so tightening a policy
    ///      invalidates orders signed under the old one rather than repurposing
    ///      them.
    function test_AnOrderSignedUnderAnOlderPolicyFails() public {
        _holdBothLegs();
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
        AuthorityRegistry.AuthorityPolicy memory tightened = _policy();
        tightened.contestWindow = CONTEST_WINDOW * 2;
        vm.prank(OWNER);
        baseRegistry.setPolicy(POLICY_ID, tightened);

        bytes32 current = baseRegistry.policyHash(POLICY_ID);
        _expectFilingRefused(
            baseKernel,
            order,
            AGENT_KEY,
            abi.encodeWithSelector(
                DispositionController.PolicyHashMismatch.selector,
                order.authorityPolicyHash,
                current
            )
        );
    }

    function test_APolicyThatForbidsATypeRefusesIt() public {
        _holdBothLegs();

        vm.chainId(BASE);
        AuthorityRegistry.AuthorityPolicy memory narrowed = _policy();
        narrowed.requiredSignatures[uint8(DispositionTypes.DispositionType.RESTRICTED_HOLD)] = 0;
        vm.prank(OWNER);
        baseRegistry.setPolicy(POLICY_ID, narrowed);

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        _expectFilingRefused(
            baseKernel,
            order,
            AGENT_KEY,
            abi.encodeWithSelector(
                DispositionController.DispositionTypeNotPermitted.selector,
                DispositionTypes.DispositionType.RESTRICTED_HOLD
            )
        );
    }

    /// @dev PRD FR-012 admits MULTISIG, and a multisig has no key. The
    ///      controller has to ask the contract, which is the EIP-1271 branch of
    ///      `SignatureChecker` and would otherwise be untested.
    function test_AContractWalletAuthorityIsAskedRatherThanRecovered() public {
        bytes32 settlementId = _holdBothLegs();

        vm.chainId(BASE);
        MockSmartWallet wallet = new MockSmartWallet(agent);
        vm.prank(OWNER);
        baseRegistry.proposeAuthority(address(wallet), DispositionTypes.AuthorityType.MULTISIG);
        vm.warp(block.timestamp + GRANT_DELAY + 1);
        baseRegistry.activateAuthority(address(wallet));

        AuthorityRegistry.AuthorityPolicy memory withMultisig = _policy();
        withMultisig.allowedAuthorityTypes |= DispositionTypes.authorityBit(
            DispositionTypes.AuthorityType.MULTISIG
        );
        vm.prank(OWNER);
        baseRegistry.setPolicy(POLICY_ID, withMultisig);

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            address(wallet),
            DispositionTypes.AuthorityType.MULTISIG
        );
        _fileOrder(baseKernel, order, AGENT_KEY);

        vm.warp(block.timestamp + CONTEST_WINDOW + 1);
        vm.prank(RELAYER);
        baseKernel.executeOrder(
            order.caseId, _proof(adapterDomain, settlementId, custodyAccount, true)
        );
        assertEq(rwa.balanceOf(custodyAccount), ASSET_AMOUNT);
    }

    function test_AContractWalletThatRefusesIsRefused() public {
        _holdBothLegs();

        vm.chainId(BASE);
        MockSmartWallet wallet = new MockSmartWallet(agent);
        vm.prank(OWNER);
        baseRegistry.proposeAuthority(address(wallet), DispositionTypes.AuthorityType.MULTISIG);
        vm.warp(block.timestamp + GRANT_DELAY + 1);
        baseRegistry.activateAuthority(address(wallet));

        AuthorityRegistry.AuthorityPolicy memory withMultisig = _policy();
        withMultisig.allowedAuthorityTypes |= DispositionTypes.authorityBit(
            DispositionTypes.AuthorityType.MULTISIG
        );
        vm.prank(OWNER);
        baseRegistry.setPolicy(POLICY_ID, withMultisig);
        wallet.setAccepting(false);

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            address(wallet),
            DispositionTypes.AuthorityType.MULTISIG
        );
        _expectFilingRefused(
            baseKernel,
            order,
            AGENT_KEY,
            abi.encodeWithSelector(
                DispositionController.InvalidAuthoritySignature.selector, address(wallet)
            )
        );
    }

    function test_ASignatureFromTheWrongKeyIsRefused() public {
        _holdBothLegs();
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
        _expectFilingRefused(
            baseKernel,
            order,
            STRANGER_KEY,
            abi.encodeWithSelector(DispositionController.InvalidAuthoritySignature.selector, agent)
        );
    }

    /// @dev PRD 4.5: the relayer has no authority to create settlement truth.
    ///      Two different relayers carrying the same signed order produce the
    ///      same outcome, and neither can produce one without an order.
    function test_TheRelayerIdentityHasNoAuthorityOverTheOutcome() public {
        bytes32 settlementId = _holdBothLegs();

        // #given nobody may reach the executor directly
        vm.chainId(BASE);
        ComplianceAuthority.ComplianceProof memory proof =
            _proof(adapterDomain, settlementId, custodyAccount, true);
        vm.expectRevert(
            abi.encodeWithSelector(
                RWACVASettlementAdapter.NotTheDispositionController.selector,
                RELAYER,
                address(baseKernel)
            )
        );
        vm.prank(RELAYER);
        adapter.executeDisposition(
            settlementId,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            ASSET_AMOUNT,
            proof
        );

        // #and an order filed by one relayer executes identically for another
        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            DispositionTypes.DispositionType.RESTRICTED_HOLD,
            custodyAccount,
            agent,
            DispositionTypes.AuthorityType.TRANSFER_AGENT
        );
        vm.prank(RELAYER);
        baseKernel.fileOrder(order, _sign(AGENT_KEY, baseKernel.orderDigest(order)));

        vm.warp(block.timestamp + CONTEST_WINDOW + 1);
        vm.prank(OTHER_RELAYER);
        baseKernel.executeOrder(
            order.caseId, _proof(adapterDomain, settlementId, custodyAccount, true)
        );

        assertEq(rwa.balanceOf(custodyAccount), ASSET_AMOUNT);
        assertEq(
            baseKernel.caseOf(order.caseId).executedDestination,
            custodyAccount,
            "the destination came from the order, not from either caller"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Steps
    // ─────────────────────────────────────────────────────────────────────────

    function _cancellationDigest(bytes32 settlementId) private view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                coordinator.domainSeparator(),
                keccak256(
                    abi.encode(coordinator.CANCELLATION_TYPEHASH(), settlementId, settlementId)
                )
            )
        );
    }

    function _disposeAsset(
        bytes32 settlementId,
        DispositionTypes.DispositionType dispositionType,
        address destination
    ) private returns (bytes32 caseId) {
        DispositionTypes.AuthorityType authorityType = dispositionType
            == DispositionTypes.DispositionType.AUTHORIZED_SUBSTITUTION
            ? DispositionTypes.AuthorityType.ISSUER
            : DispositionTypes.AuthorityType.TRANSFER_AGENT;
        uint256 key =
            authorityType == DispositionTypes.AuthorityType.ISSUER ? ISSUER_KEY : AGENT_KEY;
        address authority = authorityType == DispositionTypes.AuthorityType.ISSUER ? issuer : agent;

        DispositionOrderLib.DispositionOrder memory order = _order(
            baseKernel,
            baseRegistry,
            DispositionTypes.Leg.ASSET,
            dispositionType,
            destination,
            authority,
            authorityType
        );
        vm.chainId(BASE);
        _fileOrder(baseKernel, order, key);
        vm.warp(block.timestamp + CONTEST_WINDOW + 1);
        vm.prank(RELAYER);
        baseKernel.executeOrder(
            order.caseId, _proof(adapterDomain, settlementId, destination, true)
        );
        return order.caseId;
    }

    function _disposeCash(
        bytes32 settlementId,
        DispositionTypes.DispositionType dispositionType,
        address destination
    ) private returns (bytes32 caseId) {
        DispositionTypes.AuthorityType authorityType = dispositionType
            == DispositionTypes.DispositionType.OPERATOR_ASSISTED_OFFRAMP
            ? DispositionTypes.AuthorityType.GATEWAY_OPERATOR
            : DispositionTypes.AuthorityType.COMPLIANCE_OPERATOR;
        uint256 key = authorityType == DispositionTypes.AuthorityType.GATEWAY_OPERATOR
            ? GATEWAY_KEY
            : OPERATOR_KEY;
        address authority =
            authorityType == DispositionTypes.AuthorityType.GATEWAY_OPERATOR ? gateway : operator;

        DispositionOrderLib.DispositionOrder memory order = _order(
            monadKernel,
            monadRegistry,
            DispositionTypes.Leg.CASH,
            dispositionType,
            destination,
            authority,
            authorityType
        );
        vm.chainId(MONAD);
        _fileOrder(monadKernel, order, key);
        vm.warp(block.timestamp + CONTEST_WINDOW + 1);
        vm.prank(RELAYER);
        monadKernel.executeOrder(
            order.caseId, _proof(escrowDomain, settlementId, destination, true)
        );
        return order.caseId;
    }

    /// @dev Signature and expectation both built before the cheatcode, because
    ///      an argument evaluated afterwards becomes the "next call" and the
    ///      assertion silently measures something else. That footgun has cost
    ///      this repository real debugging time.
    function _expectFilingRefused(
        DispositionController kernel,
        DispositionOrderLib.DispositionOrder memory order,
        uint256 authorityKey,
        bytes memory expectedRevert
    ) private {
        bytes memory signature = _sign(authorityKey, kernel.orderDigest(order));
        vm.expectRevert(expectedRevert);
        vm.prank(RELAYER);
        kernel.fileOrder(order, signature);
    }
}

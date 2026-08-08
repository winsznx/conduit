// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {ComplianceAuthority} from "../ComplianceAuthority.sol";
import {DispositionTypes} from "../libraries/DispositionTypes.sol";

/// @notice What a contract holding disposable value must expose to the kernel.
///
/// Two contracts implement this and they hold value in completely different
/// ways: `CashEscrow` custodies an ERC-20 balance, and
/// `RWACVASettlementAdapter` holds nothing at all — the RWA stays in the
/// seller's wallet under a token-native reservation. The kernel does not care
/// which, and must not: a controller that knew about escrow balances would have
/// to be rewritten for the next asset model, and a controller that knew about
/// reservations would be wrong about the cash leg today.
///
/// So the interface is deliberately narrow. The executor answers what it is
/// holding and for whom, and it performs one instruction. Everything about
/// authority, conflicts and timing lives in the controller, and everything about
/// custody lives in the executor.
///
/// The compliance check stays with the executor rather than moving up. Each
/// executor has its own signer set bound to its own EIP-712 domain, and an
/// attestation minted for the Monad escrow is not valid at the Base adapter. A
/// controller doing the check centrally would need one of those domains, which
/// would make the other leg's attestations forgeable against it.
interface IDispositionExecutor {
    /// @notice What is held, for whom, and under which canonical decision.
    struct HeldLeg {
        /// @dev True only when value is committed and undelivered. Everything
        ///      the kernel does is gated on this.
        bool held;
        /// @dev Whether the canonical decision was a COMMIT. An abort-held leg
        ///      is also disposable (PRD 5.2 step 7) but not by every order type.
        bool committed;
        address asset;
        uint256 amount;
        /// @dev Where the settlement currently intends the value to go. The
        ///      order names it too, and the controller compares, so an order
        ///      signed against one receiver cannot execute after a rebind
        ///      changed it.
        address currentReceiver;
        /// @dev The party that supplied the value. `RETURN_TO_ELIGIBLE_SENDER`
        ///      may send here and nowhere else.
        address originalSender;
    }

    function heldLegOf(bytes32 settlementId) external view returns (HeldLeg memory);

    /// @notice PRD FR-012's `host-state version`, from the host that owns it.
    ///
    /// @dev Monotonic per settlement. An order binds the value it saw at signing
    ///      time, and the controller re-checks at execution, so anything that
    ///      moved the leg in between invalidates the order rather than executing
    ///      it against a state its authority never inspected.
    function hostStateVersion(bytes32 settlementId) external view returns (uint64);

    /// @notice Performs one authorized disposition.
    ///
    /// @dev Restricted to the controller. Every parameter has already been
    ///      checked against the signed order and the held leg; the executor
    ///      checks them again against its own state rather than trusting them,
    ///      because a controller misconfiguration must not be able to move value
    ///      the executor knows is wrong.
    function executeDisposition(
        bytes32 settlementId,
        DispositionTypes.DispositionType dispositionType,
        address destination,
        uint256 amount,
        ComplianceAuthority.ComplianceProof calldata compliance
    ) external;
}

// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

/// @dev File-level so they can size an array. A constant inside the library is
///      not a compile-time constant expression for that purpose, and hard-coding
///      `6` at the one place it is needed would be a second, silent declaration
///      of how many order types PRD FR-012 admits.
uint256 constant DISPOSITION_TYPE_COUNT = 6;
uint256 constant AUTHORITY_TYPE_COUNT = 7;

/// @notice The Disposition Kernel's vocabulary. PRD FR-012.
///
/// Both enums are copied from the PRD verbatim, in the PRD's order. That order
/// is load-bearing twice over: the values are encoded into signed orders and
/// into the registry's permission bitmasks, so renumbering one would silently
/// turn a `RESTRICTED_HOLD` permission into a `REBIND_RECEIVER` permission on
/// any contract not redeployed alongside it.
///
/// They live in a library rather than on the controller because the registry,
/// the controller, the two executors and the order hashing all need them, and a
/// second declaration of an enum is a second numbering waiting to drift.
library DispositionTypes {
    /// @dev PRD FR-012.
    enum DispositionType {
        REVERIFY_AND_RESUME, // 0
        REBIND_RECEIVER, // 1
        RETURN_TO_ELIGIBLE_SENDER, // 2
        AUTHORIZED_SUBSTITUTION, // 3
        OPERATOR_ASSISTED_OFFRAMP, // 4
        RESTRICTED_HOLD // 5
    }

    /// @dev PRD FR-012.
    enum AuthorityType {
        SUBJECT, // 0
        COUNTERPARTY, // 1
        ISSUER, // 2
        TRANSFER_AGENT, // 3
        COMPLIANCE_OPERATOR, // 4
        GATEWAY_OPERATOR, // 5
        MULTISIG // 6
    }

    /// @notice Which leg of the settlement an order acts on.
    ///
    /// @dev A leg is never inferred from the executor's identity. The order
    ///      names it, the case key derives from it, and the executor checks it,
    ///      so an order written for the cash leg cannot be replayed against the
    ///      asset leg of the same settlement even where both are held.
    enum Leg {
        CASH, // 0
        ASSET // 1
    }

    /// @notice `type` as a one-bit mask, for the registry's permission sets.
    ///
    /// @dev A bitmask rather than an array of bools because a policy is read on
    ///      every filing and an array costs a storage slot per entry. The shift
    ///      is safe for every member of both enums: the widest is seven values.
    function authorityBit(AuthorityType authorityType) internal pure returns (uint16) {
        // A one-bit mask at the enum's position, which is what a permission set
        // over seven named classes is. The lint's heuristic reads any literal on
        // the left of a shift as a transposed operand; here the literal is the
        // bit and the enum is the distance, which is the only order that means
        // anything.
        // forge-lint: disable-next-line(incorrect-shift)
        return uint16(1) << uint8(authorityType);
    }

    function permits(uint16 mask, AuthorityType authorityType) internal pure returns (bool) {
        return mask & authorityBit(authorityType) != 0;
    }

    /// @notice Whether this order type sends value somewhere the intent did not
    ///         name.
    ///
    /// @dev The single most important predicate in the kernel. `REVERIFY_AND_RESUME`
    ///      has no destination parameter at all — it can only retry the delivery
    ///      the settlement already agreed to — and every other type can direct
    ///      value elsewhere. That is what separates a retry from an authorization,
    ///      and it is why the two are permissioned differently rather than
    ///      sharing one code path with a flag.
    function redirectsValue(DispositionType dispositionType) internal pure returns (bool) {
        return dispositionType != DispositionType.REVERIFY_AND_RESUME;
    }
}

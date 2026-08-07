// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IATokenPolicy, IComplianceRule} from "./interfaces/IATokenPolicy.sol";

/// @title ConduitRWACVA
/// @notice A Cleanverse-native RWA CVA with token-native settlement reservations.
///
/// PRD v1.1 override sections 2 and 5 replace escrow custody on the asset leg
/// with a reservation held inside the token. The seller keeps nominal ownership
/// until a canonical COMMIT arrives; the reserved units simply stop being
/// spendable through ordinary ERC-20 paths.
///
/// That trade is deliberate and it moves the risk rather than removing it.
/// Escrow custody fails by holding the wrong balance, which a single assertion
/// catches. A reservation fails by letting a seller spend units that are
/// notionally reserved, which requires that *every* path out of a balance
/// respects the reservation — including paths added later. Invariant R1 is
/// therefore enforced in `_update`, the one funnel every ERC-20 movement passes
/// through, rather than in the individual entry points.
///
/// Invariants, from the override's asset-leg section:
///   R1  transferable balance = balanceOf(owner) - totalReserved(owner)
///   R2  a reservation is cancellable only before canonical COMMIT
///   R3  a reservation is releasable only after canonical COMMIT
///   R4  reserved units never return to freely spendable seller balance
///       after COMMIT
///   R5  every actual transfer passes policy.canTransfer at the moment of
///       transfer
///
/// The COMMIT proof itself is verified by the settlement adapter, not here. This
/// contract enforces that a release cannot happen without one having been
/// presented, and that a cancellation cannot happen after one has.
contract ConduitRWACVA is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    /// @notice Held by the settlement adapter. Never by an EOA in staging or production.
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");

    /// @notice The Cleanverse policy engine. Immutable: repointing it would
    ///         silently rewrite who may hold this asset.
    IATokenPolicy public immutable policy;

    uint8 private immutable _decimals;

    struct Reservation {
        address owner;
        uint256 amount;
        bytes32 settlementId;
        uint64 createdAt;
        bool committed;
        bool released;
        bool cancelled;
    }

    mapping(bytes32 settlementId => Reservation) private _reservations;
    mapping(address owner => uint256 amount) private _reservedOf;

    /// @dev Transient. Set only for the duration of a release, so the reservation
    ///      guard in `_update` can distinguish a legitimate settlement transfer
    ///      from an ordinary one trying to spend reserved units. Transient
    ///      storage clears at end of transaction, so a reverted release cannot
    ///      leave the guard open — which a storage bool could.
    bytes32 private transient _releasingSettlement;

    event ReservationCreated(bytes32 indexed settlementId, address indexed owner, uint256 amount);
    event ReservationCommitted(bytes32 indexed settlementId);
    event ReservationReleased(bytes32 indexed settlementId, address indexed to, uint256 amount);
    event ReservationCancelled(bytes32 indexed settlementId);

    error AmountMustBePositive();
    error ReservationExists(bytes32 settlementId);
    error ReservationUnknown(bytes32 settlementId);
    error ReservationClosed(bytes32 settlementId);
    error ReservationNotCommitted(bytes32 settlementId);
    error ReservationAlreadyCommitted(bytes32 settlementId);
    error InsufficientAvailableBalance(uint256 available, uint256 requested);
    error NotReservationOwner(address caller, address owner);
    error ZeroAddress();

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address policy_,
        address admin_
    ) ERC20(name_, symbol_) {
        if (policy_ == address(0) || admin_ == address(0)) revert ZeroAddress();

        policy = IATokenPolicy(policy_);
        _decimals = decimals_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ── Reservation accounting ───────────────────────────────────────────────

    /// @notice Units reserved across all open settlements for `owner`.
    function reservedBalanceOf(address owner) public view returns (uint256) {
        return _reservedOf[owner];
    }

    /// @notice Units `owner` may still move freely. Invariant R1.
    function availableBalanceOf(address owner) public view returns (uint256) {
        return balanceOf(owner) - _reservedOf[owner];
    }

    function reservationOf(bytes32 settlementId) external view returns (Reservation memory) {
        return _reservations[settlementId];
    }

    /// @notice Reserves `amount` of the caller's balance against a settlement.
    ///
    /// The units do not move. They stop being spendable, which is the whole
    /// point: the seller keeps nominal ownership and the buyer gains certainty
    /// that the asset cannot be sold twice.
    function reserveForSettlement(bytes32 settlementId, uint256 amount) external {
        if (amount == 0) revert AmountMustBePositive();
        if (_reservations[settlementId].owner != address(0)) {
            revert ReservationExists(settlementId);
        }

        uint256 available = availableBalanceOf(msg.sender);
        if (available < amount) revert InsufficientAvailableBalance(available, amount);

        _reservations[settlementId] = Reservation({
            owner: msg.sender,
            amount: amount,
            settlementId: settlementId,
            createdAt: uint64(block.timestamp),
            committed: false,
            released: false,
            cancelled: false
        });
        _reservedOf[msg.sender] += amount;

        emit ReservationCreated(settlementId, msg.sender, amount);
    }

    /// @notice Records that a canonical COMMIT exists for this settlement.
    ///
    /// Called by the settlement adapter after it has verified a COMMIT VAA
    /// through the Wormhole core contract. This contract does not parse VAAs;
    /// it enforces the consequences of one having been accepted.
    function markCommitted(bytes32 settlementId) external onlyRole(SETTLEMENT_ROLE) {
        Reservation storage reservation = _requireOpen(settlementId);
        if (reservation.committed) revert ReservationAlreadyCommitted(settlementId);

        reservation.committed = true;
        emit ReservationCommitted(settlementId);
    }

    /// @notice Withdraws a reservation. Invariant R2: pre-COMMIT only.
    ///
    /// Callable by the reservation owner before commit, or by the settlement
    /// adapter when a verified ABORT arrives.
    function cancelReservation(bytes32 settlementId) external {
        Reservation storage reservation = _requireOpen(settlementId);

        // R2 and R4. After COMMIT the units are spoken for; returning them to
        // freely spendable balance is the asset-side mirror of a refund after
        // commit.
        if (reservation.committed) revert ReservationAlreadyCommitted(settlementId);

        if (msg.sender != reservation.owner && !hasRole(SETTLEMENT_ROLE, msg.sender)) {
            revert NotReservationOwner(msg.sender, reservation.owner);
        }

        reservation.cancelled = true;
        _reservedOf[reservation.owner] -= reservation.amount;

        emit ReservationCancelled(settlementId);
    }

    /// @notice Moves reserved units to the verified receiver. Invariant R3.
    ///
    /// The reservation is closed before the transfer, so a token callback that
    /// re-enters finds a closed reservation rather than a live one.
    function releaseReservation(bytes32 settlementId, address receiver)
        external
        onlyRole(SETTLEMENT_ROLE)
    {
        if (receiver == address(0)) revert ZeroAddress();

        Reservation storage reservation = _requireOpen(settlementId);
        if (!reservation.committed) revert ReservationNotCommitted(settlementId);

        address owner = reservation.owner;
        uint256 amount = reservation.amount;

        // Checks-effects-interactions. Closed first, then moved.
        reservation.released = true;
        _reservedOf[owner] -= amount;

        // Opens the reservation guard for exactly this transfer. Transient, so
        // a revert cannot leave it open for the next call in the transaction.
        _releasingSettlement = settlementId;
        _transfer(owner, receiver, amount);
        _releasingSettlement = bytes32(0);

        emit ReservationReleased(settlementId, receiver, amount);
    }

    function _requireOpen(bytes32 settlementId) private view returns (Reservation storage) {
        Reservation storage reservation = _reservations[settlementId];
        if (reservation.owner == address(0)) revert ReservationUnknown(settlementId);
        if (reservation.released || reservation.cancelled) {
            revert ReservationClosed(settlementId);
        }
        return reservation;
    }

    // ── Supply ───────────────────────────────────────────────────────────────

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @dev Burning is restricted to available balance by `_update`, so a
    ///      reserved position cannot be destroyed out from under a settlement.
    function burn(address from, uint256 amount) external onlyRole(MINTER_ROLE) {
        _burn(from, amount);
    }

    // ── The compliance and reservation funnel ────────────────────────────────

    /// @dev Every balance movement passes through here: mint, burn, transfer,
    ///      and settlement release alike.
    ///
    /// Order matters. Compliance is checked first, because a transfer the policy
    /// forbids must be rejected regardless of who holds what. The reservation
    /// guard runs second, because it is meaningless for a transfer that was
    /// never going to happen.
    function _update(address from, address to, uint256 value) internal override {
        // R5. The guide's template calls this unconditionally, including for
        // mint (from == 0) and burn (to == 0), and this follows it rather than
        // inventing an exemption. Whether the deployed policy accepts the zero
        // address on either side is recorded as ASM-026 and settled against the
        // live policy before any mint is attempted; a local exemption invented
        // now would be exactly the "fake external-success branch" CLAUDE.md
        // forbids.
        if (!policy.canTransfer(address(this), from, to, value)) {
            revert IATokenPolicy.TransferNotAllowed();
        }

        // R1. Minting has no source balance to protect.
        if (from != address(0)) {
            uint256 reserved = _reservedOf[from];

            // A settlement release is spending the very units it reserved, so
            // its own reservation is excluded from the guard. Every other
            // movement, including a burn, sees the full reservation.
            if (reserved != 0) {
                bytes32 releasing = _releasingSettlement;
                if (releasing != bytes32(0) && _reservations[releasing].owner == from) {
                    reserved -= _reservations[releasing].amount;
                }

                uint256 spendable = balanceOf(from) - reserved;
                if (spendable < value) revert InsufficientAvailableBalance(spendable, value);
            }
        }

        super._update(from, to, value);
    }

    // ── RuleV2 self-management ───────────────────────────────────────────────
    // These route to the policy's `*FromToken` entry points, which authenticate
    // on the caller being this token. An admin cannot reach them directly.

    function setRuleV2(IComplianceRule.RuleV2 calldata rule) external onlyRole(DEFAULT_ADMIN_ROLE) {
        policy.setRuleV2FromToken(rule);
    }

    function addRuleV2(IComplianceRule.RuleV2 calldata rule) external onlyRole(DEFAULT_ADMIN_ROLE) {
        policy.addRuleV2FromToken(rule);
    }

    function removeRuleV2(uint256 index) external onlyRole(DEFAULT_ADMIN_ROLE) {
        policy.removeRuleV2FromToken(index);
    }

    function getRulesV2() external view returns (IComplianceRule.RuleV2[] memory) {
        return policy.getRulesV2(address(this));
    }
}

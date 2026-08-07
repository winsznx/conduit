// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {WormholeTransport} from "./WormholeTransport.sol";
import {MessageCodec} from "./libraries/MessageCodec.sol";

/// @notice The CVA cash leg on Monad. PRD FR-004, FR-009, FR-010, FR-011.
///
/// Holds the Cleanverse A-Token between preparation and a canonical decision.
/// Which custody mode is viable at all is ADR-0001's open question; this
/// contract is the `DirectATokenEscrowAdapter` path, and it is written so the
/// seam test in phase 01 has something concrete to exercise.
///
/// The rules that shape every function here:
///
///   - only the configured A-Token is accepted, so a settlement cannot be
///     prepared with a worthless lookalike;
///   - the balance delta must equal the requested amount exactly, which rejects
///     fee-on-transfer and rebasing tokens (T-23) rather than silently escrowing
///     less than the intent promised;
///   - cash may be prepared once and the amount is immutable (PRD FR-004);
///   - a refund is impossible after COMMIT, and the check is on canonical
///     coordinator state rather than a local timeout (PRD FR-008, invariant I4);
///   - value moves only after `_consume` has verified and burned the VAA.
contract CashEscrow is WormholeTransport, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The Cleanverse A-Token, discovered at deploy time and never hardcoded.
    IERC20 public immutable cashAsset;

    enum LegState {
        NONE,
        PREPARED,
        COMMITTED,
        RELEASED,
        RETURNED,
        HELD
    }

    struct CashLeg {
        address payer;
        address receiver;
        uint256 amount;
        bytes32 intentHash;
        LegState state;
    }

    mapping(bytes32 settlementId => CashLeg) private _legs;

    /// @notice Sum of all locked-but-unresolved cash. Lets an auditor compare
    ///         accounted value against the token balance in one read.
    uint256 public totalEscrowed;

    /// @notice Blocks new preparations only. It can never block a release: value
    ///         already committed must not be strandable by an admin (PRD 8.2).
    bool public preparationsPaused;

    event CashPrepared(
        bytes32 indexed settlementId,
        address indexed payer,
        address indexed receiver,
        uint256 amount
    );
    event CashReleased(bytes32 indexed settlementId, address indexed receiver, uint256 amount);
    event CashReturned(bytes32 indexed settlementId, address indexed payer, uint256 amount);
    event CashHeld(bytes32 indexed settlementId, address indexed intendedReceiver, uint256 amount);
    event PreparationsPausedSet(bool paused);

    error AmountMustBePositive();
    error LegAlreadyPrepared(bytes32 settlementId);
    error LegUnknown(bytes32 settlementId);
    error LegNotInState(bytes32 settlementId, LegState actual, LegState expected);
    error InexactBalanceDelta(uint256 expected, uint256 actual);
    error PreparationsArePaused();
    error ZeroAddress();
    error IntentHashMismatch(bytes32 actual, bytes32 expected);

    constructor(
        address cashAsset_,
        address wormhole_,
        bytes32 deploymentId_,
        uint16 localWormholeChainId_,
        uint16 remoteWormholeChainId_,
        bytes32 remoteEmitter_,
        address owner_
    )
        WormholeTransport(
            wormhole_, deploymentId_, localWormholeChainId_, remoteWormholeChainId_, remoteEmitter_
        )
        Ownable(owner_)
    {
        if (cashAsset_ == address(0) || wormhole_ == address(0)) revert ZeroAddress();
        cashAsset = IERC20(cashAsset_);
    }

    function legOf(bytes32 settlementId) external view returns (CashLeg memory) {
        return _legs[settlementId];
    }

    // ── Preparation ──────────────────────────────────────────────────────────

    /// @notice Locks cash against a settlement and publishes CASH_PREPARED.
    ///
    /// The payer must have approved this contract. The message is published only
    /// after state is persisted, per PRD FR-004, so a peer can never observe a
    /// PREPARED it could act on before the local leg exists.
    function prepareCash(
        bytes32 settlementId,
        bytes32 intentHash,
        address receiver,
        uint256 amount,
        uint256 destinationChainId,
        uint8 consistencyLevel
    ) external payable nonReentrant returns (uint64 sequence) {
        if (preparationsPaused) revert PreparationsArePaused();
        if (amount == 0) revert AmountMustBePositive();
        if (receiver == address(0)) revert ZeroAddress();
        if (_legs[settlementId].state != LegState.NONE) revert LegAlreadyPrepared(settlementId);

        // Exact balance delta. A fee-on-transfer or rebasing token delivers less
        // than requested, and escrowing that quietly would break conservation
        // for a settlement whose intent promised the full amount (T-23).
        uint256 before = cashAsset.balanceOf(address(this));
        cashAsset.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = cashAsset.balanceOf(address(this)) - before;
        if (received != amount) revert InexactBalanceDelta(amount, received);

        _legs[settlementId] = CashLeg({
            payer: msg.sender,
            receiver: receiver,
            amount: amount,
            intentHash: intentHash,
            state: LegState.PREPARED
        });
        totalEscrowed += amount;

        emit CashPrepared(settlementId, msg.sender, receiver, amount);

        sequence = _publish(
            _header(
                MessageCodec.MessageType.CASH_PREPARED,
                settlementId,
                intentHash,
                destinationChainId,
                1
            ),
            consistencyLevel
        );
    }

    // ── Canonical decisions, consumed from the coordinator ───────────────────

    /// @notice Consumes a COMMIT VAA and releases cash to the verified receiver.
    ///
    /// Permissionless: PRD FR-009 lets anyone submit a valid COMMIT. The relayer
    /// earns nothing by withholding and cannot forge, so the safe design is to
    /// let everyone try.
    ///
    /// `eligible` is supplied by the caller and represents the final,
    /// commit-time Cleanverse decision for the receiver. Phase 05 replaces it
    /// with a verified compliance attestation; until then it is an explicit
    /// parameter rather than an assumed `true`, so the held path is reachable
    /// and tested from the start.
    function releaseCash(bytes calldata commitVaa, bool eligible) external nonReentrant {
        MessageCodec.Header memory header = _consume(commitVaa, MessageCodec.MessageType.COMMIT);

        CashLeg storage leg = _legs[header.settlementId];
        if (leg.state == LegState.NONE) revert LegUnknown(header.settlementId);
        if (leg.state != LegState.PREPARED) {
            revert LegNotInState(header.settlementId, leg.state, LegState.PREPARED);
        }
        if (leg.intentHash != header.intentHash) {
            revert IntentHashMismatch(header.intentHash, leg.intentHash);
        }

        uint256 amount = leg.amount;

        // PRD FR-010: if the receiver is no longer permitted, the leg is held.
        // No refund path reopens, because a COMMIT exists (invariant I4).
        if (!eligible) {
            leg.state = LegState.HELD;
            emit CashHeld(header.settlementId, leg.receiver, amount);
            return;
        }

        // Effects before interactions. The VAA was already burned in `_consume`.
        leg.state = LegState.RELEASED;
        totalEscrowed -= amount;

        cashAsset.safeTransfer(leg.receiver, amount);
        emit CashReleased(header.settlementId, leg.receiver, amount);
    }

    /// @notice Consumes an ABORT VAA and returns cash to the payer.
    ///
    /// The source of truth is canonical coordinator state carried by the VAA,
    /// never a local timeout. PRD FR-008 is explicit: a timeout alone cannot
    /// authorize a refund when a remote release may already have happened.
    function returnCash(bytes calldata abortVaa, bool payerEligible) external nonReentrant {
        MessageCodec.Header memory header = _consume(abortVaa, MessageCodec.MessageType.ABORT);

        CashLeg storage leg = _legs[header.settlementId];
        if (leg.state == LegState.NONE) revert LegUnknown(header.settlementId);
        if (leg.state != LegState.PREPARED) {
            revert LegNotInState(header.settlementId, leg.state, LegState.PREPARED);
        }
        if (leg.intentHash != header.intentHash) {
            revert IntentHashMismatch(header.intentHash, leg.intentHash);
        }

        uint256 amount = leg.amount;

        // PRD 5.2 step 7: a return recipient who is currently ineligible leaves
        // the leg in escrow and opens a disposition case.
        if (!payerEligible) {
            leg.state = LegState.HELD;
            emit CashHeld(header.settlementId, leg.payer, amount);
            return;
        }

        leg.state = LegState.RETURNED;
        totalEscrowed -= amount;

        cashAsset.safeTransfer(leg.payer, amount);
        emit CashReturned(header.settlementId, leg.payer, amount);
    }

    // ── Administration ───────────────────────────────────────────────────────

    /// @notice Fixes the cross-chain peer. Callable once, by the owner, forever.
    ///
    /// Deployment order forces this: the two sides reference each other, so the
    /// first deployed cannot know the second. No VAA is consumable until it is
    /// set, and no later call can change it.
    function setRemotePeer(bytes32 emitter) external onlyOwner {
        _setRemotePeer(emitter);
    }

    /// @dev Pauses new preparations only. PRD 8.2 forbids an admin seizing,
    ///      rewriting, or reversing an executed settlement, and a pause that
    ///      could block a release would strand committed value.
    function setPreparationsPaused(bool paused) external onlyOwner {
        preparationsPaused = paused;
        emit PreparationsPausedSet(paused);
    }

    /// @notice Rescues a token that is not the settlement asset.
    ///
    /// PRD 8.5 permits rescue only for unsupported tokens sent by accident. The
    /// settlement asset is excluded outright rather than by an accounting check,
    /// because the simplest rule is the one that cannot be reasoned around.
    function rescueUnsupportedToken(address token, address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (token == address(cashAsset)) revert LegUnknown(bytes32(0));
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
    }
}

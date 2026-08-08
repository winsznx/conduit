// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ComplianceAuthority} from "./ComplianceAuthority.sol";
import {ConduitRWACVA} from "./ConduitRWACVA.sol";
import {DispositionController} from "./DispositionController.sol";
import {WormholeTransport} from "./WormholeTransport.sol";
import {IDispositionExecutor} from "./interfaces/IDispositionExecutor.sol";
import {DispositionTypes} from "./libraries/DispositionTypes.sol";
import {MessageCodec} from "./libraries/MessageCodec.sol";

/// @notice The asset leg on Base. PRD v1.1 override sections 5 and 10.
///
/// The override removes `AssetEscrow` from this leg: the RWA never leaves the
/// seller's wallet before commit, it is reserved inside the token. This adapter
/// is what turns an authenticated cross-chain decision into a reservation
/// action, and it exists as a separate contract for one reason — `ConduitRWACVA`
/// must not parse VAAs.
///
/// That separation is the point. The token enforces reservation accounting and
/// CCP policy; the adapter enforces that a release is backed by a canonical
/// COMMIT. Neither can be talked into doing the other's job, and the token stays
/// reusable behind `IAssetSettlementAdapter` when another regulated asset
/// arrives (override section 10).
///
/// The adapter holds `SETTLEMENT_ROLE` on the token and nothing else. It cannot
/// mint, cannot manage rules, and cannot move an unreserved balance.
contract RWACVASettlementAdapter is
    WormholeTransport,
    ComplianceAuthority,
    Ownable2Step,
    ReentrancyGuard,
    IDispositionExecutor
{
    ConduitRWACVA public immutable asset;

    /// @dev Recorded so a release cannot be pointed at an address the intent
    ///      never named. Set when the seller's reservation is registered.
    mapping(bytes32 settlementId => address) public intendedReceiver;
    mapping(bytes32 settlementId => bytes32) public boundIntentHash;

    /// @notice The Disposition Kernel for this chain. PRD FR-012.
    ///
    /// @dev Set once, for the deployment-order reason `setRemotePeer` exists.
    DispositionController public dispositionController;

    event AssetPrepared(
        bytes32 indexed settlementId,
        address indexed seller,
        address indexed receiver,
        uint256 amount
    );
    event AssetReleased(bytes32 indexed settlementId, address indexed receiver);
    event AssetHeld(bytes32 indexed settlementId, address indexed intendedReceiver, string reason);
    event AssetReturned(bytes32 indexed settlementId);
    event AssetDisposed(
        bytes32 indexed settlementId,
        address indexed destination,
        uint256 amount,
        DispositionTypes.DispositionType dispositionType
    );
    event DispositionControllerSet(address indexed controller);

    error ReceiverNotRegistered(bytes32 settlementId);
    error ReceiverMismatch(address expected, address provided);
    error IntentHashMismatch(bytes32 actual, bytes32 expected);
    error NotReservationOwner();
    error LegNotResolved(bytes32 settlementId);
    error LegNotHeld(bytes32 settlementId);
    error ZeroAddress();
    error NotTheDispositionController(address caller, address expected);
    error DispositionControllerAlreadySet(address current);
    error LegClaimedByDisposition(bytes32 settlementId);
    error DestinationNotEligible(bytes32 settlementId, address destination);
    error AmountMismatch(uint256 provided, uint256 expected);
    error LegNotDisposed(bytes32 settlementId);

    constructor(
        address asset_,
        address wormhole_,
        bytes32 deploymentId_,
        uint16 localWormholeChainId_,
        uint16 remoteWormholeChainId_,
        bytes32 remoteEmitter_,
        FinalityLevel settlementFinality_,
        FinalityLevel observationFinality_,
        uint64 maxAttestationValidity_,
        address owner_
    )
        WormholeTransport(
            wormhole_,
            deploymentId_,
            localWormholeChainId_,
            remoteWormholeChainId_,
            remoteEmitter_,
            settlementFinality_,
            observationFinality_
        )
        ComplianceAuthority(maxAttestationValidity_, "Conduit", "1")
        Ownable(owner_)
    {
        if (asset_ == address(0) || wormhole_ == address(0)) {
            revert ZeroAddress();
        }
        asset = ConduitRWACVA(asset_);
    }

    // ── Compliance authority ─────────────────────────────────────────────────

    function addComplianceSigner(address signer) external onlyOwner {
        _addComplianceSigner(signer);
    }

    function removeComplianceSigner(address signer) external onlyOwner {
        _removeComplianceSigner(signer);
    }

    function setComplianceQuorum(uint256 quorum) external onlyOwner {
        _setComplianceQuorum(quorum);
    }

    /// @notice Registers an already-created reservation and publishes ASSET_PREPARED.
    ///
    /// The seller reserves directly on the token, so this contract never needs
    /// an allowance and never custodies the asset. It records where the units
    /// are destined and announces the leg.
    ///
    /// Only the reservation's owner may register it, otherwise a third party
    /// could bind someone else's reservation to a receiver of their choosing.
    function prepareAsset(
        bytes32 settlementId,
        bytes32 intentHash,
        address receiver,
        uint256 destinationChainId,
        uint8 consistencyLevel
    ) external payable nonReentrant returns (uint64 sequence) {
        if (receiver == address(0)) revert ZeroAddress();

        ConduitRWACVA.Reservation memory reservation = asset.reservationOf(settlementId);
        if (reservation.owner == address(0)) revert ReceiverNotRegistered(settlementId);
        if (reservation.owner != msg.sender) revert NotReservationOwner();

        intendedReceiver[settlementId] = receiver;
        boundIntentHash[settlementId] = intentHash;

        // Announcing closes the seller's unilateral exit and refuses a
        // reservation that is already released, cancelled, or committed. Both
        // halves matter: a leg announced on a closed reservation reaches READY
        // with nothing behind it, and a leg that stays cancellable after it is
        // announced lets the seller take the cash and keep the bond in the gap
        // before the COMMIT VAA arrives here.
        asset.markAnnounced(settlementId);

        emit AssetPrepared(settlementId, msg.sender, receiver, reservation.amount);

        sequence = _publish(
            _header(
                MessageCodec.MessageType.ASSET_PREPARED,
                settlementId,
                intentHash,
                destinationChainId,
                1
            ),
            consistencyLevel
        );
    }

    /// @notice Consumes a COMMIT VAA and delivers the reserved units.
    ///
    /// Permissionless (PRD FR-009). The order here is deliberate: the VAA is
    /// verified and burned, the reservation is marked committed, and only then
    /// is a release attempted. If the receiver is no longer eligible the token
    /// reverts on `policy.canTransfer`, so this catches that and holds the leg
    /// rather than letting the whole transaction fail — a reverted transaction
    /// would leave the VAA unconsumed and the settlement stuck.
    ///
    /// Eligibility comes from a signed quorum bound to this settlement and this
    /// intent, not from the caller. Two independent gates now stand between a
    /// COMMIT and a delivery, and they answer different questions: the quorum is
    /// Conduit's commit-time decision, and `policy.canTransfer` is Cleanverse's
    /// decision at the moment of transfer. Either can refuse, and a refusal from
    /// either holds the leg rather than reverting.
    function releaseAsset(bytes calldata commitVaa, ComplianceProof calldata compliance)
        external
        nonReentrant
    {
        MessageCodec.Header memory header = _consume(commitVaa, MessageCodec.MessageType.COMMIT);

        address receiver = intendedReceiver[header.settlementId];
        if (receiver == address(0)) revert ReceiverNotRegistered(header.settlementId);

        bytes32 bound = boundIntentHash[header.settlementId];
        if (bound != header.intentHash) revert IntentHashMismatch(header.intentHash, bound);

        // R2 and R4 take effect from here: the reservation can no longer be
        // cancelled, whatever happens to the release below.
        asset.markCommitted(header.settlementId);

        if (!_isEligible(header.settlementId, header.intentHash, receiver, compliance)) {
            emit AssetHeld(header.settlementId, receiver, "receiver ineligible at commit time");
            return;
        }

        // The token still applies CCP policy at the moment of transfer, so this
        // can fail even when Conduit believes the receiver is eligible. That is
        // correct: the policy is authoritative, not our view of it.
        try asset.releaseReservation(header.settlementId, receiver) {
            emit AssetReleased(header.settlementId, receiver);
        } catch {
            emit AssetHeld(header.settlementId, receiver, "policy refused the transfer");
        }
    }

    /// @notice Retries a held asset leg against a fresh compliance answer.
    ///
    /// PRD FR-012's `REVERIFY_AND_RESUME`, and only that one. A hold leaves the
    /// reservation committed and unreleased, and the COMMIT VAA that authorized
    /// it is spent — `_consume` marks it before the release is attempted, which
    /// is correct, because a release that reverted must not leave the message
    /// replayable. The consequence was that a held asset leg could never move
    /// again. Invariant I9 says held value remains claimable *through* the
    /// Disposition Kernel; with no entry point it was not claimable at all.
    ///
    /// No VAA is needed here and none would help: the canonical decision is
    /// already recorded in the reservation, and `committed` is only ever set by
    /// a `releaseAsset` that verified one. The receiver is the one the intent
    /// named and is not a parameter, so this cannot rebind a destination or
    /// substitute an asset. Those need the authority registry phase 07 delivers.
    function resolveHeldAsset(bytes32 settlementId, ComplianceProof calldata compliance)
        external
        nonReentrant
    {
        address receiver = intendedReceiver[settlementId];
        if (receiver == address(0)) revert ReceiverNotRegistered(settlementId);

        // Stands down while the kernel has a case open, for the reason the cash
        // leg's retry does: a rebind resting out its contest window must not be
        // pre-empted by anyone calling the no-discretion retry and delivering to
        // the original receiver.
        if (
            address(dispositionController) != address(0)
                && dispositionController.legIsClaimed(settlementId, DispositionTypes.Leg.ASSET)
        ) {
            revert LegClaimedByDisposition(settlementId);
        }

        ConduitRWACVA.Reservation memory reservation = asset.reservationOf(settlementId);
        // Committed and still open is exactly the held state: a COMMIT was
        // applied here and the units did not move.
        if (!reservation.committed || reservation.released || reservation.cancelled) {
            revert LegNotHeld(settlementId);
        }

        bytes32 intentHash = boundIntentHash[settlementId];

        if (!_isEligible(settlementId, intentHash, receiver, compliance)) {
            emit AssetHeld(settlementId, receiver, "receiver still ineligible");
            return;
        }

        try asset.releaseReservation(settlementId, receiver) {
            emit AssetReleased(settlementId, receiver);
        } catch {
            emit AssetHeld(settlementId, receiver, "policy still refuses the transfer");
        }
    }

    /// @notice Consumes an ABORT VAA and cancels the reservation.
    ///
    /// Pre-commit only, enforced by the token: `cancelReservation` reverts once
    /// the reservation is committed, so an ABORT arriving after a COMMIT cannot
    /// unwind the asset leg even if a relayer delivers it.
    function returnAsset(bytes calldata abortVaa) external nonReentrant {
        MessageCodec.Header memory header = _consume(abortVaa, MessageCodec.MessageType.ABORT);

        bytes32 bound = boundIntentHash[header.settlementId];
        if (bound != header.intentHash) revert IntentHashMismatch(header.intentHash, bound);

        asset.cancelReservation(header.settlementId);
        emit AssetReturned(header.settlementId);
    }

    /// @notice Fixes the cross-chain peer. Callable once, by the owner, forever.
    ///
    /// Deployment order forces this: the two sides reference each other, so the
    /// first deployed cannot know the second. No VAA is consumable until it is
    /// set, and no later call can change it.
    function setRemotePeer(bytes32 emitter) external onlyOwner {
        _setRemotePeer(emitter);
    }

    // ── Disposition Kernel ───────────────────────────────────────────────────

    /// @notice What an executed disposition did, kept for the report and the
    ///         verifier.
    ///
    /// @dev The token cannot record this: after `releaseReservation` the
    ///      reservation reads identically whether it was an ordinary delivery or
    ///      an authority-directed one, and those are different facts about the
    ///      settlement. Without this the asset leg would report ASSET_RELEASED
    ///      for a rebind, and the audit package would say the buyer received the
    ///      bond when a replacement wallet did.
    struct DispositionRecord {
        bool executed;
        DispositionTypes.DispositionType dispositionType;
        address destination;
    }

    mapping(bytes32 settlementId => DispositionRecord) private _dispositions;

    function dispositionOf(bytes32 settlementId) external view returns (DispositionRecord memory) {
        return _dispositions[settlementId];
    }

    /// @inheritdoc IDispositionExecutor
    function heldLegOf(bytes32 settlementId)
        external
        view
        returns (IDispositionExecutor.HeldLeg memory)
    {
        ConduitRWACVA.Reservation memory reservation = asset.reservationOf(settlementId);
        address receiver = intendedReceiver[settlementId];

        // Committed and still open is exactly the held state here: a COMMIT was
        // applied and the units did not move. There is no separate held flag on
        // the asset leg because there is no escrow to move them into.
        bool held = receiver != address(0) && reservation.committed && !reservation.released
            && !reservation.cancelled;

        return IDispositionExecutor.HeldLeg({
            held: held,
            committed: reservation.committed,
            asset: address(asset),
            amount: reservation.amount,
            currentReceiver: receiver,
            originalSender: reservation.owner
        });
    }

    /// @inheritdoc IDispositionExecutor
    ///
    /// @dev Derived from the reservation rather than counted in a new storage
    ///      slot. Every flag it reads is set once and never cleared, so the
    ///      result only ever increases — which is the whole requirement. A
    ///      counter would be a second copy of the same information, free to
    ///      disagree with it.
    function hostStateVersion(bytes32 settlementId) external view returns (uint64) {
        ConduitRWACVA.Reservation memory reservation = asset.reservationOf(settlementId);
        if (reservation.owner == address(0)) return 0;
        if (_dispositions[settlementId].executed) return 5;
        if (reservation.released || reservation.cancelled) return 4;
        if (reservation.committed) return 3;
        if (reservation.announced) return 2;
        return 1;
    }

    /// @notice Performs an authorized disposition of the held bond. PRD FR-012.
    ///
    /// Where the value may go is the controller's decision, taken from a signed
    /// order against the registry. What happens here is custody: the reservation
    /// must really be held, the amount must really be its amount, and the
    /// destination must pass this contract's quorum against its own EIP-712
    /// domain right now — PRD 5.4 step 5's current checks on the replacement.
    ///
    /// The token then applies CCP policy at the moment of transfer and can still
    /// refuse. Unlike `releaseAsset` this is not caught: there is no consumed
    /// VAA to strand, the leg is already held, and staying held is the correct
    /// outcome of a disposition the policy will not permit. The revert unwinds
    /// the controller's case with it, leaving it open to execute later.
    function executeDisposition(
        bytes32 settlementId,
        DispositionTypes.DispositionType dispositionType,
        address destination,
        uint256 amount,
        ComplianceProof calldata compliance
    ) external nonReentrant {
        if (msg.sender != address(dispositionController)) {
            revert NotTheDispositionController(msg.sender, address(dispositionController));
        }
        if (destination == address(0)) revert ZeroAddress();

        ConduitRWACVA.Reservation memory reservation = asset.reservationOf(settlementId);
        if (!reservation.committed || reservation.released || reservation.cancelled) {
            revert LegNotHeld(settlementId);
        }
        if (amount != reservation.amount) revert AmountMismatch(amount, reservation.amount);

        bytes32 intentHash = boundIntentHash[settlementId];
        if (!_isEligible(settlementId, intentHash, destination, compliance)) {
            revert DestinationNotEligible(settlementId, destination);
        }

        _dispositions[settlementId] = DispositionRecord({
            executed: true, dispositionType: dispositionType, destination: destination
        });

        asset.releaseReservation(settlementId, destination);
        emit AssetDisposed(settlementId, destination, amount, dispositionType);
    }

    /// @notice Fixes the Disposition Kernel. Callable once, by the owner, forever.
    function setDispositionController(address controller) external onlyOwner {
        if (address(dispositionController) != address(0)) {
            revert DispositionControllerAlreadySet(address(dispositionController));
        }
        if (controller == address(0)) revert ZeroAddress();
        dispositionController = DispositionController(controller);
        emit DispositionControllerSet(controller);
    }

    /// @notice Publishes this leg's terminal state back to the coordinator.
    ///
    /// PRD FR-011: the coordinator is SETTLED only after it consumes final
    /// release proofs for both legs, so the asset leg has to report.
    ///
    /// Permissionless, and it reads the outcome off the token rather than taking
    /// it from the caller. Anyone may carry a true statement; nobody may author
    /// one.
    ///
    /// @dev This took `bool released` from whoever called it. After a genuine
    ///      hold anyone could publish ASSET_RELEASED, and every check on the
    ///      coordinator passes — releasing after a COMMIT is precisely what is
    ///      supposed to happen. Canonical state then reads SETTLED while the bond
    ///      sits reserved and undelivered, and the true ASSET_HELD report is
    ///      afterwards refused with `LegAlreadyResolved`: the correct state
    ///      permanently locked out by the false one. Nobody's balance moves,
    ///      which is why it reads as harmless. What it destroys is the
    ///      correspondence between canonical state and where the value is, and
    ///      every conservation claim rests on that. ADR-0014's rule applies here
    ///      unchanged — a boolean records that a decision exists and carries no
    ///      evidence of who made it or on what basis — and the evidence in this
    ///      case is on the same chain, one call away.
    function reportResolution(
        bytes32 settlementId,
        uint256 destinationChainId,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence) {
        ConduitRWACVA.Reservation memory reservation = asset.reservationOf(settlementId);
        if (reservation.owner == address(0)) revert ReceiverNotRegistered(settlementId);

        // A reservation that is neither committed nor cancelled has had no
        // canonical decision applied to it here, so there is nothing to report.
        // Reporting it as held would be a claim about a leg that is still open.
        if (!reservation.committed && !reservation.cancelled) {
            revert LegNotResolved(settlementId);
        }

        // A disposition is its own report. PRD 7.3 defines DISPOSITION_RESOLVED
        // as message type 8 and nothing produced it until the kernel existed;
        // reusing ASSET_RELEASED would tell the coordinator the bond reached the
        // party the intent named, which for a rebind, a substitution or a
        // restricted-custody outcome is false.
        if (_dispositions[settlementId].executed) {
            return _publish(
                _header(
                    MessageCodec.MessageType.DISPOSITION_RESOLVED,
                    settlementId,
                    boundIntentHash[settlementId],
                    destinationChainId,
                    3
                ),
                consistencyLevel
            );
        }

        // PRD 7.3 has no RETURNED type: the wire says delivered or held, and the
        // coordinator's own decision separates a release from a return. A
        // cancelled reservation is the abort direction, and the units are back
        // with the seller, so it is delivered rather than held.
        bool delivered = reservation.released || reservation.cancelled;

        return _publish(
            _header(
                delivered
                    ? MessageCodec.MessageType.ASSET_RELEASED
                    : MessageCodec.MessageType.ASSET_HELD,
                settlementId,
                boundIntentHash[settlementId],
                destinationChainId,
                2
            ),
            consistencyLevel
        );
    }
}

// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ConduitRWACVA} from "./ConduitRWACVA.sol";
import {WormholeTransport} from "./WormholeTransport.sol";
import {MessageCodec} from "./libraries/MessageCodec.sol";

/// @notice The asset leg on Arbitrum. PRD v1.1 override sections 5 and 10.
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
contract RWACVASettlementAdapter is WormholeTransport, Ownable2Step, ReentrancyGuard {
    ConduitRWACVA public immutable asset;

    /// @dev Recorded so a release cannot be pointed at an address the intent
    ///      never named. Set when the seller's reservation is registered.
    mapping(bytes32 settlementId => address) public intendedReceiver;
    mapping(bytes32 settlementId => bytes32) public boundIntentHash;

    event AssetPrepared(
        bytes32 indexed settlementId,
        address indexed seller,
        address indexed receiver,
        uint256 amount
    );
    event AssetReleased(bytes32 indexed settlementId, address indexed receiver);
    event AssetHeld(bytes32 indexed settlementId, address indexed intendedReceiver, string reason);
    event AssetReturned(bytes32 indexed settlementId);

    error ReceiverNotRegistered(bytes32 settlementId);
    error ReceiverMismatch(address expected, address provided);
    error IntentHashMismatch(bytes32 actual, bytes32 expected);
    error NotReservationOwner();
    error ZeroAddress();

    constructor(
        address asset_,
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
        if (asset_ == address(0) || wormhole_ == address(0)) revert ZeroAddress();
        asset = ConduitRWACVA(asset_);
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
    /// `receiverEligible` reflects the commit-time compliance decision. Phase 05
    /// replaces it with a verified attestation.
    function releaseAsset(bytes calldata commitVaa, bool receiverEligible) external nonReentrant {
        MessageCodec.Header memory header = _consume(commitVaa, MessageCodec.MessageType.COMMIT);

        address receiver = intendedReceiver[header.settlementId];
        if (receiver == address(0)) revert ReceiverNotRegistered(header.settlementId);

        bytes32 bound = boundIntentHash[header.settlementId];
        if (bound != header.intentHash) revert IntentHashMismatch(header.intentHash, bound);

        // R2 and R4 take effect from here: the reservation can no longer be
        // cancelled, whatever happens to the release below.
        asset.markCommitted(header.settlementId);

        if (!receiverEligible) {
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

    /// @notice Publishes this leg's terminal state back to the coordinator.
    ///
    /// PRD FR-011: the coordinator is SETTLED only after it consumes final
    /// release proofs for both legs, so the asset leg has to report.
    function reportResolution(
        bytes32 settlementId,
        bool released,
        uint256 destinationChainId,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence) {
        ConduitRWACVA.Reservation memory reservation = asset.reservationOf(settlementId);
        if (reservation.owner == address(0)) revert ReceiverNotRegistered(settlementId);

        return _publish(
            _header(
                released
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

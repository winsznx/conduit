// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {WormholeTransport} from "./WormholeTransport.sol";
import {MessageCodec} from "./libraries/MessageCodec.sol";
import {SettlementIntentLib} from "./libraries/SettlementIntentLib.sol";

/// @notice The canonical decision contract on Monad. PRD FR-007, FR-008, FR-011.
///
/// Exactly one COMMIT or one ABORT exists per settlement, and both escrows take
/// their instructions from it. That single point is what turns two independent
/// chains into one settlement: neither leg decides for itself, so neither can
/// decide differently.
///
/// Invariant I3 is the whole contract in one line: a settlement receives at most
/// one COMMIT or one ABORT. Everything else here exists to make that true under
/// an adversarial relayer, a stale VAA, and a party who signed something else.
contract SettlementCoordinator is WormholeTransport, Ownable2Step {
    using SettlementIntentLib for SettlementIntentLib.SettlementIntent;

    /// @dev PRD 7.1. Monotonic: every transition below moves right, never left.
    enum SettlementState {
        NONE,
        CASH_PREPARED,
        ASSET_PREPARED,
        READY,
        COMMIT_ISSUED,
        ABORT_ISSUED,
        SETTLED,
        ABORTED,
        HELD,
        CONTESTED
    }

    enum Decision {
        NONE,
        COMMIT,
        ABORT
    }

    struct Settlement {
        SettlementState state;
        Decision decision;
        bool cashPrepared;
        bool assetPrepared;
        bool cashResolved;
        bool assetResolved;
        bytes32 intentHash;
        uint64 stateVersion;
    }

    bytes32 public immutable domainSeparator;

    mapping(bytes32 settlementId => Settlement) private _settlements;

    event CashLegPrepared(bytes32 indexed settlementId);
    event AssetLegPrepared(bytes32 indexed settlementId);
    event CommitIssued(bytes32 indexed settlementId, uint64 sequence);
    event AbortIssued(bytes32 indexed settlementId, uint64 sequence, string reason);
    event LegResolved(bytes32 indexed settlementId, bool cash, bool released);
    event SettlementTerminal(bytes32 indexed settlementId, SettlementState state);

    error AlreadyDecided(bytes32 settlementId, Decision decision);
    error NotReady(bytes32 settlementId, SettlementState state);
    error LegAlreadyPrepared(bytes32 settlementId);
    error IntentHashMismatch(bytes32 actual, bytes32 expected);
    error IntentDoesNotMatchSettlementId(bytes32 computed, bytes32 provided);
    error DeadlinePassed(uint64 deadline, uint256 nowTimestamp);
    error PrepareDeadlinePassed(uint64 deadline, uint256 nowTimestamp);
    error InvalidBuyerSignature();
    error InvalidSellerSignature();
    error ComplianceNotFresh();
    error WrongChainForCashLeg(uint256 expected, uint256 actual);
    error AbortAfterCommitForbidden(bytes32 settlementId);
    error SettlementUnknown(bytes32 settlementId);

    constructor(
        address wormhole_,
        bytes32 deploymentId_,
        uint16 localWormholeChainId_,
        uint16 remoteWormholeChainId_,
        bytes32 remoteEmitter_,
        address owner_,
        string memory domainName,
        string memory domainVersion
    )
        WormholeTransport(
            wormhole_, deploymentId_, localWormholeChainId_, remoteWormholeChainId_, remoteEmitter_
        )
        Ownable(owner_)
    {
        domainSeparator = SettlementIntentLib.domainSeparator(
            domainName, domainVersion, block.chainid, address(this)
        );
    }

    function settlementOf(bytes32 settlementId) external view returns (Settlement memory) {
        return _settlements[settlementId];
    }

    // ── Preparation ──────────────────────────────────────────────────────────

    /// @notice Records the local cash leg as prepared.
    ///
    /// Called by the cash escrow on this chain, so no VAA is involved: the two
    /// contracts share a chain and a transaction can span both.
    function recordCashPrepared(bytes32 settlementId, bytes32 intentHash) external {
        Settlement storage settlement = _settlements[settlementId];
        _requireUndecided(settlementId, settlement);
        if (settlement.cashPrepared) revert LegAlreadyPrepared(settlementId);

        _bindIntent(settlement, intentHash);
        settlement.cashPrepared = true;
        settlement.stateVersion += 1;
        settlement.state =
            settlement.assetPrepared ? SettlementState.READY : SettlementState.CASH_PREPARED;

        emit CashLegPrepared(settlementId);
    }

    /// @notice Consumes the remote ASSET_PREPARED VAA.
    ///
    /// Permissionless, per PRD FR-009. Every check that matters happened in
    /// `_consume`; what remains is whether this settlement is in a state where a
    /// remote preparation means anything.
    function recordAssetPrepared(bytes calldata preparedVaa) external {
        MessageCodec.Header memory header =
            _consume(preparedVaa, MessageCodec.MessageType.ASSET_PREPARED);

        Settlement storage settlement = _settlements[header.settlementId];
        _requireUndecided(header.settlementId, settlement);
        if (settlement.assetPrepared) revert LegAlreadyPrepared(header.settlementId);

        _bindIntent(settlement, header.intentHash);
        settlement.assetPrepared = true;
        settlement.stateVersion += 1;
        settlement.state =
            settlement.cashPrepared ? SettlementState.READY : SettlementState.ASSET_PREPARED;

        emit AssetLegPrepared(header.settlementId);
    }

    // ── The canonical decision ───────────────────────────────────────────────

    /// @notice Issues the one COMMIT for a settlement. PRD FR-007.
    ///
    /// Anyone may call this. The authority comes from the signatures and the
    /// prepared state, not from the caller, so restricting it would add a
    /// liveness dependency without adding safety.
    ///
    /// `complianceFresh` stands in for the commit-time attestation quorum that
    /// phase 05 delivers. It is a parameter rather than an assumed `true` so the
    /// blocked-commit path is reachable and tested from the start.
    function issueCommit(
        SettlementIntentLib.SettlementIntent calldata intent,
        bytes32 settlementId,
        bytes calldata buyerSignature,
        bytes calldata sellerSignature,
        bool complianceFresh,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence) {
        Settlement storage settlement = _settlements[settlementId];

        // Both legs prepared, and no decision yet.
        _requireUndecided(settlementId, settlement);
        if (settlement.state != SettlementState.READY) {
            revert NotReady(settlementId, settlement.state);
        }

        _validateIntent(intent, settlementId, settlement);

        // Deadlines. The commit window must still be open.
        //
        // A validator can nudge block.timestamp by a few seconds. Commit windows
        // are set in minutes or hours, so that drift cannot move a settlement
        // across the boundary in any way a party could exploit; and the
        // alternative, block numbers, drifts far worse across two chains with
        // different block times.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > intent.commitDeadline) {
            revert DeadlinePassed(intent.commitDeadline, block.timestamp);
        }

        _requireSignatures(intent, settlementId, buyerSignature, sellerSignature);

        // PRD FR-006: commit-time compliance, evaluated with no application
        // cache. A stale attestation is threat T-07.
        if (!complianceFresh) revert ComplianceNotFresh();

        settlement.decision = Decision.COMMIT;
        settlement.state = SettlementState.COMMIT_ISSUED;
        settlement.stateVersion += 1;

        sequence = _publish(
            _header(
                MessageCodec.MessageType.COMMIT,
                settlementId,
                settlement.intentHash,
                intent.assetChainId,
                settlement.stateVersion
            ),
            consistencyLevel
        );

        emit CommitIssued(settlementId, sequence);
    }

    /// @notice Issues the one ABORT for a settlement. PRD FR-008.
    ///
    /// Only reachable before a COMMIT. After one exists, this always reverts,
    /// which is invariant I4 expressed at the point of decision rather than at
    /// the point of payment.
    function issueAbort(
        SettlementIntentLib.SettlementIntent calldata intent,
        bytes32 settlementId,
        bool deadlineMissed,
        bool complianceFailed,
        bool bilateralCancellation,
        uint8 consistencyLevel
    ) external payable returns (uint64 sequence) {
        Settlement storage settlement = _settlements[settlementId];

        if (settlement.decision == Decision.COMMIT) {
            revert AbortAfterCommitForbidden(settlementId);
        }
        if (settlement.decision == Decision.ABORT) {
            revert AlreadyDecided(settlementId, Decision.ABORT);
        }
        if (settlement.state == SettlementState.NONE) revert SettlementUnknown(settlementId);

        _validateIntent(intent, settlementId, settlement);

        // PRD FR-008 lists the permitted grounds. A timeout claimed by a caller
        // is checked against the chain's own clock rather than believed.
        // Same reasoning as issueCommit. The point here is that the caller's
        // claim is checked against the chain's clock rather than believed: a
        // relayer asserting "the deadline passed" proves nothing on its own.
        // forge-lint: disable-next-line(block-timestamp)
        bool deadlineActuallyMissed = block.timestamp > intent.commitDeadline;
        if (deadlineMissed && !deadlineActuallyMissed) {
            revert DeadlinePassed(intent.commitDeadline, block.timestamp);
        }
        if (!deadlineActuallyMissed && !complianceFailed && !bilateralCancellation) {
            revert NotReady(settlementId, settlement.state);
        }

        settlement.decision = Decision.ABORT;
        settlement.state = SettlementState.ABORT_ISSUED;
        settlement.stateVersion += 1;

        string memory reason =
            deadlineActuallyMissed ? "deadline" : (complianceFailed ? "compliance" : "bilateral");

        sequence = _publish(
            _header(
                MessageCodec.MessageType.ABORT,
                settlementId,
                settlement.intentHash,
                intent.assetChainId,
                settlement.stateVersion
            ),
            consistencyLevel
        );

        emit AbortIssued(settlementId, sequence, reason);
    }

    // ── Completion ───────────────────────────────────────────────────────────

    /// @notice Consumes a leg's terminal proof. PRD FR-011.
    ///
    /// The coordinator reaches SETTLED only after both legs report back, so a
    /// settlement that looks finished on one chain is not finished here. If
    /// either leg is held, the settlement is HELD and conservation still holds
    /// exactly.
    function recordLegResolved(bytes calldata resolutionVaa, MessageCodec.MessageType expectedType)
        external
    {
        bool cash = expectedType == MessageCodec.MessageType.CASH_RELEASED
            || expectedType == MessageCodec.MessageType.CASH_HELD;
        bool released = expectedType == MessageCodec.MessageType.CASH_RELEASED
            || expectedType == MessageCodec.MessageType.ASSET_RELEASED;

        MessageCodec.Header memory header = _consume(resolutionVaa, expectedType);

        Settlement storage settlement = _settlements[header.settlementId];
        if (settlement.decision == Decision.NONE) revert SettlementUnknown(header.settlementId);

        if (cash) {
            settlement.cashResolved = true;
        } else {
            settlement.assetResolved = true;
        }
        if (!released) settlement.state = SettlementState.HELD;
        settlement.stateVersion += 1;

        emit LegResolved(header.settlementId, cash, released);

        if (settlement.cashResolved && settlement.assetResolved) {
            if (settlement.state != SettlementState.HELD) {
                settlement.state = settlement.decision == Decision.COMMIT
                    ? SettlementState.SETTLED
                    : SettlementState.ABORTED;
            }
            emit SettlementTerminal(header.settlementId, settlement.state);
        }
    }

    /// @notice Records the local cash leg's own resolution, no VAA needed.
    function recordLocalCashResolved(bytes32 settlementId, bool released) external {
        Settlement storage settlement = _settlements[settlementId];
        if (settlement.decision == Decision.NONE) revert SettlementUnknown(settlementId);

        settlement.cashResolved = true;
        if (!released) settlement.state = SettlementState.HELD;
        settlement.stateVersion += 1;

        emit LegResolved(settlementId, true, released);

        if (settlement.cashResolved && settlement.assetResolved) {
            if (settlement.state != SettlementState.HELD) {
                settlement.state = settlement.decision == Decision.COMMIT
                    ? SettlementState.SETTLED
                    : SettlementState.ABORTED;
            }
            emit SettlementTerminal(settlementId, settlement.state);
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _requireUndecided(bytes32 settlementId, Settlement storage settlement) private view {
        if (settlement.decision != Decision.NONE) {
            revert AlreadyDecided(settlementId, settlement.decision);
        }
    }

    /// @dev Both legs must bind the same intent hash. Invariant I7.
    function _bindIntent(Settlement storage settlement, bytes32 intentHash) private {
        if (settlement.intentHash == bytes32(0)) {
            settlement.intentHash = intentHash;
            return;
        }
        if (settlement.intentHash != intentHash) {
            revert IntentHashMismatch(intentHash, settlement.intentHash);
        }
    }

    function _validateIntent(
        SettlementIntentLib.SettlementIntent calldata intent,
        bytes32 settlementId,
        Settlement storage settlement
    ) private view {
        // The settlement ID must be the digest of the intent presented. Without
        // this, a caller could pass terms nobody signed alongside an ID that was.
        bytes32 computed = SettlementIntentLib.digest(intent, domainSeparator);
        if (computed != settlementId) {
            revert IntentDoesNotMatchSettlementId(computed, settlementId);
        }
        if (settlement.intentHash != bytes32(0) && settlement.intentHash != computed) {
            revert IntentHashMismatch(computed, settlement.intentHash);
        }
        // The cash leg lives on this chain. An intent naming a different cash
        // chain was written for a different coordinator.
        if (intent.cashChainId != block.chainid) {
            revert WrongChainForCashLeg(intent.cashChainId, block.chainid);
        }
    }

    /// @dev PRD FR-003. `SignatureChecker` accepts an ECDSA signature from an EOA
    ///      and an EIP-1271 signature from a contract wallet, and OpenZeppelin's
    ///      ECDSA rejects the malleable high-S form, so a second valid signature
    ///      cannot be derived from the first.
    function _requireSignatures(
        SettlementIntentLib.SettlementIntent calldata intent,
        bytes32 settlementId,
        bytes calldata buyerSignature,
        bytes calldata sellerSignature
    ) private view {
        if (!SignatureChecker.isValidSignatureNow(intent.cashPayer, settlementId, buyerSignature)) {
            revert InvalidBuyerSignature();
        }
        if (!SignatureChecker.isValidSignatureNow(
                intent.assetSeller, settlementId, sellerSignature
            )) {
            revert InvalidSellerSignature();
        }
    }
}

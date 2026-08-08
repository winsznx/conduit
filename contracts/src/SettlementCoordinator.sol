// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {ComplianceAuthority} from "./ComplianceAuthority.sol";
import {WormholeTransport} from "./WormholeTransport.sol";
import {ComplianceAttestationLib} from "./libraries/ComplianceAttestationLib.sol";
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
contract SettlementCoordinator is WormholeTransport, ComplianceAuthority, Ownable2Step {
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

    /// @dev PRD FR-008's permitted grounds, as one choice rather than three
    ///      independent booleans.
    ///
    ///      Three booleans allow combinations that mean nothing — "the deadline
    ///      passed and it was bilateral" — and they let a caller assert a ground
    ///      it cannot support. Each ground below now carries its own proof:
    ///      DEADLINE is checked against the chain's clock, COMPLIANCE against a
    ///      signed refusal from the quorum, BILATERAL against both parties'
    ///      signatures. Before this, anyone could abort any live settlement by
    ///      passing `complianceFailed: true`, which is a griefing vector against
    ///      a counterparty who wants the trade to complete.
    enum AbortGround {
        DEADLINE,
        COMPLIANCE,
        BILATERAL
    }

    /// @dev What a leg actually did.
    ///
    /// `bool released` used to stand in for this, and it conflated a release
    /// with a return: the differential corpus caught the coordinator accepting a
    /// release on an abort path, which the reference model refuses. They are
    /// different events with different authority — a release requires a
    /// canonical COMMIT, a return requires a canonical ABORT — and collapsing
    /// them into one flag made that distinction unrepresentable.
    enum LegOutcome {
        NONE,
        RELEASED,
        RETURNED,
        HELD
    }

    struct Settlement {
        SettlementState state;
        Decision decision;
        bool cashPrepared;
        bool assetPrepared;
        LegOutcome cashOutcome;
        LegOutcome assetOutcome;
        bytes32 intentHash;
        uint64 stateVersion;
    }

    bytes32 public immutable domainSeparator;

    /// @notice The one contract permitted to report the local cash leg.
    ///
    /// @dev Not immutable for the same reason the peer emitter is not: the two
    ///      contracts reference each other, so whichever deploys first cannot
    ///      know the other's address. Settable once and then fixed, so the
    ///      window closes permanently rather than staying open for an owner.
    address public cashEscrow;

    /// @dev A bilateral cancellation is its own signed statement. Signing to
    ///      enter a trade is not signing to abandon it, so the intent signature
    ///      cannot stand in for this one.
    bytes32 public constant CANCELLATION_TYPEHASH =
        keccak256("SettlementCancellation(bytes32 settlementId,bytes32 intentHash)");

    /// @notice Whatever the claimed abort ground needs to prove itself.
    ///
    /// @dev One parameter so `issueAbort` fits the stack, and so a caller cannot
    ///      supply a compliance proof while claiming a bilateral ground and have
    ///      the unused half quietly ignored.
    struct Cancellation {
        ComplianceProof compliance;
        bytes buyer;
        bytes seller;
    }

    mapping(bytes32 settlementId => Settlement) private _settlements;

    event CashEscrowSet(address indexed escrow);
    event CashLegPrepared(bytes32 indexed settlementId);
    event AssetLegPrepared(bytes32 indexed settlementId);
    event CommitIssued(bytes32 indexed settlementId, uint64 sequence);
    event AbortIssued(bytes32 indexed settlementId, uint64 sequence, string reason);
    event LegResolved(bytes32 indexed settlementId, bool cash, LegOutcome outcome);
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
    error WrongChainForCashLeg(uint256 expected, uint256 actual);
    error AbortAfterCommitForbidden(bytes32 settlementId);
    error SettlementUnknown(bytes32 settlementId);
    error LegNotPrepared(bytes32 settlementId, bool cash);
    error LegAlreadyResolved(bytes32 settlementId, bool cash);
    error ReleaseRequiresCommit(bytes32 settlementId);
    error ReturnRequiresAbort(bytes32 settlementId);
    error AbortGroundNotProven(AbortGround ground);
    error NotTheCashEscrow(address caller, address expected);
    error CashEscrowAlreadySet(address current);
    error InvalidCancellationSignature(address party);
    error OutcomeDoesNotMatchMessage(LegOutcome outcome, MessageCodec.MessageType messageType);

    constructor(
        address wormhole_,
        bytes32 deploymentId_,
        uint16 localWormholeChainId_,
        uint16 remoteWormholeChainId_,
        bytes32 remoteEmitter_,
        FinalityLevel settlementFinality_,
        FinalityLevel observationFinality_,
        uint64 maxAttestationValidity_,
        address owner_,
        string memory domainName,
        string memory domainVersion
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
        ComplianceAuthority(maxAttestationValidity_, domainName, domainVersion)
        Ownable(owner_)
    {
        domainSeparator = SettlementIntentLib.domainSeparator(
            domainName, domainVersion, block.chainid, address(this)
        );
    }

    function settlementOf(bytes32 settlementId) external view returns (Settlement memory) {
        return _settlements[settlementId];
    }

    // ── Compliance authority ─────────────────────────────────────────────────
    //
    // Owner-gated, and deliberately not renounceable-by-accident: the signer set
    // is the only thing standing between a caller and a COMMIT. These are the
    // three calls PRD 17.4's key-rotation runbook drives.

    function addComplianceSigner(address signer) external onlyOwner {
        _addComplianceSigner(signer);
    }

    function removeComplianceSigner(address signer) external onlyOwner {
        _removeComplianceSigner(signer);
    }

    function setComplianceQuorum(uint256 quorum) external onlyOwner {
        _setComplianceQuorum(quorum);
    }

    // ── Preparation ──────────────────────────────────────────────────────────

    /// @notice Records the local cash leg as prepared.
    ///
    /// Called by the cash escrow on this chain, so no VAA is involved: the two
    /// contracts share a chain and a transaction can span both.
    ///
    /// @dev Restricted to the escrow, for the reason `recordLocalCashResolved`
    ///      is. This was permissionless and the escrow never called it, so the
    ///      coordinator learned that cash had arrived from whoever sent the next
    ///      transaction. A buyer who funded nothing could declare the cash leg
    ///      prepared against a genuinely prepared asset leg, reach READY, and
    ///      commit: the seller's signature is one they already produced to enter
    ///      the trade, and the quorum attests two parties who are both really
    ///      eligible. Every check passes and the bond is delivered against an
    ///      empty escrow. Unlike the resolution defect this one moves value, and
    ///      it was invisible for exactly the ADR-0015 reason — every test called
    ///      this from the test contract, so nothing ever asked whether the real
    ///      producer calls it at all.
    function recordCashPrepared(bytes32 settlementId, bytes32 intentHash) external {
        if (msg.sender != cashEscrow) revert NotTheCashEscrow(msg.sender, cashEscrow);
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
    /// Compliance arrives as signed attestations rather than as a caller
    /// boolean. Both parties to the value transfer must be attested eligible by
    /// a quorum of authorized signers, for this settlement and this intent, and
    /// within a window the contract bounds rather than the signer. A boolean
    /// carried no evidence of who decided it, when, or about whom, so any caller
    /// could assert eligibility and the contract had no way to disagree.
    function issueCommit(
        SettlementIntentLib.SettlementIntent calldata intent,
        bytes32 settlementId,
        bytes calldata buyerSignature,
        bytes calldata sellerSignature,
        ComplianceProof calldata compliance,
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
        //
        // Both sides, separately. Attesting only the receiver would let an
        // ineligible payer fund a settlement, and attesting only the payer would
        // let value reach someone the authority refused. The asset-side parties
        // are attested on the asset chain by the adapter, against the same
        // intent hash.
        _requireEligible(settlementId, settlement.intentHash, intent.cashPayer, compliance);
        _requireEligible(settlementId, settlement.intentHash, intent.cashReceiver, compliance);

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
        AbortGround ground,
        Cancellation calldata cancellation,
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

        _requireAbortGround(intent, settlementId, settlement.intentHash, ground, cancellation);

        settlement.decision = Decision.ABORT;
        settlement.state = SettlementState.ABORT_ISSUED;
        settlement.stateVersion += 1;

        string memory reason = ground == AbortGround.DEADLINE
            ? "deadline"
            : (ground == AbortGround.COMPLIANCE ? "compliance" : "bilateral");

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

    /// @notice Proves the claimed ground rather than believing it.
    ///
    /// @dev Split out because `issueAbort` otherwise exceeds the stack, and
    ///      because the three grounds are genuinely three different proofs.
    function _requireAbortGround(
        SettlementIntentLib.SettlementIntent calldata intent,
        bytes32 settlementId,
        bytes32 intentHash,
        AbortGround ground,
        Cancellation calldata cancellation
    ) private view {
        if (ground == AbortGround.DEADLINE) {
            // A relayer asserting "the deadline passed" proves nothing on its
            // own; the chain's clock does.
            // forge-lint: disable-next-line(block-timestamp)
            if (block.timestamp <= intent.commitDeadline) {
                revert AbortGroundNotProven(AbortGround.DEADLINE);
            }
            return;
        }

        if (ground == AbortGround.COMPLIANCE) {
            // A signed refusal, not an assertion. Either party being refused is
            // sufficient grounds, and the quorum must have said so explicitly.
            if (
                !_isRefused(settlementId, intentHash, intent.cashPayer, cancellation.compliance)
                    && !_isRefused(
                        settlementId, intentHash, intent.cashReceiver, cancellation.compliance
                    )
            ) {
                revert AbortGroundNotProven(AbortGround.COMPLIANCE);
            }
            return;
        }

        // BILATERAL. Both parties sign a cancellation bound to this settlement
        // and these terms. Reusing their intent signatures would not do: signing
        // to enter a trade is not signing to abandon it.
        bytes32 digest = _cancellationDigest(settlementId, intentHash);
        if (!SignatureChecker.isValidSignatureNow(intent.cashPayer, digest, cancellation.buyer)) {
            revert InvalidCancellationSignature(intent.cashPayer);
        }
        if (!SignatureChecker.isValidSignatureNow(intent.assetSeller, digest, cancellation.seller))
        {
            revert InvalidCancellationSignature(intent.assetSeller);
        }
    }

    function _cancellationDigest(bytes32 settlementId, bytes32 intentHash)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                domainSeparator,
                keccak256(abi.encode(CANCELLATION_TYPEHASH, settlementId, intentHash))
            )
        );
    }

    // ── Completion ───────────────────────────────────────────────────────────

    /// @notice Consumes a leg's terminal proof. PRD FR-011.
    ///
    /// The coordinator reaches SETTLED only after both legs report back, so a
    /// settlement that looks finished on one chain is not finished here. If
    /// either leg is held, the settlement is HELD and conservation still holds
    /// exactly.
    function recordLegResolved(
        bytes calldata resolutionVaa,
        MessageCodec.MessageType expectedType,
        LegOutcome outcome
    ) external {
        bool cash =
            expectedType == MessageCodec.MessageType.CASH_RELEASED
                || expectedType == MessageCodec.MessageType.CASH_HELD;
        bool heldMessage = expectedType == MessageCodec.MessageType.CASH_HELD
            || expectedType == MessageCodec.MessageType.ASSET_HELD;

        // PRD 7.3 has no RETURNED message type, so the wire carries only
        // "delivered" or "held" and the canonical decision distinguishes a
        // release from a return. The caller states which it means and the
        // contract checks that claim against both the message and the decision.
        if ((outcome == LegOutcome.HELD) != heldMessage) {
            revert OutcomeDoesNotMatchMessage(outcome, expectedType);
        }

        MessageCodec.Header memory header = _consume(resolutionVaa, expectedType);

        Settlement storage settlement = _settlements[header.settlementId];
        if (settlement.decision == Decision.NONE) revert SettlementUnknown(header.settlementId);
        _requireOutcomeAllowed(header.settlementId, settlement, outcome);
        _requireResolvable(header.settlementId, settlement, cash, outcome);

        _applyResolution(header.settlementId, settlement, cash, outcome);
    }

    /// @notice Records the local cash leg's own resolution, no VAA needed.
    ///
    /// @dev Restricted to the escrow. It was permissionless, and that let anyone
    ///      declare the cash leg RELEASED the moment a COMMIT existed — the
    ///      outcome and resolvability checks both pass at that point, because
    ///      releasing after a commit is exactly what is supposed to happen. The
    ///      coordinator would then report a settled cash leg while the cash sat
    ///      untouched in escrow, and `recordAssetResolved` would drive the whole
    ///      settlement to SETTLED on it. Nobody gains the funds, which is why it
    ///      reads as harmless; what it destroys is the correspondence between
    ///      canonical state and where the value actually is, and every
    ///      conservation claim rests on that.
    function recordLocalCashResolved(bytes32 settlementId, LegOutcome outcome) external {
        if (msg.sender != cashEscrow) revert NotTheCashEscrow(msg.sender, cashEscrow);
        Settlement storage settlement = _settlements[settlementId];
        if (settlement.decision == Decision.NONE) revert SettlementUnknown(settlementId);
        _requireOutcomeAllowed(settlementId, settlement, outcome);
        _requireResolvable(settlementId, settlement, true, outcome);

        _applyResolution(settlementId, settlement, true, outcome);
    }

    /// @notice Fixes the local cash escrow. Callable once, by the owner, forever.
    function setCashEscrow(address escrow) external onlyOwner {
        if (cashEscrow != address(0)) revert CashEscrowAlreadySet(cashEscrow);
        if (escrow == address(0)) revert NotTheCashEscrow(escrow, escrow);
        cashEscrow = escrow;
        emit CashEscrowSet(escrow);
    }

    /// @notice Fixes the cross-chain peer. Callable once, by the owner, forever.
    ///
    /// Deployment order forces this: the two sides reference each other, so the
    /// first deployed cannot know the second. No VAA is consumable until it is
    /// set, and no later call can change it.
    function setRemotePeer(bytes32 emitter) external onlyOwner {
        _setRemotePeer(emitter);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /// @dev A release needs a COMMIT and a return needs an ABORT. A hold is
    ///      reachable from either, because a decided settlement that cannot move
    ///      value to its destination is held whichever way it was decided.
    function _requireOutcomeAllowed(
        bytes32 settlementId,
        Settlement storage settlement,
        LegOutcome outcome
    ) private view {
        if (outcome == LegOutcome.RELEASED && settlement.decision != Decision.COMMIT) {
            revert ReleaseRequiresCommit(settlementId);
        }
        if (outcome == LegOutcome.RETURNED && settlement.decision != Decision.ABORT) {
            revert ReturnRequiresAbort(settlementId);
        }
    }

    function _applyResolution(
        bytes32 settlementId,
        Settlement storage settlement,
        bool cash,
        LegOutcome outcome
    ) private {
        if (cash) {
            settlement.cashOutcome = outcome;
        } else {
            settlement.assetOutcome = outcome;
        }
        settlement.stateVersion += 1;

        emit LegResolved(settlementId, cash, outcome);

        // The settlement's state is derived from both legs every time, rather
        // than latched on the first hold. A leg that was held and is later
        // resolved must be able to move the settlement forward, otherwise a
        // disposition could never complete one.
        bool eitherHeld =
            settlement.cashOutcome == LegOutcome.HELD || settlement.assetOutcome == LegOutcome.HELD;
        bool bothResolved =
            settlement.cashOutcome != LegOutcome.NONE && settlement.assetOutcome != LegOutcome.NONE;

        if (eitherHeld) {
            settlement.state = SettlementState.HELD;
        } else if (bothResolved) {
            settlement.state = settlement.decision == Decision.COMMIT
                ? SettlementState.SETTLED
                : SettlementState.ABORTED;
            emit SettlementTerminal(settlementId, settlement.state);
        }
    }

    /// @dev A leg that was never prepared has nothing to resolve.
    ///
    /// Found by the differential corpus: without this, a settlement where only
    /// one leg was ever prepared could be driven to a terminal state by
    /// "resolving" the leg that does not exist. The reference model refuses it
    /// because the leg is in NONE; the contract accepted it because it only
    /// tracked a resolved flag. Resolving twice is refused for the same reason
    /// — it would let one leg satisfy the both-legs condition on its own.
    function _requireResolvable(
        bytes32 settlementId,
        Settlement storage settlement,
        bool cash,
        LegOutcome outcome
    ) private view {
        bool prepared = cash ? settlement.cashPrepared : settlement.assetPrepared;
        if (!prepared) revert LegNotPrepared(settlementId, cash);

        LegOutcome current = cash ? settlement.cashOutcome : settlement.assetOutcome;

        // A held leg may resolve again: that is what the Disposition Kernel does,
        // and PRD 7.1 lists HELD -> SETTLED as an allowed transition. But only
        // *forward*. Re-holding an already-held leg is a no-op that would let a
        // disposition appear to make progress without moving anything.
        if (current == LegOutcome.HELD) {
            if (outcome == LegOutcome.HELD) revert LegAlreadyResolved(settlementId, cash);
            return;
        }
        if (current != LegOutcome.NONE) revert LegAlreadyResolved(settlementId, cash);
    }

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

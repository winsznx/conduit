// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ComplianceAuthority} from "./ComplianceAuthority.sol";
import {SettlementCoordinator} from "./SettlementCoordinator.sol";
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
///     coordinator state rather than a local timeout (PRD FR-008, invariant I4).
///
/// **The decision is read from the coordinator, not from a VAA.** This contract
/// used to take a COMMIT VAA and put it through `_consume`, which could never
/// have worked: `_consume` requires the emitter to be the remote peer on the
/// remote chain, and the coordinator that issues COMMIT is neither — it is on
/// this chain. The COMMIT message is also addressed to `intent.assetChainId`, so
/// the destination check rejected it a second time. Two independent refusals, on
/// the path that releases the cash.
///
/// It was invisible because the tests fabricated well-formed COMMIT VAAs with
/// the escrow's own peer and this chain as the destination, rather than taking
/// what the coordinator actually emits. The unit tests were self-consistent and
/// described a message nothing in the system produces.
///
/// Reading the coordinator directly is not a workaround for that, it is the
/// correct source. A VAA exists to carry state across a trust boundary; between
/// two contracts on one chain there is no boundary to cross, and a
/// guardian-attested copy of local state is strictly weaker than the state
/// itself. The coordinator already had `recordLocalCashResolved` for the
/// return direction, so this closes the loop the design was already assuming.
contract CashEscrow is WormholeTransport, ComplianceAuthority, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The Cleanverse A-Token, discovered at deploy time and never hardcoded.
    IERC20 public immutable cashAsset;

    /// @notice The canonical decision, on this chain. The only authority here.
    SettlementCoordinator public immutable coordinator;

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
    error ReleaseRequiresCommit(bytes32 settlementId);
    error ReturnRequiresAbort(bytes32 settlementId);

    constructor(
        address cashAsset_,
        address coordinator_,
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
        if (cashAsset_ == address(0) || coordinator_ == address(0) || wormhole_ == address(0)) {
            revert ZeroAddress();
        }
        cashAsset = IERC20(cashAsset_);
        coordinator = SettlementCoordinator(coordinator_);
    }

    /// @notice Tells the coordinator what this leg did.
    ///
    /// @dev Without this the cash leg is unreportable and a settlement can never
    ///      reach SETTLED. `recordLocalCashResolved` is restricted to this
    ///      contract, so if this contract never calls it, nobody can — which is
    ///      what restricting it without wiring the call produced. The coordinator
    ///      is the only place the two legs are compared, and a leg that resolves
    ///      silently is invisible to every conservation check that matters.
    ///
    ///      Called after the leg's own state is written and before the token
    ///      moves, so canonical state is never behind the value. `nonReentrant`
    ///      on the callers covers the reentrancy this ordering would otherwise
    ///      open.
    function _report(bytes32 settlementId, SettlementCoordinator.LegOutcome outcome) private {
        coordinator.recordLocalCashResolved(settlementId, outcome);
    }

    /// @dev The three questions every resolution has to answer, in one place so
    ///      the release and return paths cannot drift apart: is this leg ours and
    ///      still open, does the canonical decision permit this direction, and do
    ///      the terms it was prepared under still match the ones the coordinator
    ///      decided on.
    function _requireReleasable(bytes32 settlementId, SettlementCoordinator.Decision required)
        private
        view
        returns (CashLeg storage leg)
    {
        leg = _legs[settlementId];
        if (leg.state == LegState.NONE) revert LegUnknown(settlementId);
        if (leg.state != LegState.PREPARED) {
            revert LegNotInState(settlementId, leg.state, LegState.PREPARED);
        }

        SettlementCoordinator.Settlement memory settlement = coordinator.settlementOf(settlementId);
        if (settlement.decision != required) {
            if (required == SettlementCoordinator.Decision.COMMIT) {
                revert ReleaseRequiresCommit(settlementId);
            }
            revert ReturnRequiresAbort(settlementId);
        }
        if (settlement.intentHash != leg.intentHash) {
            revert IntentHashMismatch(settlement.intentHash, leg.intentHash);
        }
    }

    function legOf(bytes32 settlementId) external view returns (CashLeg memory) {
        return _legs[settlementId];
    }

    // ── Compliance authority ─────────────────────────────────────────────────
    //
    // A separate signer set from the coordinator's by construction: they are
    // different contracts on different chains, and the EIP-712 domain binds each
    // attestation to one of them. An attestation minted for the coordinator is
    // not a valid attestation here even with the same signer and subject.

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
    /// Release-time eligibility comes from a signed quorum, not from the caller.
    /// The check is non-reverting on a shortfall and reverting on malformed
    /// input, which is the distinction that matters after COMMIT: no refund
    /// path reopens, so a release that cannot proceed must reach the held state
    /// rather than revert and strand the cash. A forged or misbound attestation
    /// is a different thing and still reverts.
    function releaseCash(bytes32 settlementId, ComplianceProof calldata compliance)
        external
        nonReentrant
    {
        CashLeg storage leg =
            _requireReleasable(settlementId, SettlementCoordinator.Decision.COMMIT);

        uint256 amount = leg.amount;

        // PRD FR-010: if the receiver is no longer permitted, the leg is held.
        // No refund path reopens, because a COMMIT exists (invariant I4).
        if (!_isEligible(settlementId, leg.intentHash, leg.receiver, compliance)) {
            leg.state = LegState.HELD;
            emit CashHeld(settlementId, leg.receiver, amount);
            _report(settlementId, SettlementCoordinator.LegOutcome.HELD);
            return;
        }

        leg.state = LegState.RELEASED;
        totalEscrowed -= amount;

        _report(settlementId, SettlementCoordinator.LegOutcome.RELEASED);

        cashAsset.safeTransfer(leg.receiver, amount);
        emit CashReleased(settlementId, leg.receiver, amount);
    }

    /// @notice Consumes an ABORT VAA and returns cash to the payer.
    ///
    /// The source of truth is canonical coordinator state carried by the VAA,
    /// never a local timeout. PRD FR-008 is explicit: a timeout alone cannot
    /// authorize a refund when a remote release may already have happened.
    function returnCash(bytes32 settlementId, ComplianceProof calldata compliance)
        external
        nonReentrant
    {
        CashLeg storage leg = _requireReleasable(settlementId, SettlementCoordinator.Decision.ABORT);

        uint256 amount = leg.amount;

        // PRD 5.2 step 7: a return recipient who is currently ineligible leaves
        // the leg in escrow and opens a disposition case.
        if (!_isEligible(settlementId, leg.intentHash, leg.payer, compliance)) {
            leg.state = LegState.HELD;
            emit CashHeld(settlementId, leg.payer, amount);
            _report(settlementId, SettlementCoordinator.LegOutcome.HELD);
            return;
        }

        leg.state = LegState.RETURNED;
        totalEscrowed -= amount;

        _report(settlementId, SettlementCoordinator.LegOutcome.RETURNED);

        cashAsset.safeTransfer(leg.payer, amount);
        emit CashReturned(settlementId, leg.payer, amount);
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

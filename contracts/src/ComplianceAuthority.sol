// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ComplianceAttestationLib} from "./libraries/ComplianceAttestationLib.sol";

/// @notice The signer set and quorum that decide commit-time compliance.
///
/// Inherited by every contract that used to take a caller-supplied boolean. The
/// verification is here rather than duplicated per contract because three call
/// sites drifting apart is how one of them ends up accepting a one-signature
/// quorum nobody noticed.
///
/// PRD FR-006 requires commit-time compliance evaluated with no application
/// cache, and threat T-07 is a stale attestation replayed after the facts
/// changed. Three rules follow, and all three are enforced rather than assumed:
///
/// **Quorum, not a signature.** One compromised signer should not be able to
/// authorize a settlement. `quorum` distinct authorized signers must attest the
/// same subject, and duplicates from one signer count once — that check is the
/// difference between a quorum and a loop counter.
///
/// **A bounded lifetime the signer does not choose.** `expiresAt` is in the
/// signed struct, so a signer could set it a year out and hand a compromised key
/// a year of authority. `maxAttestationValidity` is immutable in the bytecode and
/// caps the window independently.
///
/// **Failure is refusal, never assumption.** A missing, expired, or unsigned
/// attestation does not mean "assume eligible" and does not mean "assume
/// ineligible and silently abort". It reverts, so the caller learns the
/// difference between a compliance refusal and a compliance answer that never
/// arrived. An explicit `eligible: false` attestation is a different thing: it is
/// a signed refusal, and it produces the held path with evidence attached.
///
/// **An unconfigured authority refuses everything.** The quorum starts at zero,
/// and `attesting >= 0` is true for an empty attestation array — a freshly
/// deployed contract would have accepted any commit with no compliance evidence
/// at all, which is worse than having no check, because the check appears to be
/// there. The zero case is therefore rejected explicitly rather than left to the
/// comparison. Deployment and configuration are two steps, and the window
/// between them is closed rather than permissive.
abstract contract ComplianceAuthority {
    using ComplianceAttestationLib for ComplianceAttestationLib.ComplianceAttestation;

    /// @notice The attestations and their signatures, carried together.
    ///
    /// @dev One parameter rather than two parallel arrays at every call site.
    ///      Parallel arrays that can be passed separately eventually are, and a
    ///      caller that reorders one without the other produces signatures that
    ///      verify against the wrong attestations.
    struct ComplianceProof {
        ComplianceAttestationLib.ComplianceAttestation[] attestations;
        bytes[] signatures;
    }

    /// @notice EIP-712 domain for attestations, bound to this chain and contract.
    bytes32 public immutable attestationDomainSeparator;

    /// @notice The longest an attestation may be valid for, set at deployment.
    uint64 public immutable maxAttestationValidity;

    mapping(address => bool) private _signers;
    uint256 private _signerCount;
    uint256 private _quorum;

    error NotAComplianceSigner(address account);
    error AlreadyAComplianceSigner(address account);
    error QuorumExceedsSignerCount(uint256 quorum, uint256 signerCount);
    error QuorumIsZero();
    error AttestationForWrongSettlement(bytes32 expected, bytes32 actual);
    error AttestationForWrongIntent(bytes32 expected, bytes32 actual);
    error AttestationExpired(uint64 expiresAt, uint256 nowTimestamp);
    error AttestationNotYetValid(uint64 issuedAt, uint256 nowTimestamp);
    error AttestationValidityTooLong(uint64 window, uint64 maximum);
    error AttestationSignerNotAuthorized(address recovered);
    error AttestationSignersNotDistinct(address repeated);
    error AttestationCountMismatch(uint256 attestations, uint256 signatures);
    error ComplianceQuorumNotMet(address subject, uint256 attesting, uint256 required);
    error ComplianceNotConfigured();

    event ComplianceSignerAdded(address indexed signer);
    event ComplianceSignerRemoved(address indexed signer);
    event ComplianceQuorumSet(uint256 quorum);

    constructor(
        uint64 maxAttestationValidity_,
        string memory domainName,
        string memory domainVersion
    ) {
        maxAttestationValidity = maxAttestationValidity_;
        attestationDomainSeparator = ComplianceAttestationLib.domainSeparator(
            domainName, domainVersion, block.chainid, address(this)
        );
    }

    function isComplianceSigner(address account) public view returns (bool) {
        return _signers[account];
    }

    function complianceSignerCount() public view returns (uint256) {
        return _signerCount;
    }

    function complianceQuorum() public view returns (uint256) {
        return _quorum;
    }

    // ── Signer set management ────────────────────────────────────────────────
    //
    // Internal, so each concrete contract chooses its own access control rather
    // than inheriting an owner it did not ask for.

    function _addComplianceSigner(address signer) internal {
        if (_signers[signer]) revert AlreadyAComplianceSigner(signer);
        _signers[signer] = true;
        _signerCount += 1;
        emit ComplianceSignerAdded(signer);
    }

    function _removeComplianceSigner(address signer) internal {
        if (!_signers[signer]) revert NotAComplianceSigner(signer);
        _signers[signer] = false;
        _signerCount -= 1;
        // Removing a signer can strand a quorum above the surviving set, which
        // would wedge every future commit. Failing here forces the operator to
        // lower the quorum first, deliberately, rather than discovering it at
        // the next settlement.
        if (_quorum > _signerCount) revert QuorumExceedsSignerCount(_quorum, _signerCount);
        emit ComplianceSignerRemoved(signer);
    }

    function _setComplianceQuorum(uint256 quorum_) internal {
        if (quorum_ == 0) revert QuorumIsZero();
        if (quorum_ > _signerCount) revert QuorumExceedsSignerCount(quorum_, _signerCount);
        _quorum = quorum_;
        emit ComplianceQuorumSet(quorum_);
    }

    // ── Verification ─────────────────────────────────────────────────────────

    /// @notice The exact eligibility question the value-moving paths ask, as a
    ///         view anyone can call.
    ///
    /// @dev Two callers need this and neither should have to send a transaction
    ///      to find out. A preflight must be able to prove that the proof it is
    ///      about to submit verifies here — against this contract's own domain
    ///      separator and signer set, not against a local reimplementation of
    ///      them — before a settlement is twenty-five minutes old. And PRD 15.2's
    ///      independent verifier has to check a settled proof without trusting
    ///      the application database, which means asking the contract rather than
    ///      re-deriving its answer.
    ///
    ///      It shares `_countAttestations` with the release paths rather than
    ///      restating the checks, so the two cannot drift. A malformed proof
    ///      reverts here exactly as it would there; a shortfall returns false,
    ///      which is the release paths' behaviour rather than `issueCommit`'s
    ///      revert. The difference is deliberate and it is the one place this is
    ///      not identical to the commit path: a caller wanting the commit
    ///      semantics reads `false` and stops.
    function verifyEligible(
        bytes32 settlementId,
        bytes32 intentHash,
        address subject,
        ComplianceProof calldata proof
    ) external view returns (bool) {
        return _isEligible(settlementId, intentHash, subject, proof);
    }

    /// @notice Whether the quorum has explicitly refused, as a view.
    ///
    /// @dev Separate from `verifyEligible` for the reason `_isRefused` is
    ///      separate from `_isEligible`: silence and refusal are different
    ///      answers and only one of them is grounds for an abort.
    function verifyRefused(
        bytes32 settlementId,
        bytes32 intentHash,
        address subject,
        ComplianceProof calldata proof
    ) external view returns (bool) {
        return _isRefused(settlementId, intentHash, subject, proof);
    }

    /// @notice Requires `quorum` distinct authorized signers to attest `subject`
    ///         eligible for this exact settlement and intent, right now.
    ///
    /// @dev Reverts rather than returning false. A caller that could branch on
    ///      the result would be free to ignore it, and the one place that matters
    ///      is the canonical COMMIT, which is irreversible.
    function _requireEligible(
        bytes32 settlementId,
        bytes32 intentHash,
        address subject,
        ComplianceProof calldata proof
    ) internal view {
        uint256 required = _quorum;
        if (required == 0) revert ComplianceNotConfigured();

        uint256 attesting = _countAttestations(settlementId, intentHash, subject, proof, true);
        if (attesting < required) {
            revert ComplianceQuorumNotMet(subject, attesting, required);
        }
    }

    /// @notice Whether the quorum attests `subject` eligible, without reverting
    ///         on a shortfall.
    ///
    /// @dev For the post-COMMIT release paths only. After COMMIT there is no
    ///      refund, so a release that cannot proceed must reach the held state
    ///      rather than revert and strand the settlement. Malformed input still
    ///      reverts: "the signature does not verify" and "the authority says no"
    ///      are different answers and must not collapse into one.
    function _isEligible(
        bytes32 settlementId,
        bytes32 intentHash,
        address subject,
        ComplianceProof calldata proof
    ) internal view returns (bool) {
        uint256 required = _quorum;
        // Fails closed: an unconfigured authority holds the leg rather than
        // releasing it. Reverting here would strand a settlement that has
        // already committed, and there is no refund after COMMIT.
        if (required == 0) return false;
        return _countAttestations(settlementId, intentHash, subject, proof, true) >= required;
    }

    /// @notice Whether the quorum has explicitly refused `subject`.
    ///
    /// @dev Not the negation of `_isEligible`. "The authority said no" and "the
    ///      authority has not answered" are different states, and only the first
    ///      is grounds for an abort. Treating silence as refusal would let anyone
    ///      abort a live settlement by supplying nothing at all — which is what
    ///      the caller-supplied `complianceFailed` boolean allowed.
    function _isRefused(
        bytes32 settlementId,
        bytes32 intentHash,
        address subject,
        ComplianceProof calldata proof
    ) internal view returns (bool) {
        uint256 required = _quorum;
        if (required == 0) return false;
        return _countAttestations(settlementId, intentHash, subject, proof, false) >= required;
    }

    function _countAttestations(
        bytes32 settlementId,
        bytes32 intentHash,
        address subject,
        ComplianceProof calldata proof,
        bool wanted
    ) private view returns (uint256 attesting) {
        if (proof.attestations.length != proof.signatures.length) {
            revert AttestationCountMismatch(proof.attestations.length, proof.signatures.length);
        }

        // Distinctness is tracked against the signers already counted for this
        // subject. A signer submitting the same opinion twice is one opinion.
        address[] memory counted = new address[](proof.attestations.length);

        for (uint256 i = 0; i < proof.attestations.length; i += 1) {
            ComplianceAttestationLib.ComplianceAttestation calldata attestation =
                proof.attestations[i];

            address signer = _recoverAuthorizedSigner(attestation, proof.signatures[i]);

            if (attestation.subject != subject) continue;

            _requireBoundAndFresh(settlementId, intentHash, attestation);

            // Checked after binding, so a stale or misbound attestation is
            // rejected as malformed rather than silently counted as an answer.
            if (attestation.eligible != wanted) continue;

            for (uint256 j = 0; j < attesting; j += 1) {
                if (counted[j] == signer) revert AttestationSignersNotDistinct(signer);
            }

            counted[attesting] = signer;
            attesting += 1;
        }
    }

    function _recoverAuthorizedSigner(
        ComplianceAttestationLib.ComplianceAttestation calldata attestation,
        bytes calldata signature
    ) private view returns (address signer) {
        // The struct is copied to memory for hashing; the digest is over the
        // same seven fields either way.
        ComplianceAttestationLib.ComplianceAttestation memory copy = attestation;
        signer = ECDSA.recover(
            ComplianceAttestationLib.digest(attestationDomainSeparator, copy), signature
        );
        if (!_signers[signer]) revert AttestationSignerNotAuthorized(signer);
    }

    function _requireBoundAndFresh(
        bytes32 settlementId,
        bytes32 intentHash,
        ComplianceAttestationLib.ComplianceAttestation calldata attestation
    ) private view {
        if (attestation.settlementId != settlementId) {
            revert AttestationForWrongSettlement(settlementId, attestation.settlementId);
        }
        if (attestation.intentHash != intentHash) {
            revert AttestationForWrongIntent(intentHash, attestation.intentHash);
        }

        // Ordered so an inverted window produces the custom error rather than an
        // arithmetic panic, which would tell an operator nothing about why.
        if (attestation.expiresAt < attestation.issuedAt) {
            revert AttestationValidityTooLong(0, maxAttestationValidity);
        }
        uint64 window = attestation.expiresAt - attestation.issuedAt;
        if (window > maxAttestationValidity) {
            revert AttestationValidityTooLong(window, maxAttestationValidity);
        }

        // Timestamp drift is bounded by a validator's few seconds. The validity
        // window is minutes, so drift cannot carry an attestation across the
        // boundary in a way any party can steer.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > attestation.expiresAt) {
            revert AttestationExpired(attestation.expiresAt, block.timestamp);
        }
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < attestation.issuedAt) {
            revert AttestationNotYetValid(attestation.issuedAt, block.timestamp);
        }
    }
}

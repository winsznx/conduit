// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

/// @notice EIP-712 hashing for a commit-time compliance attestation. PRD FR-006.
///
/// Replaces the `bool complianceFresh` and `bool eligible` parameters the
/// settlement contracts previously took from whoever happened to call them. A
/// boolean carries no evidence of who decided it, when, about whom, or on what
/// basis, so any caller could assert eligibility and the contract had no way to
/// disagree. CLAUDE.md states the rule directly: application database state never
/// authorizes value movement. A signed attestation is what replaces it.
///
/// Every field exists to close a specific substitution:
///
///   `settlementId`  an attestation for one settlement cannot authorize another
///   `intentHash`    nor the same settlement under renegotiated terms
///   `subject`       nor a different party in the same settlement
///   `eligible`      a refusal is signed as explicitly as an approval, so an
///                   ineligible result is evidence rather than an absent record
///   `issuedAt`      lets the contract bound how long an attestation may live,
///                   rather than trusting the signer to choose a short window
///   `expiresAt`     PRD FR-006 requires commit-time compliance; threat T-07 is
///                   a stale attestation replayed after the facts changed
///   `evidenceHash`  binds the decision to the exact normalized Cleanverse
///                   response behind it, so the audit package can show the
///                   answer the authority actually saw
///
/// The domain separator binds chain ID and verifying contract, so an attestation
/// for the Monad coordinator is not a valid attestation for the Base adapter even
/// though both accept the same struct.
library ComplianceAttestationLib {
    bytes32 internal constant COMPLIANCE_ATTESTATION_TYPEHASH = keccak256(
        "ComplianceAttestation(bytes32 settlementId,bytes32 intentHash,address subject,bool eligible,uint64 issuedAt,uint64 expiresAt,bytes32 evidenceHash)"
    );

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    struct ComplianceAttestation {
        bytes32 settlementId;
        bytes32 intentHash;
        address subject;
        bool eligible;
        uint64 issuedAt;
        uint64 expiresAt;
        /// @dev keccak256 of the normalized Cleanverse response. Never the
        ///      response itself: PRD forbids raw PII on chain, and a hash is
        ///      enough to prove the off-chain record was not swapped afterwards.
        bytes32 evidenceHash;
    }

    function hashStruct(ComplianceAttestation memory attestation) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                COMPLIANCE_ATTESTATION_TYPEHASH,
                attestation.settlementId,
                attestation.intentHash,
                attestation.subject,
                attestation.eligible,
                attestation.issuedAt,
                attestation.expiresAt,
                attestation.evidenceHash
            )
        );
    }

    function domainSeparator(
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract
    ) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
    }

    function digest(bytes32 separator, ComplianceAttestation memory attestation)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked("\x19\x01", separator, hashStruct(attestation)));
    }
}

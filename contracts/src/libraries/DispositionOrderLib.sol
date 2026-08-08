// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {DispositionTypes} from "./DispositionTypes.sol";

/// @notice EIP-712 hashing for a disposition order. PRD FR-012.
///
/// FR-012 lists sixteen things an order binds. All sixteen are here, plus five
/// the deployed system needs and the PRD's list assumes rather than states: the
/// deployment generation, the disposition type itself, the receiver the order is
/// displacing, the authority's own address, and the hash of the policy content.
///
/// The reason every one of them is in the signed struct rather than a parameter
/// is the same reason the settlement intent works that way. A field outside the
/// signature is a field the relayer chooses. An order that bound only the case
/// and the destination would be a signed statement that value may move — a
/// statement whose amount, asset, leg and generation are filled in by whoever
/// submits it.
///
/// Each field closes a specific substitution:
///
///   `caseId`          derived from the settlement and leg, so two orders about
///                     the same held value necessarily meet in one case and the
///                     conflict check cannot be dodged by filing elsewhere
///   `settlementId`    an order for one settlement cannot move another's value
///   `deploymentId`    nor the same settlement on a different generation, which
///                     is a live concern: two generations hold real settlements
///                     against the same token
///   `leg`             nor the other leg of the same settlement
///   `dispositionType` an authority permitted to sign a resume is not thereby
///                     permitted to sign a rebind
///   `sourceEscrow`    names the contract that will actually part with the value
///   `asset`           and what it will part with
///   `amount`          and how much, checked against the held leg rather than
///                     believed, so an order cannot quietly move a different sum
///   `currentReceiver` the party being displaced, so an order written while one
///                     receiver was intended cannot execute after a rebind
///                     changed it
///   `destination`     where the value goes. Absent for REVERIFY_AND_RESUME,
///                     which is the whole reason that type needs no authority
///   `destinationIdentityCommitment`
///                     PRD 5.4 step 8 requires the audit package to record the
///                     old and new commitments, and REBIND_RECEIVER is only a
///                     rebind if the commitment is unchanged
///   `authority`       who is signing, so an EIP-1271 wallet can be asked
///   `authorityType`   under which of PRD FR-012's seven classes
///   `authorityPolicyId` / `authorityPolicyHash`
///                     the policy, and its exact content. Binding the ID alone
///                     would let a policy be rewritten under a signed order;
///                     binding the hash means a policy change invalidates
///                     in-flight orders rather than repurposing them
///   `evidenceCommitment` the off-chain case file, unswappable afterwards
///   `complianceAttestationIds`
///                     the attestations the authority saw when it signed, which
///                     are not the ones execution will check — that is the point
///                     of recording both
///   `notBefore` / `expiry`
///                     a stale order fails rather than sitting executable
///   `nonce`           consumed per authority, so a valid order is single-use
///   `hostStateVersion` the coordinator's own version counter at signing time,
///                     so an order signed against one settlement state cannot
///                     execute against a later one
///
/// The domain separator binds chain ID and verifying contract, so an order for
/// the Monad controller is not a valid order for the Base controller even with
/// the same authority, the same settlement and the same bytes.
library DispositionOrderLib {
    bytes32 internal constant DISPOSITION_ORDER_TYPEHASH = keccak256(
        "DispositionOrder(bytes32 caseId,bytes32 settlementId,bytes32 deploymentId,uint8 leg,uint8 dispositionType,address sourceEscrow,address asset,uint256 amount,address currentReceiver,address destination,bytes32 destinationIdentityCommitment,address authority,uint8 authorityType,bytes32 authorityPolicyId,bytes32 authorityPolicyHash,bytes32 evidenceCommitment,bytes32 complianceAttestationIds,uint64 notBefore,uint64 expiry,uint256 nonce,uint64 hostStateVersion)"
    );

    /// @notice The adjudication of a contested case. PRD FR-012's last line.
    ///
    /// @dev Signed and typed for the same reason an order is. Choosing the
    ///      winner of a conflict is a decision with the same consequence as
    ///      authorizing the movement in the first place, so it carries the same
    ///      evidence: who decided, under which policy, about which case, and
    ///      which of the filed orders won.
    bytes32 internal constant CONFLICT_RESOLUTION_TYPEHASH = keccak256(
        "ConflictResolution(bytes32 caseId,bytes32 deploymentId,bytes32 winningOrderHash,address authority,uint8 authorityType,bytes32 authorityPolicyId,bytes32 authorityPolicyHash,bytes32 evidenceCommitment,uint64 notBefore,uint64 expiry,uint256 nonce)"
    );

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    struct DispositionOrder {
        bytes32 caseId;
        bytes32 settlementId;
        bytes32 deploymentId;
        DispositionTypes.Leg leg;
        DispositionTypes.DispositionType dispositionType;
        address sourceEscrow;
        address asset;
        uint256 amount;
        address currentReceiver;
        address destination;
        bytes32 destinationIdentityCommitment;
        address authority;
        DispositionTypes.AuthorityType authorityType;
        bytes32 authorityPolicyId;
        bytes32 authorityPolicyHash;
        bytes32 evidenceCommitment;
        bytes32 complianceAttestationIds;
        uint64 notBefore;
        uint64 expiry;
        uint256 nonce;
        uint64 hostStateVersion;
    }

    struct ConflictResolution {
        bytes32 caseId;
        bytes32 deploymentId;
        bytes32 winningOrderHash;
        address authority;
        DispositionTypes.AuthorityType authorityType;
        bytes32 authorityPolicyId;
        bytes32 authorityPolicyHash;
        bytes32 evidenceCommitment;
        uint64 notBefore;
        uint64 expiry;
        uint256 nonce;
    }

    /// @notice The case an order belongs to, derived rather than chosen.
    ///
    /// @dev PRD FR-012 binds a case ID without saying where it comes from, and
    ///      letting the signer choose it would defeat the conflict rule
    ///      outright: two authorities wanting different outcomes would each file
    ///      under their own case, both cases would be uncontested, and both
    ///      would execute. Deriving it from the generation, the settlement and
    ///      the leg means every order about one piece of held value lands in one
    ///      case by construction.
    function caseIdFor(bytes32 deploymentId, bytes32 settlementId, DispositionTypes.Leg leg)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(deploymentId, settlementId, uint8(leg)));
    }

    /// @dev Split in three because twenty-two words exceed the stack. The
    ///      concatenation order is unchanged, so the digest is identical to a
    ///      single `abi.encode` of all of them.
    function hashStruct(DispositionOrder memory order) internal pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    DISPOSITION_ORDER_TYPEHASH,
                    order.caseId,
                    order.settlementId,
                    order.deploymentId,
                    uint8(order.leg),
                    uint8(order.dispositionType),
                    order.sourceEscrow,
                    order.asset
                ),
                abi.encode(
                    order.amount,
                    order.currentReceiver,
                    order.destination,
                    order.destinationIdentityCommitment,
                    order.authority,
                    uint8(order.authorityType),
                    order.authorityPolicyId
                ),
                abi.encode(
                    order.authorityPolicyHash,
                    order.evidenceCommitment,
                    order.complianceAttestationIds,
                    order.notBefore,
                    order.expiry,
                    order.nonce,
                    order.hostStateVersion
                )
            )
        );
    }

    function hashStruct(ConflictResolution memory resolution) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CONFLICT_RESOLUTION_TYPEHASH,
                resolution.caseId,
                resolution.deploymentId,
                resolution.winningOrderHash,
                resolution.authority,
                uint8(resolution.authorityType),
                resolution.authorityPolicyId,
                resolution.authorityPolicyHash,
                resolution.evidenceCommitment,
                resolution.notBefore,
                resolution.expiry,
                resolution.nonce
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

    function digest(bytes32 separator, DispositionOrder memory order)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(hex"1901", separator, hashStruct(order)));
    }

    function digest(bytes32 separator, ConflictResolution memory resolution)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(hex"1901", separator, hashStruct(resolution)));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

/// @notice EIP-712 hashing for the settlement intent. PRD FR-002, FR-003.
///
/// This must produce byte-identical digests to
/// `packages/domain/src/intent.ts`. The two are written independently and
/// cross-checked against fixed vectors in `SettlementIntentLib.t.sol` and
/// `packages/domain/src/intent.test.ts`, because a silent divergence here means
/// a signature the SDK produces and the contract rejects — or worse, one the
/// contract accepts for terms the signer never saw.
library SettlementIntentLib {
    /// @dev PRD FR-002's struct minus `settlementId`, which is the digest of the
    ///      rest. Listing the ID inside its own preimage would be circular.
    ///      Field order is part of the type hash and must never be reordered.
    bytes32 internal constant SETTLEMENT_INTENT_TYPEHASH = keccak256(
        "SettlementIntent(uint32 version,uint256 cashChainId,address cashEscrow,address cashAsset,uint256 cashAmount,address cashPayer,address cashReceiver,uint256 assetChainId,address assetEscrow,address assetToken,uint256 assetAmount,address assetSeller,address assetReceiver,bytes32 cashPolicyHash,bytes32 assetPolicyHash,uint64 prepareDeadline,uint64 commitDeadline,uint64 releaseDeadline,uint256 nonce)"
    );

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    struct SettlementIntent {
        uint32 version;
        uint256 cashChainId;
        address cashEscrow;
        address cashAsset;
        uint256 cashAmount;
        address cashPayer;
        address cashReceiver;
        uint256 assetChainId;
        address assetEscrow;
        address assetToken;
        uint256 assetAmount;
        address assetSeller;
        address assetReceiver;
        bytes32 cashPolicyHash;
        bytes32 assetPolicyHash;
        uint64 prepareDeadline;
        uint64 commitDeadline;
        uint64 releaseDeadline;
        uint256 nonce;
    }

    /// @dev Split in two because nineteen fields plus the typehash exceeds the
    ///      stack. The concatenation order is unchanged, so the digest is
    ///      identical to a single `abi.encode` of all twenty values.
    function hashStruct(SettlementIntent memory intent) internal pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                abi.encode(
                    SETTLEMENT_INTENT_TYPEHASH,
                    intent.version,
                    intent.cashChainId,
                    intent.cashEscrow,
                    intent.cashAsset,
                    intent.cashAmount,
                    intent.cashPayer,
                    intent.cashReceiver,
                    intent.assetChainId,
                    intent.assetEscrow,
                    intent.assetToken
                ),
                abi.encode(
                    intent.assetAmount,
                    intent.assetSeller,
                    intent.assetReceiver,
                    intent.cashPolicyHash,
                    intent.assetPolicyHash,
                    intent.prepareDeadline,
                    intent.commitDeadline,
                    intent.releaseDeadline,
                    intent.nonce
                )
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

    /// @notice The settlement ID, which is also the digest both parties sign.
    ///
    /// One value for both purposes is deliberate. If the identifier and the
    /// signing digest differed, a signature could be valid for an intent whose
    /// ID it did not cover.
    function digest(SettlementIntent memory intent, bytes32 separator)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(bytes.concat(hex"1901", separator, hashStruct(intent)));
    }
}

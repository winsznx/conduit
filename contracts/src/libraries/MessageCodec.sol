// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

/// @notice Cross-chain message header. PRD 7.3.
///
/// Byte-compatible with `packages/domain/src/messages.ts`, and cross-checked
/// against fixed vectors in both languages. The relayer and the indexer read
/// these payloads off-chain; if their decoder and this one disagreed, a message
/// the contract accepts could be displayed as something else entirely.
///
/// The encoding is fixed-width and positional. No length prefix, no optional
/// field, no dynamic type. A truncated or extended payload fails to decode
/// rather than decoding into something plausible, which is the property that
/// matters when the input is attacker-influenced.
library MessageCodec {
    /// 4 + 1 + 32 + 32 + 32 + 32 + 32 + 8
    uint256 internal constant HEADER_BYTES = 173;

    uint32 internal constant PROTOCOL_VERSION = 1;

    /// @dev PRD 7.3. Values are positional and must never be renumbered: a
    ///      reordering silently turns a COMMIT into an ABORT on any peer that
    ///      has not been redeployed.
    enum MessageType {
        CASH_PREPARED, // 0
        ASSET_PREPARED, // 1
        COMMIT, // 2
        ABORT, // 3
        CASH_RELEASED, // 4
        ASSET_RELEASED, // 5
        CASH_HELD, // 6
        ASSET_HELD, // 7
        DISPOSITION_RESOLVED // 8
    }

    struct Header {
        uint32 protocolVersion;
        MessageType messageType;
        bytes32 deploymentId;
        bytes32 settlementId;
        bytes32 intentHash;
        uint256 sourceChainId;
        uint256 destinationChainId;
        uint64 stateVersion;
    }

    error PayloadTooShort(uint256 length);
    error UnknownMessageType(uint8 value);
    error UnsupportedProtocolVersion(uint32 version);

    function encode(Header memory header) internal pure returns (bytes memory) {
        return abi.encodePacked(
            header.protocolVersion,
            uint8(header.messageType),
            header.deploymentId,
            header.settlementId,
            header.intentHash,
            header.sourceChainId,
            header.destinationChainId,
            header.stateVersion
        );
    }

    function decode(bytes memory payload) internal pure returns (Header memory header) {
        if (payload.length < HEADER_BYTES) revert PayloadTooShort(payload.length);

        uint32 protocolVersion;
        uint8 messageType;
        bytes32 deploymentId;
        bytes32 settlementId;
        bytes32 intentHash;
        uint256 sourceChainId;
        uint256 destinationChainId;
        uint64 stateVersion;

        // Offsets are absolute from the start of the data, which begins at
        // `payload + 32`. Reading fixed widths at fixed offsets is what makes a
        // malformed payload fail rather than shift.
        assembly ("memory-safe") {
            let data := add(payload, 32)
            protocolVersion := shr(224, mload(data))
            messageType := shr(248, mload(add(data, 4)))
            deploymentId := mload(add(data, 5))
            settlementId := mload(add(data, 37))
            intentHash := mload(add(data, 69))
            sourceChainId := mload(add(data, 101))
            destinationChainId := mload(add(data, 133))
            stateVersion := shr(192, mload(add(data, 165)))
        }

        if (protocolVersion != PROTOCOL_VERSION) {
            revert UnsupportedProtocolVersion(protocolVersion);
        }
        // An unrecognised type is never treated as a no-op: consuming it would
        // burn the VAA's replay slot without applying any effect.
        if (messageType > uint8(type(MessageType).max)) revert UnknownMessageType(messageType);

        header = Header({
            protocolVersion: protocolVersion,
            messageType: MessageType(messageType),
            deploymentId: deploymentId,
            settlementId: settlementId,
            intentHash: intentHash,
            sourceChainId: sourceChainId,
            destinationChainId: destinationChainId,
            stateVersion: stateVersion
        });
    }
}

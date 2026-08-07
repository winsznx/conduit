// SPDX-License-Identifier: Apache-2.0
pragma solidity =0.8.36;

/// @notice The subset of the Wormhole core contract Conduit uses.
///
/// PRD 8.3 restricts Conduit to core messaging: `publishMessage` and
/// `parseAndVerifyVM`. No token bridge, no relayer contract, no automatic
/// delivery. The cash and the asset never cross a chain; only authenticated
/// settlement state does.
///
/// `parseAndVerifyVM` is the load-bearing call. It checks guardian quorum
/// against the current guardian set and returns `valid` plus a reason. CLAUDE.md
/// is explicit that off-chain VAA parsing is never trusted on its own, so every
/// consumer calls this on-chain even when a worker has already parsed the same
/// bytes.
interface IWormhole {
    struct Signature {
        bytes32 r;
        bytes32 s;
        uint8 v;
        uint8 guardianIndex;
    }

    struct VM {
        uint8 version;
        uint32 timestamp;
        uint32 nonce;
        /// @dev Wormhole's own chain ID, not the native EVM chain ID.
        uint16 emitterChainId;
        /// @dev Left-padded to 32 bytes, so an EVM emitter occupies the low 20.
        bytes32 emitterAddress;
        uint64 sequence;
        uint8 consistencyLevel;
        bytes payload;
        uint32 guardianSetIndex;
        Signature[] signatures;
        /// @dev The double-keccak digest. Conduit's replay key.
        bytes32 hash;
    }

    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistencyLevel)
        external
        payable
        returns (uint64 sequence);

    function parseAndVerifyVM(bytes calldata encodedVM)
        external
        view
        returns (VM memory vm, bool valid, string memory reason);

    function messageFee() external view returns (uint256);

    function chainId() external view returns (uint16);
}

// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {IWormhole} from "../../src/interfaces/IWormhole.sol";

/// @notice A configurable stand-in for the Wormhole core contract.
///
/// It does not verify signatures. That is deliberate: these tests exercise
/// Conduit's checks *around* guardian verification, and a mock that faked
/// signature validation would test nothing while looking rigorous.
///
/// `setValid(false)` covers the case where the real core rejects, so the
/// contract's handling of an invalid VAA is still exercised.
contract MockWormhole is IWormhole {
    uint256 public fee;
    uint16 private _chainId;
    bool private _valid = true;
    string private _reason = "";

    uint64 public nextSequence;

    struct Published {
        uint32 nonce;
        bytes payload;
        uint8 consistencyLevel;
        uint256 value;
    }

    Published[] private _published;

    constructor(uint16 chainId_) {
        _chainId = chainId_;
    }

    function setFee(uint256 value) external {
        fee = value;
    }

    function setValid(bool value, string calldata reason_) external {
        _valid = value;
        _reason = reason_;
    }

    function publishedCount() external view returns (uint256) {
        return _published.length;
    }

    function publishedAt(uint256 index) external view returns (Published memory) {
        return _published[index];
    }

    function messageFee() external view override returns (uint256) {
        return fee;
    }

    function chainId() external view override returns (uint16) {
        return _chainId;
    }

    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistencyLevel)
        external
        payable
        override
        returns (uint64 sequence)
    {
        _published.push(
            Published({
                nonce: nonce, payload: payload, consistencyLevel: consistencyLevel, value: msg.value
            })
        );
        sequence = nextSequence;
        nextSequence += 1;
    }

    /// @dev The encoded VAA is an abi-encoded VM, so a test can construct any
    ///      emitter, payload, or hash without needing guardian keys.
    function parseAndVerifyVM(bytes calldata encodedVM)
        external
        view
        override
        returns (VM memory vm, bool valid, string memory reason)
    {
        vm = abi.decode(encodedVM, (VM));
        valid = _valid;
        reason = _reason;
    }

    /// @notice Builds an encoded VAA for a test.
    function encodeVaa(
        uint16 emitterChainId,
        bytes32 emitterAddress,
        uint64 sequence,
        bytes memory payload,
        bytes32 hash
    ) external pure returns (bytes memory) {
        VM memory vm = VM({
            version: 1,
            timestamp: 0,
            nonce: 0,
            emitterChainId: emitterChainId,
            emitterAddress: emitterAddress,
            sequence: sequence,
            consistencyLevel: 1,
            payload: payload,
            guardianSetIndex: 0,
            signatures: new Signature[](0),
            hash: hash
        });
        return abi.encode(vm);
    }
}

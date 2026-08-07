// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {IWormhole} from "./interfaces/IWormhole.sol";
import {MessageCodec} from "./libraries/MessageCodec.sol";

/// @notice Publishing and consuming authenticated cross-chain messages.
///
/// PRD 8.4 fixes the checks, and FR-009 fixes who may perform them: anyone. The
/// relayer is untrusted for correctness and permissionless by design, so this
/// contract's job is to make relaying safe rather than to restrict it. A relayer
/// can choose *when* a message lands and can decline to relay at all — that is
/// threat T-29, a liveness concern. It cannot forge one, which is invariant I12.
///
/// Every accepted VAA passes all six checks:
///
///   1. guardian quorum, via the core contract rather than an off-chain parse
///   2. emitter chain matches the expected Wormhole chain ID   (T-12)
///   3. emitter address matches the expected peer              (T-11)
///   4. deployment ID matches this deployment                  (T-13)
///   5. protocol version is supported
///   6. the VAA hash has not been consumed                     (T-10)
///
/// Consumption is recorded *before* any external call. A token callback that
/// re-enters finds the hash already spent.
abstract contract WormholeTransport {
    IWormhole public immutable wormhole;

    /// @notice Binds this deployment. PRD 8.2: every intent binds exact
    ///         addresses and a deployment ID, so a valid message from a
    ///         different deployment of the same code is rejected.
    bytes32 public immutable deploymentId;

    /// @notice This chain's Wormhole chain ID, not its EVM chain ID.
    uint16 public immutable localWormholeChainId;

    /// @notice The peer's Wormhole chain ID.
    uint16 public immutable remoteWormholeChainId;

    /// @notice The peer contract, left-padded to 32 bytes as Wormhole encodes it.
    bytes32 public immutable remoteEmitter;

    /// @dev PRD 8.4: "The VAA hash is marked consumed before external token calls."
    mapping(bytes32 vaaHash => bool) public consumedVaa;

    event MessagePublished(
        uint64 indexed sequence,
        MessageCodec.MessageType indexed messageType,
        bytes32 indexed settlementId
    );
    event VaaConsumed(bytes32 indexed vaaHash, bytes32 indexed settlementId);

    error VaaInvalid(string reason);
    error UnexpectedEmitterChain(uint16 actual, uint16 expected);
    error UnexpectedEmitter(bytes32 actual, bytes32 expected);
    error UnexpectedDeployment(bytes32 actual, bytes32 expected);
    error UnexpectedDestinationChain(uint256 actual, uint256 expected);
    error VaaAlreadyConsumed(bytes32 vaaHash);
    error UnexpectedMessageType(MessageCodec.MessageType actual, MessageCodec.MessageType expected);
    error InsufficientMessageFee(uint256 provided, uint256 required);

    constructor(
        address wormhole_,
        bytes32 deploymentId_,
        uint16 localWormholeChainId_,
        uint16 remoteWormholeChainId_,
        bytes32 remoteEmitter_
    ) {
        wormhole = IWormhole(wormhole_);
        deploymentId = deploymentId_;
        localWormholeChainId = localWormholeChainId_;
        remoteWormholeChainId = remoteWormholeChainId_;
        remoteEmitter = remoteEmitter_;
    }

    /// @dev Wormhole charges a message fee on some chains and zero on others.
    ///      Reading it per call rather than caching means a fee change does not
    ///      silently start reverting every publish.
    function _publish(MessageCodec.Header memory header, uint8 consistencyLevel)
        internal
        returns (uint64 sequence)
    {
        uint256 fee = wormhole.messageFee();
        if (msg.value < fee) revert InsufficientMessageFee(msg.value, fee);

        sequence =
            wormhole.publishMessage{value: fee}(0, MessageCodec.encode(header), consistencyLevel);
        emit MessagePublished(sequence, header.messageType, header.settlementId);
    }

    /// @notice Verifies a VAA and marks it consumed. Permissionless.
    ///
    /// Returns the decoded header rather than acting on it, so the caller
    /// applies effects only after every check has passed.
    function _consume(bytes calldata encodedVaa, MessageCodec.MessageType expectedType)
        internal
        returns (MessageCodec.Header memory header)
    {
        // 1. Guardian quorum. On-chain, never a trusted off-chain parse.
        (IWormhole.VM memory vm, bool valid, string memory reason) =
            wormhole.parseAndVerifyVM(encodedVaa);
        if (!valid) revert VaaInvalid(reason);

        // 2 and 3. The message came from the peer we expect, on the chain we
        // expect. Either alone is insufficient: an attacker who deploys the same
        // code on another chain satisfies the address check.
        if (vm.emitterChainId != remoteWormholeChainId) {
            revert UnexpectedEmitterChain(vm.emitterChainId, remoteWormholeChainId);
        }
        if (vm.emitterAddress != remoteEmitter) {
            revert UnexpectedEmitter(vm.emitterAddress, remoteEmitter);
        }

        // 6. Replay. Checked before effects, recorded before interactions.
        if (consumedVaa[vm.hash]) revert VaaAlreadyConsumed(vm.hash);

        // The codec rejects an unsupported protocol version and an unknown type.
        header = MessageCodec.decode(vm.payload);

        // 4. This deployment, not another deployment of the same code.
        if (header.deploymentId != deploymentId) {
            revert UnexpectedDeployment(header.deploymentId, deploymentId);
        }
        if (header.messageType != expectedType) {
            revert UnexpectedMessageType(header.messageType, expectedType);
        }
        if (header.destinationChainId != block.chainid) {
            revert UnexpectedDestinationChain(header.destinationChainId, block.chainid);
        }

        consumedVaa[vm.hash] = true;
        emit VaaConsumed(vm.hash, header.settlementId);
    }

    function _header(
        MessageCodec.MessageType messageType,
        bytes32 settlementId,
        bytes32 intentHash,
        uint256 destinationChainId,
        uint64 stateVersion
    ) internal view returns (MessageCodec.Header memory) {
        return MessageCodec.Header({
            protocolVersion: MessageCodec.PROTOCOL_VERSION,
            messageType: messageType,
            deploymentId: deploymentId,
            settlementId: settlementId,
            intentHash: intentHash,
            sourceChainId: block.chainid,
            destinationChainId: destinationChainId,
            stateVersion: stateVersion
        });
    }
}

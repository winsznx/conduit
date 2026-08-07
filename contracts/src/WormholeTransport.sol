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
    /// @notice How final a source chain's state was when guardians signed.
    ///
    /// Deliberately an enum rather than the raw `consistencyLevel`, because the
    /// wire encoding is not ordinal: 200 means instant, 201 means safe, and
    /// *anything else* means finalized. A naive `>=` on the raw byte would rank
    /// instant above finalized and admit exactly the message it was meant to
    /// reject.
    enum FinalityLevel {
        INSTANT,
        SAFE,
        FINALIZED
    }

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
    ///
    /// Not immutable, and that is a deliberate trade. The two sides of a
    /// cross-chain pair reference each other, so neither address exists when the
    /// first is deployed. The alternatives were worse: a placeholder corrected
    /// later leaves a window where the contract accepts messages from an address
    /// nobody chose, and CREATE2 address prediction makes the deployment depend
    /// on salt bookkeeping across two chains.
    ///
    /// Instead the peer is set exactly once and then locked forever. Immutable
    /// in effect from the moment it matters, settable only in the gap before any
    /// message can be consumed.
    bytes32 public remoteEmitter;

    /// @notice True once the peer is set. Never returns to false.
    bool public remotePeerLocked;

    /// @notice The minimum finality a message may carry when it authorizes an
    ///         irreversible economic outcome.
    ///
    /// Immutable and bound into the deployment. A COMMIT is economically
    /// irreversible, so every state it depends on must have reached this
    /// threshold first. Wormhole warns that non-finalized consistency on EVM
    /// carries reorg risk, and a reorg that unwinds a PREPARED after its COMMIT
    /// has released the opposite leg is the double-payout the whole protocol
    /// exists to prevent.
    ///
    /// It cannot be lowered per settlement, by an owner, or by a relayer. A
    /// downgradeable finality policy is not a policy.
    FinalityLevel public immutable settlementFinality;

    /// @notice The minimum for messages that inform rather than authorize.
    ///
    /// A fast VAA is genuinely useful: it warms a relayer, updates a UI, and
    /// lets downstream work start early. It simply may not move value.
    FinalityLevel public immutable observationFinality;

    /// @dev PRD 8.4: "The VAA hash is marked consumed before external token calls."
    mapping(bytes32 vaaHash => bool) public consumedVaa;

    event MessagePublished(
        uint64 indexed sequence,
        MessageCodec.MessageType indexed messageType,
        bytes32 indexed settlementId
    );
    event VaaConsumed(bytes32 indexed vaaHash, bytes32 indexed settlementId);
    event RemotePeerSet(bytes32 indexed emitter);

    error VaaInvalid(string reason);
    error UnexpectedEmitterChain(uint16 actual, uint16 expected);
    error UnexpectedEmitter(bytes32 actual, bytes32 expected);
    error UnexpectedDeployment(bytes32 actual, bytes32 expected);
    error UnexpectedDestinationChain(uint256 actual, uint256 expected);
    error VaaAlreadyConsumed(bytes32 vaaHash);
    error UnexpectedMessageType(MessageCodec.MessageType actual, MessageCodec.MessageType expected);
    error InsufficientMessageFee(uint256 provided, uint256 required);
    error RemotePeerAlreadyLocked();
    error RemotePeerNotSet();
    error RemotePeerCannotBeZero();
    error InsufficientFinality(
        MessageCodec.MessageType messageType, FinalityLevel actual, FinalityLevel required
    );

    constructor(
        address wormhole_,
        bytes32 deploymentId_,
        uint16 localWormholeChainId_,
        uint16 remoteWormholeChainId_,
        bytes32 remoteEmitter_,
        FinalityLevel settlementFinality_,
        FinalityLevel observationFinality_
    ) {
        settlementFinality = settlementFinality_;
        observationFinality = observationFinality_;

        wormhole = IWormhole(wormhole_);
        deploymentId = deploymentId_;
        localWormholeChainId = localWormholeChainId_;
        remoteWormholeChainId = remoteWormholeChainId_;

        // The second side of the pair knows its peer at construction; the first
        // does not and passes zero.
        if (remoteEmitter_ != bytes32(0)) {
            remoteEmitter = remoteEmitter_;
            remotePeerLocked = true;
            emit RemotePeerSet(remoteEmitter_);
        }
    }

    /// @notice Maps a raw Wormhole consistency level onto its finality class.
    ///
    /// Wormhole's EVM encoding: 200 instant, 201 safe, everything else
    /// finalized. Treating the byte as a magnitude is the trap this exists to
    /// close.
    function finalityOf(uint8 consistencyLevel) public pure returns (FinalityLevel) {
        if (consistencyLevel == 200) return FinalityLevel.INSTANT;
        if (consistencyLevel == 201) return FinalityLevel.SAFE;
        return FinalityLevel.FINALIZED;
    }

    /// @notice Whether a message class can make an outcome economically irreversible.
    ///
    /// A remote PREPARED is included because it authorizes COMMIT, and COMMIT is
    /// the point of no return. A RELEASED or HELD proof is included because the
    /// coordinator marks the settlement terminal on it.
    function authorizesValue(MessageCodec.MessageType messageType) public pure returns (bool) {
        return messageType == MessageCodec.MessageType.COMMIT
            || messageType == MessageCodec.MessageType.ABORT
            || messageType == MessageCodec.MessageType.CASH_PREPARED
            || messageType == MessageCodec.MessageType.ASSET_PREPARED
            || messageType == MessageCodec.MessageType.CASH_RELEASED
            || messageType == MessageCodec.MessageType.ASSET_RELEASED
            || messageType == MessageCodec.MessageType.CASH_HELD
            || messageType == MessageCodec.MessageType.ASSET_HELD
            || messageType == MessageCodec.MessageType.DISPOSITION_RESOLVED;
    }

    function requiredFinalityFor(MessageCodec.MessageType messageType)
        public
        view
        returns (FinalityLevel)
    {
        return authorizesValue(messageType) ? settlementFinality : observationFinality;
    }

    /// @dev Concrete contracts wrap this with their own owner check. Callable
    ///      once; every later attempt reverts, including by the owner.
    function _setRemotePeer(bytes32 emitter) internal {
        if (remotePeerLocked) revert RemotePeerAlreadyLocked();
        if (emitter == bytes32(0)) revert RemotePeerCannotBeZero();

        remoteEmitter = emitter;
        remotePeerLocked = true;
        emit RemotePeerSet(emitter);
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
        // 0. No message is consumable before the peer is fixed. Without this,
        //    an unlocked contract would compare against bytes32(0) and the
        //    emitter check would be vacuous.
        if (!remotePeerLocked) revert RemotePeerNotSet();

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

        // 7. Authentic is not the same as final. `parseAndVerifyVM` proves the
        //    guardians signed it; it says nothing about whether the source state
        //    can still be reorganised out from under us. A relayer chooses which
        //    VAA to submit, so without this a fast VAA could be substituted for
        //    a finalized one and the settlement made irreversible on state that
        //    is not.
        FinalityLevel actual = finalityOf(vm.consistencyLevel);
        FinalityLevel required = requiredFinalityFor(header.messageType);
        if (uint8(actual) < uint8(required)) {
            revert InsufficientFinality(header.messageType, actual, required);
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

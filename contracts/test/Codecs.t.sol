// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {MessageCodec} from "../src/libraries/MessageCodec.sol";
import {SettlementIntentLib} from "../src/libraries/SettlementIntentLib.sol";

/// @notice Cross-language agreement between the contracts and the reference model.
///
/// The phase 04 gate is that the reference model and the contracts produce
/// identical outcomes. Hashing is where a divergence is both most likely and
/// least visible: an EIP-712 field reordered on one side still produces a
/// perfectly valid-looking digest, and the failure only appears when a signature
/// the SDK produced is rejected on chain — or, worse, when one is accepted for
/// terms the signer never saw.
///
/// Every literal below is produced by `packages/domain`, and
/// `packages/domain/src/codec-vectors.test.ts` asserts the same values from the
/// TypeScript side. Neither file derives its expectations from the other, so a
/// change to either implementation fails both.
contract CodecsTest is Test {
    function _intent() private pure returns (SettlementIntentLib.SettlementIntent memory) {
        return SettlementIntentLib.SettlementIntent({
            version: 1,
            cashChainId: 10_143,
            cashEscrow: 0x1111111111111111111111111111111111111111,
            cashAsset: 0x2222222222222222222222222222222222222222,
            cashAmount: 1_000_000,
            cashPayer: 0x3333333333333333333333333333333333333333,
            cashReceiver: 0x4444444444444444444444444444444444444444,
            assetChainId: 421_614,
            assetEscrow: 0x5555555555555555555555555555555555555555,
            assetToken: 0x6666666666666666666666666666666666666666,
            assetAmount: 50,
            assetSeller: 0x7777777777777777777777777777777777777777,
            assetReceiver: 0x8888888888888888888888888888888888888888,
            cashPolicyHash: keccak256("cash-policy"),
            assetPolicyHash: keccak256("asset-policy"),
            prepareDeadline: 1_786_060_800,
            commitDeadline: 1_786_064_400,
            releaseDeadline: 1_786_068_000,
            nonce: 42
        });
    }

    function _separator() private pure returns (bytes32) {
        return SettlementIntentLib.domainSeparator(
            "Conduit", "1", 10_143, 0x9999999999999999999999999999999999999999
        );
    }

    // ── EIP-712 intent hashing ───────────────────────────────────────────────

    function test_PolicyHashesMatchTheReferenceModel() public pure {
        assertEq(
            keccak256("cash-policy"),
            0x7cfb3db32fe34e8af6e239b3715720d93be7465d546eaad49a41f39a8a4710c5
        );
        assertEq(
            keccak256("asset-policy"),
            0x44a7e3926ca90a694b32eff79cef7a47de7b09ce15c8413fd0c01da5c6839e9d
        );
    }

    function test_SettlementIdMatchesTheReferenceModel() public pure {
        // Produced by packages/domain/src/intent.ts. A reordered EIP-712 field,
        // a changed type string, or a different domain would move this.
        assertEq(
            SettlementIntentLib.digest(_intent(), _separator()),
            0x114267ac4c241429904aea6ea0b5d6d44b569c35aefac85c07adccb9294ccc51
        );
    }

    function test_SettlementIdChangesWithEveryEconomicTerm() public pure {
        bytes32 baseline = SettlementIntentLib.digest(_intent(), _separator());

        SettlementIntentLib.SettlementIntent memory changed = _intent();
        changed.cashAmount += 1;
        assertTrue(SettlementIntentLib.digest(changed, _separator()) != baseline);

        changed = _intent();
        changed.assetReceiver = address(0xdead);
        assertTrue(SettlementIntentLib.digest(changed, _separator()) != baseline);

        changed = _intent();
        changed.nonce += 1;
        assertTrue(SettlementIntentLib.digest(changed, _separator()) != baseline);
    }

    function test_SettlementIdIsBoundToTheDeployment() public pure {
        // PRD FR-003: a signature from one chain cannot authorize a different
        // chain or deployment. Both live in the domain separator.
        bytes32 onMonad = SettlementIntentLib.digest(_intent(), _separator());

        bytes32 otherChain = SettlementIntentLib.digest(
            _intent(),
            SettlementIntentLib.domainSeparator(
                "Conduit", "1", 421_614, 0x9999999999999999999999999999999999999999
            )
        );
        bytes32 otherContract = SettlementIntentLib.digest(
            _intent(), SettlementIntentLib.domainSeparator("Conduit", "1", 10_143, address(0xbeef))
        );

        assertTrue(onMonad != otherChain, "chain must be bound");
        assertTrue(onMonad != otherContract, "verifying contract must be bound");
    }

    // ── Message header codec ─────────────────────────────────────────────────

    function _header() private pure returns (MessageCodec.Header memory) {
        bytes32 id = 0x114267ac4c241429904aea6ea0b5d6d44b569c35aefac85c07adccb9294ccc51;
        return MessageCodec.Header({
            protocolVersion: MessageCodec.PROTOCOL_VERSION,
            messageType: MessageCodec.MessageType.COMMIT,
            deploymentId: 0x6c335c492f1a8d4e0ec69a3da1427251ac22a5359580966028fa5812d655d103,
            settlementId: id,
            intentHash: id,
            sourceChainId: 10_143,
            destinationChainId: 421_614,
            stateVersion: 7
        });
    }

    function test_EncodedHeaderMatchesTheReferenceModel() public pure {
        bytes memory encoded = MessageCodec.encode(_header());

        assertEq(encoded.length, MessageCodec.HEADER_BYTES, "fixed 173-byte header");
        assertEq(
            keccak256(encoded), 0xea3fb23e7193f33f676888d0f4c5abc10827b4aac259f177fb486b00e8b3d028
        );
    }

    function test_HeaderRoundTrips() public pure {
        MessageCodec.Header memory original = _header();
        MessageCodec.Header memory decoded = MessageCodec.decode(MessageCodec.encode(original));

        assertEq(decoded.protocolVersion, original.protocolVersion);
        assertEq(uint8(decoded.messageType), uint8(original.messageType));
        assertEq(decoded.deploymentId, original.deploymentId);
        assertEq(decoded.settlementId, original.settlementId);
        assertEq(decoded.intentHash, original.intentHash);
        assertEq(decoded.sourceChainId, original.sourceChainId);
        assertEq(decoded.destinationChainId, original.destinationChainId);
        assertEq(decoded.stateVersion, original.stateVersion);
    }

    function test_RejectsTruncatedPayload() public {
        bytes memory encoded = MessageCodec.encode(_header());
        bytes memory truncated = new bytes(encoded.length - 1);
        for (uint256 i = 0; i < truncated.length; i++) {
            truncated[i] = encoded[i];
        }

        vm.expectRevert(
            abi.encodeWithSelector(MessageCodec.PayloadTooShort.selector, truncated.length)
        );
        this.decodeExternal(truncated);
    }

    function test_RejectsUnknownMessageType() public {
        bytes memory encoded = MessageCodec.encode(_header());
        encoded[4] = bytes1(uint8(99));

        vm.expectRevert(abi.encodeWithSelector(MessageCodec.UnknownMessageType.selector, 99));
        this.decodeExternal(encoded);
    }

    function test_RejectsUnsupportedProtocolVersion() public {
        MessageCodec.Header memory header = _header();
        header.protocolVersion = 2;

        vm.expectRevert(abi.encodeWithSelector(MessageCodec.UnsupportedProtocolVersion.selector, 2));
        this.decodeExternal(MessageCodec.encode(header));
    }

    function test_ToleratesTrailingPayloadBeyondTheHeader() public pure {
        // Later phases append message-specific bodies. The header must decode
        // from the front without caring what follows it.
        bytes memory withBody = bytes.concat(MessageCodec.encode(_header()), hex"deadbeef");
        MessageCodec.Header memory decoded = MessageCodec.decode(withBody);

        assertEq(uint8(decoded.messageType), uint8(MessageCodec.MessageType.COMMIT));
        assertEq(decoded.stateVersion, 7);
    }

    function decodeExternal(bytes memory payload)
        external
        pure
        returns (MessageCodec.Header memory)
    {
        return MessageCodec.decode(payload);
    }

    function testFuzz_HeaderRoundTripsForAnyValues(
        uint8 messageType,
        bytes32 deploymentId,
        bytes32 settlementId,
        bytes32 intentHash,
        uint256 sourceChainId,
        uint256 destinationChainId,
        uint64 stateVersion
    ) public pure {
        uint8 bounded = uint8(bound(messageType, 0, uint8(type(MessageCodec.MessageType).max)));

        MessageCodec.Header memory header = MessageCodec.Header({
            protocolVersion: MessageCodec.PROTOCOL_VERSION,
            messageType: MessageCodec.MessageType(bounded),
            deploymentId: deploymentId,
            settlementId: settlementId,
            intentHash: intentHash,
            sourceChainId: sourceChainId,
            destinationChainId: destinationChainId,
            stateVersion: stateVersion
        });

        MessageCodec.Header memory decoded = MessageCodec.decode(MessageCodec.encode(header));

        assertEq(decoded.deploymentId, deploymentId);
        assertEq(decoded.settlementId, settlementId);
        assertEq(decoded.intentHash, intentHash);
        assertEq(decoded.sourceChainId, sourceChainId);
        assertEq(decoded.destinationChainId, destinationChainId);
        assertEq(decoded.stateVersion, stateVersion);
        assertEq(uint8(decoded.messageType), bounded);
    }
}

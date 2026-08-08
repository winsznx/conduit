// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {ComplianceAuthority} from "../src/ComplianceAuthority.sol";
import {SettlementCoordinator} from "../src/SettlementCoordinator.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {ComplianceAttestationLib} from "../src/libraries/ComplianceAttestationLib.sol";
import {MessageCodec} from "../src/libraries/MessageCodec.sol";
import {ComplianceFixture} from "./helpers/ComplianceFixture.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";
import {MockAToken} from "./mocks/TestTokens.sol";

/// @notice Finality enforcement. An authentic VAA is not a sufficiently final one.
///
/// `parseAndVerifyVM` proves the guardians signed a message. It says nothing
/// about whether the source state can still be reorganised away. Wormhole warns
/// that non-finalized consistency on EVM carries reorg risk, and the danger is
/// specific here: a COMMIT is economically irreversible, so a reorg that unwinds
/// the PREPARED it rested on leaves one leg released and the other never funded.
/// That is the double-payout the protocol exists to close.
///
/// A relayer chooses which VAA to submit. Without enforcement it could publish
/// at instant, wait for guardians to sign, and hand the fast VAA to a contract
/// expecting a final one — with `valid == true` throughout.
///
/// Base Sepolia makes this concrete rather than theoretical: instant VAAs
/// arrived in 2.6 seconds during the phase 02 seam test, while the documented
/// finalized path is roughly eighteen minutes. Those are not two speeds of the
/// same guarantee.
///
/// Exercised through the coordinator's `recordAssetPrepared`, which is where a
/// cross-chain message now enters the settlement path. These tests used to drive
/// `CashEscrow.releaseCash`, and that turned out to be a release that consumed a
/// VAA nothing in the system emits — the escrow reads the coordinator directly
/// now. The finality check itself is unchanged: one `_consume` in
/// `WormholeTransport`, shared by every contract that takes a message.
contract FinalityTest is ComplianceFixture {
    MockWormhole private wormhole;
    MockAToken private aToken;

    address private constant OWNER = address(0x0E7E4);
    address private constant PAYER = address(0x9A4E4);
    address private constant RECEIVER = address(0x4EC1E5);
    address private constant RELAYER = address(0x4E1A4);

    uint16 private constant LOCAL_WH_CHAIN = 10_009;
    uint16 private constant REMOTE_WH_CHAIN = 10_004;
    bytes32 private constant DEPLOYMENT_ID = keccak256("deployment-1");
    bytes32 private constant REMOTE_EMITTER = bytes32(uint256(uint160(address(0xC0FFEE))));
    bytes32 private constant SETTLEMENT_ID = keccak256("settlement-1");
    bytes32 private constant INTENT_HASH = keccak256("intent-1");

    uint256 private constant AMOUNT = 1000e6;

    // Wormhole's EVM encoding. Note it is not ordinal.
    uint8 private constant INSTANT = 200;
    uint8 private constant SAFE = 201;
    uint8 private constant FINALIZED = 1;

    function setUp() public {
        wormhole = new MockWormhole(LOCAL_WH_CHAIN);
        aToken = new MockAToken(6);
        aToken.mint(PAYER, AMOUNT * 10);
    }

    function _escrow(
        WormholeTransport.FinalityLevel settlement,
        WormholeTransport.FinalityLevel observation
    ) private returns (SettlementCoordinator) {
        SettlementCoordinator coordinator = new SettlementCoordinator(
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            settlement,
            observation,
            15 minutes,
            OWNER,
            "Conduit",
            "1"
        );

        vm.startPrank(OWNER);
        coordinator.addComplianceSigner(_signerA());
        coordinator.setComplianceQuorum(1);
        vm.stopPrank();

        return coordinator;
    }

    function _vaa(uint8 consistencyLevel, string memory seed) private view returns (bytes memory) {
        bytes memory payload = MessageCodec.encode(
            MessageCodec.Header({
                protocolVersion: MessageCodec.PROTOCOL_VERSION,
                messageType: MessageCodec.MessageType.ASSET_PREPARED,
                deploymentId: DEPLOYMENT_ID,
                settlementId: SETTLEMENT_ID,
                intentHash: INTENT_HASH,
                sourceChainId: 84_532,
                destinationChainId: block.chainid,
                stateVersion: 2
            })
        );

        IWormhole.VM memory vaa = IWormhole.VM({
            version: 1,
            timestamp: 0,
            nonce: 0,
            emitterChainId: REMOTE_WH_CHAIN,
            emitterAddress: REMOTE_EMITTER,
            sequence: 1,
            consistencyLevel: consistencyLevel,
            payload: payload,
            guardianSetIndex: 0,
            signatures: new IWormhole.Signature[](0),
            hash: keccak256(bytes(seed))
        });
        return abi.encode(vaa);
    }

    // ── The encoding is not a magnitude ──────────────────────────────────────

    function test_ConsistencyLevelIsClassifiedNotCompared() public {
        // 200 is instant and 1 is finalized. Any `>=` on the raw byte ranks the
        // weakest guarantee above the strongest and admits exactly the message
        // it was meant to reject.
        SettlementCoordinator escrow = _escrow(
            WormholeTransport.FinalityLevel.FINALIZED, WormholeTransport.FinalityLevel.INSTANT
        );

        assertEq(uint8(escrow.finalityOf(INSTANT)), uint8(WormholeTransport.FinalityLevel.INSTANT));
        assertEq(uint8(escrow.finalityOf(SAFE)), uint8(WormholeTransport.FinalityLevel.SAFE));
        assertEq(
            uint8(escrow.finalityOf(FINALIZED)), uint8(WormholeTransport.FinalityLevel.FINALIZED)
        );

        // Everything outside the two magic values is finalized, including the
        // block-count form.
        assertEq(uint8(escrow.finalityOf(15)), uint8(WormholeTransport.FinalityLevel.FINALIZED));
        assertEq(uint8(escrow.finalityOf(0)), uint8(WormholeTransport.FinalityLevel.FINALIZED));
    }

    // ── Instant and safe cannot authorize value ──────────────────────────────

    function test_InstantVaaCannotAuthorizeReleaseUnderProductionProfile() public {
        SettlementCoordinator escrow = _escrow(
            WormholeTransport.FinalityLevel.FINALIZED, WormholeTransport.FinalityLevel.INSTANT
        );

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.InsufficientFinality.selector,
                MessageCodec.MessageType.ASSET_PREPARED,
                WormholeTransport.FinalityLevel.INSTANT,
                WormholeTransport.FinalityLevel.FINALIZED
            )
        );
        escrow.recordAssetPrepared(_vaa(INSTANT, "instant"));

        assertEq(aToken.balanceOf(RECEIVER), 0, "no value moved on a fast VAA");
    }

    function test_SafeVaaCannotAuthorizeReleaseWhenPolicyRequiresFinalized() public {
        SettlementCoordinator escrow = _escrow(
            WormholeTransport.FinalityLevel.FINALIZED, WormholeTransport.FinalityLevel.INSTANT
        );

        vm.prank(RELAYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                WormholeTransport.InsufficientFinality.selector,
                MessageCodec.MessageType.ASSET_PREPARED,
                WormholeTransport.FinalityLevel.SAFE,
                WormholeTransport.FinalityLevel.FINALIZED
            )
        );
        escrow.recordAssetPrepared(_vaa(SAFE, "safe"));
    }

    function test_FinalizedVaaIsAccepted() public {
        SettlementCoordinator escrow = _escrow(
            WormholeTransport.FinalityLevel.FINALIZED, WormholeTransport.FinalityLevel.INSTANT
        );

        vm.prank(RELAYER);
        escrow.recordAssetPrepared(_vaa(FINALIZED, "finalized"));
        assertEq(
            uint8(escrow.settlementOf(SETTLEMENT_ID).state),
            uint8(SettlementCoordinator.SettlementState.ASSET_PREPARED),
            "a sufficiently final message is accepted"
        );
    }

    // ── A relayer cannot substitute a weaker VAA ─────────────────────────────

    function test_RelayerCannotSubstituteALowerConsistencyVaa() public {
        // The attack: publish at instant, wait for guardians, then hand the fast
        // VAA to a contract expecting a final one. `valid` is true throughout,
        // which is exactly why authenticity is not the check that matters here.
        SettlementCoordinator escrow = _escrow(
            WormholeTransport.FinalityLevel.FINALIZED, WormholeTransport.FinalityLevel.INSTANT
        );

        bytes memory fast = _vaa(INSTANT, "substituted");

        // The core contract is perfectly happy with it.
        (, bool valid,) = wormhole.parseAndVerifyVM(fast);
        assertTrue(valid, "the VAA is authentic");

        vm.prank(RELAYER);
        vm.expectRevert();
        escrow.recordAssetPrepared(fast);

        // And the fast VAA is not consumed, so the settlement is not stranded:
        // the same message re-published at finality still works.
        assertFalse(escrow.consumedVaa(keccak256("substituted")));

        vm.prank(RELAYER);
        escrow.recordAssetPrepared(_vaa(FINALIZED, "proper"));
        assertEq(
            uint8(escrow.settlementOf(SETTLEMENT_ID).state),
            uint8(SettlementCoordinator.SettlementState.ASSET_PREPARED),
            "a sufficiently final message is accepted"
        );
    }

    // ── The policy is immutable and deployment-bound ─────────────────────────

    function test_FinalityPolicyCannotBeChangedAfterDeployment() public {
        SettlementCoordinator escrow = _escrow(
            WormholeTransport.FinalityLevel.FINALIZED, WormholeTransport.FinalityLevel.INSTANT
        );

        // There is no setter. The values are immutable, so an owner, a relayer,
        // and a per-settlement caller are all equally unable to lower them.
        assertEq(
            uint8(escrow.settlementFinality()), uint8(WormholeTransport.FinalityLevel.FINALIZED)
        );

        bytes4 setterSelector = bytes4(keccak256("setSettlementFinality(uint8)"));
        (bool ok,) = address(escrow).call(abi.encodeWithSelector(setterSelector, uint8(0)));
        assertFalse(ok, "no downgrade path may exist");
    }

    function test_FinalityIsBoundIntoTheDeployedBytecode() public {
        // Two deployments differing only in finality profile must not be
        // interchangeable. Binding it as an immutable puts it in the bytecode,
        // so the deployment manifest's codeHash covers it and a verifier can see
        // which profile is live.
        SettlementCoordinator strict = _escrow(
            WormholeTransport.FinalityLevel.FINALIZED, WormholeTransport.FinalityLevel.INSTANT
        );
        SettlementCoordinator loose = _escrow(
            WormholeTransport.FinalityLevel.INSTANT, WormholeTransport.FinalityLevel.INSTANT
        );

        assertTrue(
            address(strict).codehash != address(loose).codehash,
            "the finality profile must be visible in the code hash"
        );
    }

    // ── Message classification ───────────────────────────────────────────────

    function test_EveryValueBearingMessageRequiresSettlementFinality() public {
        SettlementCoordinator escrow = _escrow(
            WormholeTransport.FinalityLevel.FINALIZED, WormholeTransport.FinalityLevel.INSTANT
        );

        MessageCodec.MessageType[9] memory economic = [
            MessageCodec.MessageType.CASH_PREPARED,
            MessageCodec.MessageType.ASSET_PREPARED,
            MessageCodec.MessageType.ASSET_PREPARED,
            MessageCodec.MessageType.ABORT,
            MessageCodec.MessageType.CASH_RELEASED,
            MessageCodec.MessageType.ASSET_RELEASED,
            MessageCodec.MessageType.CASH_HELD,
            MessageCodec.MessageType.ASSET_HELD,
            MessageCodec.MessageType.DISPOSITION_RESOLVED
        ];

        // Every message class Conduit defines moves or freezes value, so every
        // one requires settlement finality. If a purely informational class is
        // added later, this test is where the exemption has to be argued.
        for (uint256 i = 0; i < economic.length; i++) {
            assertTrue(escrow.authorizesValue(economic[i]));
            assertEq(
                uint8(escrow.requiredFinalityFor(economic[i])),
                uint8(WormholeTransport.FinalityLevel.FINALIZED)
            );
        }
    }

    // ── A permissive profile is possible, and visibly so ─────────────────────

    function test_ARelaxedProfileIsExplicitRatherThanAccidental() public {
        // A staging deployment may accept instant, and nothing hides that: the
        // profile is a constructor argument, an immutable, and a manifest field.
        SettlementCoordinator relaxed = _escrow(
            WormholeTransport.FinalityLevel.INSTANT, WormholeTransport.FinalityLevel.INSTANT
        );

        vm.prank(RELAYER);
        relaxed.recordAssetPrepared(_vaa(INSTANT, "relaxed"));
        assertEq(
            uint8(relaxed.settlementOf(SETTLEMENT_ID).state),
            uint8(SettlementCoordinator.SettlementState.ASSET_PREPARED),
            "a relaxed profile accepts instant, visibly and on purpose"
        );
    }

    function testFuzz_NoConsistencyLevelBypassesTheRequirement(uint8 consistencyLevel) public {
        SettlementCoordinator escrow = _escrow(
            WormholeTransport.FinalityLevel.FINALIZED, WormholeTransport.FinalityLevel.INSTANT
        );

        bool shouldSucceed = consistencyLevel != INSTANT && consistencyLevel != SAFE;

        vm.prank(RELAYER);
        if (shouldSucceed) {
            escrow.recordAssetPrepared(_vaa(consistencyLevel, "fuzz"));
            assertEq(
                uint8(escrow.settlementOf(SETTLEMENT_ID).state),
                uint8(SettlementCoordinator.SettlementState.ASSET_PREPARED),
                "a sufficiently final message is accepted"
            );
        } else {
            vm.expectRevert();
            escrow.recordAssetPrepared(_vaa(consistencyLevel, "fuzz"));
            assertEq(aToken.balanceOf(RECEIVER), 0);
        }
    }
}

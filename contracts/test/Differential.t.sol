// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

import {ComplianceAuthority} from "../src/ComplianceAuthority.sol";
import {SettlementCoordinator} from "../src/SettlementCoordinator.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";
import {IWormhole} from "../src/interfaces/IWormhole.sol";
import {ComplianceAttestationLib} from "../src/libraries/ComplianceAttestationLib.sol";
import {MessageCodec} from "../src/libraries/MessageCodec.sol";
import {SettlementIntentLib} from "../src/libraries/SettlementIntentLib.sol";
import {ComplianceFixture} from "./helpers/ComplianceFixture.sol";
import {MockWormhole} from "./mocks/MockWormhole.sol";

/// @notice The phase 04 gate: the reference model and the contracts must produce
///         identical outcomes for generated traces.
///
/// Matching hashes were never enough for this. Two implementations can agree on
/// every digest and still disagree about which *sequences* of events are legal,
/// and that disagreement is what strands a settlement or double-pays a party.
///
/// `scripts/generate-settlement-traces.mjs` walks pseudo-random command
/// sequences through `packages/domain` and records where the model landed. This
/// replays the same sequences through a real coordinator and asserts it agrees.
///
/// Two things make the corpus worth trusting. It records refusals as well as
/// acceptances, so a contract that *accepts* what the model rejects is caught —
/// which is the dangerous direction and is invisible if only the happy steps are
/// replayed. And the generator fails if fewer than four distinct terminal states
/// are reached, so a corpus that has quietly stopped exercising anything cannot
/// pass by being narrow.
contract DifferentialTest is ComplianceFixture {
    SettlementCoordinator private coordinator;
    MockWormhole private wormhole;

    uint256 private constant BUYER_KEY = 0xB0FFEE;
    uint256 private constant SELLER_KEY = 0x5E11E4;
    address private buyer;
    address private seller;

    uint16 private constant LOCAL_WH_CHAIN = 10_009;
    uint16 private constant REMOTE_WH_CHAIN = 10_003;
    bytes32 private constant DEPLOYMENT_ID = keccak256("deployment-1");
    bytes32 private constant REMOTE_EMITTER = bytes32(uint256(uint160(address(0xC0FFEE))));
    uint256 private constant ASSET_CHAIN = 421_614;

    // Codes are fixed by the generator and must match it exactly.
    uint256 private constant PREPARE_CASH = 0;
    uint256 private constant PREPARE_ASSET = 1;
    uint256 private constant ISSUE_COMMIT = 2;
    uint256 private constant ISSUE_ABORT = 3;
    uint256 private constant RELEASE_CASH = 4;
    uint256 private constant HOLD_CASH = 5;
    uint256 private constant RELEASE_ASSET = 6;
    uint256 private constant HOLD_ASSET = 7;
    uint256 private constant RETURN_CASH = 8;
    uint256 private constant RETURN_ASSET = 9;

    string private fixture;
    uint256 private traceCount;

    uint64 private constant MAX_ATTESTATION_VALIDITY = 15 minutes;

    function setUp() public {
        buyer = vm.addr(BUYER_KEY);
        seller = vm.addr(SELLER_KEY);

        wormhole = new MockWormhole(LOCAL_WH_CHAIN);
        coordinator = new SettlementCoordinator(
            address(wormhole),
            DEPLOYMENT_ID,
            LOCAL_WH_CHAIN,
            REMOTE_WH_CHAIN,
            REMOTE_EMITTER,
            WormholeTransport.FinalityLevel.FINALIZED,
            WormholeTransport.FinalityLevel.INSTANT,
            MAX_ATTESTATION_VALIDITY,
            address(0x0E7E4),
            "Conduit",
            "1"
        );

        vm.startPrank(address(0x0E7E4));
        coordinator.addComplianceSigner(_signerA());
        coordinator.addComplianceSigner(_signerB());
        coordinator.setComplianceQuorum(2);
        vm.stopPrank();

        fixture = vm.readFile("contracts/test/fixtures/settlement-traces.json");
        traceCount = vm.parseJsonUint(fixture, "$.count");
    }

    /// @dev A distinct intent per trace, so each has its own settlement ID and
    ///      the traces cannot contaminate one another through shared state.
    function _intent(uint256 nonce)
        private
        view
        returns (SettlementIntentLib.SettlementIntent memory)
    {
        return SettlementIntentLib.SettlementIntent({
            version: 1,
            cashChainId: block.chainid,
            cashEscrow: address(0x1111),
            cashAsset: address(0x2222),
            cashAmount: 1000e6,
            cashPayer: buyer,
            cashReceiver: address(0x4444),
            assetChainId: ASSET_CHAIN,
            assetEscrow: address(0x5555),
            assetToken: address(0x6666),
            assetAmount: 50,
            assetSeller: seller,
            assetReceiver: address(0x8888),
            cashPolicyHash: keccak256("cash-policy"),
            assetPolicyHash: keccak256("asset-policy"),
            prepareDeadline: uint64(block.timestamp + 1 hours),
            commitDeadline: uint64(block.timestamp + 2 hours),
            releaseDeadline: uint64(block.timestamp + 3 hours),
            nonce: nonce
        });
    }

    function _sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _vaa(MessageCodec.MessageType messageType, bytes32 settlementId, bytes32 uniqueHash)
        private
        view
        returns (bytes memory)
    {
        bytes memory payload = MessageCodec.encode(
            MessageCodec.Header({
                protocolVersion: MessageCodec.PROTOCOL_VERSION,
                messageType: messageType,
                deploymentId: DEPLOYMENT_ID,
                settlementId: settlementId,
                intentHash: settlementId,
                sourceChainId: ASSET_CHAIN,
                destinationChainId: block.chainid,
                stateVersion: 1
            })
        );

        IWormhole.VM memory vaa = IWormhole.VM({
            version: 1,
            timestamp: 0,
            nonce: 0,
            emitterChainId: REMOTE_WH_CHAIN,
            emitterAddress: REMOTE_EMITTER,
            sequence: 1,
            consistencyLevel: 1,
            payload: payload,
            guardianSetIndex: 0,
            signatures: new IWormhole.Signature[](0),
            hash: uniqueHash
        });
        return abi.encode(vaa);
    }

    /// @dev Applies one command. Returns whether the coordinator accepted it, so
    ///      the caller can compare against the model's own verdict.
    function _step(uint256 code, uint256 nonce, bytes32 settlementId, bytes32 unique)
        private
        returns (bool accepted)
    {
        SettlementIntentLib.SettlementIntent memory intent = _intent(nonce);

        if (code == PREPARE_CASH) {
            try coordinator.recordCashPrepared(settlementId, settlementId) {
                return true;
            } catch {
                return false;
            }
        }
        if (code == PREPARE_ASSET) {
            try coordinator.recordAssetPrepared(
                _vaa(MessageCodec.MessageType.ASSET_PREPARED, settlementId, unique)
            ) {
                return true;
            } catch {
                return false;
            }
        }
        if (code == ISSUE_COMMIT) {
            // The corpus explores state-machine orderings, not compliance, so
            // every trace supplies a fully eligible quorum. Compliance refusal
            // has its own tests; mixing the two would leave a failing trace
            // ambiguous between the two subsystems.
            (
                ComplianceAttestationLib.ComplianceAttestation[] memory attestations,
                bytes[] memory attestationSignatures
            ) = _attestAll(
                coordinator.attestationDomainSeparator(),
                _keys(SIGNER_A_KEY, SIGNER_B_KEY),
                settlementId,
                settlementId,
                _subjects(intent.cashPayer, intent.cashReceiver),
                true
            );

            try coordinator.issueCommit(
                intent,
                settlementId,
                _sign(BUYER_KEY, settlementId),
                _sign(SELLER_KEY, settlementId),
                ComplianceAuthority.ComplianceProof(attestations, attestationSignatures),
                1
            ) {
                return true;
            } catch {
                return false;
            }
        }
        if (code == ISSUE_ABORT) {
            // The corpus explores orderings, so aborts use the deadline ground with
            // the clock warped past it — a ground the chain proves rather than one
            // the trace asserts.
            (
                ComplianceAttestationLib.ComplianceAttestation[] memory refusals,
                bytes[] memory refusalSignatures
            ) = _attestAll(
                coordinator.attestationDomainSeparator(),
                _keys(SIGNER_A_KEY, SIGNER_B_KEY),
                settlementId,
                settlementId,
                _subjects(intent.cashPayer),
                false
            );

            try coordinator.issueAbort(
                intent,
                settlementId,
                SettlementCoordinator.AbortGround.COMPLIANCE,
                SettlementCoordinator.Cancellation(
                    ComplianceAuthority.ComplianceProof(refusals, refusalSignatures), "", ""
                ),
                1
            ) {
                return true;
            } catch {
                return false;
            }
        }
        if (code == RELEASE_CASH || code == HOLD_CASH || code == RETURN_CASH) {
            SettlementCoordinator.LegOutcome outcome = code == HOLD_CASH
                ? SettlementCoordinator.LegOutcome.HELD
                : (code == RELEASE_CASH
                        ? SettlementCoordinator.LegOutcome.RELEASED
                        : SettlementCoordinator.LegOutcome.RETURNED);
            try coordinator.recordLocalCashResolved(settlementId, outcome) {
                return true;
            } catch {
                return false;
            }
        }

        // RELEASE_ASSET, HOLD_ASSET, RETURN_ASSET
        MessageCodec.MessageType messageType = code == HOLD_ASSET
            ? MessageCodec.MessageType.ASSET_HELD
            : MessageCodec.MessageType.ASSET_RELEASED;
        SettlementCoordinator.LegOutcome assetOutcome = code == HOLD_ASSET
            ? SettlementCoordinator.LegOutcome.HELD
            : (code == RELEASE_ASSET
                    ? SettlementCoordinator.LegOutcome.RELEASED
                    : SettlementCoordinator.LegOutcome.RETURNED);
        try coordinator.recordLegResolved(
            _vaa(messageType, settlementId, unique), messageType, assetOutcome
        ) {
            return true;
        } catch {
            return false;
        }
    }

    function _stateName(SettlementCoordinator.SettlementState state)
        private
        pure
        returns (string memory)
    {
        if (state == SettlementCoordinator.SettlementState.NONE) return "NONE";
        if (state == SettlementCoordinator.SettlementState.CASH_PREPARED) return "CASH_PREPARED";
        if (state == SettlementCoordinator.SettlementState.ASSET_PREPARED) return "ASSET_PREPARED";
        if (state == SettlementCoordinator.SettlementState.READY) return "READY";
        if (state == SettlementCoordinator.SettlementState.COMMIT_ISSUED) return "COMMIT_ISSUED";
        if (state == SettlementCoordinator.SettlementState.ABORT_ISSUED) return "ABORT_ISSUED";
        if (state == SettlementCoordinator.SettlementState.SETTLED) return "SETTLED";
        if (state == SettlementCoordinator.SettlementState.ABORTED) return "ABORTED";
        if (state == SettlementCoordinator.SettlementState.HELD) return "HELD";
        return "CONTESTED";
    }

    function test_ContractsAgreeWithTheReferenceModelOnEveryTrace() public {
        assertGt(traceCount, 100, "corpus is too small to be meaningful");

        uint256 divergences = 0;

        for (uint256 i = 0; i < traceCount; i++) {
            string memory base = string.concat("$.traces[", vm.toString(i), "]");
            uint256[] memory codes = vm.parseJsonUintArray(fixture, string.concat(base, ".codes"));
            uint256[] memory accepted =
                vm.parseJsonUintArray(fixture, string.concat(base, ".accepted"));
            string memory expectedState =
                vm.parseJsonString(fixture, string.concat(base, ".expectedState"));

            bytes32 settlementId =
                SettlementIntentLib.digest(_intent(i), coordinator.domainSeparator());

            for (uint256 step = 0; step < codes.length; step++) {
                // A fresh VAA hash per step, so replay protection never rejects
                // a step the model considered legal.
                bytes32 unique = keccak256(abi.encodePacked(i, step, uint256(7)));
                bool contractAccepted = _step(codes[step], i, settlementId, unique);

                if (contractAccepted != (accepted[step] == 1)) {
                    divergences += 1;
                    emit log_named_uint("trace", i);
                    emit log_named_uint("step", step);
                    emit log_named_uint("code", codes[step]);
                    emit log_named_string(
                        "divergence",
                        contractAccepted
                            ? "contract accepted what the model refused"
                            : "contract refused what the model accepted"
                    );
                }
            }

            string memory actualState = _stateName(coordinator.settlementOf(settlementId).state);

            assertEq(
                actualState,
                expectedState,
                string.concat("terminal state diverged on trace ", vm.toString(i))
            );
        }

        assertEq(divergences, 0, "the contract and the model disagreed on at least one step");
    }
}

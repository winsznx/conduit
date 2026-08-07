// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {ConduitRWACVA} from "../src/ConduitRWACVA.sol";
import {RWACVASettlementAdapter} from "../src/RWACVASettlementAdapter.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";

/// @notice Deploys the asset leg on Base Sepolia. PRD 19 phase 03.
///
/// Two contracts, in order, because the adapter needs the token's address and
/// the token needs the adapter to hold `SETTLEMENT_ROLE`:
///
///   1. ConduitRWACVA, bound to the live CCP policy
///   2. RWACVASettlementAdapter, bound to the token
///   3. grant SETTLEMENT_ROLE to the adapter
///
/// The peer emitter is *not* set here. It is the Monad coordinator, which does
/// not exist yet, and PRD 8.4 requires the remote emitter to be exact. Setting
/// it to a placeholder and correcting it later would leave a window where the
/// adapter accepts messages from an address nobody chose. `setRemotePeer` on the
/// transport is a one-time call that locks afterwards.
///
/// Every address comes from the environment rather than a literal, because the
/// policy address is discovered from chain state (ADR-0010) and CLAUDE.md
/// forbids hardcoding a Cleanverse address.
contract DeployAssetLeg is Script {
    /// @dev Ten constructor arguments plus the environment reads exceeds the
    ///      stack in one frame. Grouping the settings into a struct keeps the
    ///      script readable without reaching for `via-ir`, which would change
    ///      the bytecode the deployment manifest hashes.
    struct Settings {
        address policy;
        address wormhole;
        bytes32 deploymentId;
        uint16 localWormholeChainId;
        uint16 remoteWormholeChainId;
        WormholeTransport.FinalityLevel settlementFinality;
        WormholeTransport.FinalityLevel observationFinality;
        uint64 maxAttestationValidity;
        address deployer;
    }

    function _settings(address deployer) private view returns (Settings memory) {
        return Settings({
            policy: vm.envAddress("CCP_POLICY_BASE_SEPOLIA"),
            wormhole: vm.envAddress("WORMHOLE_CORE_BASE_SEPOLIA"),
            deploymentId: vm.envBytes32("CONDUIT_DEPLOYMENT_ID"),
            localWormholeChainId: uint16(vm.envUint("BASE_SEPOLIA_WORMHOLE_CHAIN_ID")),
            remoteWormholeChainId: uint16(vm.envUint("MONAD_WORMHOLE_CHAIN_ID")),
            // A COMMIT is economically irreversible, so the state it rests on
            // must be final. Recorded in the deployment manifest.
            settlementFinality: WormholeTransport.FinalityLevel(
                vm.envOr("SETTLEMENT_FINALITY", uint256(2))
            ),
            observationFinality: WormholeTransport.FinalityLevel(
                vm.envOr("OBSERVATION_FINALITY", uint256(0))
            ),
            // Bounded in the bytecode so a compliance signer cannot widen its
            // own attestation window. PRD FR-006.
            maxAttestationValidity: uint64(vm.envOr("MAX_ATTESTATION_VALIDITY", uint256(900))),
            deployer: deployer
        });
    }

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        Settings memory s = _settings(vm.addr(deployerKey));

        // A policy with no bytecode is the failure ADR-0009 exists to prevent.
        // Checking here means a misconfigured environment costs nothing rather
        // than producing a token that reverts on its first transfer.
        require(s.policy.code.length > 0, "CCP policy has no bytecode on this chain");
        require(s.wormhole.code.length > 0, "Wormhole core has no bytecode on this chain");

        vm.startBroadcast(deployerKey);

        ConduitRWACVA token = new ConduitRWACVA(
            vm.envOr("RWA_CVA_NAME", string("Conduit Demo Bond")),
            vm.envOr("RWA_CVA_SYMBOL", string("cBOND")),
            uint8(vm.envOr("RWA_CVA_DECIMALS", uint256(6))),
            s.policy,
            s.deployer
        );

        RWACVASettlementAdapter adapter = new RWACVASettlementAdapter(
            address(token),
            s.wormhole,
            s.deploymentId,
            s.localWormholeChainId,
            s.remoteWormholeChainId,
            // Peer unset. Locked in by the wiring step once the coordinator exists.
            bytes32(0),
            s.settlementFinality,
            s.observationFinality,
            s.maxAttestationValidity,
            s.deployer
        );

        token.grantRole(token.SETTLEMENT_ROLE(), address(adapter));

        vm.stopBroadcast();

        console2.log("chainId               ", block.chainid);
        console2.log("deployer              ", s.deployer);
        console2.log("policy                ", s.policy);
        console2.log("ConduitRWACVA         ", address(token));
        console2.log("RWACVASettlementAdapter", address(adapter));
        console2.log("SETTLEMENT_ROLE granted to the adapter");
        console2.log("peer emitter           UNSET - run the wiring step after the Monad deploy");
        console2.log("settlementFinality     ", uint256(s.settlementFinality));
        console2.log("observationFinality    ", uint256(s.observationFinality));
        console2.log("maxAttestationValidity ", s.maxAttestationValidity);
    }
}

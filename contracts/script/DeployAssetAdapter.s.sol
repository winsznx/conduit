// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {ConduitRWACVA} from "../src/ConduitRWACVA.sol";
import {RWACVASettlementAdapter} from "../src/RWACVASettlementAdapter.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";

/// @notice Redeploys the asset adapter against an existing `ConduitRWACVA`.
///
/// `DeployAssetLeg` deploys both, which is right the first time and wrong every
/// time after. The token's address is the subject of the Cleanverse owner
/// signature: redeploying it invalidates a signature a human has already
/// produced, and that has happened once already (ADR-0011). The adapter is a
/// different matter — it holds `SETTLEMENT_ROLE` and no value, so replacing it
/// costs a role grant and nothing else.
///
/// The old adapter keeps its role unless it is revoked. That is deliberate and
/// left to a separate, explicit call: revoking as a side effect of a deploy
/// would strand any settlement mid-flight on the previous adapter.
contract DeployAssetAdapter is Script {
    function run() external {
        address token = vm.envAddress("RWA_CVA_ADDRESS");
        address wormhole = vm.envAddress("WORMHOLE_CORE_BASE_SEPOLIA");
        bytes32 deploymentId = vm.envBytes32("CONDUIT_DEPLOYMENT_ID");
        uint16 localWormholeChainId = uint16(vm.envUint("BASE_SEPOLIA_WORMHOLE_CHAIN_ID"));
        uint16 remoteWormholeChainId = uint16(vm.envUint("MONAD_WORMHOLE_CHAIN_ID"));

        WormholeTransport.FinalityLevel settlementFinality =
            WormholeTransport.FinalityLevel(vm.envOr("SETTLEMENT_FINALITY", uint256(2)));
        WormholeTransport.FinalityLevel observationFinality =
            WormholeTransport.FinalityLevel(vm.envOr("OBSERVATION_FINALITY", uint256(0)));
        uint64 maxAttestationValidity = uint64(vm.envOr("MAX_ATTESTATION_VALIDITY", uint256(900)));

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        require(token.code.length > 0, "RWA CVA has no bytecode on this chain");
        require(wormhole.code.length > 0, "Wormhole core has no bytecode on this chain");

        vm.startBroadcast(deployerKey);

        RWACVASettlementAdapter adapter = new RWACVASettlementAdapter(
            token,
            wormhole,
            deploymentId,
            localWormholeChainId,
            remoteWormholeChainId,
            // Peer unset. Locked once the Monad coordinator exists.
            bytes32(0),
            settlementFinality,
            observationFinality,
            maxAttestationValidity,
            deployer
        );

        ConduitRWACVA(token).grantRole(ConduitRWACVA(token).SETTLEMENT_ROLE(), address(adapter));

        vm.stopBroadcast();

        console2.log("chainId                ", block.chainid);
        console2.log("token (unchanged)      ", token);
        console2.log("RWACVASettlementAdapter", address(adapter));
        console2.log("maxAttestationValidity ", maxAttestationValidity);
        console2.log("peer emitter            UNSET - run the wiring step after the Monad deploy");
    }
}

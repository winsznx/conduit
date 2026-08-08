// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {CashEscrow} from "../src/CashEscrow.sol";
import {WormholeTransport} from "../src/WormholeTransport.sol";

/// @notice Redeploys only the cash escrow, against a different cash asset.
///
/// `DeployCashLeg` deploys the coordinator alongside it, which is right the
/// first time and wasteful afterwards. Only `CashEscrow` binds its asset, as an
/// immutable, so pointing the cash leg at a different CVA is one deployment
/// rather than two — and on a chain at 102 gwei with a nearly empty deployer
/// that difference is whether the work proceeds at all.
///
/// The coordinator keeps its address, and with it the peer emitter the Base
/// adapter already locked to. `setRemotePeer` locks permanently after one call,
/// so redeploying the coordinator would strand that wiring and require the
/// adapter to be redeployed too, on the other chain, to re-lock against the new
/// address. The cheap path and the correct path are the same one here.
contract DeployCashEscrow is Script {
    function run() external {
        address cashAsset = vm.envAddress("MONAD_CASH_ATOKEN");
        address wormhole = vm.envAddress("WORMHOLE_CORE_MONAD_TESTNET");
        bytes32 deploymentId = vm.envBytes32("CONDUIT_DEPLOYMENT_ID");
        uint16 localWormholeChainId = uint16(vm.envUint("MONAD_WORMHOLE_CHAIN_ID"));
        uint16 remoteWormholeChainId = uint16(vm.envUint("BASE_SEPOLIA_WORMHOLE_CHAIN_ID"));

        address remoteAdapter = vm.envAddress("RWA_CVA_ADAPTER_ADDRESS");
        bytes32 remoteEmitter = bytes32(uint256(uint160(remoteAdapter)));

        WormholeTransport.FinalityLevel settlementFinality =
            WormholeTransport.FinalityLevel(vm.envOr("SETTLEMENT_FINALITY", uint256(2)));
        WormholeTransport.FinalityLevel observationFinality =
            WormholeTransport.FinalityLevel(vm.envOr("OBSERVATION_FINALITY", uint256(0)));
        uint64 maxAttestationValidity = uint64(vm.envOr("MAX_ATTESTATION_VALIDITY", uint256(900)));

        address coordinatorAddress = vm.envAddress("SETTLEMENT_COORDINATOR_ADDRESS");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        require(cashAsset.code.length > 0, "cash CVA has no bytecode on this chain");
        require(wormhole.code.length > 0, "Wormhole core has no bytecode on this chain");
        require(coordinatorAddress.code.length > 0, "coordinator has no bytecode on this chain");

        vm.startBroadcast(deployerKey);

        CashEscrow escrow = new CashEscrow(
            cashAsset,
            coordinatorAddress,
            wormhole,
            deploymentId,
            localWormholeChainId,
            remoteWormholeChainId,
            remoteEmitter,
            settlementFinality,
            observationFinality,
            maxAttestationValidity,
            deployer
        );

        vm.stopBroadcast();

        console2.log("chainId               ", block.chainid);
        console2.log("cash asset            ", cashAsset);
        console2.log("CashEscrow            ", address(escrow));
        console2.log("coordinator (kept)    ", coordinatorAddress);
        console2.log("next: coordinator.setCashEscrow, compliance signers, vault CVI, mint");
    }
}

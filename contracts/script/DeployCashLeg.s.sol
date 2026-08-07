// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {CashEscrow} from "../src/CashEscrow.sol";
import {SettlementCoordinator} from "../src/SettlementCoordinator.sol";

/// @notice Deploys the cash leg on Monad Testnet. PRD 19 phases 01 and 04.
///
/// The second side of the pair, so both peer emitters are known: the asset
/// adapter on Base Sepolia already exists. The coordinator and escrow are
/// therefore constructed with their peer set and locked immediately, and only
/// the Base-side adapter needs a later wiring call.
///
/// The A-Token address is passed in rather than hardcoded. PRD 2.4 requires it
/// to come from `query_deposit_atoken_list`, and ADR-0007 cross-checks that
/// against chain state before it reaches this script.
contract DeployCashLeg is Script {
    function run() external {
        address cashAsset = vm.envAddress("MONAD_CASH_ATOKEN");
        address wormhole = vm.envAddress("WORMHOLE_CORE_MONAD_TESTNET");
        bytes32 deploymentId = vm.envBytes32("CONDUIT_DEPLOYMENT_ID");
        uint16 localWormholeChainId = uint16(vm.envUint("MONAD_WORMHOLE_CHAIN_ID"));
        uint16 remoteWormholeChainId = uint16(vm.envUint("BASE_SEPOLIA_WORMHOLE_CHAIN_ID"));

        // Wormhole encodes an EVM emitter left-padded into 32 bytes.
        address remoteAdapter = vm.envAddress("RWA_CVA_ADAPTER_ADDRESS");
        bytes32 remoteEmitter = bytes32(uint256(uint160(remoteAdapter)));

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        require(cashAsset.code.length > 0, "cash A-Token has no bytecode on this chain");
        require(wormhole.code.length > 0, "Wormhole core has no bytecode on this chain");

        vm.startBroadcast(deployerKey);

        SettlementCoordinator coordinator = new SettlementCoordinator(
            wormhole,
            deploymentId,
            localWormholeChainId,
            remoteWormholeChainId,
            remoteEmitter,
            deployer,
            "Conduit",
            "1"
        );

        CashEscrow escrow = new CashEscrow(
            cashAsset,
            wormhole,
            deploymentId,
            localWormholeChainId,
            remoteWormholeChainId,
            remoteEmitter,
            deployer
        );

        vm.stopBroadcast();

        console2.log("chainId                ", block.chainid);
        console2.log("deployer               ", deployer);
        console2.log("cash A-Token           ", cashAsset);
        console2.log("SettlementCoordinator  ", address(coordinator));
        console2.log("CashEscrow             ", address(escrow));
        console2.log("remote emitter (Base)  ", remoteAdapter);
        console2.log("domainSeparator        ");
        console2.logBytes32(coordinator.domainSeparator());
    }
}

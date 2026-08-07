// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {ConduitVaultRegistrar} from "../src/ConduitVaultRegistrar.sol";

/// @notice Deploys the CVI registrar. PRD 19 phase 01 and 03, ADR-0001.
///
/// The validator address is passed in rather than written as a literal. It is not
/// published in any guide and was recovered from chain state — the `to` of the
/// transaction `POST /validator/grant` produced — so it belongs in the deployment
/// manifest alongside every other discovered address, not in source.
///
/// Deployment does not grant `REGISTER_ROLE`. That is Cleanverse's call, made
/// off-chain against this contract's `owner()`, and the registrar reports whether
/// it has arrived rather than assuming it.
contract DeployVaultRegistrar is Script {
    function run() external {
        // One env var name, chosen per chain, because the validator turns out to
        // be deployed at the same address on both and hardcoding either would
        // hide that fact rather than record it.
        address validator = block.chainid == 84_532
            ? vm.envAddress("CCP_VALIDATOR_BASE_SEPOLIA")
            : vm.envAddress("CCP_VALIDATOR_MONAD_TESTNET");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        require(validator.code.length > 0, "validator has no bytecode on this chain");

        vm.startBroadcast(deployerKey);
        ConduitVaultRegistrar registrar = new ConduitVaultRegistrar(validator, deployer);
        vm.stopBroadcast();

        console2.log("chainId               ", block.chainid);
        console2.log("deployer              ", deployer);
        console2.log("validator             ", validator);
        console2.log("ConduitVaultRegistrar ", address(registrar));
        console2.log("owner                 ", registrar.owner());
        console2.log("hasRegisterRole       ", registrar.hasRegisterRole());
        console2.log("next: POST /validator/grant for the registrar address");
    }
}

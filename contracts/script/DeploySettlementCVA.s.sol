// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {ConduitRWACVA} from "../src/ConduitRWACVA.sol";

/// @notice Deploys the sandbox settlement CVA on Monad. Override section 8, fallback 2.
///
/// The cash leg is meant to settle in Cleanverse's own aUSDC. This credential
/// cannot obtain any: `/faucet` reverts `ERC20InsufficientBalance` on its own
/// empty source wallet, a direct deposit is refunded as `non_whitelist_transfer`,
/// and Circle's faucet refuses the automated session with "verify that you are
/// not a bot". All three are provisioning, none is a design problem, and none is
/// ours to fix (ASM-035).
///
/// So the cash leg runs on a CVA we issue and register ourselves, through the
/// same `POST /atoken/register_atoken` path proven on Base. What that preserves
/// is everything the architecture depends on: the token calls the live CCP
/// policy on every transfer, holders need real CVI, and `CashEscrow` needs the
/// vault registration ADR-0001 established. What it does not preserve is the
/// backing, and the naming says so — this is a sandbox settlement unit, not
/// aUSDC, and not fiat-backed anything. Calling it otherwise would be the exact
/// mislabelled report CLAUDE.md forbids.
///
/// If real aUSDC becomes available the headline demo moves back to it. This is
/// how the remaining engineering gets built and proven in the meantime.
///
/// Reuses `ConduitRWACVA` rather than introducing a near-duplicate contract. Its
/// reservation machinery is unused on the cash leg, where the escrow takes
/// custody instead; carrying an unused feature is cheaper than carrying a second
/// token implementation with its own test surface.
contract DeploySettlementCVA is Script {
    function run() external {
        address policy = vm.envAddress("CCP_POLICY_MONAD_TESTNET");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        require(policy.code.length > 0, "CCP policy has no bytecode on this chain");

        vm.startBroadcast(deployerKey);

        ConduitRWACVA cva = new ConduitRWACVA(
            vm.envOr("SETTLEMENT_CVA_NAME", string("Conduit Sandbox Settlement Unit")),
            vm.envOr("SETTLEMENT_CVA_SYMBOL", string("cSETTLE")),
            uint8(vm.envOr("SETTLEMENT_CVA_DECIMALS", uint256(6))),
            policy,
            deployer
        );

        vm.stopBroadcast();

        console2.log("chainId               ", block.chainid);
        console2.log("policy                ", policy);
        console2.log("settlement CVA        ", address(cva));
        console2.log("owner                 ", cva.owner());
        console2.log("next: register_atoken with chain=monad, then RuleV2, then vault CVI");
    }
}

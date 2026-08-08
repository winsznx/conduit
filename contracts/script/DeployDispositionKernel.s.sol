// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {AuthorityRegistry} from "../src/AuthorityRegistry.sol";
import {DispositionController} from "../src/DispositionController.sol";

/// @notice Deploys the Disposition Kernel for one chain. PRD 8.1, FR-012.
///
/// One registry and one controller per chain, because both are bound to the
/// chain they serve: the controller's EIP-712 domain fixes `chainId` and
/// `verifyingContract` at construction, so an order signed for Monad is not a
/// valid order for Base even with the same authority and the same settlement.
/// That separation is load-bearing rather than incidental — two generations have
/// already collided on a bare address across these two chains (ADR-0018).
///
/// The executor is not set here. The controller must know the escrow and the
/// escrow must know the controller, so whichever deploys first cannot name the
/// other; `wire-generation-3.mjs` closes that loop once and it locks.
contract DeployDispositionKernel is Script {
    function run() external {
        bytes32 deploymentId = vm.envBytes32("CONDUIT_DEPLOYMENT_ID");

        /// @dev Long enough that a grant is visible on chain before it can be
        ///      used, short enough that a demonstration can wait it out. The
        ///      contest window sits on top of it, so the total delay between an
        ///      authority appearing and value moving is the sum.
        uint64 grantDelay = uint64(vm.envOr("AUTHORITY_GRANT_DELAY", uint256(120)));

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        AuthorityRegistry registry = new AuthorityRegistry(deployer, grantDelay);
        DispositionController controller =
            new DispositionController(address(registry), deploymentId, deployer, "Conduit", "1");

        vm.stopBroadcast();

        console2.log("chainId               ", block.chainid);
        console2.log("AuthorityRegistry     ", address(registry));
        console2.log("DispositionController ", address(controller));
        console2.log("grantDelay            ", grantDelay);
        console2.log("domainSeparator       ", vm.toString(controller.domainSeparator()));
    }
}

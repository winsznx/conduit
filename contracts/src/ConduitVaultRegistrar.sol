// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IAPassComplianceValidator} from "./interfaces/IAPassComplianceValidator.sol";
import {IComplianceRule} from "./interfaces/IATokenPolicy.sol";

/// @notice Gives Conduit's settlement contracts the CVI they need to hold a CVA.
///
/// A CVA refuses a holder without CVI. `CashEscrow` is a contract, nobody issued
/// it CVI, and the Monad policy proves the consequence directly:
/// `canTransfer(aUSDC, eligibleEOA, escrow, 1)` reverts `NoAPass(0x1645BA08…)`
/// while `canTransfer(aUSDC, eligibleEOA, eligibleEOA, 1)` returns true. Without
/// this contract the cash leg cannot hold cash, and PRD 19 phase 01 cannot pass.
///
/// The guide calls this role the Factory. Conduit does not create pools, so
/// naming it a factory would describe a thing it never does; what it is, is the
/// one address permitted to register Conduit's vaults with the validator.
///
/// Two properties are worth stating because both are deliberate:
///
/// **It holds no value and moves none.** `REGISTER_ROLE` is authority over
/// registration, not over funds. A compromise of this owner key can register a
/// pool or set a rule; it cannot touch a settlement, because the settlement
/// contracts do not grant it anything.
///
/// **The validator is immutable.** A settable validator would let whoever holds
/// the owner key point registration at a contract of their choosing and mint
/// eligibility, which is the whole property the CCP exists to provide.
contract ConduitVaultRegistrar is Ownable2Step {
    /// @notice `0xaC7e5179C2C7f03f209136886c172eb34F161792` on Monad Testnet.
    IAPassComplianceValidator public immutable validator;

    error ValidatorHasNoCode();
    error RegistrarLacksRegisterRole();

    event PoolRegistered(address indexed pool);
    event VaultCviRegistered(address indexed pool, address indexed aToken, address feeAddress);

    constructor(address validator_, address owner_) Ownable(owner_) {
        // A validator address with no bytecode produces a registrar whose every
        // call succeeds silently against nothing, which is indistinguishable from
        // working until a transfer reverts weeks later.
        if (validator_.code.length == 0) revert ValidatorHasNoCode();
        validator = IAPassComplianceValidator(validator_);
    }

    /// @notice Whether Cleanverse has granted this registrar `REGISTER_ROLE`.
    ///
    /// @dev The grant is off-chain (`POST /validator/grant`) and asynchronous, so
    ///      the deploy cannot assert it. Reading it is how an operator knows
    ///      whether the next call will work, rather than finding out from a
    ///      revert.
    function hasRegisterRole() public view returns (bool) {
        return validator.hasRole(validator.REGISTER_ROLE(), address(this));
    }

    /// @notice Step one: register the pool and set its compliance rule.
    ///
    /// @dev `registerApass` reverts `PoolNotRegistered()` until this has run. The
    ///      ordering is the guide's and is enforced by the validator, not here.
    function registerPool(address pool, IComplianceRule.RuleV2 calldata rule) external onlyOwner {
        _requireRole();
        validator.registerV2(pool, rule);
        emit PoolRegistered(pool);
    }

    /// @notice Step two: issue CVI to the vault so a CVA will accept it.
    ///
    /// @param feeAddress `address(0)` skips fee-account registration. Conduit
    ///        takes no fee on the cash leg, so it passes zero rather than
    ///        registering an address it would never use.
    function registerVaultCvi(address pool, address aToken, address feeAddress) external onlyOwner {
        _requireRole();
        validator.registerApass(pool, aToken, feeAddress);
        emit VaultCviRegistered(pool, aToken, feeAddress);
    }

    /// @notice Replace a registered pool's rule.
    ///
    /// @dev The registrar-side entry point exists because `setRuleV2FromContract`
    ///      authenticates on `msg.sender` being the pool, and `CashEscrow` has no
    ///      code to call it. Deliberately not part of the settlement contracts:
    ///      an escrow that could rewrite its own compliance rule mid-settlement
    ///      would make the rule a variable rather than a constraint.
    function setPoolRule(address pool, IComplianceRule.RuleV2 calldata rule) external onlyOwner {
        _requireRole();
        validator.setRuleV2FromRegistrar(pool, rule);
    }

    /// @dev Checked here rather than left to the validator so the failure names
    ///      the missing grant instead of surfacing as an AccessControl error
    ///      about an address the operator did not choose.
    function _requireRole() private view {
        if (!hasRegisterRole()) revert RegistrarLacksRegisterRole();
    }
}

// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {IComplianceRule} from "./IATokenPolicy.sol";

/// @notice The CVI Compliance Validator. Distinct from `IATokenPolicy`.
///
/// Two contracts, two jobs, and conflating them costs a day. `IATokenPolicy` is
/// what a CVA calls on every transfer (`canTransfer`). This is what issues CVI to
/// a contract so a CVA will accept it as a holder at all. They share the RuleV2
/// shape and nothing else: probing the Monad A-Token's policy
/// `0x36489bE45fa84f70a0c2BDB11D824Be608CB12Dd` for `isRegistered`,
/// `complianceVerify`, `registerApass`, and `REGISTER_ROLE` returns empty-data
/// reverts on every one, which is a contract saying the selector does not exist.
///
/// The deployed address is not printed in the guide and is not returned by
/// `query_deposit_atoken_list`. It came from chain state: `POST /validator/grant`
/// produces a transaction, and that transaction's `to` is the validator. On Monad
/// Testnet it is `0xaC7e5179C2C7f03f209136886c172eb34F161792`, confirmed by
/// `REGISTER_ROLE()` returning
/// `0xd1f21ec03a6eb050fba156f5316dad461735df521fb446dd42c5a4728e9c70fe` and by
/// `hasRole` flipping to true for the granted address in the same block.
///
/// @dev The guide's V2 listing declares a five-field RuleV2 here, as the CVA
///      guide did for the policy. It is six on both. The proof is the selector
///      rather than an argument about the document:
///
///        registerV2(address,(bytes2,bytes2,uint8,uint8,bool,uint256))
///          → 0x7b6c63cb, present, simulates successfully
///        registerV2(address,(bytes2,bytes2,uint8,uint8,uint256))
///          → 0xba62f533, empty-data revert, not present
///
///      A selector is a hash of the exact signature, so this is not a decode that
///      happens to work. See ADR-0010, now confirmed on a second contract.
interface IAPassComplianceValidator is IComplianceRule {
    /// @dev Thrown by `registerApass` when the pool has not been through
    ///      `registerV2` first. Selector `0x739f4185`, observed live.
    error PoolNotRegistered();

    function registerV2(address poolAddress, RuleV2 calldata rule) external;

    /// @dev Issues CVI to a CVA vault. `feeAddress == address(0)` skips the fee
    ///      registration, per the guide's section 4.5.
    function registerApass(address poolAddress, address aTokenAddress, address feeAddress) external;

    function registerApass(address poolAddress, address aTokenAddress) external;

    function setRuleV2FromRegistrar(address poolAddress, RuleV2 calldata rule) external;

    /// @dev Called by the registered contract itself, authenticating on
    ///      `msg.sender`, which is why the registrar cannot set another pool's
    ///      rules after registration.
    function setRuleV2FromContract(RuleV2 calldata rule) external;
    function addRuleV2FromContract(RuleV2 calldata rule) external;
    function removeRuleV2FromContract(uint256 index) external;

    function isRegistered(address poolAddress) external view returns (bool);
    function complianceVerify(address poolAddress, address userAddress) external view returns (bool);
    function getRulesV2(address poolAddress) external view returns (RuleV2[] memory);

    function REGISTER_ROLE() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);
}

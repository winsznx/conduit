// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {IATokenPolicy, IComplianceRule} from "../../src/interfaces/IATokenPolicy.sol";

/// @notice A deterministic stand-in for the Cleanverse policy engine.
///
/// This exists to make the token's own behaviour testable, not to model CCP.
/// It is a test fixture and must never be deployed or reasoned about as if it
/// were the real policy: PRD 2.5 is explicit that a mock is not acceptable as
/// final proof, and the real engine's semantics are settled against the
/// deployed contract in phase 03.
///
/// It deliberately supports denying a specific address, so a test can reproduce
/// "recipient became ineligible between prepare and release" without needing a
/// live identity to freeze.
contract MockATokenPolicy is IATokenPolicy {
    bool public allowAll = true;
    mapping(address account => bool) public denied;
    /// @dev Records whether the zero address was ever presented, so a test can
    ///      assert what the token asks about mint and burn (ASM-026).
    bool public sawZeroAddress;

    mapping(address token => RuleV2[]) private _rules;

    function setAllowAll(bool value) external {
        allowAll = value;
    }

    function setDenied(address account, bool value) external {
        denied[account] = value;
    }

    function canTransfer(address, address from, address to, uint256)
        external
        view
        override
        returns (bool)
    {
        if (from == address(0) || to == address(0)) {
            // Mint and burn. The real policy's behaviour here is ASM-026; the
            // mock permits them so token tests are not blocked on that answer.
            return true;
        }
        if (!allowAll) return false;
        return !denied[from] && !denied[to];
    }

    /// @dev Non-view variant used by tests that need the observation recorded.
    function observeZeroAddress(address from, address to) external {
        if (from == address(0) || to == address(0)) sawZeroAddress = true;
    }

    function setRuleV2(address token, RuleV2 calldata rule) external override {
        delete _rules[token];
        _rules[token].push(rule);
    }

    function addRuleV2(address token, RuleV2 calldata rule) external override {
        _rules[token].push(rule);
    }

    function removeRuleV2(address token, uint256 index) external override {
        RuleV2[] storage rules = _rules[token];
        rules[index] = rules[rules.length - 1];
        rules.pop();
    }

    function setRuleV2FromToken(RuleV2 calldata rule) external override {
        delete _rules[msg.sender];
        _rules[msg.sender].push(rule);
    }

    function addRuleV2FromToken(RuleV2 calldata rule) external override {
        _rules[msg.sender].push(rule);
    }

    function removeRuleV2FromToken(uint256 index) external override {
        RuleV2[] storage rules = _rules[msg.sender];
        rules[index] = rules[rules.length - 1];
        rules.pop();
    }

    function getRulesV2(address token) external view override returns (RuleV2[] memory) {
        return _rules[token];
    }
}

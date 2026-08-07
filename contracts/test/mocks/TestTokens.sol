// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A well-behaved ERC-20 standing in for the Cleanverse A-Token.
contract MockAToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(uint8 decimals_) ERC20("Mock aUSDC", "ausdc") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A token that keeps a cut of every transfer.
///
/// PRD FR-004 and 8.5 require fee-on-transfer and rebasing behaviour to be
/// rejected rather than tolerated. Escrowing 99 units against an intent that
/// promised 100 breaks conservation for a settlement whose counterparty is owed
/// the full amount, and the shortfall would only surface at release. This
/// fixture makes that failure happen at preparation, where it is cheap.
contract FeeOnTransferToken is ERC20 {
    uint256 public immutable feeBasisPoints;

    constructor(uint256 feeBasisPoints_) ERC20("Fee Token", "FEE") {
        feeBasisPoints = feeBasisPoints_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }

        uint256 fee = (value * feeBasisPoints) / 10_000;
        super._update(from, to, value - fee);
        if (fee != 0) super._update(from, address(0xfee), fee);
    }
}

/// @notice A token whose balance can be inflated or deflated out from under a holder.
contract RebasingToken is ERC20 {
    /// @dev Unsigned: only inflation is needed to break an exact-delta check,
    ///      and a signed field would need a cast the linter cannot prove safe.
    uint256 public rebaseGain;

    constructor() ERC20("Rebase Token", "RBS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @dev Applied on the next transfer, so a balance read before and after a
    ///      transfer disagrees by more than the amount moved.
    function setRebaseGain(uint256 gain) external {
        rebaseGain = gain;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (rebaseGain != 0 && to != address(0)) {
            super._update(address(0), to, rebaseGain);
        }
    }
}

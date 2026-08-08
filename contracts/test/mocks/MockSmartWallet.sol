// SPDX-License-Identifier: MIT
pragma solidity =0.8.36;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice A contract wallet, for the MULTISIG authority class.
///
/// PRD FR-012 admits `MULTISIG` as an authority type, and a multisig has no
/// private key: it signs by being asked. `SignatureChecker` falls through to
/// EIP-1271 for contract accounts, which is what makes that authority class
/// reachable at all — and a test that only ever used EOAs would never touch
/// that branch.
///
/// The wallet holds one owner key and accepts exactly what that key signed. It
/// is deliberately not a real threshold scheme: what is under test is that the
/// controller asks the contract rather than recovering a key, and that a wallet
/// which says no is refused.
contract MockSmartWallet is IERC1271 {
    bytes4 private constant MAGIC_VALUE = 0x1626ba7e;

    address public immutable signer;
    bool public accepting = true;

    constructor(address signer_) {
        signer = signer_;
    }

    /// @dev Lets a test turn the wallet hostile without changing anything else,
    ///      which is the difference between "the signature is malformed" and
    ///      "the wallet refuses this signature".
    function setAccepting(bool value) external {
        accepting = value;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature)
        external
        view
        override
        returns (bytes4)
    {
        if (!accepting) return 0xffffffff;
        (address recovered, ECDSA.RecoverError failure,) = ECDSA.tryRecover(digest, signature);
        if (failure != ECDSA.RecoverError.NoError || recovered != signer) return 0xffffffff;
        return MAGIC_VALUE;
    }
}

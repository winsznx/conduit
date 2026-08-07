// SPDX-License-Identifier: UNLICENSED
pragma solidity =0.8.36;

import {Test} from "forge-std/Test.sol";

/// @title Phase 00 build probe
/// @notice Holds no protocol logic and must never gain any. Phase 00 delivers
///         the repository and toolchain only, so this is the single Solidity
///         unit whose job is to prove the pinned compiler, the pinned EVM
///         version, and the forge-std harness are wired before any settlement
///         contract exists. Phase 04 adds the real suite alongside it.
///
///         The exact pragma is the compiler assertion: with
///         `auto_detect_solc = false` and `solc = "0.8.36"` in foundry.toml, a
///         drifted pin fails the build rather than this suite. Cross-file
///         agreement between the pragma, foundry.toml, and toolchain.json is
///         enforced by tests/toolchain.test.ts.
contract ToolchainPinTest is Test {
    /// @dev TSTORE and TLOAD are Cancun opcodes, so this compiles and runs only
    ///      while `evm_version` is Cancun or later. Whether the target chains
    ///      execute this version is a separate, still-open question recorded as
    ///      ASM-013 and resolved by live probes in phase 02.
    function test_PinnedEvmVersionProvidesTransientStorage() public {
        bytes32 slot = keccak256("conduit.phase00.toolchain.probe");
        assembly ("memory-safe") {
            tstore(slot, 1)
        }

        uint256 loaded;
        assembly ("memory-safe") {
            loaded := tload(slot)
        }

        assertEq(loaded, 1, "transient storage unavailable under pinned evm_version");
    }

    /// @dev Proves the forge-std remapping resolves and cheatcodes are live, so
    ///      a failing phase 04 suite means broken product code rather than a
    ///      broken harness.
    function test_ForgeStdHarnessIsWired() public {
        uint64 fixedUtcTimestamp = 1_786_060_800; // 2026-08-07T00:00:00Z
        vm.warp(fixedUtcTimestamp);
        assertEq(block.timestamp, fixedUtcTimestamp);
    }
}

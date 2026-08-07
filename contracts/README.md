# contracts

Foundry project for the settlement contracts of PRD 8.1.

```text
src/          protocol contracts             — first code lands in phase 03
test/         Foundry unit, fuzz, invariant  — build probe only in phase 00
script/       deployment and operations      — phase 04
deployments/  deployment manifests           — phase 01 onward
lib/          pinned dependencies            — forge-std at foundry.lock revisions
```

## Phase 00 state

`src/` and `script/` are empty. `test/` holds one file, `ToolchainPin.t.sol`, whose only job is
to prove the pinned compiler, the pinned EVM version, and the forge-std harness are wired before
any settlement contract exists. It contains no protocol logic and must never gain any.

## Toolchain

| Setting          | Value                              | Why                                                                         |
| ---------------- | ---------------------------------- | --------------------------------------------------------------------------- |
| `solc`           | 0.8.36, `auto_detect_solc = false` | newest release with an empty upstream known-bug list (ADR-0002)             |
| `evm_version`    | `cancun`                           | below the Foundry 1.7.1 default of `osaka`; target-chain support is ASM-013 |
| `bytecode_hash`  | `none`                             | reproducible bytecode for PRD 17.3 manifests and PRD FR-014 verification    |
| `cbor_metadata`  | `false`                            | same                                                                        |
| `optimizer_runs` | 200                                | —                                                                           |
| `ffi`            | `false`                            | the build takes no untrusted input                                          |

## Rules that apply to every contract written here

From CLAUDE.md, and they are not negotiable per-contract:

- checks-effects-interactions;
- `SafeERC20`;
- `nonReentrant`;
- exact balance deltas, with fee-on-transfer and rebasing behaviour rejected;
- explicit custom errors;
- state-transition events;
- no admin bypass of recipient eligibility;
- no rescue of active settlement assets;
- every terminal state irreversible.

## Static analysis

Slither runs on every commit as step 10 of `pnpm verify`, configured by
[`slither.config.json`](../slither.config.json):

- `foundry_compile_all` includes test contracts, so the analyser has first-party code to read
  while `src/` is still empty. Without it, crytic-compile aborts on a missing `out/build-info`.
- `filter_paths` excludes `contracts/lib`, because vendored dependencies are not this
  repository's findings to fix.
- `fail_on: low` blocks the build on low, medium, and high findings. Informational findings are
  printed but do not block.

No detector is disabled. PRD 15.5 forbids silencing a tool without a waiver in
`docs/security-waivers/`, and printing an informational finding is not silencing it — which
matters here, because Foundry's `test_Xxx` naming will always trip Slither's `naming-convention`
detector, and suppressing that detector would also hide it in production code.

Current output: 3 informational findings, all in `ToolchainPin.t.sol` (inline assembly for the
transient-storage probe, and two `test_` function names).

## Commands

```bash
forge build --deny warnings
forge test
forge snapshot --check
node scripts/storage-layout.mjs --check
```

All four run inside `pnpm verify`. Run that instead of the individual commands when checking
whether work is ready.

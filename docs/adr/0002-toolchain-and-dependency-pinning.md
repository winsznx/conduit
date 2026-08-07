# ADR-0002: Toolchain and dependency pinning

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 00
**Supersedes:** —
**Superseded by:** —

## Context

PRD 11.1 requires that "all versions are exact-pinned in the lockfile and toolchain manifest.
No floating Solidity compiler, npm dependency, Docker tag, GitHub Action, or Terraform
provider." CLAUDE.md repeats it as a repository rule.

The requirement is not stylistic. PRD 17.3 hashes deployed bytecode into a deployment manifest,
and PRD FR-014 requires a public verifier to recompute those hashes from source on a machine
that has never seen this repository. A compiler that resolves differently on two machines
breaks that chain, and so does a `^` that quietly upgrades a transitive dependency between the
audited commit and the deployed one.

## Decision

`toolchain.json` is the single source of truth for every pin. Nothing else in the repository
may introduce a version.

**Pins**

| Concern          | Pin                                                       | Rationale                                                                                       |
| ---------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Node             | 24.14.1 exact, `engine-strict=true`                       | active LTS; exact rather than a range so `.node-version`, `engines`, and CI agree byte for byte |
| pnpm             | 10.33.0 via `packageManager`                              | Corepack resolves it without a global install                                                   |
| npm dependencies | exact semver, `save-exact=true`                           | `workspace:*` is the only permitted exception                                                   |
| Solidity         | 0.8.36 with `auto_detect_solc = false`                    | see below                                                                                       |
| EVM version      | `cancun`                                                  | Foundry 1.7.1 defaults to `osaka`; deliberately lower, see ASM-013                              |
| forge-std        | tag `v1.16.2`, rev `bf647bd…`, recorded in `foundry.lock` | git tags are mutable, revisions are not                                                         |
| Docker images    | `repo@sha256:…` digests                                   | a republished tag would change bytes silently                                                   |
| GitHub Actions   | commit SHA with the tag in a trailing comment             | a moved tag is a supply-chain write into CI                                                     |
| Terraform CLI    | 1.15.8 exact                                              | no providers yet, see ASM-014                                                                   |

**Solidity 0.8.36** is chosen from upstream evidence, not recency. The Solidity project
publishes `bugs_by_version.json`, listing the known bugs present in each release. Checked on
2026-08-07:

| Version         | Known bugs                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.8.30          | InheritanceOrderReversalOnStorageEndWarning, UnsoundSpillInMutualRecursion, TransientStorageClearingHelperCollision, LostStorageArrayWriteOnSlotOverflow |
| 0.8.32 – 0.8.33 | InheritanceOrderReversalOnStorageEndWarning, UnsoundSpillInMutualRecursion, TransientStorageClearingHelperCollision                                      |
| 0.8.34 – 0.8.35 | InheritanceOrderReversalOnStorageEndWarning, UnsoundSpillInMutualRecursion                                                                               |
| **0.8.36**      | **none**                                                                                                                                                 |

0.8.36 is the only release in the range with an empty list. `TransientStorageClearingHelperCollision`
in particular would sit directly under the transient-storage usage the pinned Cancun EVM
version enables.

**TypeScript is pinned to 6.0.3, not the current 7.0.2.** typescript-eslint 8.66.0 declares
`typescript >=4.8.4 <6.1.0`, and PRD 15.5 makes static TypeScript analysis a CI gate. Type-aware
lint rules are the only mechanism that enforces the CLAUDE.md bans on `any`, `@ts-ignore`, and
swallowed errors, so dropping them to gain a compiler major would trade an enforced rule for a
version number. Tracked as ASM-015 and revisited when typescript-eslint supports TypeScript 7.

**Reproducible bytecode.** `bytecode_hash = "none"` and `cbor_metadata = false` remove the
metadata trailer, so a verifier recompiling from source reaches the same runtime bytecode as the
deployment, independent of build paths.

## Evidence

- `scripts/verify-toolchain.mjs` compares the installed Node, pnpm, and Foundry against
  `toolchain.json` and exits non-zero on any mismatch. It runs first in both `pnpm bootstrap`
  and `pnpm verify`.
- `tests/toolchain.test.ts` compares the manifest against `package.json`, `.node-version`,
  `.nvmrc`, `.npmrc`, `foundry.toml`, `foundry.lock`, `remappings.txt`, every Solidity pragma,
  every workflow `uses:`, `docker-compose.yml`, and `versions.tf`.
- `tests/version-pinning.test.ts` rejects any dependency range in any workspace manifest.
- `contracts/test/ToolchainPin.t.sol` executes TSTORE/TLOAD, so a regression below Cancun fails
  the contract suite rather than surfacing at deploy time.

## Consequences

- A contributor on Node 24.14.2 is blocked until they switch. That friction is the point, and
  it is recorded as ASM-017 in case it proves unacceptable during hardening.
- Dependency upgrades become deliberate commits that touch `toolchain.json` and turn a test red
  until every mirror of the pin is updated together.
- The verifier of PRD FR-014 can recompute bytecode hashes from a tagged commit alone.

## Alternatives rejected

**Caret ranges with a lockfile.** The lockfile pins the install but not the manifest, so a fresh
`pnpm install` without `--frozen-lockfile` resolves differently, and the audited commit stops
describing the deployed artifact.

**Renovate or Dependabot on automerge.** Useful later, but it would move pins without moving the
ADR and assumptions that justify them. Upgrades stay manual until phase 09.

**Latest Solidity by default.** Recency is not evidence. The upstream bug list is, and it
happens to select the newest release here — but for a reason that can be re-checked at each
phase gate rather than assumed.

## Assumptions touched

Introduces [ASM-013](../assumptions.md) (Cancun on the target chains),
[ASM-015](../assumptions.md) (TypeScript held at 6.0.3), and
[ASM-017](../assumptions.md) (exact Node pin friction).

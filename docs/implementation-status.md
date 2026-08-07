# Implementation status

Maintained per CLAUDE.md after every phase. PRD 19 defines the phases; a phase is `PASS` only
when its PRD gate has real evidence, never because code compiles.

**Source of truth date:** 2026-08-05 (PRD v1.0), amended 2026-08-07 (v1.1 override)
**Last updated:** 2026-08-07

`CONDUIT_PRD_v1.1_OVERRIDE.md` arrived during phase 00 and wins wherever it conflicts with v1.0.
Its adoption is recorded in [ADR-0004](./adr/0004-prd-v1-1-override-adoption.md). The phase
structure below is unchanged; what each phase must deliver is amended.

## Phase summary

| Phase    | Title                                    | State       | Gate                                                                                               |
| -------- | ---------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| Phase 00 | repository and truth lock                | PASS        | fresh clone → one bootstrap command → all empty-suite checks green                                 |
| Phase 01 | Cleanverse capability and seam proof     | IN PROGRESS | real A-Token enters and exits the selected custody mode with exact conservation                    |
| Phase 02 | Wormhole transport proof                 | NOT STARTED | Monad Testnet message verifies on Arbitrum Sepolia and the reverse, with replay rejected           |
| Phase 03 | restricted RWA fixture                   | NOT STARTED | eligible transfer succeeds, ineligible transfer fails, AssetEscrow locks and releases exact amount |
| Phase 04 | settlement contracts and reference model | NOT STARTED | reference model and contracts produce identical outcomes for generated traces                      |
| Phase 05 | Cleanverse Validator integration         | NOT STARTED | real Cleanverse eligibility result changes commit outcome on-chain                                 |
| Phase 06 | full happy-path DvP                      | NOT STARTED | CVA cash and restricted RWA settle under one intent, both chains publicly verifiable               |
| Phase 07 | Disposition Kernel                       | NOT STARTED | every generated held case reaches an allowed terminal state or stays safely contested              |
| Phase 08 | evidence and verifier                    | NOT STARTED | new machine with only a settlement ID independently verifies the complete proof                    |
| Phase 09 | hardening                                | NOT STARTED | all security, recovery, and chaos gates pass with no undisclosed critical issue                    |
| Phase 10 | presentation proof                       | NOT STARTED | judge verifies both cases in under two minutes without private credentials                         |

## PRD v1.1 override acceptance additions

v1.0 is not complete until every row below is `PASS`. None can be attempted in phase 00, which
delivers no product logic. `tests/docs.test.ts` parses these directly from the override, so an
item added upstream fails the build until it appears here.

| Acceptance addition                                                 | State       | Gate phase |
| ------------------------------------------------------------------- | ----------- | ---------- |
| `ConduitRWACVA` is deployed on Arbitrum Sepolia.                    | NOT STARTED | 03         |
| It is registered/issued as a Cleanverse CVA.                        | NOT STARTED | 03         |
| RuleV2 is configured and independently queryable.                   | NOT STARTED | 03         |
| Eligible RWA CVA transfer succeeds.                                 | NOT STARTED | 03         |
| Ineligible RWA CVA transfer fails through CCP policy.               | NOT STARTED | 03         |
| Reservation prevents seller double-spend.                           | NOT STARTED | 03         |
| Reservation cannot cancel after COMMIT.                             | NOT STARTED | 04         |
| Held post-COMMIT RWA can be dispositioned once.                     | NOT STARTED | 07         |
| Final demo uses the real registered CVA, not an ERC-3643-only mock. | NOT STARTED | 10         |
| API compatibility fields are not confused with canonical RuleV2.    | NOT STARTED | 05         |
| final web matches `design.md`.                                      | NOT STARTED | 06         |
| staging runs on Cloudflare.                                         | NOT STARTED | 09         |

Two of these are blocked on inputs this repository does not hold. The CCP CVA Integration Guide
that defines RuleV2 semantics and the `IATokenPolicy` interface has not been supplied (ASM-018),
and `design.md` is a `HUMAN_GATE_DESIGN` deliverable. Neither is a reason to start phase 01.

---

## Phase 00 — repository and truth lock

**State:** PASS

### Delivered

| PRD 19 deliverable         | Where                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| monorepo                   | `apps/`, `packages/`, `contracts/`, `docs/`, `infra/`, `scripts/` per PRD 11.1             |
| `CLAUDE.md`                | repository root, excluded from formatters                                                  |
| PRD copied into repository | `CONDUIT_PRD_v1.0.md`, excluded from formatters                                            |
| toolchain manifest         | [`toolchain.json`](../toolchain.json)                                                      |
| formatting                 | Prettier for TypeScript/JSON/Markdown, `forge fmt` for Solidity                            |
| lint                       | ESLint 10 flat config with type-aware `typescript-eslint` rules                            |
| typecheck                  | `tsc --build` across 14 strict project references                                          |
| test skeleton              | Vitest repository-hygiene suite, Foundry build probe, Playwright harness                   |
| docs directories           | `docs/adr`, `docs/threat-model`, `docs/runbooks`, `docs/evidence`, `docs/security-waivers` |
| threat-model skeleton      | 37 PRD 14.3 threats plus 11 from the v1.1 override, all bound to invariants                |
| no product logic           | every workspace exports only its own identity and target phase                             |

Beyond the PRD 19 list, phase 00 also absorbed the v1.1 override that arrived mid-phase:
[ADR-0004](./adr/0004-prd-v1-1-override-adoption.md) records the conflict and its resolution,
ASM-014 moves to `RESOLVED`, ASM-018 through ASM-023 open, and the threat register gains
reservation invariants R1–R5 with eleven new threats.

### Gate evidence

The gate is `fresh clone → one bootstrap command → all empty-suite checks green`.

```bash
git clone <repo> conduit && cd conduit
pnpm bootstrap
```

`pnpm bootstrap` verifies the machine's toolchain against `toolchain.json`, installs from the
committed `pnpm-lock.yaml` with `--frozen-lockfile`, restores Solidity dependencies at the
revisions in `foundry.lock`, builds contracts with warnings as errors, then runs `pnpm verify`.

`pnpm verify` runs sixteen blocking steps in the order CLAUDE.md prescribes. Every step either
passes or fails; none is skipped, because a silent skip reads as a pass.

| #   | Step                                     | Tool                                     |
| --- | ---------------------------------------- | ---------------------------------------- |
| 1   | toolchain pins match this machine        | `scripts/verify-toolchain.mjs`           |
| 2   | formatting                               | `prettier --check`, `forge fmt --check`  |
| 3   | lint                                     | `eslint` with `--max-warnings 0`         |
| 4   | typecheck                                | `tsc --build --force`                    |
| 5   | unit and repository-hygiene suite        | `vitest run`                             |
| 6   | contract build, warnings as errors       | `forge build --deny warnings`            |
| 7   | contract tests                           | `forge test`                             |
| 8   | gas snapshot unchanged                   | `forge snapshot --check`                 |
| 9   | storage layout snapshot unchanged        | `scripts/storage-layout.mjs --check`     |
| 10  | static analysis                          | Slither                                  |
| 11  | secret scan, worktree and history        | gitleaks                                 |
| 12  | dependency advisories                    | `pnpm audit`                             |
| 13  | container configuration scan             | Trivy                                    |
| 14  | infrastructure-as-code scan              | Checkov                                  |
| 15  | deployment manifests conform to PRD 17.3 | `scripts/check-deployment-manifests.mjs` |
| 16  | end-to-end harness                       | Playwright                               |

Measured on a clone of this commit into an empty directory, with no `node_modules`, no
`contracts/lib`, and no build output:

```text
PASS  toolchain 0.30s    PASS  contracts-test    0.26s    PASS  deps-audit      1.73s
PASS  format    1.95s    PASS  contracts-gas     0.23s    PASS  container-scan  9.88s
PASS  lint      3.56s    PASS  contracts-layout  0.05s    PASS  iac-scan        7.34s
PASS  typecheck 1.55s    PASS  slither          23.32s    PASS  manifests       0.15s
PASS  unit      2.07s    PASS  secrets          11.61s    PASS  e2e             2.24s
PASS  contracts-build 0.27s

gate PASSED: 16/16 steps green
bootstrap complete — repository gate is green
```

Counts: 234 Vitest assertions across 5 files, 2 Foundry tests, 2 Playwright tests.

### What the empty suites actually assert

Phase 00 has no product logic, so the tests assert the things that _do_ exist and would
silently rot otherwise:

- the PRD 11.1 directory layout, file by file;
- every pin in `toolchain.json` agreeing with `package.json`, `.node-version`, `foundry.toml`,
  `foundry.lock`, `remappings.txt`, the workflows, `docker-compose.yml`, and `versions.tf`;
- every npm dependency being an exact version, with `workspace:*` the only permitted exception;
- every GitHub Action pinned to a commit SHA annotated with its tag;
- all thirteen workspaces resolving and loading by their published names after `tsc --build`;
- every PRD 19 phase appearing in this file with an explicit state;
- all twelve PRD 23 questions appearing in the assumptions register, unresolved;
- all 37 PRD 14.3 threats appearing in the threat register, each bound to an invariant;
- every PRD 14.4 invariant bound to at least one threat;
- `.env.example` carrying names with no values;
- zero security waivers, because phase 00 silences no tool.

Coverage is measured against the PRD text itself. A requirement added upstream turns the build
red until the documentation catches up.

### Known limitations

1. **No external capability is proven.** Phase 00 deliberately contacts no chain, no Cleanverse
   endpoint, and no Wormhole guardian. Everything about those systems remains `OPEN` in
   [assumptions.md](./assumptions.md).
2. **`evm_version = "cancun"` is unverified against the target chains** (ASM-013). It is a
   conservative pin below the Foundry default, not a confirmed chain capability.
3. **TypeScript is held at 6.0.3, one major behind current** (ASM-015), because
   typescript-eslint 8.66.0 declares `typescript <6.1.0` and type-aware linting is a PRD 15.5
   gate.
4. **`infra/terraform` declares no providers** (ASM-014). No cloud target has been chosen, and
   inventing one would convert an assumption into a fact.
5. **Playwright drives no browser yet.** The harness runs and is version-pinned; the twenty PRD
   15.4 scenarios arrive with `apps/web` in phase 06.
6. **Every workspace is `private: true`, including `packages/sdk`.** PRD FR-015 publishes it as
   `@conduit-protocol/sdk`; the flag flips in the phase that actually publishes.
7. **`contracts/src` is empty by design.** The storage-layout and gas snapshots therefore cover
   the build probe only. Both gates exist now so they are in place before the code they guard.
8. **The v1.1 override is adopted in documentation only.** No CVA contract, RuleV2 codec,
   Cloudflare configuration, or Supabase schema exists. Adopting it here means the repository
   stops asserting a superseded architecture, nothing more.
9. **The CCP CVA Integration Guide is absent** (ASM-018). The override ranks it above API V5.6,
   and RuleV2 country-bit positions come from it. Phase 03 cannot start without it, and the
   override forbids guessing those positions.
10. **A formatter rewrote two ranked source documents.** `prettier --write .` ran across the
    repository before `CONDUIT_PRD_v1.1_OVERRIDE.md` and `CLAUDE_ONESHOT_CONDUIT.md` were known
    to exist. The change was markdown normalization with no semantic difference, but byte
    identity with the supplied files cannot be proven because they were untracked at the time.
    Both are now formatter-excluded and the exclusion is asserted by a test. See ADR-0004.

### Security findings

No finding at low severity or above, and no waiver in `docs/security-waivers/`.

| Tool            | Result                                                                   |
| --------------- | ------------------------------------------------------------------------ |
| Slither 0.11.5  | 24 contracts, 117 detectors, 3 informational findings, 0 low/medium/high |
| gitleaks 8.30.1 | worktree and full history clean                                          |
| `pnpm audit`    | no known vulnerabilities                                                 |
| Trivy 0.73.0    | 1 config file detected (`infra/terraform`), 0 misconfigurations          |
| Checkov 3.3.9   | 168 GitHub Actions checks passed, 0 failed, 0 skipped                    |

The three Slither findings are all in `contracts/test/ToolchainPin.t.sol`: inline assembly for
the transient-storage probe, and two `test_` function names that Foundry's convention requires
and Slither's `naming-convention` detector flags. They are printed rather than suppressed,
because suppressing the detector would also hide it in production code. See
[contracts/README.md](../contracts/README.md).

Trivy currently covers Terraform only. It has no docker-compose scanner, and the v1.1 override
targets Cloudflare Workers rather than containers, so there may never be an application
container to scan. That is a real gap in the PRD 15.5 "container scan" line and is recorded here
rather than papered over.

### Deviation from the one-shot execution policy

`CLAUDE_ONESHOT_CONDUIT.md` and override section 15 call for continuous execution across phases,
pausing only at a human gate. This run stopped at the phase 00 gate because the session
instruction asked for phase 00 only, with its status report. The narrower, more recent
instruction wins; the conflict is recorded in ADR-0004 rather than resolved silently, and
continuous execution resumes on request.

### Next phase

Phase 01 — Cleanverse capability and seam proof. It requires live sandbox credentials and
resolves ASM-001 through ASM-004, ASM-007, and ASM-019, and records the custody result in
ADR-0001. Under override section 8 it gains a second branch: if direct `CashEscrow` custody
fails CCP transfer policy, attempt a Cleanverse-native `ConduitSettlementCVA` reservation before
considering an institutional settlement wallet.

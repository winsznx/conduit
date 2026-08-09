# Implementation status

Maintained per CLAUDE.md after every phase. PRD 19 defines the phases; a phase is `PASS` only
when its PRD gate has real evidence, never because code compiles.

**Source of truth date:** 2026-08-05 (PRD v1.0), amended 2026-08-07 (v1.1 override)
**Last updated:** 2026-08-09

`CONDUIT_PRD_v1.1_OVERRIDE.md` arrived during phase 00 and wins wherever it conflicts with v1.0.
Its adoption is recorded in [ADR-0004](./adr/0004-prd-v1-1-override-adoption.md). The phase
structure below is unchanged; what each phase must deliver is amended.

## Capability status

Five states, and no checkmarks. A checkmark cannot distinguish "runs in
production" from "has a passing unit test", and that distinction is the whole
difference between a claim and evidence.

```text
LIVE                  running in the deployed product, with on-chain evidence
LIVE DEMONSTRATED     executed once against live chains, with a settlement id
IMPLEMENTED + TESTED  built and covered by tests; never run against live chains
PARTIAL               works, with a named gap
EXTERNAL BLOCKER      blocked by something outside this repository
FUTURE                not built, and named here so nobody assumes it is
```

### Product

| Capability                                                              | State    | Evidence                          |
| ----------------------------------------------------------------------- | -------- | --------------------------------- |
| Browser DvP flow, compose → sign → prepare → commit → release → SETTLED | **LIVE** | `0xd46775dc…`, `0x3f9b03f4…`      |
| Wallet connection, EIP-6963, silent restore, per-action chain switching | **LIVE** | 70 browser tests                  |
| Live Cleanverse eligibility, server-side credential                     | **LIVE** | every settlement's preflight      |
| Commit-time compliance minted after finality                            | **LIVE** | attestation table in the manifest |
| Counterparty signing from a second machine                              | **LIVE** | `/app/settlements/:id/sign`       |
| Settlement workspace and next-action resolver                           | **LIVE** | 34 unit tests over the resolver   |
| Cross-chain finality UX from real guardian state                        | **LIVE** | 12 samples, `observed-latency.md` |
| Independent verifier                                                    | **LIVE** | `/verify/:id`, 18 checks          |
| Evidence explorer                                                       | **LIVE** | `/app/evidence`, 4 packages       |
| Disposition center and the six order types                              | **LIVE** | `/app/dispositions`               |

### Protocol

| Capability                                                                  | State                    | Evidence                               |
| --------------------------------------------------------------------------- | ------------------------ | -------------------------------------- |
| Two-chain DvP under one signed intent                                       | **LIVE**                 | generation 3, four settlements         |
| Wormhole transport, both directions, replay refused                         | **LIVE**                 | `phase-02-wormhole-seam.json`          |
| FINALIZED-only consumption for value-moving messages                        | **LIVE**                 | immutable per message class            |
| Post-COMMIT compliance change → HELD                                        | **LIVE DEMONSTRATED**    | `0xc113ad33…`                          |
| `REVERIFY_AND_RESUME`                                                       | **LIVE DEMONSTRATED**    | same settlement                        |
| `RETURN_TO_ELIGIBLE_SENDER`, `RESTRICTED_HOLD`, `OPERATOR_ASSISTED_OFFRAMP` | **IMPLEMENTED + TESTED** | `DispositionKernel.t.sol`              |
| `REBIND_RECEIVER`, `AUTHORIZED_SUBSTITUTION`                                | **IMPLEMENTED + TESTED** | no live destination — see blockers     |
| Contest window and `CONTESTED` adjudication                                 | **IMPLEMENTED + TESTED** | `DispositionConflicts.t.sol`           |
| Generation isolation                                                        | **LIVE**                 | `phase-06-generation-isolation.json`   |
| Reference model ↔ contract equivalence                                      | **IMPLEMENTED + TESTED** | `Differential.t.sol`, generated corpus |

### Compliance

| Capability                                                   | State                 | Evidence                                 |
| ------------------------------------------------------------ | --------------------- | ---------------------------------------- |
| Both settlement assets registered as Cleanverse CVAs, ISSUED | **LIVE**              | `phase-03-cva-registration.json`         |
| RuleV2 configured and independently queryable                | **LIVE**              | `phase-03-cva-rulev2.json`               |
| RuleV2 change refuses a real delivery                        | **LIVE DEMONSTRATED** | TierTooLow, `0xc113ad33…`                |
| `verify_apass` result-code discipline, code 4 only           | **LIVE**              | `packages/cleanverse` + 22 tests         |
| Outage vs refusal kept distinct end to end                   | **LIVE**              | resolver tests + browser tests           |
| Attestation quorum above one                                 | **FUTURE**            | contract supports it; no second operator |
| Directly verifiable Cleanverse signatures                    | **FUTURE**            | would remove the intermediary entirely   |
| TEE-backed attestor                                          | **FUTURE**            | not built                                |

### Blocked, and by what

| Capability                                         | State                      | Blocker                                                    |
| -------------------------------------------------- | -------------------------- | ---------------------------------------------------------- |
| Distinct A-Pass buyer and seller                   | **EXTERNAL BLOCKER**       | `generate_apass` returns 403 for this credential — ASM-035 |
| Live `REBIND_RECEIVER` / `AUTHORIZED_SUBSTITUTION` | **EXTERNAL BLOCKER**       | needs a second A-Passed identity, same cause               |
| CCP validator pool on the asset chain              | **EXTERNAL BLOCKER**       | `validator/grant` refused on Base — ASM-037                |
| aUSDC as the cash leg                              | **EXTERNAL BLOCKER**       | sandbox faucet reverts on its own empty wallet — ASM-035   |
| Fiat off-ramp completion                           | **EXTERNAL BLOCKER**       | `RM_003 Unable to verify APass on chain` — ASM-010         |
| R2 evidence storage                                | **PARTIAL / NOT DEPLOYED** | repository-backed and labelled as such — ASM-039           |
| Mainnet                                            | **FUTURE**                 | no deployment, no claim                                    |

## Phase summary

| Phase    | Title                                    | State       | Gate                                                                                               |
| -------- | ---------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| Phase 00 | repository and truth lock                | PASS        | fresh clone → one bootstrap command → all empty-suite checks green                                 |
| Phase 01 | Cleanverse capability and seam proof     | BLOCKED     | real A-Token enters and exits the selected custody mode with exact conservation                    |
| Phase 02 | Wormhole transport proof                 | IN PROGRESS | Monad Testnet message verifies on Base Sepolia and the reverse, with replay rejected               |
| Phase 03 | restricted RWA fixture                   | IN PROGRESS | eligible transfer succeeds, ineligible transfer fails, AssetEscrow locks and releases exact amount |
| Phase 04 | settlement contracts and reference model | PASS        | reference model and contracts produce identical outcomes for generated traces                      |
| Phase 05 | Cleanverse Validator integration         | IN PROGRESS | real Cleanverse eligibility result changes commit outcome on-chain                                 |
| Phase 06 | full happy-path DvP                      | PASS        | CVA cash and restricted RWA settle under one intent, both chains publicly verifiable               |
| Phase 07 | Disposition Kernel                       | IN PROGRESS | every generated held case reaches an allowed terminal state or stays safely contested              |
| Phase 08 | evidence and verifier                    | NOT STARTED | new machine with only a settlement ID independently verifies the complete proof                    |
| Phase 09 | hardening                                | NOT STARTED | all security, recovery, and chaos gates pass with no undisclosed critical issue                    |
| Phase 10 | presentation proof                       | NOT STARTED | judge verifies both cases in under two minutes without private credentials                         |

## PRD v1.1 override acceptance additions

v1.0 is not complete until every row below is `PASS`. None can be attempted in phase 00, which
delivers no product logic. `tests/docs.test.ts` parses these directly from the override, so an
item added upstream fails the build until it appears here.

| Acceptance addition                                                 | State       | Gate phase |
| ------------------------------------------------------------------- | ----------- | ---------- |
| `ConduitRWACVA` is deployed on Arbitrum Sepolia.                    | IN PROGRESS | 03         |
| It is registered/issued as a Cleanverse CVA.                        | PASS        | 03         |
| RuleV2 is configured and independently queryable.                   | IN PROGRESS | 03         |
| Eligible RWA CVA transfer succeeds.                                 | PASS        | 03         |
| Ineligible RWA CVA transfer fails through CCP policy.               | NOT STARTED | 03         |
| Reservation prevents seller double-spend.                           | PASS        | 03         |
| Reservation cannot cancel after COMMIT.                             | PASS        | 04         |
| Held post-COMMIT RWA can be dispositioned once.                     | PASS        | 07         |
| Final demo uses the real registered CVA, not an ERC-3643-only mock. | NOT STARTED | 10         |
| API compatibility fields are not confused with canonical RuleV2.    | NOT STARTED | 05         |
| final web matches `design.md`.                                      | PASS        | 06         |
| staging runs on Cloudflare.                                         | PASS        | 09         |

The first row's wording is upstream text and is quoted verbatim so `tests/docs.test.ts` can
match it. The asset leg now deploys to **Base Sepolia**: Arbitrum Sepolia has no CCP deployment,
which [ADR-0009](./adr/0009-asset-chain-has-no-ccp-deployment.md) demonstrates two independent
ways. Base is the implementation network. It is not the architecture.

`design.md` remains a `HUMAN_GATE_DESIGN` deliverable.

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

Counts at the time of the phase 00 gate: 234 Vitest assertions across 5 files, 2 Foundry tests,
2 Playwright tests. That measurement is left as recorded. The gate has since grown to seventeen
steps — step 7 regenerates the settlement trace corpus and fails if the committed corpus drifts
from its generator — and current counts are in the phase 04 section.

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

Execution continued past this point under `CLAUDE_ONESHOT_CONDUIT.md`, on request.

---

## Phase 01 — Cleanverse capability and seam proof

**State:** IN PROGRESS — custody mode decided and proven on chain, blocked on obtaining a token

### Delivered

| Deliverable                 | Where                                                                           |
| --------------------------- | ------------------------------------------------------------------------------- |
| typed Cleanverse client     | `packages/cleanverse/src/client.ts`                                             |
| encryption helper           | `packages/cleanverse/src/encryption.ts`                                         |
| response parser             | `packages/cleanverse/src/schemas.ts`, `codes.ts`                                |
| doctor CLI                  | `packages/cli` — `conduit doctor`                                               |
| A-Pass normalization        | `packages/cleanverse/src/apass.ts`                                              |
| Validator reads             | `validatorVerify`, `validatorRules`, `validatorIsRegister`, `validatorIsPaused` |
| custom CVA registration     | `packages/cleanverse/src/registration.ts`                                       |
| CVI vault registrar         | `contracts/src/ConduitVaultRegistrar.sol`, live at `0x3FFd3944…` on Monad       |
| validator interface         | `contracts/src/interfaces/IAPassComplianceValidator.sol`                        |
| role/capability matrix      | machine-readable via `conduit doctor --json`                                    |
| ADR-001 cash custody result | [ADR-0001](./adr/0001-cash-custody-mode.md) — `Accepted`                        |

### Live evidence captured

Chain identity and Wormhole core deployment, against public testnet RPCs
([ADR-0006](./adr/0006-wormhole-registry-pin-and-live-chain-identity.md)):

```text
ok  rpc.monadTestnet               chain ID 10143
ok  rpc.baseSepolia                chain ID 84532
ok  wormhole.bytecode.monadTestnet 680 bytes at 0xaBf89de706B583424328B54dD05a8fC986750Da8
ok  wormhole.bytecode.baseSepolia  680 bytes at 0x79A1027a6A159502049F10906D333EC57E95F083
```

The credential authenticates and the eligibility matrix is real rather than assumed. Four
findings came out of exercising it, each recorded where it was found:

1. **Body encryption is per endpoint, not global** ([ADR-0008](./adr/0008-encryption-is-per-endpoint.md)).
   Sending an encrypted body to a plaintext endpoint produced an earlier, wrong conclusion that
   the `chain` argument was ignored. ADR-0007 is corrected at source.
2. **The API key arrives as unpadded Base64.** The decoder restores padding rather than
   rejecting a credential the platform actually issues.
3. **A-Pass is scoped per chain** (ASM-031). `0x83C130ed…065Bb` is `ACTIVE` on Monad and absent
   on Base: the live policy reverts `NoAPass(address)` for the same wallet. Eligibility on the
   cash leg does not imply eligibility on the asset leg.
4. **`generate_apass` returns HTTP 403 on both chains**, as a plain-text gateway response with
   no Cleanverse envelope. Recorded as `SANDBOX_AUTHORIZATION_MISMATCH`, not
   `FEATURE_UNAVAILABLE`: a control request proves the same `api-id` receives code `0000` from
   discovery in the same session, so the credential is valid and the role is not provisioned.

### Custody decided: direct contract custody, no fallback needed

[ADR-0001](./adr/0001-cash-custody-mode.md). The Monad policy refused `CashEscrow` outright, and
the refusal named the escrow rather than the token or the sender:

```text
canTransfer(aUSDC, eligibleEOA, escrow,      1)   before  NoAPass(0x1645BA08…)   after  true
canTransfer(aUSDC, escrow,      eligibleEOA, 1)   before  NoAPass(0x1645BA08…)   after  true
canTransfer(aUSDC, eligibleEOA, eligibleEOA, 1)   before  true                   after  true
```

The third line is the control. What changed between the two columns is two transactions from
`ConduitVaultRegistrar`, and three things had to be established first, none of them written down
anywhere:

- **The validator's address.** Not in either guide, not returned by discovery, and not the
  A-Token's policy — probing that policy for `isRegistered`, `complianceVerify`, `registerApass`,
  and `REGISTER_ROLE` returns an empty-data revert on all four. It came from chain state: a grant
  is a transaction and that transaction's `to` is the validator,
  `0xaC7e5179C2C7f03f209136886c172eb34F161792`.
- **The grant payload.** The gateway rejects unknown fields by name, so eliminating candidates
  left exactly `chain`, `address`, `owner_signature`. Granting to an EOA is refused with "Invalid
  contract owner signature" even when the EOA signs for itself, because the gateway reads
  `owner()` on the address — the grantee must be a contract.
- **The ordering.** `registerApass` reverts `PoolNotRegistered()` until `registerV2` has run.

The validator's RuleV2 has six fields, which confirms
[ADR-0010](./adr/0010-rulev2-has-six-fields-on-chain.md) on a second contract and a second chain.
The proof is the selector rather than a decode that happens to work: `0x7b6c63cb` is present and
the five-field `0xba62f533` is an empty-data revert. Both CCP guides declare five.

### Blocked on the token, not on the design

The gate is "real A-Token enters and exits the selected custody mode with exact conservation".
Custody is proven; there is no aUSDC to move. Three paths, all closed on provisioning of this
credential rather than on a missing platform capability:

```text
/faucet          code 0002  ERC20InsufficientBalance(0xc448042e…, balance 0)
                            the sandbox faucet's own source wallet is empty
deposit          executed on chain, refunded by Cleanverse ~40 blocks later. Reproduced twice.
                 query_txs classifies each pair non_whitelist_transfer / non_whitelist_refund
/generate_apass  HTTP 403 on both chains
```

`query_institution_txs` answers `institution address is empty`, the same fact from a third angle.
A deposit that executes and is then refunded by policy is the platform working correctly and
refusing us, which is why this is `SANDBOX_AUTHORIZATION_MISMATCH` and not a missing feature.
ASM-035, `docs/evidence/phase-01-cash-funding.json`.

---

## Phase 02 — Wormhole transport proof

**State:** IN PROGRESS — transport proven both directions, contract path not yet exercised live

### Delivered

`contracts/src/WormholeTransport.sol` is the shared base of all three settlement contracts. Every
inbound VAA passes seven checks before it can do anything:

| #   | Check                                                     | Failure mode it closes                                  |
| --- | --------------------------------------------------------- | ------------------------------------------------------- |
| 1   | peer emitter is set                                       | a live contract that accepts anyone                     |
| 2   | `parseAndVerifyVM` guardian quorum                        | forged message                                          |
| 3   | emitter chain matches the configured remote               | a real message from the wrong chain                     |
| 4   | emitter address matches the locked peer                   | a real message from an unrelated contract               |
| 5   | VAA hash not already consumed                             | replay                                                  |
| 6   | deployment ID, protocol version, destination chain        | cross-deployment and cross-version confusion            |
| 7   | finality at or above the level the message class requires | authentic message resting on reorganisable source state |

Check 7 is the phase 02 security correction. See
[ADR-0013](./adr/0013-finality-policy-for-economic-authorization.md).

### Gate evidence

Two-direction seam test, verified by `eth_call` against the real destination core contract rather
than an off-chain parse ([ADR-0012](./adr/0012-wormhole-transport-proven-both-directions.md)):

```text
Monad Testnet → Base Sepolia  tx 0x0de96ea098a7b7206c2451d145c7f23b35d788a5d75abe13c238f2a4faba81c8
                              VAA in 3.5s, valid=true on the Base core
Base Sepolia → Monad Testnet  tx 0x523aff0aed58dc41f5236f4b94e9dd324437bc9e99e60ba3f7139dc700c590be
                              VAA in 2.6s, valid=true on the Monad core
```

Both figures are transport latency at consistency level 200 and are labelled
`FAST_TRANSPORT_SEAM_EVIDENCE` in `docs/evidence/phase-02-wormhole-seam.json`. They are not
settlement latency. Conduit enforces `FINALIZED` for every message that authorizes value, and
Base's finalized path is roughly eighteen minutes. Both numbers are published because publishing
only the fast one would misrepresent settlement and publishing only the slow one would understate
the transport.

Finality profile, read back live from the deployed contracts:

```text
Monad Testnet   SettlementCoordinator   settlementFinality 2 (FINALIZED)  observationFinality 0
                CashEscrow              settlementFinality 2 (FINALIZED)  observationFinality 0
Base Sepolia    RWACVASettlementAdapter settlementFinality 2 (FINALIZED)  observationFinality 0
```

`contracts/test/Finality.t.sol` — 10 tests including a 256-run fuzz over every possible
consistency byte — proves the raw level is classified rather than compared, that instant and safe
cannot authorize a release under the production profile, that a rejected VAA is not consumed so a
downgrade attempt cannot strand the settlement, that no setter exists, that the profile is visible
in the code hash, and that all nine message classes require settlement finality.

### Known limitations

1. **The seam test emitter is an EOA.** What it establishes is Wormhole network availability and
   destination core acceptance. It does not exercise the locked peer-emitter path, the deployment
   ID, the protocol version, the settlement ID, the intent hash, or replay consumption, because
   those are enforced in `WormholeTransport` rather than in the core contract. The
   contract-to-contract run is part of the phase 06 DvP gate. Until then this phase is
   `IN PROGRESS`, not `PASS`.
2. **The testnet guardian set has one signer** (ASM-033). Quorum is genuinely verified on chain,
   but a 1-of-1 quorum is a testnet property and is stated as such wherever the proof appears.

---

## Phase 03 — restricted RWA fixture

**State:** IN PROGRESS — deployed and policy-bound, Cleanverse registration awaiting a signature

### Delivered

Live on Base Sepolia (84532), manifest `contracts/deployments/base-sepolia-0x9303f240.json`:

```text
ConduitRWACVA            0x6B70a81E010d8CEFE7c44701e490337661785644
RWACVASettlementAdapter  0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5
```

The token's address is deliberately unchanged across redeployments. It is the
subject of the Cleanverse owner signature, and replacing it invalidates a
signature a human has already produced — which happened once, in ADR-0011.
`DeployAssetAdapter` exists so the adapter can be replaced without touching it.

`ConduitRWACVA` calls the live CCP policy on every transfer. It holds no eligibility opinion of
its own: `policy.canTransfer` decides, and a refusal is a refusal. The adapter holds
`SETTLEMENT_ROLE` and nothing else, so a compromised adapter cannot mint, cannot change RuleV2,
and cannot move an unreserved balance.

Two corrections landed here rather than in review:

- **RuleV2 has six fields, not the five in the guide** ([ADR-0010](./adr/0010-rulev2-has-six-fields-on-chain.md)).
  The deployed struct still carries the deprecated `isBlackList` slot. A five-field decode threw
  on real data. A byte-level regression test now pins the layout.
- **The token had no `owner()`.** Cleanverse registration reads it, so registration would have
  failed _after_ a human had already signed the owner message. `Ownable2Step` was added and the
  token redeployed.

### Outstanding

`HUMAN_GATE_SIGN`. Registration through the documented `POST /atoken/register_atoken` needs an
EIP-191 signature from the owner key over the exact plaintext
`base0x6b70a81e010d8cefe7c44701e490337661785644`. The client is written and tested; only the
signature is missing. ASM-032 stays `OPEN` until a real request returns a terminal `applyStatus`.

An earlier claim that Method B had no endpoint was based on guessed route names and is retracted
in ADR-0011 and ASM-032. It was never a platform limitation, and recording it as one would have
been wrong.

---

## Phase 04 — settlement contracts and reference model

**State:** PASS

### Gate evidence

The gate is "reference model and contracts produce identical outcomes for generated traces".

`scripts/generate-settlement-traces.mjs` emits 400 traces through the TypeScript reference model
in `packages/domain`. `contracts/test/Differential.t.sol` replays every one against the deployed
Solidity and asserts the same outcome, leg by leg. Regenerating the corpus is step 7 of the gate,
so a generator change that would silently invalidate the corpus fails the build instead.

Four coordinator defects surfaced there after roughly ninety hand-written tests had passed:

1. a leg that was never prepared could be resolved;
2. a release was accepted on the abort path;
3. a held leg could never resolve again;
4. a held leg could be re-held.

Each is a state-machine hole that reads as correct in isolation and only appears when arbitrary
orderings are generated rather than imagined.

```text
CashEscrowTest               31
CodecsTest                   11
ConduitRWACVATest            27
DifferentialTest              1  (400 traces)
FinalityTest                 10
RWACVASettlementAdapterTest  18
SettlementCoordinatorTest    26
ToolchainPinTest              2
                            ---
                            126 Solidity tests, 0 failed

448 Vitest assertions across 15 files
gate PASSED: 17/17 steps green
```

Live on Monad Testnet (10143), manifest `contracts/deployments/monad-testnet-0x9303f240.json`:

```text
SettlementCoordinator  0xe1792F67472b5CA51F6B1133A995001eeA9f9FdD
CashEscrow             0x742bEe50781562C2aCb6049D02C4BAF43a4eCadf
ConduitVaultRegistrar  0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5
```

Both peers are locked in both directions. `setRemotePeer` is settable once and then permanently
locked, which is how the deployment ordering circularity is resolved without a window where
either side accepts a message from an address nobody chose.

### Known limitations

The contracts are deployed and unit-proven. No settlement has run end to end across both chains
yet: that is the phase 06 gate, and it needs the registered CVA from phase 03 and real aUSDC,
which ASM-035 currently blocks.

---

## Phase 05 — Cleanverse Validator integration

**State:** IN PROGRESS — compliance is attested rather than asserted; the live eligibility flip
still needs a funded settlement

### The booleans are gone

Four caller-supplied booleans used to decide whether value moved
([ADR-0014](./adr/0014-compliance-is-attested-not-asserted.md)). They were explicit parameters
rather than assumed `true`, which made the blocked paths reachable and testable, and that was the
right call for the state machine and the wrong thing to ship. A boolean records that a decision
exists and says nothing about who made it, when, about whom, or on what evidence.

`complianceFailed` was the worst of them: anyone could abort a healthy, in-window settlement that
both parties wanted to complete. Griefing rather than theft, which is the class that survives
review because nobody's balance changes.

Each is now a signed statement:

| Was                                                                                | Is                                                                                                                    |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `issueCommit(..., bool complianceFresh, ...)`                                      | a quorum attests both cash parties, bound to this settlement and these terms                                          |
| `issueAbort(..., bool deadlineMissed, bool complianceFailed, bool bilateral, ...)` | one `AbortGround`, each proving itself: the chain's clock, a signed refusal, or both parties' cancellation signatures |
| `releaseCash(vaa, bool eligible)`                                                  | the quorum's answer for the receiver, held rather than reverted on a shortfall                                        |
| `releaseAsset(vaa, bool receiverEligible)`                                         | the same, alongside the CCP policy check the token performs independently                                             |

Two properties are worth stating because both were bugs before they were features:

- **An unconfigured authority refuses everything.** The quorum starts at zero and
  `attesting >= 0` holds for an empty array, so the first version accepted any commit with no
  evidence at all — worse than no check, because the check appears to be there.
- **Refusal and silence are different states.** `_isEligible` and `_isRefused` are not negations.
  "The authority said no" is grounds for an abort; "the authority has not answered" is not.

### Cross-implementation evidence

The digest is implemented twice, independently, and pinned by a fixed vector:

```text
packages/domain/src/attestation.test.ts     0x4a31393a4953e7e12fa930c32075640385d3d73a7e1753962432db4c7ed32063
contracts/test/ComplianceAttestation.t.sol  0x4a31393a4953e7e12fa930c32075640385d3d73a7e1753962432db4c7ed32063
```

A 256-run fuzz asserts every field changes the digest, because a field left out of the preimage
is a field an attacker chooses freely.

Live on chain, all three contracts:

```text
signers 1   quorum 1   maxAttestationValidity 900s
compliance signer 0xEC16Ead9832292fEfc95Bc94C3D536Eed98ED26c, separate from the deployer
```

### Known limitations

1. **The quorum is 1-of-1** (ASM-036). Quorum is genuinely enforced and a signer attesting twice
   is rejected, but a one-signer threshold is a testnet property and is not a threshold
   guarantee.
2. **Half the gate is met.** "Real Cleanverse eligibility result changes commit outcome
   on-chain" now has a settlement attached to it: phase 06 committed against live
   `verify_apass` (result code 4) and `validator/verify` (`valid: true`) answers queried after
   the finality wait, signed, and accepted by the coordinator's own `verifyEligible`. What is
   still missing is the other direction — an answer of _not eligible_ changing the outcome on
   chain. That needs a controlled Cleanverse state transition on a live settlement, and it is
   the next piece of work rather than a demonstrated property.
3. **The escrow pool rule is still the placeholder** (ASM-034).

---

## Phase 06 — full happy-path DvP

**State:** PASS

### Gate evidence

The gate is "CVA cash and restricted RWA settle under one intent, both chains
publicly verifiable". Settlement
`0x940f1c152189bd0aa9803dceb671b676426cab36681ac6bdd492b1645f658858`, terminal
state `SETTLED`, read back from the deployed coordinator.

```text
Base Sepolia   reserveForSettlement    0xfc6f78733a2a511b984c59fc41d31ff775dbac6f3350c4e127310bb7338c1a8a
               prepareAsset            0xd0f77aa566ae21facbab89d3c2c0722217d309167cedd1a508e7dfd110cdf14d  seq 0
Monad Testnet  prepareCash             0xb6b7e9154f56a8d1eda2bd546a8ab2569bcebd4a55938f9cd55599551fb10239
               recordAssetPrepared     0x75c632e4c9cc637afb9b2961fc19bf8fd364699c38f8690ac26fa19d7b5d3864  READY
               issueCommit             0x56731cb9ada806e25c61d67edb313319c63dae6315f6ed0b2b45746933647866  seq 0
               releaseCash             0x1fa7e514a112761007ab54d7be3ee8892da382a657b9c4fad700a8216d1b6216
Base Sepolia   releaseAsset            0xe0fe0f7a90419368910377917e3af75299d2c37317d1fea0fec5cf3c4ea5a082
               reportResolution        0x1353a81c985a2fe1b0885e350725c497e0f7c34f81c57af9412cd8580186bb85  seq 1
Monad Testnet  recordLegResolved       0xb384e9baaf9834f823b16dad0212e4e56e5db155b4ddad08fa163160de8b2ae7  SETTLED
```

Both cross-chain messages were consumed at `FINALIZED`. The clean measurement is
the ASSET_RELEASED VAA: 1223 seconds from receipt to signature, against 1485 for
the same class in attempt 3. Neither was shortened, and an instant VAA would have
been refused by `_consume`.

Commit-time compliance was queried live after the finality wait, from
`verify_apass` (result code 4) and `validator/verify` (`valid: true`) on the cash
side and `verify_apass` on the asset side, and each signed attestation was put to
the verifying contract's own `verifyEligible` before the transaction that spent
it. `maxAttestationValidity` is an immutable 900 seconds and the finality wait is
longer than that, so a prepare-time answer could not have reached the commit.

Refusals, observed while the settlement was committed and unreleased:

```text
returnCash after COMMIT                              ReturnRequiresAbort
cancelReservation before the COMMIT VAA reached Base ReservationAlreadyAnnounced
replaying the ASSET_PREPARED VAA                     VaaAlreadyConsumed
replaying the COMMIT VAA at the adapter              VaaAlreadyConsumed
```

Conservation, and both statements hold whenever they are read rather than only
at the end of a run: the escrow's `totalEscrowed` equals its token balance, both
zero, and the seller's reserved balance is zero with the reservation
`committed` and `released`.

`docs/evidence/phase-06-dvp-attempt-4.json` assembles the settlement from all six
passes; `docs/evidence/artifacts/dvp-940f1c1521.log` is the append-only primary
record.

### Live deployment

```text
Monad Testnet   SettlementCoordinator    0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE
                CashEscrow               0x793c7a8f0c9549ee6cAf7EcC014DDafB7da601EB
Base Sepolia    ConduitRWACVA            0x7a78912533b43C483621200b4919806c0B855E5b  (cBOND2, registered, ISSUED)
                RWACVASettlementAdapter  0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE
```

The previous stack was replaced because [ADR-0016](./adr/0016-the-asset-seam-had-the-same-defects-and-two-worse-ones.md)
changed a struct, two signatures, and added a verifier view. Core contracts are
non-upgradeable, so a new version deploys separately.

### Known limitations

1. **The buyer and the seller are one key.** `generate_apass` returns 403 for
   this credential on both chains (ASM-035), so no second A-Passed EOA can exist
   and both intent signatures come from one wallet. Each leg moves value into and
   out of a settlement contract rather than between two wallets, so the two
   ERC-20 legs are self-transfers with a net wallet delta of zero and
   conservation is proven at the escrow balance and the reservation. A
   credential limitation, not a protocol one.
2. **The post-COMMIT compliance change and its disposition are both live.** A
   real issuer-controlled RuleV2 transition made the buyer ineligible after
   COMMIT, the live policy answered `TierTooLow`, delivery was refused, the bond
   reached HELD, the issuer restored the rule, and `resolveHeldAsset` delivered
   it — terminal SETTLED, and an independent verifier derives `SETTLED_FINAL`
   from the settlement ID alone. Proven twice: on generation 2
   ([phase-07-disposition-summary.md](./evidence/phase-07-disposition-summary.md),
   settlement `0x30aa1b73…`) and again on generation 3, the canonical deployment
   ([phase-07-disposition-gen3-summary.md](./evidence/phase-07-disposition-gen3-summary.md),
   settlement `0xc113ad33…`). See
   [phase-07-held-summary.md](./evidence/phase-07-held-summary.md) for the
   generation-1 run that reached HELD before a disposition path existed. Only
   `REVERIFY_AND_RESUME` is reachable; the other five FR-012 order types need
   the authority registry.
3. **Six passes over two and a half hours.** Five ended in a defect and four of
   those were in the runner. The protocol refused exactly once, correctly, when
   the runner presented one signer's opinion about one subject twice. The runner
   is now resumable and each pass repeats nothing, which is what made finishing
   possible without re-locking funds.

---

## Phase 07 — Disposition Kernel

**State:** IN PROGRESS — all six order types implemented, tested and
verifier-supported; not yet deployed or exercised live.

The gate is "every generated held case reaches an allowed terminal state or stays
safely contested with exact conservation". The state machine that does it is
complete and green; what is missing is a generation carrying it and a live run.

### Delivered

```text
contracts/src/AuthorityRegistry.sol           seven authority classes, timelocked
                                              grants, named policies with content
                                              hashes, per-type destination lists
contracts/src/DispositionController.sol       file → contest window → CONTESTED →
                                              adjudicate → execute
contracts/src/interfaces/IDispositionExecutor.sol
contracts/src/libraries/DispositionOrderLib.sol   EIP-712 order and resolution
contracts/src/libraries/DispositionTypes.sol      PRD FR-012's two enums
packages/domain/src/disposition.ts            the same order, independently
packages/verifier/src/disposition.ts          reconstruction from state alone
packages/verifier/src/refusal.ts              ADR-0019's evidence rule, enforced
```

`CashEscrow` and `RWACVASettlementAdapter` implement `IDispositionExecutor`;
`SettlementCoordinator` gains `LegOutcome.DISPOSED` and consumes PRD 7.3's
`DISPOSITION_RESOLVED`, which existed in the codec and had no producer until now.

### All six FR-012 order types

Each is exercised end to end against a hold reached the way a settlement reaches
one — reserve, prepare, commit, be refused — with every cross-chain message the
exact payload a production contract emitted (ADR-0015).

| Type                        | Destination rule                                | Proven by                                                            |
| --------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| `REVERIFY_AND_RESUME`       | must equal the current intended receiver        | `test_ReverifyAndResumeDeliversToThePartyTheIntentNamed`             |
| `REBIND_RECEIVER`           | same registered identity commitment, new wallet | `test_RebindReceiverDeliversToTheReplacementWalletAndNotTheOriginal` |
| `RETURN_TO_ELIGIBLE_SENDER` | the original sender, and only after a COMMIT    | `test_ReturnToEligibleSenderSendsCashBackAndTheCommitStaysHistory`   |
| `AUTHORIZED_SUBSTITUTION`   | an approved substitute _for this receiver_      | `test_AuthorizedSubstitutionDeliversToAnIssuerApprovedSubstitute`    |
| `OPERATOR_ASSISTED_OFFRAMP` | a registered gateway account                    | `test_OperatorAssistedOfframpMovesCashToTheRegisteredGatewayAccount` |
| `RESTRICTED_HOLD`           | a registered restricted custodian               | `test_RestrictedHoldMovesValueIntoRegisteredCustodyAndIsTerminal`    |

Every row has a matching negative test proving the destination is permissible for
that type and for no other.

### Conflict handling

`test_ARelayerRaceCannotDecideTheOutcome` files two valid, disagreeing,
authorized orders in both arrival orders and asserts the results are identical
and that nothing moved. That is the property the contest window exists for, and
[ADR-0020](./adr/0020-the-disposition-kernel-rests-orders-before-it-executes-them.md)
records why an immediate-execution kernel cannot satisfy PRD FR-012's last line.

### Live evidence

One settlement composed, checked, signed, prepared, committed, released and
settled entirely from the deployed surface. Nothing was intercepted: the RPCs
are the public endpoints, the compliance answers came from Cleanverse through
the Worker, the guardian signatures came from the guardian set, and every
transaction was broadcast and mined.

Two of them, in fact. The first found four defects and needed help past them;
the second ran start to finish with none.

```text
run 1        0x3f9b03f41d6d8af9d87c0d4a9db50297beebf3f3596d577ef0c1f3d83fd3d385
             SETTLED · SETTLED_FINAL, 18 of 18 checks
             found D-07 and D-08 below, and needed two messages recorded by hand

run 2        0xd46775dc9cbcdfdd4f60df1c9de4de15fc609b29f47f1d3d1860e398c33aca77
             SETTLED · SETTLED_FINAL, 18 of 18 checks
             composed, signed, prepared, committed, released and settled with no
             intervention of any kind, in 42 minutes of which 22 were waiting
             for Base economic finality

artifact     docs/evidence/phase-06-browser-dvp.json           (run 2)
verification docs/evidence/verification-d46775dc9c.json        (run 2)
             docs/evidence/verification-3f9b03f41d.json        (run 1)
```

Nine transactions per run, each fetched back and required to have succeeded and
to have been sent to one of this deployment's own contracts. Run 2's four
messages were all FINALIZED and each consumed exactly once: ASSET_PREPARED 8
after 1343 seconds, CASH_PREPARED 4, COMMIT 3 after 3, ASSET_RELEASED 9 after 1107. The workspace offered nothing at all until the guardian set had signed.

### Defects the live run found, which the deterministic suite could not

Both are about a database and a receipt that a scripted chain does not have.

**D-07. The sequence was recorded at broadcast.** Wormhole keeps a sequence in
an event, so the browser tells the server where the message is — and it was
telling it before the transaction was mined. The server correctly refused with
`receipt_unavailable` and the number was gone. Writes now carry an `onConfirmed`
hook that runs once, on a successful receipt, before observation.

**D-08. The message row has a foreign key the browser had not satisfied.**
`conduit.settlements` is written by the indexer and does not exist for a
settlement composed thirty seconds ago. The endpoint now reads `settlementOf`
from the coordinator and writes the row from what the chain says.

Two more surfaced while the run was in flight: the browser and the Worker do not
read the same node, so the recording is retried across RPC lag; and a Wormhole
emitter is thirty-two bytes, so storing the twenty-byte sender put every live
message in the table twice under two spellings.

### Test counts

```text
contracts   281 passing   (was 208)
  DispositionKernel.t.sol            19   the six order types
  DispositionInvariants.t.sol        26   the ways they must not work
  DispositionConflicts.t.sol         14   CONTESTED, adjudication, the race
  DispositionOrderLib.t.sol           9   cross-language digest vectors
  SettlementScopedAccounting.t.sol    5   one wallet, two settlements
vitest      604 passing   (was 572)
  packages/domain/src/disposition.test.ts     10
  packages/verifier/src/disposition.test.ts   12
  packages/verifier/src/refusal.test.ts        7
```

### Protocol defect found and fixed

**D-06.** `ConduitRWACVA._update` subtracted the releasing reservation from
`_reservedOf` after `releaseReservation` had already decremented it. Unreachable
with one reservation; with a smaller second one it underflows and the release
reverts, leaving held value no authority can free. The deployed seller is one
settlement away from that shape. See the threat register and
`contracts/test/SettlementScopedAccounting.t.sol`.

### Verifier support

From a settlement ID and two RPC URLs the verifier now reconstructs the
disposition order that won, the authorities that signed it, their registered
classes, the policy content those orders bound, the destination, the amount and
the compliance digest checked at execution — all from contract state, with no log
range to scan. It classifies:

```text
SETTLED_FINAL                 the intent's own parties received the value
DISPOSITION_FINAL             an authority redirected it under PRD FR-012
RESTRICTED_HOLD_FINAL         it ended in registered restricted custody
CONTESTED                     two authorities disagree; nothing may move
HELD_PENDING_DISPOSITION      committed, undelivered, no case resolved it
SETTLED_PENDING_VERIFICATION  SETTLED on chain, a check did not pass here
NOT_SETTLED                   the coordinator's own state is not SETTLED
```

None of those is a Solidity enum. `DispositionController.CaseState` is; the
settlement-level outcomes are derived, exactly as `SETTLED_FINAL` is under
[ADR-0017](./adr/0017-settled-is-on-chain-settled-final-is-derived.md).

### ASM-010 resolved

Fiat Ramp is granted for this credential and SELL quoting is live on five
networks with real quote tokens and real pricing. The hosted widget refuses with
`RM_003 Unable to verify APass on chain` — PRD 5.5's third precondition, and the
same blocker as ASM-035. Separately, neither settlement asset is a listed ramp
asset and Monad is not a ramp network. `docs/evidence/asm-010-fiat-ramp.json`.

### Known limitations

1. **Not deployed.** The executors gained an entry point and the contracts are
   non-upgradeable, so the kernel needs generation 3. Nothing here has run
   against a live chain.
2. **`OPERATOR_ASSISTED_OFFRAMP`'s external half cannot complete.** The on-chain
   disposition moves the held units to a registered gateway account and is real.
   The fiat leg after it is blocked on ASM-035 and on the ramp's asset listing,
   both recorded above. No fiat settlement is claimed anywhere.
3. **PRD 7.1's `CONTESTED` settlement state is never entered on chain.** Driving
   it from a remote leg's contested case would need a message PRD 7.3 does not
   define, and ADR-0015 forbids inventing one. It is a verifier classification;
   ADR-0020 records the reasoning.
4. **`REBIND_RECEIVER` and `AUTHORIZED_SUBSTITUTION` are unexercised against a
   real second identity.** Both work against registered test wallets. A live
   demonstration needs a second A-Passed identity, which ASM-035 blocks.

---

## Participant web flow

**State:** PASS
**Surface:** <https://conduit.timjosh507.workers.dev>

A participant now composes, checks, signs, prepares, commits, releases and
disposes a settlement from a browser. No CLI is required at any point, and no
step is simulated: every button corresponds to a call on a deployed contract.

### What the browser does

```text
connect wallet          EIP-6963 discovery, silent restore, per-action chain switch
live eligibility        Cleanverse, through the Worker, with the API key server-side
build terms             settlement id recomputed from the terms, in the browser
EIP-712 signature       recovered locally and again on the server before storage
counterparty signature  from their own machine, over the same digest
reserve + announce      seller, Base Sepolia, two transactions, each observed
approve + escrow        payer, Monad Testnet, allowance read rather than assumed
wait                    Base economic finality, refused below FINALIZED on chain
consume ASSET_PREPARED  permissionless, and the settlement becomes READY
fresh compliance        asked again after the wait, never reused from preparation
COMMIT                  simulated against the coordinator before a wallet is asked
release cash            permissionless, with a proof the escrow itself accepts
release asset           permissionless, and it holds rather than reverts if refused
report + record         the outcome crosses back and the settlement is terminal
```

### The action resolver

`apps/web/src/actions.ts` is a pure function from canonical protocol state to one
next action and whether the connected account may take it. Its inputs are the
coordinator's own record, the escrow leg, the token's reservation, the adapter's
binding, the observed messages, and the account. The projection supplies the
terms and the two intent signatures — both of which the coordinator re-verifies
on chain — and nothing else, because application database state never authorizes
value movement.

Thirty-three unit tests walk it. Every branch that enables a value-moving button
has one, including the two the product exists to keep apart: a refused
participant and an unanswered check.

### The attestation layer is a trust assumption, and is labelled as one

Every value-moving call demands a quorum of compliance attestations signed by an
address the contract's registered signer set contains. The contract proves an
authorised signer asserted eligibility and bound it to this settlement, this
intent and a window it cannot widen. It cannot prove the signer asked Cleanverse.

This deployment runs one Conduit-operated signer at quorum 1, so compromise of
that key is compromise of the eligibility verdict for every uncommitted
settlement. It is not compromise of custody. Recorded as **T-08** and **T-09**,
`ACCEPTED` with a written waiver, stated on `/app/system`, on the verifier page,
in the verifier package README and in the evidence manifest. Nothing in this
repository describes the attestation layer as trustless.

Multiple independent attestors, a threshold quorum, TEE-backed attestors and
directly verifiable Cleanverse signatures are `FUTURE`. `setComplianceQuorum` and
`addComplianceSigner` are live owner functions on the deployed contracts; what is
missing is a second independent operator.

### The compliance authority moved into the Worker

Every value-moving call demands a quorum of attestations signed by an address the
contract's registered signer set contains. A browser cannot produce one, and a
participant who could would be authorising their own settlement. The Worker holds
that key and signs eligibility answers Cleanverse gave — nothing else.
[ADR-0021](./adr/0021-the-web-surface-holds-a-compliance-key-and-nothing-else.md)
states precisely what that key cannot do: it cannot move a token, sign an intent,
decide a settlement, or release a leg without a canonical COMMIT already on
chain.

Verified against the deployed generation-3 coordinator: the signer is registered,
the quorum is one, and `verifyEligible` returns `true` for a proof the production
endpoint minted.

### Confirmed is not observed

`apps/web/src/client/tx.ts` runs every write through six named rungs and refuses
to call the last one reached until two things hold: the RPC reports
`latest >= N` for the receipt's block, and the effect the step was for is present
in contract state. A failure is classified before it is explained —
`RPC_STATE_LAG` and `CONTRACT_REVERT` produce the same silence at the call site
and mean opposite things.

### Live evidence

One settlement composed, checked, signed, prepared, committed, released and
settled entirely from the deployed surface. Nothing was intercepted: the RPCs
are the public endpoints, the compliance answers came from Cleanverse through
the Worker, the guardian signatures came from the guardian set, and every
transaction was broadcast and mined.

Two of them, in fact. The first found four defects and needed help past them;
the second ran start to finish with none.

```text
run 1        0x3f9b03f41d6d8af9d87c0d4a9db50297beebf3f3596d577ef0c1f3d83fd3d385
             SETTLED · SETTLED_FINAL, 18 of 18 checks
             found D-07 and D-08 below, and needed two messages recorded by hand

run 2        0xd46775dc9cbcdfdd4f60df1c9de4de15fc609b29f47f1d3d1860e398c33aca77
             SETTLED · SETTLED_FINAL, 18 of 18 checks
             composed, signed, prepared, committed, released and settled with no
             intervention of any kind, in 42 minutes of which 22 were waiting
             for Base economic finality

artifact     docs/evidence/phase-06-browser-dvp.json           (run 2)
verification docs/evidence/verification-d46775dc9c.json        (run 2)
             docs/evidence/verification-3f9b03f41d.json        (run 1)
```

Nine transactions per run, each fetched back and required to have succeeded and
to have been sent to one of this deployment's own contracts. Run 2's four
messages were all FINALIZED and each consumed exactly once: ASSET_PREPARED 8
after 1343 seconds, CASH_PREPARED 4, COMMIT 3 after 3, ASSET_RELEASED 9 after 1107. The workspace offered nothing at all until the guardian set had signed.

### Defects the live run found, which the deterministic suite could not

Both are about a database and a receipt that a scripted chain does not have.

**D-07. The sequence was recorded at broadcast.** Wormhole keeps a sequence in
an event, so the browser tells the server where the message is — and it was
telling it before the transaction was mined. The server correctly refused with
`receipt_unavailable` and the number was gone. Writes now carry an `onConfirmed`
hook that runs once, on a successful receipt, before observation.

**D-08. The message row has a foreign key the browser had not satisfied.**
`conduit.settlements` is written by the indexer and does not exist for a
settlement composed thirty seconds ago. The endpoint now reads `settlementOf`
from the coordinator and writes the row from what the chain says.

Two more surfaced while the run was in flight: the browser and the Worker do not
read the same node, so the recording is retried across RPC lag; and a Wormhole
emitter is thirty-two bytes, so storing the twenty-byte sender put every live
message in the table twice under two spellings.

### Test counts

```text
vitest       752 assertions across 32 files
playwright    69 browser tests against the deployed surface
              of which 11 drive the write flow against a scripted chain
              and  4 cover held value and the disposition kernel
```

The scripted chain advances only by decoding the selector the browser encoded, so
an app that skips a call never moves the state and the assertion fails. A live
run against both testnets is `apps/web/qa/live.spec.ts`, opt-in behind
`CONDUIT_LIVE=1`.

### Known limitations

1. **The compliance authority runs in the same Worker as the read surface.** A
   production topology separates it; nothing depends on the co-location, and the
   endpoint contract is the boundary. ADR-0021.
2. **`REBIND_RECEIVER` and `AUTHORIZED_SUBSTITUTION` cannot be filed against a
   live destination.** Both are offered and both read authority correctly; ASM-035
   means no second A-Passed identity exists to name.
3. **Evidence is served from the repository, not from object storage.** The page
   says so and names the path of every package. ASM-039 stays open; replacing the
   storage changes where the bytes live and nothing about what they mean.

---

## Product journey — one session, and proof you can click

**State:** PASS
**Surface:** <https://conduit.timjosh507.workers.dev>

No protocol scope was added. Every contract, every message, every settlement and
every attestation is exactly what the participant web flow left. What changed is
who owns state in the browser, what the console leads with, and whether a reader
can check a claim without opening a JSON file.

### One participant session

Four surfaces used to discover wallets, restore accounts, read balances and ask
Cleanverse independently — the top-bar control, the sidebar strip, the composer
and the workspace. Each was correct alone; together they were four sources of
truth for one fact, and two of them could render different answers on the same
screen while an account changed.

`apps/web/src/client/session.ts` now owns identity, connection, per-chain
eligibility, balances, activity and orientation. Views subscribe and none of them
fetches for itself. Reads are coalesced by key, eligibility carries a five-minute
TTL, and a `BroadcastChannel` carries account changes and protocol movement
between tabs. It wraps the proven `wallet` singleton rather than replacing it:
`tx.ts` is the code that has driven real settlements on two chains, and a session
refactor is not a reason to touch it.

[ADR-0022](./adr/0022-one-participant-session-owns-identity-and-nothing-owns-a-chain.md)
records the decision, including the one that was easiest to get wrong.

### Conduit still has no active network

A settlement uses both chains at once, so "the app is on Base" is never a true
statement about anything. The session holds no selected chain, the account panel
offers no network picker, and no view branches on where the wallet points. The
panel states both chains, both verdicts, and where the wallet currently is —
information, not a mode. The switch belongs to the action, as its own rung in
`runWrite`.

Two tests hold that line from opposite directions: `settlement.spec.ts` asserts a
Base action asks the wallet to move to Base, and `wallet.spec.ts` asserts that
merely opening the account panel asks for nothing.

### The console leads with the participant

`/app` opened with four counters and the newest rows in the projection, which is
a fair summary of a database and a poor answer to the question a participant
arrives with. `GET /api/participant` answers the real one: the settlements this
address is a party to, which side it is on, and what each is waiting for. The
deployment-wide numbers stay, below.

Disconnected, the page says what the console is for and offers the routes that
need no wallet. A judge reading the proof is never asked to install anything.

### Orientation, twice, and never again

A first visit explains what Conduit is. A first connection explains that two
chains are in play at once and names what Cleanverse answered for this wallet.
The refused branch is the one that matters: it says the refusal is Cleanverse's
answer rather than a Conduit error, and offers the proven settlement, the
compliance-change case and the verifier. Marked seen when it is shown with a real
answer, not when it is dismissed.

### Activity outlives the page

Base finality on this deployment runs 999–1485 seconds. Every write now reports
each rung to the session, keyed by settlement and step, and a drawer renders it
on every route — so opening the verifier during the wait does not lose sight of a
reservation made ninety seconds ago. The workspace still paints its own ladder.
The drawer authorises nothing and is never read back as evidence.

### Proof you can click

- Every Wormhole message on a settlement page now links to the transaction that
  published it, on the chain that emitted it, alongside the signed VAA it
  produced.
- [`docs/onchain.md`](./onchain.md) indexes **57 transactions** across five runs.
  Not one of them is transcribed: `scripts/build-onchain-index.mjs` reads each
  hash out of an artifact, asks both chains, and takes the chain, block, status
  and callee from the receipt. A hash neither chain knows stays in the document
  as `NOT_FOUND`, and an RPC that cannot be reached produces `UNREACHABLE` and
  refuses to overwrite a good record with a worse one.
- That check is gate step 18. A link that stops resolving fails the build.
- `/app/deployments` links the generation history, the transaction index and the
  machine-checked verification record.

### A defect the session refactor exposed

The HELD panel cleared its host, awaited four chain reads, then appended. Two
overlapping paints — routine, since the workspace re-renders on a ten-second poll
— interleaved their clear and their append, and rendered the panel twice with two
sets of order buttons in front of an authority about to file something
irreversible. A paint token per host now makes the stale paint discard its work.
Found by `settlement.spec.ts`, not by reading.

### Test counts

```text
vitest       762 assertions across 32 files
foundry      281 tests across 19 suites
playwright    78 browser tests against the deployed surface
              of which 8 are the four judge journeys, walked end to end
gate         19/19 steps green
```

Journey D is new: it connects a wallet the sandbox refuses, and asserts the
orientation names the refusal, the overview leads with the participant, the
identity survives navigation with no second prompt, and the sidebar reports it
without offering a second way to connect.

### Known limitations

1. **The activity drawer is a browser's record of its own writes.** It survives
   navigation and reaches other tabs; it does not survive a closed browser, and
   it is not evidence. The chain is.
2. **`/api/participant` reads the projection.** A settlement composed a minute
   ago is not in it, and the empty state says so rather than implying absence.
3. **The transaction index covers curated runs, not every transaction ever
   sent.** The five runs are named in the script; funding, wiring and faucet
   transactions live in their own artifacts under `docs/evidence`.

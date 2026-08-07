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
| Phase 01 | Cleanverse capability and seam proof     | BLOCKED     | real A-Token enters and exits the selected custody mode with exact conservation                    |
| Phase 02 | Wormhole transport proof                 | IN PROGRESS | Monad Testnet message verifies on Base Sepolia and the reverse, with replay rejected               |
| Phase 03 | restricted RWA fixture                   | IN PROGRESS | eligible transfer succeeds, ineligible transfer fails, AssetEscrow locks and releases exact amount |
| Phase 04 | settlement contracts and reference model | PASS        | reference model and contracts produce identical outcomes for generated traces                      |
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
| `ConduitRWACVA` is deployed on Arbitrum Sepolia.                    | IN PROGRESS | 03         |
| It is registered/issued as a Cleanverse CVA.                        | NOT STARTED | 03         |
| RuleV2 is configured and independently queryable.                   | IN PROGRESS | 03         |
| Eligible RWA CVA transfer succeeds.                                 | NOT STARTED | 03         |
| Ineligible RWA CVA transfer fails through CCP policy.               | NOT STARTED | 03         |
| Reservation prevents seller double-spend.                           | NOT STARTED | 03         |
| Reservation cannot cancel after COMMIT.                             | PASS        | 04         |
| Held post-COMMIT RWA can be dispositioned once.                     | NOT STARTED | 07         |
| Final demo uses the real registered CVA, not an ERC-3643-only mock. | NOT STARTED | 10         |
| API compatibility fields are not confused with canonical RuleV2.    | NOT STARTED | 05         |
| final web matches `design.md`.                                      | NOT STARTED | 06         |
| staging runs on Cloudflare.                                         | NOT STARTED | 09         |

The first row's wording is upstream text and is quoted verbatim so `tests/docs.test.ts` can
match it. The asset leg now deploys to **Base Sepolia**: Arbitrum Sepolia has no CCP deployment,
which [ADR-0009](./adr/0009-asset-leg-moves-to-base-sepolia.md) demonstrates two independent
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

1. **Body encryption is per endpoint, not global** ([ADR-0008](./adr/0008-per-endpoint-body-encryption.md)).
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
RWACVASettlementAdapter  0xC0A9Eb5F9D1fd0D4264564B1C7A1ed69946E3170
```

`ConduitRWACVA` calls the live CCP policy on every transfer. It holds no eligibility opinion of
its own: `policy.canTransfer` decides, and a refusal is a refusal. The adapter holds
`SETTLEMENT_ROLE` and nothing else, so a compromised adapter cannot mint, cannot change RuleV2,
and cannot move an unreserved balance.

Two corrections landed here rather than in review:

- **RuleV2 has six fields, not the five in the guide** ([ADR-0010](./adr/0010-rulev2-has-six-fields.md)).
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
SettlementCoordinator  0x1491A25Fc93778ECcb69BCec96495c6f12c686d1
CashEscrow             0x1645BA0873118A997Bd39718A82dd268E46D3B48
```

Both peers are locked in both directions. `setRemotePeer` is settable once and then permanently
locked, which is how the deployment ordering circularity is resolved without a window where
either side accepts a message from an address nobody chose.

### Known limitations

The contracts are deployed and unit-proven. No settlement has run end to end across both chains
yet: that is the phase 06 gate, and it needs the registered CVA from phase 03 and the compliance
attestation from phase 05.

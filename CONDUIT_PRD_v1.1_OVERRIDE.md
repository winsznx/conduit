# Conduit PRD v1.1 Architecture Override

**Status:** REQUIRED OVERRIDE  
**Applies to:** `CONDUIT_PRD_v1.0.md`  
**Date:** 2026-08-07  
**Reason:** New official Cleanverse Compliance Protocol (CCP) CVA Integration Guide supplied after v1.0 was written.

This file overrides conflicting sections of `CONDUIT_PRD_v1.0.md`. Everything not explicitly changed here remains binding.

---

## 1. New source-of-truth priority

For CVA issuance, transfer policy, and RuleV2 semantics, use this order:

1. Cleanverse CCP CVA Integration Guide supplied 2026-08-07
2. Cleanverse API V5.6
3. This PRD v1.1 override
4. `CONDUIT_PRD_v1.0.md`
5. accepted ADRs
6. code/tests/README

Do not use legacy Rule interfaces when RuleV2 interfaces are available.

---

## 2. Material architecture change

### OLD

Arbitrum leg:

```text
generic ERC-3643-style restricted security token
→ AssetEscrow
→ generic issuer identity registry
```

### NEW

Arbitrum leg:

```text
Cleanverse-native RWA CVA
→ custom CVA contract using RuleV2
→ Cleanverse CCP policy.canTransfer(...)
→ token-native Conduit reservation
→ Wormhole commit
→ direct compliant transfer to buyer
```

The RWA is now an actual Cleanverse Verified Asset, not merely a transfer-restricted fixture.

Conduit therefore proves:

```text
CVA cash on Monad
settles
CVA RWA ownership on Arbitrum
under one cross-chain DvP commitment
```

This makes Cleanverse load-bearing on both economic legs.

---

## 3. Confirmed new Cleanverse capabilities

The new guide confirms:

- CVA is the native compliant asset standard of CCP.
- CVA can represent a stablecoin, RWA, or other ERC-20 asset.
- Every CVA transfer is gated through CVI and the RuleV2 policy engine.
- RuleV2 uses Group, Sub-Group, Tier, Sub-Tier, and country bitmap restrictions.
- Multiple RuleV2 rules are evaluated using OR semantics.
- Developers may either:
  - launch a CVA through the API, or
  - deploy a custom CVA contract and register it with Cleanverse.
- Custom CVA contracts may contain custom business logic.
- Custom contracts must call `policy.canTransfer(token, from, to, amount)` before transfers.
- Custom CVA contracts may expose RuleV2 management wrappers.
- Custom CVAs can support mint/burn and AccessControl.
- Registration is authenticated by an EIP-191 `personal_sign` signature over lowercase `chain + atoken_address`.
- After registration, RuleV2 can be managed from the token through `*FromToken` policy entry points.
- The current API may still expose legacy country arrays while RuleV2 represents them as `poolCountryBitmap`.
- `is_black_list` is deprecated in RuleV2 semantics; the compatibility API may still accept it.

---

## 4. RuleV2 model

Canonical on-chain structure:

```solidity
struct RuleV2 {
    bytes2 allowedGroup;
    bytes2 allowedSubGroup;
    uint8 minTier;
    uint8 minSubTier;
    uint256 poolCountryBitmap;
}
```

Semantics:

- `allowedGroup == 0x0000`: unrestricted group
- `allowedSubGroup == 0x0000`: unrestricted subgroup
- `minTier == 0`: unrestricted tier
- `minSubTier == 0`: unrestricted subtier
- `poolCountryBitmap == 0`: unrestricted country
- multiple rules: OR
- fields within one rule: conjunctive requirements as enforced by CCP policy

The application layer must normalize legacy API country arrays into an internal RuleV2 representation but must not invent country-bit positions. Use the official CCP policy or supplied contract/interface as source of truth.

---

## 5. New RWA token: `ConduitRWACVA`

Deploy on Arbitrum Sepolia.

Purpose:

- demo tokenized bond / private-credit unit;
- registered as a real Cleanverse CVA;
- RuleV2-gated;
- token-native reservation for cross-chain DvP.

Required interface:

```solidity
interface IConduitRWACVA {
    struct Reservation {
        address owner;
        uint256 amount;
        bytes32 settlementId;
        uint64 createdAt;
        bool committed;
        bool released;
        bool cancelled;
    }

    function reserveForSettlement(
        bytes32 settlementId,
        uint256 amount
    ) external;

    function cancelReservation(
        bytes32 settlementId
    ) external;

    function releaseReservation(
        bytes32 settlementId,
        address receiver,
        bytes calldata commitVaa,
        bytes calldata complianceProof
    ) external;

    function reservedBalanceOf(address owner)
        external
        view
        returns (uint256);

    function availableBalanceOf(address owner)
        external
        view
        returns (uint256);
}
```

### Reservation design

Do not transfer the RWA into `AssetEscrow`.

Instead:

1. seller keeps nominal ownership before commit;
2. token records a settlement reservation;
3. reserved units become non-transferable through normal ERC-20 paths;
4. after canonical COMMIT, the reserved units transfer directly from seller to verified buyer;
5. `policy.canTransfer(address(this), seller, buyer, amount)` is checked at the actual transfer;
6. pre-commit ABORT removes the reservation;
7. post-COMMIT cancellation is impossible;
8. if buyer becomes ineligible after COMMIT, reservation remains HELD until the Disposition Kernel supplies an eligible destination.

The token MUST enforce:

```text
normal transferable balance =
balanceOf(owner) - totalReserved(owner)
```

No normal transfer may spend reserved units.

### `_update` requirement

The token must call Cleanverse policy before every actual mint/burn/transfer as required by the template. Reservation bookkeeping alone is not an ERC-20 transfer and therefore does not create a new holder.

For an actual transfer:

```solidity
if (!policy.canTransfer(address(this), from, to, amount)) {
    revert TransferNotAllowed();
}
```

Then apply reservation constraints and execute `super._update(...)`.

The implementation order must be reviewed carefully so mint/burn behavior matches CCP requirements.

---

## 6. Custom CVA registration workflow

The agent prepares all code and API payloads. The user performs wallet-required actions.

Workflow:

```text
1. agent builds and tests ConduitRWACVA
2. user deploys contract on Arbitrum Sepolia
3. agent reads deployed address and bytecode
4. agent generates exact lowercase registration message:
   "arbitrum" + lowercase(atoken_address)
5. user signs message with the contract owner wallet using EIP-191 personal_sign
6. agent submits encrypted register CVA API request
7. agent polls Query Apply Status until terminal
8. if ISSUED:
   - resolve policy contract
   - configure RuleV2
   - verify rules on-chain/API
9. agent proves eligible transfer succeeds
10. agent proves ineligible transfer fails
11. agent proves reservation prevents double-spend
```

Never ask the user to paste a private key into chat or source files.

---

## 7. Rule management

Preferred for custom RWA CVA:

```solidity
setRuleV2(...)
addRuleV2(...)
removeRuleV2(...)
getRulesV2(...)
```

These wrappers call:

```solidity
policy.setRuleV2FromToken(...)
policy.addRuleV2FromToken(...)
policy.removeRuleV2FromToken(...)
policy.getRulesV2(address(this))
```

Use `DEFAULT_ADMIN_ROLE` or equivalent for management.

Rule changes must be:

- audited;
- confirmed on-chain before another mutation;
- snapshotted into the settlement deployment manifest;
- versioned in Conduit;
- reflected in future settlement policy hashes.

Existing signed intents bind their policy snapshot/hash and must not silently inherit changed economic terms. Final recipient transfer still uses current CCP policy.

---

## 8. Cash leg strategy

### Preferred

Use an existing real sandbox CVA/A-Token on Monad discovered from Cleanverse.

Run the original custody spike:

```text
buyer
→ actual sandbox CVA
→ CashEscrow
→ verified seller receiver
```

### New deterministic fallback

If the existing sandbox CVA cannot be held by CashEscrow because the contract itself cannot satisfy CCP transfer policy, do NOT immediately fall back to a trusted institutional settlement wallet.

First attempt a Cleanverse-native custom cash CVA:

```text
ConduitSettlementCVA
→ Method B custom CVA
→ RuleV2
→ token-native cash reservation
```

It uses the same reservation concept as `ConduitRWACVA` so funds remain in the payer wallet but cannot be spent while reserved.

This fallback is admitted only if:

- hackathon credentials allow CVA registration on Monad;
- Cleanverse approves the CVA;
- the test token is described honestly as a sandbox settlement CVA;
- no claim of fiat backing is made unless demonstrated.

If neither direct custody nor custom CVA reservation is possible, open an ADR and use an institutional settlement wallet only with an explicit custody trust disclosure.

---

## 9. Asset-side compliance

For `ConduitRWACVA`, the token's CCP policy is the authoritative transfer gate.

Conduit MAY also register the Conduit settlement host with the Validator module to prove protocol-level eligibility rules, but Validator registration does not replace token-level `policy.canTransfer`.

Required final release checks:

```text
canonical COMMIT proof valid
AND
settlement intent matches
AND
reservation exists and is unspent
AND
current Conduit compliance attestation valid
AND
CVA policy.canTransfer(...) == true
```

---

## 10. Revised asset-side contracts

Replace the generic RWA fixture architecture with:

```text
ConduitRWACVA.sol
IATokenPolicy.sol
RuleV2Codec.sol
RWACVASettlementAdapter.sol
WormholeTransport.sol
DispositionController.sol
ComplianceAttestationVerifier.sol
```

`AssetEscrow.sol` is no longer required for the RWA CVA if token-native reservation is implemented correctly.

Keep an `IAssetSettlementAdapter` boundary so other regulated assets can be added later without modifying the settlement coordinator.

---

## 11. Revised DvP state

The asset leg uses:

```text
UNRESERVED
RESERVED
COMMITTED
RELEASED
HELD
CANCELLED
DISPOSED
```

Invariant:

```text
reserved amount may be:
- cancelled only before canonical COMMIT;
- released only after canonical COMMIT;
- held after COMMIT if destination is ineligible;
- dispositioned exactly once.

It can never return to freely spendable seller balance after COMMIT.
```

This closes the same double-payout class as the cash-side no-refund-after-commit invariant.

---

## 12. Stronger final proof

Happy path:

```text
Monad:
real sandbox CVA cash locked/reserved

Arbitrum:
real Cleanverse-registered RWA CVA reserved in seller balance

Wormhole:
two PREPARED states
one canonical COMMIT

Final:
cash → eligible seller
RWA CVA → eligible buyer

Proof:
both CVA policies enforced
same settlementId
same intentHash
0 double spend
0 post-commit refund
0 transfer to ineligible receiver
```

Failure path:

```text
buyer active at prepare
buyer RWA receiving eligibility becomes invalid
canonical commit exists
RWA transfer fails closed under CCP policy
reserved RWA remains HELD
cash cannot be refunded after commit
Disposition Kernel rebinds/substitutes eligible RWA receiver
held amount released exactly once
```

This is stronger than a generic ERC-3643 demo because the failure is enforced by the sponsor's native CVA transfer policy.

---

## 13. Cloudflare + Supabase production stack override

Application/runtime stack:

```text
Next.js App Router
@opennextjs/cloudflare
Cloudflare Workers
Supabase Postgres
Cloudflare Hyperdrive where it materially improves Worker-to-Postgres connection handling
Cloudflare R2
Cloudflare Queues
OpenTelemetry
```

Database remains PostgreSQL because settlement state, outbox, idempotency, cross-chain projections, audit records, and evidence metadata require relational transactions.

Use Supabase as the managed PostgreSQL provider. Do not provision or pay for a separate Cloudflare database product merely for platform purity.

Do not replace PostgreSQL with D1.

Use:

- Cloudflare Workers for API/web runtime;
- OpenNext for Next.js;
- Supabase Postgres as the canonical application database;
- Supabase migrations managed from the repository;
- Supabase local development where practical for schema/migration validation;
- Cloudflare Hyperdrive only as the Worker connection/pooling layer when compatible with the chosen Supabase connection mode;
- R2 for evidence artifacts, PDFs, claim ledgers, reports, and immutable exports;
- Queues for at-least-once asynchronous tasks;
- the PostgreSQL transactional outbox remains the source of critical job intent;
- queue consumers are idempotent;
- Cloudflare Worker secret bindings for Cleanverse credentials and database connection material;
- separate local, preview, staging, and production Worker environments.

### Supabase rules

- Prefer a dedicated Supabase project for Conduit.
- Never expose the Supabase service-role key to the browser.
- Browser code must not receive privileged database credentials.
- Application writes that affect settlement state flow through the server/API layer.
- Use migrations checked into source control.
- Enable row-level security only for tables directly exposed through Supabase client APIs. The preferred architecture does not expose protocol-critical tables directly to browsers.
- Keep protocol truth on-chain; Supabase stores projections, jobs, evidence metadata, and application state.
- Use connection strings/secrets via environment bindings, never committed `.env` values.
- Test migrations locally or against a disposable branch/project before production.
- Backups, PITR, and plan-specific retention are documented according to the actual Supabase plan in use. Do not claim paid recovery features if the active plan does not provide them.

---

## 14. Web-design gate

Protocol/backend work must not invent a final visual language.

Before final web implementation:

```text
WAIT_FOR_DESIGN_MD
```

The user will provide `design.md`.

When present:

1. read it in full;
2. treat it as the UI source of truth;
3. build every page/component/state from it;
4. preserve protocol semantics from the PRD;
5. do not allow design decisions to weaken compliance/error visibility;
6. run responsive and accessibility E2E;
7. deploy preview to Cloudflare;
8. continue automatically after preview validation.

Before `design.md`, build only:

- route skeletons;
- typed view models;
- test selectors;
- unstyled functional pages needed for E2E.

---

## 15. One-shot execution policy

All PRD phases remain mandatory but Claude Code executes them continuously.

Do NOT stop after a phase merely to ask for permission.

Only stop for a HUMAN_GATE:

### HUMAN_GATE_DEPLOY

Required when a new blockchain contract must be deployed or an owner wallet must sign.

Return:

```text
HUMAN_GATE_DEPLOY
Network:
Artifact:
Constructor/initializer args:
Expected deployer:
Exact command:
Expected chain ID:
Expected post-deploy checks:
What to paste back:
```

### HUMAN_GATE_SIGN

Required for CVA registration or another owner signature.

Return:

```text
HUMAN_GATE_SIGN
Purpose:
Exact plaintext message:
Signature standard:
Expected signer:
Exact command/tool instruction:
What to paste back:
```

### HUMAN_GATE_DESIGN

Required once backend/protocol functionality is complete enough for final UI.

Return:

```text
HUMAN_GATE_DESIGN
Place design.md at repository root and reply CONTINUE.
```

### HUMAN_GATE_EXTERNAL_BLOCKER

Only for a real unsupported external capability.

Never stop for:

- routine code decisions;
- test failures the agent can debug;
- dependency setup;
- ABI generation;
- API schema implementation;
- database migrations;
- worker/indexer implementation;
- Cloudflare local configuration;
- ordinary refactoring;
- documentation;
- CI fixes.

---

## 16. Git, GitHub, and repository publication policy

Development is local-first.

### Commit strategy

- Initialize and use local git from the beginning.
- Commit coherent milestones directly to the current local branch.
- Do not create a PR for every phase.
- Do not create review branches unless they solve a real isolation need.
- Do not wait for GitHub Actions to continue development.
- Do not add `Co-authored-by`, AI attribution, Claude attribution, or similar trailers to commit messages.
- Commit messages should be concise, conventional, and written in the project voice.
- Squash only when it improves history. Do not destroy useful milestone evidence.

### Local validation before GitHub publication

Before remote publication, run the complete local release gate:

```text
format
lint
typecheck
unit tests
contract tests
fuzz tests
stateful invariants
integration tests
database migration validation
worker/indexer tests
Playwright E2E
security scans
secret scans
dependency audit
Next.js production build
OpenNext Cloudflare build
wrangler config validation
wrangler deploy --dry-run where supported
Supabase migration dry-run / disposable-project validation
deployment script simulations
contract deployment simulations
environment/schema validation
```

GitHub Actions may be created as reproducibility/safety automation near the end, but:

- local tests are the development gate;
- do not block progress waiting on Actions;
- do not use remote CI as the primary debugging loop;
- workflows must mirror commands already proven locally;
- if an Action fails because the workflow differs from a locally passing command, fix the workflow without weakening the local gate.

### Final repository creation

Do not create the GitHub repository at the start merely to use GitHub as a build loop.

After the product has passed the local release gate and the repository is ready for publication:

1. run `gh auth status`;
2. use the currently authenticated GitHub account;
3. create the repository as `conduit` unless a repository with that name already exists under that authenticated account;
4. default to public visibility for hackathon submission unless the user has explicitly changed that instruction;
5. push the complete local git history;
6. set the repository description;
7. set relevant repository topics;
8. set the homepage/demo URL when available;
9. ensure README and required root documentation are present;
10. verify the pushed default branch matches the local release commit;
11. verify no secret, API key, private key, seed phrase, `.env`, credential export, or private evidence artifact entered git history.

Suggested topics:

```text
cleanverse
cva
cvi
cross-chain
delivery-versus-payment
rwa
defi
monad
arbitrum
wormhole
compliance
settlement
```

No PR is required for the initial publication.

### Repository writing policy

Before writing or materially rewriting public-facing prose, inspect the Claude root for:

```text
writing.md
voice.md
```

Also recognize obvious capitalization variants such as `WRITING.md` and `VOICE.md`.

If present, read them in full and apply them to:

- README;
- repository description;
- docs landing pages;
- architecture explanations;
- public error/help copy;
- demo script;
- submission copy;
- GitHub release notes;
- changelog prose;
- comments where narrative style matters;
- user-facing web copy after `design.md` arrives.

These files affect writing quality and voice only. They never override:

- protocol truth;
- security requirements;
- Cleanverse terminology;
- API semantics;
- test evidence;
- legal/compliance accuracy;
- the PRD.

Do not invent generic hackathon copy, marketing filler, fake metrics, canned “revolutionary” language, or AI-sounding prose when these files provide a style constraint.

---

## 17. Acceptance additions

v1.0 is not complete until:

- [ ] `ConduitRWACVA` is deployed on Arbitrum Sepolia.
- [ ] It is registered/issued as a Cleanverse CVA.
- [ ] RuleV2 is configured and independently queryable.
- [ ] Eligible RWA CVA transfer succeeds.
- [ ] Ineligible RWA CVA transfer fails through CCP policy.
- [ ] Reservation prevents seller double-spend.
- [ ] Reservation cannot cancel after COMMIT.
- [ ] Held post-COMMIT RWA can be dispositioned once.
- [ ] Final demo uses the real registered CVA, not an ERC-3643-only mock.
- [ ] API compatibility fields are not confused with canonical RuleV2.
- [ ] final web matches `design.md`.
- [ ] staging runs on Cloudflare.

---

## 18. Pitch correction

Use:

> Conduit coordinates DvP between two Cleanverse-native assets on different chains. CVA cash settles on Monad while a RuleV2-gated RWA CVA changes ownership on Arbitrum. Tokens never bridge; authenticated settlement state does.

Do not use:

> ERC-3643-style token on Arbitrum

after the real RWA CVA is issued.

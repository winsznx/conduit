# Submission — Conduit

## Project name

Conduit

## One-liner

Cross-chain delivery-versus-payment for Cleanverse-native assets. Both assets
stay on their issuance chains; what crosses is authenticated settlement state.

## Short description

A restricted RWA on Base Sepolia and a Cleanverse settlement unit on Monad
Testnet settle under one signed intent. Neither token moves chains. Conduit
coordinates a single authenticated settlement commitment across both, makes that
commitment irreversible only after economic finality and a fresh compliance
answer, and — when a transfer rule changes after the commitment — holds the
undeliverable value rather than unwinding a leg that has already been paid.

A participant does all of it from a browser.

## Problem

Cash and restricted ownership can live on different chains. Two things make the
trade between them hard, and they compound.

**The chains do not finalize together.** Base Sepolia's finality has run between
999 and 1485 seconds on this deployment; Monad's is roughly a block. Whoever
moves first is exposed for the difference.

**Compliance is an answer, not a property.** An issuer can raise a minimum
holder tier between the moment a settlement commits and the moment it delivers.
A participant who was eligible when the trade was agreed can be refused at the
point of transfer.

Bridging solves neither. It replaces a settlement problem with a custody problem
and creates a wrapped supply to attack.

## Solution

```text
prepare  →  economic finality  →  fresh compliance  →  COMMIT  →  deliver
                                                          │
                                       delivery refused ──┴──▶ HELD ──▶ disposition
```

Both legs prepare on their own chains. `ASSET_PREPARED` crosses to the
coordinator, which refuses it below `FINALIZED`. Only then is Cleanverse asked
again, with no application cache, and only then can COMMIT be issued.

After COMMIT there is no refund. If the delivery is refused at the moment of
transfer, the leg holds — accounted exactly — and moves only through an order a
registered authority signed, which rests for a contest window before it can
execute.

## Why Cleanverse is load-bearing

Remove Cleanverse and there is no product, because there is nothing to be
compliant about and no reason for the commitment to be conditional.

| Layer      | Load-bearing because                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| **CVI**    | eligibility is asked per participant per chain; a settlement that cannot deliver is never signed          |
| **CVA**    | both settlement assets are registered CVAs — the token itself consults the policy on every transfer       |
| **RuleV2** | the issuer's transfer rule is the thing that changed mid-settlement and caused the only HELD case we have |

The integration is built around four distinctions, and collapsing any one of
them produces a wrong answer:

```text
HTTP 200                      is not business success
validator/verify valid:false  is non-eligibility, not an API failure
verify_apass code 4           is the only code that authorises
an outage                     is the absence of a decision, never a refusal
```

The last one is enforced end to end: an unavailable check never mints an
attestation, never enables signing, and never reads as a refusal on any screen.

## Why Wormhole is load-bearing

Conduit needs one chain to act on another chain's state without trusting a
relayer, and without moving a token. That is precisely a message-passing
problem.

```text
ASSET_PREPARED · CASH_PREPARED · COMMIT · ASSET_RELEASED / ASSET_HELD · DISPOSITION_RESOLVED
```

Each peer is locked to exactly one remote emitter. Every message is checked for
emitter chain, emitter address, deployment id, protocol version and message type
before its payload is read, and its VAA hash is burned before any token moves.
Finality is classified, never ranked: Wormhole encodes 200 as instant and 201 as
safe, so comparing the raw byte would place instant above finalized — a
substitution a settlement layer cannot afford.

A compromised relayer delays a settlement. It cannot forge one, and there is no
wrapped supply to attack because nothing is wrapped.

## Technical architecture

```text
Monad Testnet 10143                     Base Sepolia 84532
───────────────────                     ──────────────────
SettlementCoordinator                   RWACVASettlementAdapter
CashEscrow                              ConduitRWACVA          (registered CVA)
ConduitSandboxSettlementCVA (CVA)       AuthorityRegistry
ConduitVaultRegistrar                   DispositionController
AuthorityRegistry
DispositionController

              ── Wormhole, FINALIZED for anything that moves value ──

Cloudflare Worker            server-rendered console, read API,
                             compliance attestation endpoint
Browser bundle               wallet, EIP-712 signing, the action resolver,
                             every protocol write
Postgres                     projection only — never authorises anything
Verifier                     two chain RPCs, the manifests, the guardian set,
                             and no database at all
```

The console's backbone is a pure function from canonical chain state to one next
action and whether the connected account may take it. It reads the coordinator's
record, the escrow leg, the token's reservation, the adapter's binding and the
observed messages. The projection supplies only the terms and the two intent
signatures, both of which the coordinator re-verifies on chain.

## Live deployments

Generation 3, canonical. Core contracts are non-upgradeable, so a new version is
a new generation and old settlements stay verifiable against the one that
produced them.

| Contract                    | Chain         | Address                                      |
| --------------------------- | ------------- | -------------------------------------------- |
| SettlementCoordinator       | Monad Testnet | `0xb08bC7F285dd3fC1047798b661E93AB7427a7A61` |
| CashEscrow                  | Monad Testnet | `0x8151D682836f5B7106181bc8e48DC899ab538930` |
| ConduitSandboxSettlementCVA | Monad Testnet | `0xFEfd2eA28dB25c720ec5298964F8d2F34e3f1F16` |
| ConduitVaultRegistrar       | Monad Testnet | `0x3FFd39444EBba2307B34c5F36F96e4e04511EBA5` |
| AuthorityRegistry           | Monad Testnet | `0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7` |
| DispositionController       | Monad Testnet | `0x3c4060D402675A25CAd836247CFA0B95614efe81` |
| ConduitRWACVA               | Base Sepolia  | `0xDdB1AE5685F4033Ed10B3DfCe5e9dc13D3e4989B` |
| RWACVASettlementAdapter     | Base Sepolia  | `0xb08bC7F285dd3fC1047798b661E93AB7427a7A61` |
| AuthorityRegistry           | Base Sepolia  | `0x33BB1eBa633d527f664bEFEd0FD6F13E0bE70E45` |
| DispositionController       | Base Sepolia  | `0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7` |

Deployment id `0xdcb9db121ca873817fca7ee6a8e2cd8ef0249b7c83f4e656553338da00eccaa6`,
solc 0.8.36 exact-pinned, manifests under `contracts/deployments/`.

`0xb08bC7F2…` is the coordinator on Monad **and** the adapter on Base. Identity
here is `(chainId, address)` everywhere, never an address alone.

## Live product

<https://conduit.timjosh507.workers.dev>

## Verifier

<https://conduit.timjosh507.workers.dev/app/verifier>

Or from a clone, with only a settlement id:

```bash
pnpm conduit verify 0xd46775dc9cbcdfdd4f60df1c9de4de15fc609b29f47f1d3d1860e398c33aca77
```

## Canonical settlement

```text
0xd46775dc9cbcdfdd4f60df1c9de4de15fc609b29f47f1d3d1860e398c33aca77
```

Composed, checked against Cleanverse, signed, reserved, escrowed, waited out Base
economic finality, asked again, committed, both legs released, outcome reported —
entirely from a browser, with no intervention of any kind. 42 minutes, of which
22 were the wait that cannot be shortened.

- Settlement: <https://conduit.timjosh507.workers.dev/app/settlements/0xd46775dc9cbcdfdd4f60df1c9de4de15fc609b29f47f1d3d1860e398c33aca77>
- Verification: <https://conduit.timjosh507.workers.dev/verify/0xd46775dc9cbcdfdd4f60df1c9de4de15fc609b29f47f1d3d1860e398c33aca77>
- Evidence: <https://conduit.timjosh507.workers.dev/evidence/0xd46775dc9cbcdfdd4f60df1c9de4de15fc609b29f47f1d3d1860e398c33aca77>

`SETTLED` canonical, `SETTLED_FINAL` derived, 18 of 18 checks, no scan gaps.

A second browser settlement, `0x3f9b03f4…`, took the same path and found four
defects on the way; both are recorded in full.

## Post-COMMIT compliance change

```text
0xc113ad335d202d985d527b0a193498ef2ecceb9a129a58c5002943c88601a3b0
```

```text
eligible at COMMIT      code 4, evidence hash recorded on chain
COMMIT issued           the cash leg releases and cannot be un-released
RuleV2 minTier 0 → 21   the issuer moves the rule, on chain
delivery refused        TierTooLow, at the moment of transfer
asset leg HELD          accounted exactly, no refund of the released leg
RuleV2 21 → 0           the rule is restored
REVERIFY_AND_RESUME     an authorised order, executed
SETTLED_FINAL           independently verified
```

- Settlement: <https://conduit.timjosh507.workers.dev/app/settlements/0xc113ad335d202d985d527b0a193498ef2ecceb9a129a58c5002943c88601a3b0>
- The same path on generation 1: `0x30aa1b73…`

## Test counts

```text
Vitest       754 assertions across 32 files
Foundry      281 tests across 19 suites
               9 fuzz properties at 256 runs each
              26 disposition invariants
              10 exploit regressions
Playwright    76 browser tests against the deployed surface
               1 opt-in live run against both testnets
Release gate  17 of 17 steps
```

The gate is: toolchain pins, format, lint, typecheck, unit, contract build with
warnings as errors, trace corpus regeneration, contract tests, gas snapshot,
storage layout, Slither, gitleaks over worktree and full history, dependency
audit, Trivy config scan, Checkov, deployment manifest schema, end-to-end.

## Known limitations

**One controlled identity.** `generate_apass` returns 403 for this credential, so
no second A-Passed wallet can exist and payer and seller are the same key.
Conservation is proven at the escrow balance and the reservation rather than at a
wallet delta. It is why `REBIND_RECEIVER` and `AUTHORIZED_SUBSTITUTION` have no
live destination to reach.

**The attestation signer is 1-of-1 and Conduit-operated.** The contract proves an
authorised signer asserted eligibility and bound it to this settlement, this
intent and a window it cannot widen. It cannot prove the signer asked Cleanverse.
At a quorum of one that is a trust assumption in the operator — threat register
T-08 and T-09, accepted with a written waiver. Nothing here describes the
attestation layer as trustless. Multiple attestors, threshold quorum, TEE-backed
attestors and directly verifiable Cleanverse signatures are future architecture,
not implemented.

**Not all six disposition types are live-demonstrated.**
`REVERIFY_AND_RESUME` is. The other five are implemented and tested; two of them
are blocked on the identity limitation above.

**Not aUSDC.** The Monad cash leg settles in a sandbox CVA we issued and
registered ourselves. It calls the live CCP policy on every transfer and holders
need real CVI, so the architecture holds — but no reserve stands behind it.

**Public testnet guardian configuration.** Wormhole's testnet guardian set is
1-of-1. A property of the network, not of this design.

**No CCP validator pool on the asset chain.** `validator/grant` on Base was
refused for this credential, so asset-leg eligibility rests on `verify_apass`
plus the on-chain CCP policy rather than on both sources.

**Fiat off-ramp does not complete.** SELL quoting is live with real quote tokens
and pricing; the widget refuses with `RM_003 Unable to verify APass on chain`.
The on-chain `OPERATOR_ASSISTED_OFFRAMP` is real; no fiat settlement is claimed.

**Evidence is repository-backed, not object storage.** Every package names the
repository path it came from, and the gate byte-compares what the site serves
against `docs/evidence`. ASM-039 stays open.

**Sandbox eligibility is inconsistent for unknown wallets.** Some addresses this
sandbox has never seen return `code 4` and others return `code 2`. A judge
connecting a fresh wallet may be cleared or refused; the console reports the
answer it received either way.

**Testnet only.** No mainnet deployment and no mainnet claim.

## Team

winsznx

---

# Judging rubric

## Concept — 20

The race this exists to lose safely: two chains that finalize at different
times, and a compliance answer that can change between the two moments.

Conduit's position is that the correct response to a post-commitment refusal is
**not** to unwind. The seller has been paid; reversing that is theft from one
side to protect the other. So the commitment stands, the undeliverable leg is
held and accounted exactly, and it moves only through an authorised order that
rests for a contest window.

That position is what makes the irreversible boundary meaningful, and it is why
`maxAttestationValidity` being 900 seconds against a 1343-second finality wait is
a design property rather than a coincidence: a prepare-time answer _structurally
cannot_ authorise a commit.

Evidence: [README](../README.md), `0xc113ad33…`.

## CVI / CVA depth — 30

| Claim                                         | Evidence                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| Both settlement assets are registered CVAs    | `docs/evidence/phase-03-cva-registration.json`, ISSUED on both chains    |
| RuleV2 configured and independently queryable | `docs/evidence/phase-03-cva-rulev2.json`                                 |
| Live eligibility, per participant per chain   | every settlement's preflight; `/api/eligibility` on the deployed console |
| Fresh commit-time compliance after finality   | attestation table in `docs/evidence/MANIFEST.md`, minted post-wait       |
| A real RuleV2 change refuses a real delivery  | minTier 0 → 21, `TierTooLow`, `0xc113ad33…`                              |
| HELD after that refusal, with no refund       | same settlement, cash leg RELEASED and not returned                      |
| Disposition resolving held value              | `REVERIFY_AND_RESUME`, executed, `SETTLED_FINAL`                         |
| Result-code discipline                        | `packages/cleanverse`, 22 tests; only code 4 authorises                  |
| Outage never read as refusal                  | resolver unit tests, browser tests, and the attestation endpoint         |

## Build — 25

```text
two chains          Monad Testnet 10143, Base Sepolia 84532, generation 3
contracts           18 Solidity sources, solc 0.8.36 exact-pinned,
                    non-upgradeable, gas and storage-layout snapshots gated
Wormhole            5 message types, locked peers, FINALIZED-only for value,
                    VAA burned before any token moves
browser flow        every protocol write from a wallet in a page: reserve,
                    announce, approve, escrow, consume, commit, release, report
verifier            two RPCs, the manifests, the guardian set, no database
disposition kernel  six order types, contest window, conflict adjudication
exploit regressions 10 tests pinning defects found during development
tests               754 Vitest · 281 Foundry · 76 Playwright · 17/17 gate
```

## UX / demo — 15

| Claim                              | Where                                                          |
| ---------------------------------- | -------------------------------------------------------------- |
| Wallet flow                        | EIP-6963 discovery, silent restore, per-action chain switching |
| Live compose, check, sign          | `/app/settlements/new`                                         |
| Prepare, finality, commit, release | `/app/settlements/:id` — one action at a time, chain-derived   |
| Finality UX from real state        | five stages per message, observations never averaged           |
| HELD and disposition               | `/app/dispositions`, and the six types with authority state    |
| Verifier                           | `/verify/:id`, 18 checks, public                               |

Every button on the settlement page corresponds to a call on a deployed
contract. No step is simulated, and no action is offered that the chain would
refuse: the resolver gates on canonical state, and the commit is simulated
against the coordinator before a wallet is asked for anything.

## Scale — 10

**Asset adapters.** The asset leg talks to `RWACVASettlementAdapter`, not to a
token. A second asset class needs an adapter, not a new coordinator.

**Chain-qualified identity.** `(chainId, address)` everywhere. The same twenty
bytes are two different contracts in this deployment, four times across three
generations, and a test fails the build if a unique key on a bare address
appears in the schema.

**Permissionless execution.** `recordAssetPrepared`, `issueCommit`,
`releaseCash`, `releaseAsset`, `reportResolution` and `fileOrder` are all
submittable by anyone. The authority is the signature, never the sender, so
relaying can be operated by whoever wants the settlement to finish.

**Modular authority policies.** `AuthorityRegistry` holds named policies with
per-type signature thresholds and separate bitmasks for who may sign and who may
adjudicate. Changing the rules is a policy write, not a redeployment.

**Indexed projections.** Reads are served from a projection that authorises
nothing; the chains remain the authority, and the projection can be rebuilt.

**Independent verification.** Anyone can re-derive a settlement's outcome from a
settlement id and two RPC URLs, with no access to our database and no trust in
our server.

---

# Demo script — 3 minutes

Use the deployed site. Do not run a fresh settlement during the recording: the
Base finality wait is real and around twenty-two minutes. Every screen below is
already populated with the settlements that have already happened.

**0:00–0:20 — the problem.** Landing page, "The problem". Two chains that do not
finalize together, and eligibility that can change while a settlement is in
flight. One line: bridging replaces a settlement problem with a custody problem.

**0:20–0:40 — both assets stay put.** "One intent, two chains". A restricted bond
on Base, a Cleanverse settlement unit on Monad, neither moving. What crosses is
authenticated state.

**0:40–1:10 — the participant flow.** `/app/settlements/new`: role, amounts, and
the compliance preflight running against Cleanverse live. Then open the settled
canonical settlement `0xd46775dc…` and scroll the action panel and the history —
reserve, announce, escrow, each one observed before the next was offered.

**1:10–1:30 — the wait, and the second question.** The finality panel: message
observed in seconds, FINALIZED in 1343. Then the compliance panel: prepare-time
and commit-time side by side, and why a 900-second attestation cannot cross a
1343-second wait.

**1:30–1:45 — COMMIT and settlement.** The irreversible boundary panel, then the
terminal state: `SETTLED` canonical, `SETTLED_FINAL` derived, both legs
`RELEASED`.

**1:45–2:20 — the important failure.** Open `0xc113ad33…`. Eligible at commit.
The issuer raises RuleV2 to minTier 21. Delivery refused with `TierTooLow`. The
cash leg has already released and is not refunded. The asset leg is HELD. Then
`/app/dispositions`: the protocol history, and `REVERIFY_AND_RESUME` executed to
a terminal state.

**2:20–2:45 — independent verification.** `/verify/0xd46775dc…`. Eighteen checks
from two chain RPCs, the committed manifests and the guardian set. Say the
sentence: the application database is not an input, and `SETTLED_FINAL` is a
conclusion this software drew rather than a value any contract stores.

**2:45–3:00 — why Cleanverse, and close.** Compliance is not a gate in front of
the protocol, it is a state in it: asked at composition, asked again immediately
before the irreversible decision, and enforced by the asset itself at the moment
of transfer. When it says no after the commitment, the value is held lawfully
rather than unwound.

Do not scroll source code.

## Before recording

```text
use production, not localhost
open every page once first — the projection reads a pooled database and the
  first request to a cold isolate is the slow one
have these ready in tabs:
  /                                          the problem, and the proof
  /app/settlements/0xd46775dc…               the canonical browser settlement
  /app/settlements/0xc113ad33…               the compliance-change case
  /app/dispositions                          protocol history, six order types
  /verify/0xd46775dc…                        eighteen checks
  /app/evidence                              four packages
```

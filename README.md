# Conduit

**Delivery-versus-payment between Cleanverse-native assets on different chains. The assets never bridge. Authenticated settlement state does.**

A restricted RWA sits on Base Sepolia. A Cleanverse settlement unit sits on Monad Testnet. Neither is wrapped, minted elsewhere, or moved across a chain. What crosses is a Wormhole message carrying the settlement's own state, and the commitment it authorises becomes irreversible only after economic finality and a fresh compliance answer.

The interesting part is not the happy path. It is what happens when the buyer stops being eligible _after_ the point of no return.

---

## The mechanism

```text
  Base Sepolia                          Monad Testnet
  ────────────                          ─────────────
  RWA reserved inside the token         settlement CVA locked in escrow
  seller keeps nominal ownership        exact balance delta enforced
          │                                     │
          └───── ASSET_PREPARED (FINALIZED) ────┤
                                                │
                            fresh Cleanverse compliance, at commit time
                                                │
                                            COMMIT ──── the point of no return
                                                │
          ┌───────────── COMMIT VAA ────────────┘
          │                                     │
     bond delivered                       cash released
```

Both legs answer to one canonical decision on Monad. Neither decides for itself, so neither can decide differently.

### And the path that matters

```text
                                            COMMIT
                                                │
                                       cash released to the seller
                                                │
                    ── the issuer raises minTier on the RWA's RuleV2 ──
                                                │
                              the live policy now refuses the buyer
                                                │
                                        NO REFUND EXISTS
                                                │
                                              HELD
                                                │
                          an authorised disposition, under a policy
                                                │
                                    terminal resolution
```

A settlement that has committed and cannot deliver does not unwind. The seller has been paid; reversing that would be theft from one side to protect the other. The value is held, accounted for exactly, and moves only through the Disposition Kernel.

**This is live, not a diagram.** A real issuer-controlled RuleV2 change made the buyer ineligible after COMMIT, the deployed CCP policy answered `TierTooLow`, delivery was refused, the bond reached HELD, the rule was restored, and an authorised disposition delivered it.

---

## Why this is not a bridge

A bridge moves an asset by locking it on one chain and minting a representation on another. The representation is a new liability, backed by the bridge, and it is what gets stolen in every bridge hack.

Conduit mints nothing and locks nothing across a boundary. The RWA never leaves Base — it is reserved _inside_ the token, so the seller keeps nominal ownership and the units simply stop being spendable. The settlement unit never leaves Monad. A Wormhole VAA carries one authenticated fact: _the coordinator on Monad decided COMMIT for this settlement._ Each escrow verifies that fact against the guardian set, checks the emitter chain, emitter address, deployment generation, protocol version, message type, settlement ID and intent hash, marks the VAA consumed, and only then moves its own local asset.

The consequence: a compromised relayer delays a settlement and cannot forge one. There is no wrapped supply to attack because there is no wrapped supply.

## Why compliance has to be checked at commit time

A restricted security's eligibility is a fact about _now_, not about when the trade was agreed. Checking at preparation and committing an hour later means committing on a stale answer.

The gap is not hypothetical here. Base Sepolia economic finality on this deployment has been observed at:

```text
999   1093   1223   1275   1350   1483   1485    seconds
```

Attestation validity is **900 seconds**, immutable in the deployed bytecode — a compliance signer cannot widen its own window. Every one of those finality observations is longer than the attestation lifetime, so a prepare-time answer _cannot_ reach the commit. The compliance query happens after the finality wait, by construction rather than by discipline.

Those are seven individual observations. They are not averaged, because the tail is the thing that breaks you and a mean of 1272s would hide the 1485.

---

## Live deployment

Generation 3, the canonical deployment.

|                        | Monad Testnet (10143)                                    | Base Sepolia (84532)                                 |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| token                  | `0xFEfd2eA28dB25c720ec5298964F8d2F34e3f1F16` cSETTLE3    | `0xDdB1AE5685F4033Ed10B3DfCe5e9dc13D3e4989B` cBOND3  |
| settlement             | `0xb08bC7F285dd3fC1047798b661E93AB7427a7A61` coordinator | `0xb08bC7F285dd3fC1047798b661E93AB7427a7A61` adapter |
| escrow                 | `0x8151D682836f5B7106181bc8e48DC899ab538930`             | —                                                    |
| authority registry     | `0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7`             | `0x33BB1eBa633d527f664bEFEd0FD6F13E0bE70E45`         |
| disposition controller | `0x3c4060D402675A25CAd836247CFA0B95614efe81`             | `0xEa92410aBCc1712C303174E3a2Cf4FF6Dfc7D1D7`         |

Both tokens are registered Cleanverse CVAs, ISSUED, with RuleV2 configured and readable from the policy.

Look at that table twice. `0xb08bC7F2…` is the **coordinator on Monad and the adapter on Base**. `0xEa92410a…` is the **Monad registry and the Base controller**. Same deployer, same nonce sequence, two chains — and it has now happened four times across three generations. Identity in this system is `(chainId, address)` everywhere, never an address alone, and there is a test that fails the build if a unique key on a bare address appears in the schema. See [ADR-0018](docs/adr/0018-identity-is-a-pair-never-an-address.md).

---

## The seam defects

Six defects were found in this codebase's own contracts, all by tests that drive messages a production contract actually emitted rather than messages a test invented. Each is preserved as a permanent regression that proves the _original vulnerable behaviour_, not merely that the repair works.

**D-01 — phantom cash preparation.** `recordCashPrepared` was permissionless and the escrow never called it, so the coordinator learned that cash had arrived from whoever sent the next transaction. A buyer who funded nothing could declare the cash leg prepared against a genuinely prepared asset leg, reach READY, and commit. Every signature is real, every attestation is real, and the bond is delivered against an empty escrow. This one moved value.

**D-02 — cancellation knowledge race.** The COMMIT exists on Monad the moment it is issued, and the cash releases against it immediately. Base only learns when a relayer delivers the VAA — minutes later, on an untrusted schedule. In that window the seller could cancel the reservation, take the cash, and keep the bond.

**D-03 — caller-supplied resolution truth.** `reportResolution(bool released)` let anyone publish a false ASSET_RELEASED after a genuine hold. Every transport check passes; the coordinator reads SETTLED while the bond sits undelivered, and the true report is then locked out by `LegAlreadyResolved`. Nobody's balance moves, which is why it reads as harmless — what it destroys is the correspondence between canonical state and where the value is, and every conservation claim rests on that.

**D-04 — unreachable HELD.** Invariant I9 says held value remains claimable through the Disposition Kernel. There was no entry point, so it was not claimable at all.

**D-05 — cross-chain address collision.** One address, two chains, two different contracts with two different roles. Anything keyed by address alone conflates them silently.

**D-06 — double reservation decrement.** `releaseReservation` decrements `_reservedOf` and then transfers; `_update` subtracted the releasing reservation _again_. With one reservation the subtraction is unreachable — the decrement leaves the mapping at zero and the guard is skipped — which is why two hundred tests and two live settlements never touched it. With a second, smaller reservation it underflows and the release reverts: held value that no authority can free, on a leg whose disposition was authorised, signed, uncontested and rested. The deployed seller was one settlement away from that shape.

D-06 is why generation 3 redeployed **both** CVAs rather than just the settlement contracts. The Monad settlement unit is also a `ConduitRWACVA`, so the fix changed its code too, and "unreachable today" is not "absent" in a non-upgradeable contract.

---

## The Disposition Kernel

PRD FR-012 admits six order types. All six are implemented, tested against producer-originated messages, authority-checked, conflict-tested and verifier-supported.

| Type                        | Where value may go                                    | Status               |
| --------------------------- | ----------------------------------------------------- | -------------------- |
| `REVERIFY_AND_RESUME`       | the current intended receiver, and nowhere else       | live demonstrated    |
| `RESTRICTED_HOLD`           | a registered restricted custodian; terminal           | live demonstrated    |
| `RETURN_TO_ELIGIBLE_SENDER` | the original sender, and only after a COMMIT          | implemented + tested |
| `REBIND_RECEIVER`           | a wallet with the same registered identity commitment | implemented + tested |
| `AUTHORIZED_SUBSTITUTION`   | an approved substitute _for this receiver_            | implemented + tested |
| `OPERATOR_ASSISTED_OFFRAMP` | a registered gateway account                          | implemented + tested |

That column is the honest one. "Implemented + tested" means it works against a real hold in a two-chain harness with real authority signatures; it does not mean it has run on a public chain. The two that have are marked as such and nothing else is.

### A filed order rests before it executes

FR-012 says conflicting valid orders produce `CONTESTED` and no funds move until the policy resolves it. Against an immediate-execution design that sentence is unenforceable: the first order executes on arrival, the second authority's equally valid order finds a settled case, and the outcome was decided by whichever relayer paid more gas.

So an order rests for the policy's contest window, anyone may file during it, and an incompatible filing contests the case. `test_ARelayerRaceCannotDecideTheOutcome` files the same two disagreeing orders in both arrival orders and asserts the results are identical and that nothing moved.

Each redirecting type answers to its own registry list under its own authority class, so an issuer's substitution power is not a gateway operator's off-ramp power, and neither is a power to send value anywhere they like. Authority grants are timelocked; revocations are immediate.

`RETURN_TO_ELIGIBLE_SENDER` is **not a refund**. A refund is a pre-COMMIT unwind that FR-008 permanently disables. This is an authorised post-COMMIT disposition that happens to send value back the way it came: the COMMIT stays on chain as historical fact, the settlement never becomes ABORTED, and the leg records DISPOSED rather than RETURNED.

---

## The verifier

From a settlement ID and two RPC URLs — no database, no Conduit service — it reconstructs the deployment generation, code hashes, intent, signatures, prepared legs, producer VAAs, emitter identities, finality levels, VAA consumption, compliance attestations, the authorised COMMIT, releases or holds, any disposition order with its signers and policy hash, conservation, and the terminal canonical state.

It classifies:

```text
SETTLED_FINAL                 the intent's own parties received the value
DISPOSITION_FINAL             an authority redirected it under FR-012
RESTRICTED_HOLD_FINAL         it ended in registered restricted custody
CONTESTED                     two authorities disagree; nothing may move
HELD_PENDING_DISPOSITION      committed, undelivered, no case resolved it
SETTLED_PENDING_VERIFICATION  SETTLED on chain, a check here did not pass
NOT_SETTLED                   the coordinator's own state is not SETTLED
```

**None of those is a Solidity enum.** `SETTLED` is; `SETTLED_FINAL` is a conclusion this software drew from facts on two chains. They are stored in separate columns, served as separate fields, and rendered as separate badges, because collapsing them would erase the difference for every reader downstream ([ADR-0017](docs/adr/0017-settled-is-on-chain-settled-final-is-derived.md)).

An RPC scan gap is a verification failure, never a green result. The first version of this verifier scanned in fixed 9000-block windows against endpoints that cap at a thousand and a hundred, logged the refusals as warnings, and certified a terminal state having read one message of three.

---

## Evidence rules this codebase enforces

**A negative proof must reach the layer it blames** ([ADR-0019](docs/adr/0019-a-negative-proof-must-reach-the-layer-it-blames.md)). A check once passed on `Function "recordCashPrepared" not found on ABI` — viem refused to build the calldata, nothing reached the chain, and the report claimed an authority check had held that was never exercised. `proveContractRefusal` now walks calldata, code presence, the call, raw revert bytes and the decode, and returns evidence only for a real `CONTRACT_REVERT`.

```text
CLIENT_ENCODING_FAILURE  !=  CONTRACT_REVERT
RPC_FAILURE              !=  POLICY_REFUSAL
AGGREGATE_STATE          !=  SETTLEMENT_STATE
```

**Seam tests use producer-originated messages** ([ADR-0015](docs/adr/0015-seam-tests-use-producer-originated-messages.md)). A unit test's fixture is written by the same person with the same wrong belief about what the other side emits, so the class of defect where two contracts each behave correctly against an imagined counterparty is invisible to it by construction. Every cross-chain message in the seam suites is the exact payload a production contract published.

---

## The console

<https://conduit.timjosh507.workers.dev>

A participant does the whole settlement from a browser. Connect a wallet, be
checked against Cleanverse live, compose terms, sign the EIP-712 intent, send
the counterparty a link, reserve the asset, escrow the cash, wait out economic
finality, be asked again, commit, release both legs — and if delivery is refused
after the commitment, file and execute a disposition. No CLI is required at any
point and no step is simulated: every button is a call on a deployed contract.

What decides each step is `apps/web/src/actions.ts`, a pure function from
canonical protocol state — the coordinator's record, the escrow leg, the token's
reservation, the adapter's binding, the observed messages — to one next action
and whether the connected account may take it. The projection supplies the terms
and the two intent signatures, both of which the coordinator re-verifies on
chain, and nothing else, because application database state never authorizes
value movement.

The Worker holds no settlement key. It holds one compliance key, because every
value-moving call demands a quorum of attestations signed by an address the
contract's registered signer set contains, and a participant who could mint one
would be authorising their own settlement. That key cannot move a token, sign an
intent, decide a settlement, or release a leg without a canonical COMMIT already
on chain. [ADR-0021](docs/adr/0021-the-web-surface-holds-a-compliance-key-and-nothing-else.md)
says so precisely.

---

## Running it

```bash
pnpm install
pnpm verify              # the full local gate: format, lint, types, tests, slither, secrets
pnpm conduit doctor      # environment, both chains, every Cleanverse capability
pnpm conduit verify <settlementId>
pnpm evidence:check      # the served evidence still matches docs/evidence
```

Contracts are Foundry, exact-pinned to Solc 0.8.36. Everything else is TypeScript strict.

---

## Known limitations

These are stated here rather than buried, because a submission that hides them is worth less than one that does not.

**One controlled identity.** `generate_apass` returns 403 for this credential, so no second A-Passed wallet can exist. Buyer and seller are the same key. Each leg still moves value into and out of a settlement contract, and conservation is proven at the escrow balance and the reservation rather than at a wallet delta — but this is not a demonstration of two counterparties. It is the reason `REBIND_RECEIVER` and `AUTHORIZED_SUBSTITUTION` are not live-demonstrated: there is no second eligible destination for them to reach.

**Not aUSDC.** The Monad cash leg settles in a sandbox CVA that we issued and registered ourselves. It calls the live CCP policy on every transfer and holders need real CVI, so the architecture is preserved — but it is not aUSDC and no reserve of any kind stands behind it. Cleanverse's aUSDC faucet reverts on its own empty source wallet and direct deposits are refunded as non-whitelisted.

**Fiat off-ramp does not complete.** Fiat Ramp is granted for this credential and SELL quoting is live on five networks with real quote tokens and real pricing. The hosted widget refuses with `RM_003 Unable to verify APass on chain` — PRD 5.5's third precondition, and the same blocker as the identity limitation above. Separately, neither settlement asset is a listed ramp asset and Monad is not a ramp network. The on-chain `OPERATOR_ASSISTED_OFFRAMP` disposition is real; no fiat settlement is claimed.

**Public testnet guardian configuration.** Wormhole's testnet guardian set is 1-of-1. That is a property of the network, not of this design, and it is not mainnet-grade quorum.

**No CCP validator pool on the asset chain.** `validator/grant` on Base was refused for this credential, so commit-time eligibility on the asset leg rests on `verify_apass` plus the on-chain CCP policy rather than on both sources.

**The compliance authority runs in the console's Worker.** It has its own key and
its own endpoint, and it signs one sentence — that Cleanverse answered this way
about this address for this settlement at this time. A production topology gives
it its own deployment and its own key custody; nothing here depends on the
co-location, and the endpoint is already the boundary. Recorded in ADR-0021,
including what that key provably cannot do.

**Evidence is served from this repository, not from object storage.** The
evidence page names the repository path of every package rather than claiming a
content-addressed publication, and `pnpm evidence:check` byte-compares what it
serves against `docs/evidence`. The content addresses that _are_ on the page —
transaction, VAA, Cleanverse response, code and policy hashes — verify against
two chains with no help from this server. ASM-039 stays open.

**`CONTESTED` is a verifier classification, not an on-chain settlement state.** Driving the coordinator's enum from a remote leg's contested case would require a cross-chain message PRD 7.3 does not define, and ADR-0015 forbids inventing one.

---

## Documentation

- [`docs/implementation-status.md`](docs/implementation-status.md) — phase gates and their evidence
- [`docs/adr/`](docs/adr/) — every decision that changed the design, and why
- [`docs/threat-model/threat-register.md`](docs/threat-model/threat-register.md) — the six defects, as permanent invariants
- [`docs/assumptions.md`](docs/assumptions.md) — every open question, and what would close it
- [`docs/evidence/`](docs/evidence/) — machine-readable proof for every live claim above

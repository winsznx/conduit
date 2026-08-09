# The disposition, reproduced on the canonical generation

**Live, on deployment generation 3, 2026-08-08/09.**
Settlement `0xc113ad335d202d985d527b0a193498ef2ecceb9a129a58c5002943c88601a3b0`.
Machine-readable: `phase-07-compliance-change-0xdcb9db12.json`. Independent
verification: `verification-c113ad335d.json`. Stream:
`artifacts/compliance-change-c113ad335d.log`, which is a local file and not
committed — see ASM-039.

Generation 2 proved the held-then-dispositioned path works. It was not the
generation the rest of the system runs on. This is the same path on
`0xdcb9db12` — the generation the happy path, the read plane, and the projection
all point at — so the claim "Conduit holds and then disposes" is now made about
the deployment a reader would actually inspect.

Nothing about the scenario was weakened to get it to pass. Same restriction,
same live policy, same refusal, same three adversarial attempts.

## The whole path

```text
both legs prepared, buyer eligible      verify_apass code 4, canTransfer true
Base economic finality                  1189s, FINALIZED
fresh commit-time compliance            still code 4 — the commit was legitimate
COMMIT                                  the point of no return
cash released to the seller             irreversible from here

── the issuer raises minTier 0 → 21 ──  0x4e0394879c5aa701d2326805851578269081a0de…
the live policy refuses the buyer       canTransfer reverts
Cleanverse refuses                      TierTooLow — a signed refusal, not silence
releaseAsset                            HELD. Not delivered, not returned.
ASSET_HELD, 1483s finality              coordinator state HELD

── the issuer restores minTier 21 → 0 ── 0x2400916ef715a2e515eb079ef65a3bcc3500bd60…
eligibility returns                     code 4, canTransfer true

resolveHeldAsset  REVERIFY_AND_RESUME   0xf76401dc39e32bbf28dc5c5eb215f09135b6d8b6…
reportResolution                        0xee6e40f3f9d2ed3c5583a636088309caac6c5828…
recordLegResolved                       0xeee17497b5cd9d7bca2d8c32853b9f9b1c39e592…
the settlement is terminal              SETTLED
```

Five commit-time compliance queries, all live, all against the real policy. The
refusal is computed by the CCP contract and named by Cleanverse as `TierTooLow`.

One caveat on what the on-chain half of that refusal records. The artifact's
`onChainCanTransfer` reads `revert The contract function "canTransfer" reverted
with the following signature:` with nothing after the colon. The revert is real
and the decision it drove is correct, but the selector is dropped before it
reaches the artifact: the ABI used for `canTransfer` does not declare the
policy's custom errors, so viem cannot decode the name, and the fallback pattern
in `revertName` expects `Error: Name(` while viem emits the raw four-byte
selector on the next line. Cleanverse still names the error, so the finding is
corroborated — the on-chain field is thinner than it should be. Generation 2's
artifact records the identical string, so this is long-standing rather than new.

## What could not happen, taken while committed and undelivered

```text
returnCash — a refund to the payer after COMMIT   LegNotInState
the seller reclaiming the reserved bond           ReservationAlreadyCommitted
an ABORT after the COMMIT                         AbortAfterCommitForbidden
```

## Conservation

```text
                      before       at held      after        after disposition
cash escrow balance   25,000,000   25,000,000   25,000,000   25,000,000
escrow accounted      25,000,000   25,000,000   25,000,000   25,000,000
rwa seller nominal     4,000,000    4,000,000    4,000,000    4,000,000
rwa seller reserved      500,000    1,000,000    1,000,000      500,000
rwa seller available   3,500,000    3,000,000    3,000,000    3,500,000
rwa total supply       4,000,000    4,000,000    4,000,000    4,000,000
```

The reserved balance moves 500,000 → 1,000,000 → 500,000: this settlement's
500,000 is reserved at preparation, stays reserved through the hold, and is
released by the disposition. Supply never changes and no unit is owned twice.

The cash line needs the same care the generation-2 report gave the reserved
residue, and for the same reason. It is flat at 25,000,000 across all four
snapshots, and that is **not** this settlement's cash standing still. This
settlement's 25,000,000 entered escrow at `prepareCash` and left at
`releaseCash`, both inside the window between the `before` and `at held`
snapshots, so the two movements cancel at every point where a snapshot was
taken. Buyer and seller are one key (ASM-035), so the payer balance is flat for
the same reason.

The 25,000,000 that is actually sitting there belongs to a different settlement:

```text
0x5305a093…  legState PREPARED (1)  amount 25,000,000  ← never committed
0xc113ad33…  legState RELEASED (3)  amount 25,000,000  ← this one, settled
escrow totalEscrowed 25,000,000, token balance 25,000,000
```

`0x5305a093…` is the run that died when the host filled its disk. It prepared
its cash leg and never reached COMMIT. Its commit deadline
(2026-08-09T00:03:07Z) has passed with the leg still `PREPARED`, which is the
refundable state — no COMMIT ever existed for it, so returning the cash is
permitted and takes nothing from anyone. It is left in place here rather than
swept, because sweeping it would have changed escrow balances in the middle of
the run this document reports on.

`totalEscrowed` equals the token balance at every snapshot, which is the
conservation statement that holds: the escrow accounts for exactly what it
holds, and the one open leg is the one that explains the balance.

## Independent verification

From the settlement ID and two RPC URLs, with the committed manifests and the
guardian set as the only other inputs:

```text
ASSET_PREPARED  seq 3  wormhole:10004:0x…7a7a61  FINALIZED  → coordinator  consumed
ASSET_HELD      seq 4  wormhole:10004:0x…7a7a61  FINALIZED  → coordinator  consumed
ASSET_RELEASED  seq 5  wormhole:10004:0x…7a7a61  FINALIZED  → coordinator  consumed
CASH_PREPARED   seq 2  wormhole:10009:0x…538930  FINALIZED  no consumer
COMMIT          seq 1  wormhole:10009:0x…7a7a61  FINALIZED  → adapter      consumed

canonical on-chain state   SETTLED
derived classification     SETTLED_FINAL
```

Five messages, every one authentic, final, and consumed at most once. Every
block range the settlement could span was read, with no gaps.

This generation is also where the coordinator and the adapter share the twenty
bytes `0xb08bC7F2…7a7A61` on two different chains. The verifier reports the
collision and keeps the two identified apart rather than treating one as the
other; the projection does the same.

## A note on the ASSET_RELEASED timing

The run recorded 1482 seconds for the ASSET_RELEASED VAA, and that figure is not
published as a finality sample. The poll spent part of that window unable to
reach the guardian API at all — `UND_ERR_CONNECT_TIMEOUT`, seventeen consecutive
attempts between 23:44:20Z and 23:51:09Z — and an independent request for the
same sequence returned the signed VAA before the run's own poll recovered. True
finality was therefore at most 1229 seconds. `observed-latency.md` carries the
reasoning and excludes the number.

## Scope

`REVERIFY_AND_RESUME` and only that, unchanged from generation 2. The
destination is the one the intent named and is not a parameter of
`resolveHeldAsset`, so this cannot rebind a receiver or substitute an asset. The
other five PRD FR-012 order types need the authority registry and remain
unreachable.

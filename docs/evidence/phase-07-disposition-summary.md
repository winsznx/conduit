# Held after COMMIT, then dispositioned to a terminal settlement

**Live, on deployment generation 2, 2026-08-08.**
Settlement `0x30aa1b738cab5f534452b7ef4515119232505dba674ab768520e58be59ef4a17`.
Machine-readable: `phase-07-compliance-change-0x893ca44e.json`. Independent verification:
`verification-30aa1b738c.json`. Stream: `artifacts/compliance-change-30aa1b738c.log`.

This path has since been reproduced on generation 3, the canonical deployment —
see `phase-07-disposition-gen3-summary.md`. This report is kept as the
generation-2 record rather than rewritten, because a settlement stays verifiable
only against the generation that knows it.

A trade was legitimately committable. Eligibility changed after the commit.
Conduit refused to deliver, refused to refund, held the value, and delivered it
only once the authority said yes again — to the party the intent named, and
nowhere else.

## The whole path

```text
both legs prepared, buyer eligible      verify_apass code 4, canTransfer true
Base economic finality                  1350s, FINALIZED
fresh commit-time compliance            still code 4 — the commit was legitimate
COMMIT                                  the point of no return
cash released to the seller             irreversible from here

── the issuer raises minTier 0 → 21 ──  0x52b637bb7361e16ccbec8dfb23c6a22b…
the live policy refuses the buyer       canTransfer reverts
Cleanverse refuses                      TierTooLow — a signed refusal, not silence
releaseAsset                            HELD. Not delivered, not returned.
ASSET_HELD, 1093s finality              coordinator state HELD

── the issuer restores minTier 21 → 0 ── 0x051467c50b949b16cb9afd72199221b9…
eligibility returns                     code 4, canTransfer true

resolveHeldAsset  REVERIFY_AND_RESUME   0xd0b20a90f7181f1ddb96e06727b2a0a2d…
the bond is delivered                   to the receiver the intent named
ASSET_RELEASED, 1483s finality          HELD → RELEASED, forward only
recordLegResolved                       SETTLED
```

Five commit-time compliance queries, all live, all against the real policy. The
refusal is computed by the CCP contract and named by Cleanverse as `TierTooLow`;
nothing in this path manufactures an eligibility boolean.

## What could not happen, taken while committed and undelivered

```text
returnCash — a refund to the payer after COMMIT   LegNotInState
the seller reclaiming the reserved bond           ReservationAlreadyCommitted
an ABORT after the COMMIT                         AbortAfterCommitForbidden
```

## Conservation

```text
                      before      at held     after       after disposition
cash escrow balance   0           0           0           0
escrow accounted      0           0           0           0
rwa seller nominal    2,000,000   2,000,000   2,000,000   2,000,000
rwa seller reserved     500,000   1,000,000   1,000,000     500,000
rwa seller available  1,500,000   1,000,000   1,000,000   1,500,000
rwa total supply      2,000,000   2,000,000   2,000,000   2,000,000
```

The reserved balance moves 500,000 → 1,000,000 → 500,000. This settlement's
500,000 is reserved at preparation, stays reserved through the hold, and is
released by the disposition. Supply never changes and no unit is owned twice.

The 500,000 that remains is **not** a residue of this settlement. It belongs to
the generation-1 settlement `0x2b8ff0a7…a988e0bd`, which is still held —
correctly, because generation 1 has no disposition path. Both reservations live
on the same token and the same seller, and the aggregate accounts for exactly
the one that is still open:

```text
0x30aa1b73…  amount 500,000  committed true  released true   ← this one, settled
0x2b8ff0a7…  amount 500,000  committed true  released false  ← still held
seller reservedBalanceOf 500,000
```

That distinction cost a verifier finding. `reservedBalanceOf` is an aggregate
over every open reservation an owner has, and the first check asserted it was
zero — failing a settlement that had released perfectly because a different one
was still held. The check now asks about this settlement's own reservation and
reports the aggregate as context. It is the address-collision mistake in another
costume: a claim keyed to the wrong identity.

The cash line is flat because the buyer and the seller are one key (ASM-035).
The escrow taking 25,000,000 cSETTLE and releasing it, with `totalEscrowed`
equal to the balance at every snapshot, is the conservation statement that holds
here and it is checked rather than asserted.

## Independent verification

From the settlement ID and two RPC URLs, with the committed manifests and the
guardian set as the only other inputs:

```text
2 deployment generations found
  0x893ca44e coordinator eip155:10143:0x0AEBe99A…5c86  knows this settlement
  0x9303f240 coordinator eip155:10143:0xE4bA8F4D…f45be  does not know it

ASSET_PREPARED  seq 0  wormhole:10004:0x…bdf93a  FINALIZED  → coordinator  consumed
ASSET_HELD      seq 1  wormhole:10004:0x…bdf93a  FINALIZED  → coordinator  consumed
ASSET_RELEASED  seq 2  wormhole:10004:0x…bdf93a  FINALIZED  → coordinator  consumed
CASH_PREPARED   seq 0  wormhole:10009:0x…bd85b   FINALIZED  no consumer
COMMIT          seq 0  wormhole:10009:0x…5c86    FINALIZED  → adapter      consumed

canonical on-chain state   SETTLED
derived classification     SETTLED_FINAL
```

The generation selection is the part worth noticing: the verifier asked both
coordinators and used the one that knows this settlement. A generation-1
settlement stays verifiable against generation-1 contracts forever, and the
current generation cannot answer for it.

## Scope

`REVERIFY_AND_RESUME` and only that. The destination is the one the intent named
and is not a parameter of `resolveHeldAsset`, so this cannot rebind a receiver
or substitute an asset. The other five PRD FR-012 order types need the authority
registry phase 07 delivers and remain unreachable.

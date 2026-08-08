# Eligibility changed after COMMIT, and the bond did not move

**Live, on the deployed generation-1 stack, 2026-08-08.**
Settlement `0x2b8ff0a739d575f9fb680b1df185d65c58ad74aa454de10c4c4f65c9a988e0bd`.
Machine-readable: `phase-07-compliance-change.json`. Stream:
`artifacts/compliance-change-2b8ff0a739.log`.

The happy path shows Conduit can settle. This shows the harder thing: a trade
that was legitimately committable stopped being legitimately deliverable, and
Conduit neither refunded a seller who had already been paid nor delivered a
restricted asset to someone the policy now refuses. It held the value.

## What happened

```text
both legs prepared, buyer eligible          verify_apass code 4, canTransfer true
Base economic finality                      1275s, FINALIZED
fresh commit-time compliance                still code 4 — the commit was legitimate
COMMIT                                      0x…  the point of no return
cash released to the seller                 irreversible from here

── the issuer raises minTier on the RWA's RuleV2 ──
   0x1fa640cc622897f132de798912fdc946454ffdf01ca2fe01dfa78861110df32f
   [0x0000,0x0000,0,0,false,0] → [0x0000,0x0000,21,0,false,0]

the live policy now refuses the buyer       canTransfer reverts
Cleanverse now refuses                      TierTooLow(0x83C1…, 21, 20)
fresh commit-time compliance                a signed refusal, not a withheld answer
releaseAsset                                HELD. Not delivered, not returned.
ASSET_HELD reported and consumed            999s finality, coordinator state HELD

── the issuer restores the rule ──
   0x1252241f7ceb3085ae2c3142e27ac4b9474bc4220233b80d2128d780ef693202

eligibility returns                         code 4, canTransfer true
the bond is still held                      awaiting a disposition
```

The refusal is computed by the live CCP policy, not asserted by the runner.
`TierTooLow` names the subject, the required tier and the held tier: 21 against 20. `update_status` was not used because `generate_apass` is 403 for this
credential (ASM-035), which puts account-status transitions out of reach; RuleV2
is the other real Cleanverse compliance surface and it belongs to the issuer.

## What could not happen

Taken while the settlement was committed and the bond undelivered:

```text
returnCash — a refund to the payer after COMMIT   LegNotInState
the seller reclaiming the reserved bond           ReservationAlreadyCommitted
an ABORT after the COMMIT                         AbortAfterCommitForbidden
```

The second is the defect ADR-0016 closed, refused live in the window it used to
exist in.

## Conservation

```text
                    before        at held       after
cash payer          725,000,000   725,000,000   725,000,000
cash escrow balance 0             0             0
escrow accounted    0             0             0

rwa seller nominal  2,000,000     2,000,000     2,000,000
rwa seller reserved 0             500,000       500,000
rwa seller available 2,000,000    1,500,000     1,500,000
rwa receiver        2,000,000     2,000,000     2,000,000
```

Nothing disappeared, nothing is owned twice, and the committed leg is not
refundable. The 500,000 cBOND2 is reserved and locked: the seller cannot spend
it, cannot reclaim it, and the buyer has not received it. That is what "held"
means, expressed in balances.

The cash figures are flat because the buyer and the seller are one key
(ASM-035), so the 25,000,000 cSETTLE left the payer, entered the escrow and
returned to the same wallet. The escrow balance going 0 → 0 across the run with
`totalEscrowed` matching it at every point is the conservation statement that
does hold here, and it is checked rather than asserted.

## What this does not show

The disposition. `resolveHeldAsset` is not in the deployed adapter — it postdates
this generation, the contracts are non-upgradeable, and the replacement is
blocked on Monad gas (`phase-07-generation-2-blocked.json`). The path itself is
proven in `contracts/test/CrossChainSettlementSeam.t.sol` against
producer-originated messages across two chain IDs, and
`scripts/run-compliance-change.mjs` will run it live the moment a generation
carrying it exists: the script branches on the deployed bytecode rather than on
a flag, so it cannot claim a disposition the chain would have refused.

Until then the bond stays held, which is the correct state for it to be in.

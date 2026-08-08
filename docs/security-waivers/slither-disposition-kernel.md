# Waiver: Slither `operator-fee-outlier` on `DispositionController.resolveConflict`

**Status:** Active
**Opened:** 2026-08-08
**Expires:** 2026-11-08
**Scope:** the `operator-fee-outlier` detector, which is a third-party plugin
detector and not part of Slither's own set. Every Slither detector stays
unfiltered, and `fail_on` remains `low`.

## Finding

```text
Detector: operator-fee-outlier
Operator fee outlier risk: DispositionController.resolveConflict(
  bytes32,DispositionOrderLib.ConflictResolution[],bytes[]
) — 1 loop(s) + 2 state writes.
Arsia operator fee component likely >25% of total cost.
Reference: https://github.com/winsznx/tryanneal/blob/main/packages/detectors/README.md
```

## Why it does not apply

The detector models an **Arsia** operator fee component. Conduit deploys to Monad
Testnet and Base Sepolia. Neither charges an Arsia operator fee, so the cost
model the detector is warning about does not exist for this deployment. It is not
a false positive about the code shape — the loop and the writes are real — it is
a warning about a fee schedule Conduit is never billed under.

The shape it is pointing at is also the correct shape for the function.
`resolveConflict` validates one resolver per iteration because each resolver's
signature, nonce and authority class are separate facts; there is no batched
question that answers them. The two state writes are the case's new lead order
and its new state, and both are the point of the call.

Nothing about the loop can be made to fail expensively by an external party: it
is bounded by the caller's own array, the caller pays for it, and the whole call
reverts as a unit, so a partial execution cannot leave state behind. A resolver
supplying a thousand resolutions runs out of gas and changes nothing.

## Invariants checked

None of PRD 14.4's invariants is at risk. The finding is about gas cost
attribution, not about who may authorize a disposition, where value may go, or
whether it is conserved. `DispositionInvariants.t.sol` holds those.

## Compensating control

`forge snapshot --check --tolerance 1` gates the gas cost of every test including
`DispositionConflicts.t.sol`, so a change that made adjudication materially more
expensive fails the build on the number rather than on a heuristic.

## Removal condition

Conduit deploying to a chain that charges an Arsia operator fee, or
`resolveConflict` gaining a second loop or an unbounded one.

## What was fixed instead of waived

Four other detectors fired on the first version of this code and none of them is
waived, because each was pointing at something worth changing:

| Detector                | Was                                                                                                                            | Now                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `redundant-statements`  | a no-op `policy;` silencing an unused return                                                                                   | `_validateOrder` returns nothing                                                                                                       |
| `dead-code`             | `_validateResolution` declared and never called — a string replacement that silently no-opped, exactly ADR-0019's failure mode | called, and the call site was read back                                                                                                |
| `calls-loop`            | `registry.requireAuthority` once per resolver                                                                                  | `requireAuthorities` once, looping over the registry's own storage                                                                     |
| `incorrect-equality`    | `effectiveAt == 0` as a "no pending grant" sentinel, and a three-way `==` chain                                                | an explicit `PendingGrant.exists` flag, and `legIsClaimed` restated as the two states that _release_ the claim so it closes by default |
| `cyclomatic-complexity` | 19, then 12                                                                                                                    | 8, after `_countResolver` came out                                                                                                     |

The `incorrect-equality` and `cyclomatic-complexity` changes are improvements on
their own terms. The `dead-code` one was a real defect the detector caught.

## Review

Re-examined at the next contract change touching `DispositionController`, and at
expiry regardless.

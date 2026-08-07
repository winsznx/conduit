# ADR-0001: Cash custody mode for the Cleanverse A-Token leg

**Status:** Open
**Date:** 2026-08-07
**Phase:** 01
**Supersedes:** —
**Superseded by:** —

## Context

PRD 2.5 makes this a mandatory seam test and names this ADR as the place its result is
recorded. The number is therefore reserved from phase 00 so no unrelated decision can claim it.

The Cleanverse V5.6 documentation proves that Validator-registered contracts are supported. It
does not prove that an arbitrary registered contract can receive and later transfer the
selected A-Token. Those are different claims, and the whole cash leg rests on the second one.

PRD 2.5 fixes the experiment:

```text
verified buyer
→ approve CashEscrow
→ CashEscrow.transferFrom(actual A-Token)
→ CashEscrow holds exact amount
→ eligible receiver receives exact amount
```

## Decision

**Not yet made.** It cannot be made from documentation. It is made by running the seam test
above against the real sandbox A-Token in phase 01, and this ADR is completed with the result
before any production contract is written.

The choice is between the three adapters PRD 2.5 defines:

| Adapter                                | Selected when                                                                           | Cost                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `DirectATokenEscrowAdapter`            | `CashEscrow` can hold the real sandbox A-Token                                          | none — the intended design                                                             |
| `InstitutionalSettlementWalletAdapter` | Cleanverse requires an eligible institutional wallet instead of direct contract custody | explicit operator custody, segregated on-chain subledger, independent proof of balance |
| `PermitPullAdapter`                    | the selected A-Token exposes a compatible permit or authorization mechanism             | only viable if permit support is demonstrated, never assumed                           |

## Evidence

None yet. Phase 01 must record here:

- the A-Token address, symbol, and decimals returned by `query_deposit_atoken_list`;
- the `verify_apass` result code for the buyer, the escrow address, and the receiver;
- the approve, `transferFrom`, and release transaction hashes on Monad Testnet;
- the exact balance deltas at each step;
- whether the escrow contract required its own A-Pass.

## Consequences

Deferred until the decision is made. Two consequences are already fixed by the PRD and hold
regardless of outcome:

- if `InstitutionalSettlementWalletAdapter` is selected, it must not be presented as trustless
  escrow anywhere in the UI, README, or submission;
- mock CVA is not an acceptable final proof (PRD 2.5), so no outcome permits shipping the demo
  against a stand-in token.

## Alternatives rejected

None yet. Rejecting an adapter before the seam test would be exactly the speculation PRD 23
forbids.

## Assumptions touched

Resolves [ASM-002](../assumptions.md) (can a Validator-registered contract hold that A-Token)
and [ASM-003](../assumptions.md) (does the contract require its own A-Pass). Depends on
[ASM-001](../assumptions.md) (which A-Token pair the Monad sandbox offers).

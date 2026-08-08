# ADR-0020: The Disposition Kernel rests orders before it executes them

**Status:** Accepted
**Date:** 2026-08-08
**Phase:** 07
**Supersedes:** —
**Superseded by:** —
**Related:** ADR-0014 (compliance is attested), ADR-0016 (asset-seam defects), ADR-0017 (SETTLED vs SETTLED_FINAL), ADR-0018 (identity is a pair)

## Context

PRD FR-012 admits six disposition order types and seven authority classes, and
ends with one sentence:

> Conflicting valid orders produce `CONTESTED`. No funds move until conflict
> resolution under the configured authority policy.

Phase 06 shipped `REVERIFY_AND_RESUME` as a permissionless retry on each escrow.
That type has no destination parameter — it can only re-attempt the delivery the
settlement already agreed to — so it needs no authority and cannot conflict with
itself. The other five all direct value somewhere the counterparties did not
name, and they need the authority model this ADR records.

Three questions had to be answered before any of them could be written.

**Where does a case live?** PRD FR-012 binds a `case ID` without saying where it
comes from. If a signer chooses it, the conflict rule collapses: two authorities
wanting different outcomes each file under their own case, both are uncontested,
and both execute. So the case ID is _derived_ —
`keccak256(deploymentId, settlementId, leg)` — and the controller rejects any
order whose `caseId` is not that value. Every order about one piece of held value
lands in one case by construction.

**When may an order execute?** This is the load-bearing decision. Taken against
an immediate-execution design, the PRD's sentence is unenforceable: the first
valid order executes on arrival, the second conflicting order finds a settled
case, and the legal outcome was decided by whichever relayer's transaction landed
first. Two authorities genuinely disagreeing would be adjudicated by gas price.

**What counts as a conflict?** Four things decide where value ends up: the order
type, the destination, the amount and the asset. Two orders agreeing on all four
have the same effect whichever executes.

## Decision

### A filed order rests for the policy's contest window

`fileOrder` never moves value. It starts or joins a case. Anyone may file during
the window; an order agreeing with the resting one is a co-signature, and one
disagreeing contests the case. Only after the window closes, and only with the
policy's required number of distinct authorities, may `executeOrder` run.

`test_ARelayerRaceCannotDecideTheOutcome` files the same two disagreeing orders
in both arrival orders and asserts the results are identical and that nothing
moved. That test is the reason the window exists.

The window is not the only door. The escrows' permissionless
`REVERIFY_AND_RESUME` retry would pre-empt a resting rebind just as effectively
as an early execution — the value would reach the original receiver the moment
they became eligible again, while an authority was deciding it should go
elsewhere. So the retry asks `legIsClaimed` and stands down while a case is live.

### Destinations are allow-listed per order type, not in general

Each of the five redirecting types answers to its own registry list, maintained
by its own authority class:

```text
REBIND_RECEIVER            same registered identity commitment as the receiver
RETURN_TO_ELIGIBLE_SENDER  the original sender, and only after a COMMIT
AUTHORIZED_SUBSTITUTION    an approved substitute *for this receiver*
OPERATOR_ASSISTED_OFFRAMP  a registered gateway account
RESTRICTED_HOLD            a registered restricted custodian
```

One merged "approved address" set would make an issuer's substitution authority
and a gateway operator's off-ramp authority interchangeable. They are not, and
keeping them apart is what stops a disposition order from becoming a generic
drain authorization. The substitute list is keyed by the receiver being
substituted for the same reason: a global approval would be good against every
held settlement in the system.

The amount and the asset are read from the held leg and compared, never taken
from the order. An authority signs about the value that is stuck and cannot sign
about a different quantity of it.

### `RETURN_TO_ELIGIBLE_SENDER` is not a refund

A refund is a pre-COMMIT unwind that PRD FR-008 permanently disables once a
COMMIT exists. This is an authorized post-COMMIT disposition that happens to send
value back the way it came. The distinction is enforced, not documented: the type
requires the COMMIT decision, the COMMIT stays on chain as historical fact, the
settlement never becomes `ABORTED`, and the leg records `DISPOSED` rather than
`RETURNED`. Without the COMMIT requirement this order type would be a refund with
a different name.

### `RESTRICTED_HOLD` moves value; `HELD` is the absence of a decision

PRD 5.3 lists `SETTLED_TO_RESTRICTED_CUSTODY` as a terminal outcome, so
`RESTRICTED_HOLD` transfers the units to a registered custodian and closes the
case. It is not "leave it held forever with a label". The verifier reports
`RESTRICTED_HOLD_FINAL` and `HELD_PENDING_DISPOSITION` separately for exactly
this reason: the first is an authorized outcome a policy chose and a custodian
received, the second is value nothing has yet freed. They look alike from a
distance and mean opposite things about whether anyone is still owed an answer.

### Grants are timelocked, revocations are immediate

Without the delay the registry owner could add itself as an ISSUER, sign an
`AUTHORIZED_SUBSTITUTION`, and take a held bond inside one transaction. With it,
the grant is visible on chain for the whole window and the contest window sits on
top of it. Revocation stays instant because the fail-safe direction of an
access-control change should never wait.

### Orders bind the policy's content, not just its name

`authorityPolicyHash` pins what the policy said. A policy edited afterwards
invalidates orders signed under the old one rather than repurposing them, which
is why policy changes are _not_ timelocked: tightening a policy should take
effect immediately, and the orders it would have authorized should stop being
fileable.

### Only some of PRD 7.1's `CONTESTED` is on chain

A contested case is a fact about the kernel, and the settlement's own leg state
is unchanged: it is still exactly `HELD`. The coordinator is not driven to
`SettlementState.CONTESTED`, because doing so for the _asset_ leg would require a
cross-chain message PRD 7.3 does not define, and ADR-0015 forbids inventing one.
Driving it for the cash leg alone would make the canonical state mean different
things depending on which leg was contested.

So `CONTESTED` is a verifier classification, derived by reading the controller on
whichever chain holds the contested leg. This is the same treatment `SETTLED_FINAL`
gets under ADR-0017, and the report must never present it as contract state.

## Consequences

**A disposition is slower than a delivery, deliberately.** The contest window is
minutes to hours of latency between an authority signing and value moving. That
is the cost of the outcome being decided by the policy rather than by whoever
paid more gas.

**A hostile authority can stall a case by contesting it.** Filing a conflicting
order it has no intention of pursuing pushes the case to `CONTESTED` and forces
adjudication. That is a griefing cost, not a theft: the resolver class is
narrower than the signing class, the value stays exactly where it was, and the
griefer burns a nonce and a registered authority position doing it. A policy with
no resolver class is refused outright, because a conflict it cannot resolve is
permanent loss of the held value.

**Executors re-check everything.** The controller has already verified the amount,
the asset, the receiver and the held state, and each executor verifies them again
against its own custody before moving anything. A controller misconfiguration, or
a future controller with a bug, must not be able to move value the executor knows
is wrong.

**Compliance is checked twice and neither is redundant.** The authority signed its
order minutes or hours before execution; PRD 5.4 step 5 requires current checks on
the replacement. The executor's check at the moment of transfer is the one that
can say no about the present.

**The kernel needs a new deployment generation.** The contracts are
non-upgradeable and the executors gained an entry point, so generation 2 cannot
host it. Generation 1 keeps its held settlement and its lack of any disposition
path, which is correct and is the regression vector `SettlementScopedAccounting.t.sol`
preserves.

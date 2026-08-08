# ADR-0016: The asset seam had the same defects, and two of them moved value

**Status:** Accepted
**Date:** 2026-08-08
**Phase:** 06
**Supersedes:** —
**Superseded by:** —

## Context

ADR-0015 recorded three defects in the cash seam, why unit tests could not see
them, and one prediction: the asset leg had not had the equivalent scrutiny and
should be assumed to carry the same class of defect until a producer-originated
test said otherwise.

`CrossChainSettlementSeam.t.sol` is that test. Two real chain IDs switched with
`vm.chainId`, one Wormhole core per chain, and every protocol message the exact
payload a production contract emitted. The two chains matter: on one chain the
destination check and both EIP-712 domains compare a value against itself, so
three of the seven transport checks are vacuous and a single-chain harness
cannot fail them.

Seventeen of its twenty tests failed against the contracts as deployed.

## The defects

**A buyer who funded nothing could take the bond.** `recordCashPrepared` was
permissionless, and `CashEscrow` never called it. The coordinator therefore
learned that cash had arrived from whoever sent the next transaction. Against a
genuinely prepared asset leg, the buyer calls it, the settlement reaches READY,
and `issueCommit` succeeds: the seller's signature is one they already produced
to enter the trade, and the quorum attests two parties who are both really
eligible. Every check passes and the adapter delivers against an empty escrow.

It is the same shape as `recordLocalCashResolved` one leg upstream, and it
survived that fix because every test called it from the test contract. Nothing
ever asked whether the real producer calls it at all. Now the escrow makes the
call inside the transaction that takes the cash, and the coordinator accepts it
from nobody else.

**Canonical state could be made to disagree with where the value is, and then
locked.** `reportResolution` took a `bool released` from whoever called it,
unrestricted. After a genuine hold, anyone could publish ASSET_RELEASED; the
coordinator's checks all pass, because releasing after a COMMIT is precisely
what is supposed to happen. Canonical state then reads SETTLED while the bond
sits reserved and undelivered — and the true ASSET_HELD report is afterwards
refused with `LegAlreadyResolved`, so the correct state is permanently locked
out by the false one. Nobody's balance moves, which is why it reads as
harmless; what it destroys is the correspondence between canonical state and
where the value is, and every conservation claim rests on that.

ADR-0014's rule applies unchanged, and the evidence was on the same chain one
call away. The outcome now comes off the token: released, cancelled, or held,
derived rather than asserted.

**The seller could take the cash and keep the bond.** `cancelReservation` gated
the owner's exit on `committed`, which is _this chain's knowledge_ of the
COMMIT and arrives only when a relayer delivers the VAA. The COMMIT exists on
Monad well before that, and the cash releases against it immediately — same
chain, nothing to wait for. That leaves a window, minutes wide and timed by an
untrusted relayer, in which a seller watching the coordinator cancels on Base,
sells the units, and lets the later `releaseAsset` revert on a closed
reservation. The VAA is never consumed, so the asset leg can never resolve at
all.

Invariant R2 says "cancellable only before canonical COMMIT". The last moment
this chain can be sure of that is before the leg is announced: after
`prepareAsset` the settlement can reach COMMIT with no further transaction here.
So `prepareAsset` announces, announcing refuses a reservation that is already
closed, and from then on only a canonical ABORT frees the units.

**A held leg was held forever.** PRD 7.1 lists HELD -> SETTLED and invariant I9
says held value remains claimable through the Disposition Kernel. Neither was
reachable: `releaseCash` requires PREPARED, and `releaseAsset` requires a COMMIT
VAA that `_consume` has already burned. Not "claimable through the kernel" —
not claimable.

`resolveHeldCash` and `resolveHeldAsset` are PRD FR-012's `REVERIFY_AND_RESUME`
and only that. The destination is the one the intent named and is not a
parameter, so neither can rebind a receiver or substitute an asset; those five
order types need the authority registry phase 07 delivers. This one needs
nothing beyond the quorum that already decides every release, which is why it
can exist now and they cannot.

**One party on both sides needs one attestation, not two.** `issueCommit` asks
about `cashPayer` and `cashReceiver` separately. A caller building one
attestation per _party_ rather than per _subject_ presents one signer's opinion
about one address twice when they are the same address, and
`AttestationSignersNotDistinct` refuses it. The contract is right — two copies
of one opinion are not a quorum of two — and the caller was wrong. Every other
test uses distinct parties, so none of them could see it. It cost a live run at
the commit, with both Cleanverse queries answering eligible and the contract
still refusing.

## Decision

**The producer-originated rule extends to the asset leg, permanently.**
`CrossChainSettlementSeam.t.sol` joins `CashSettlementSeam.t.sol` as a file that
is not to be folded into the unit suites or simplified into fixtures. Its tests
are regressions for defects that reached deployed contracts.

**A cross-chain seam test runs on two chain IDs.** A harness where source and
destination are the same chain cannot fail the destination check, and both
EIP-712 domains collapse. `vm.chainId` per leg, one core contract per chain, and
a relay helper that copies the producer's payload and consistency level and
authors neither.

**No contract takes an outcome from a caller when it can read it.** ADR-0014
removed the compliance booleans. `reportResolution`'s `released` was the last
one, and it was worse than the others because the evidence it should have used
was one call away on the same chain.

## Consequences

- Both legs were redeployed. The struct, two function signatures, and the new
  verifier view all changed, so the previous deployment could not be upgraded
  into this one — the contracts are non-upgradeable by design and a new version
  deploys separately.
- The asset CVA was re-registered with Cleanverse under a new symbol, because
  `register_atoken` refuses a duplicate symbol with code 12002. Registration is
  a prerequisite of eligibility rather than a formality: `verify_apass` answers
  code 1, "atoken not exist", for an unregistered token, and code 4 only once
  RuleV2 is configured as well.
- `REVERIFY_AND_RESUME` exists and the other five disposition order types do
  not. Phase 07 remains NOT STARTED and the gap is one order type narrower.

## Alternatives rejected

**Restricting `reportResolution` to a relayer set.** It would close the false
report and add a liveness dependency. Reading the outcome off the token closes
it without one: anyone may carry a true statement, nobody may author one.

**Gating `cancelReservation` on a timestamp.** A grace period after
`prepareAsset` is a guess about relayer latency, and the failure mode of
guessing low is the theft this closes.

## Assumptions touched

Closes the ADR-0015 prediction about the asset leg. Does not touch ASM-036 or
ASM-037.

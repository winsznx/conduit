# ADR-0013: An authentic VAA is not a sufficiently final VAA

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 02
**Supersedes:** —
**Superseded by:** —

## Context

Phase 02 measured VAAs arriving in 2.6 and 3.5 seconds at consistency level 200. It is tempting
to read that as settlement latency. It is not.

Level 200 is Wormhole's _instant_: guardians sign as soon as they observe the message, before the
source chain's state is irreversible. Level 201 is _safe_. Anything else is _finalized_, and
Base's documented finalized path is roughly eighteen minutes. Wormhole warns explicitly that
non-finalized consistency on EVM carries reorg risk, and that the risk is most acute where remote
economic state is released against the VAA — which is precisely what Conduit does.

The failure this prevents is concrete. A remote `ASSET_PREPARED` authorizes `COMMIT`. `COMMIT` is
economically irreversible: no refund follows it, and the opposite leg releases against it. If the
PREPARED rested on state that was later reorganised away, the cash leg has paid for an asset that
was never prepared. That is the double-payout the protocol exists to close, arriving through the
transport rather than through the state machine.

`parseAndVerifyVM` does not help. It proves the guardians signed a message. It says nothing about
whether the source state behind that message still exists. A relayer chooses which VAA to submit,
so without enforcement it can publish at instant, wait for signatures, and hand the fast VAA to a
contract that expected a final one — with `valid == true` at every step.

## Decision

**Conduit enforces a minimum finality per message class, on chain, independently of
authenticity.**

**Finality is classified, never compared.** The wire encoding is not ordinal: 200 is the weakest
guarantee and 1 is among the strongest. A naive `consistencyLevel >= required` ranks instant
above finalized and admits exactly the message it was meant to reject. `finalityOf` maps the raw
byte onto `INSTANT | SAFE | FINALIZED` and the comparison happens on that enum.

**Every message class Conduit defines authorizes value**, so every one requires the settlement
level. PREPARED authorizes COMMIT; RELEASED and HELD mark a settlement terminal; ABORT and
DISPOSITION_RESOLVED move or free value. `observationFinality` exists for classes that inform
rather than authorize, and today there are none. A future informational class has to argue its
exemption in `test_EveryValueBearingMessageRequiresSettlementFinality`.

**The profile is immutable and bytecode-bound.** Both levels are constructor arguments stored as
immutables, so they appear in the deployed runtime bytecode and are therefore covered by the
`bytecodeHashes` a verifier recomputes. There is no setter: not for an owner, not per settlement,
not after signatures. A downgradeable finality policy is not a policy. The profile is also a
required field in the deployment manifest, so a verifier reads which profile is live rather than
inferring it.

**Fast VAAs keep their legitimate uses.** Relayer warming, UI preflight, downstream preparation,
observability. They may not authorize a canonical COMMIT, a post-commit cancellation lockout, an
asset or cash release, or an irreversible disposition. The distinction is enforced in
`_consume`, not left to a caller's discipline.

**Both measurements are kept and published.** Fast cross-chain observation of 2.6–3.5 seconds is
real and worth showing. Conservative settlement finality of roughly eighteen minutes on Base is
also real. Presenting only the first would be a lie by selection, and presenting only the second
would hide a genuine capability. The architecture is more credible with both.

## Evidence

`contracts/test/Finality.t.sol`, ten cases including a 256-run fuzz over every possible
consistency byte:

```text
instant cannot authorize release under the production profile
safe cannot authorize release when policy requires finalized
finalized is accepted
a relayer cannot substitute a lower-consistency VAA, and the rejected VAA is not consumed
  so the settlement is not stranded and the same message at finality still works
the raw byte is classified, not compared: 200 INSTANT, 201 SAFE, 0/1/15 FINALIZED
no setter exists; a downgrade call reverts
two deployments differing only in profile have different code hashes
every one of the nine message classes requires settlement finality
a relaxed profile is possible but explicit, visible in the constructor and the manifest
```

Live on both chains, read back from the deployed contracts:

```text
Monad Testnet   SettlementCoordinator  settlementFinality 2 (FINALIZED)
                CashEscrow             settlementFinality 2 (FINALIZED)
Base Sepolia    RWACVASettlementAdapter settlementFinality 2 (FINALIZED)
```

## Consequences

- Settlement latency is bounded below by the slower chain's finality, roughly eighteen minutes
  from Base. That is the honest number for the demo, alongside the fast-observation figure.
- The application and view layers gain intermediate states — `PREPARED_FAST`, `FINALITY_PENDING`,
  `READY_FINAL`, `SETTLED_PENDING_FINALITY`, `SETTLED_FINAL` — so a user sees progress during the
  wait. They are normalized view states, not on-chain ones: the on-chain machine stays monotonic
  and adding states to it to describe waiting would change what the invariants mean.
- A staging deployment may run a relaxed profile. It is visible in the constructor, the
  immutable, the code hash, and the manifest, so it cannot be mistaken for production.
- ASM-033 remains open and separate: the testnet guardian set has one signer, which is a
  different weakness from finality and must be stated on its own terms.

## Alternatives rejected

**Trust `parseAndVerifyVM`.** Conflates authenticity with irreversibility. It was the original
design and it is the vulnerability this ADR closes.

**Compare the raw consistency byte.** Would look like enforcement and rank instant above
finalized.

**Configure finality per settlement.** Puts the security parameter in the hands of whoever
constructs the intent, and a relayer or counterparty could then choose a weaker profile for a
settlement that has already been signed.

## Assumptions touched

Refines [ASM-012](../assumptions.md): the measurement stands as fast-transport evidence, and the
settlement profile is now a separate, enforced decision.

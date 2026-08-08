# Commit-time compliance is structurally enforced, not merely intended

**Measured 2026-08-08, against the live deployment.**

```text
maxAttestationValidity (immutable, SettlementCoordinator)   900s
observed Base Sepolia economic finality (DvP attempt 3)    1485s
```

The validity window is shorter than the wait it would have to survive. An
attestation minted when the legs are prepared is expired by the time the
finalized `ASSET_PREPARED` VAA arrives, so `issueCommit` cannot accept it. There
is no configuration in which a prepare-time compliance decision reaches a commit.

That is the property Conduit exists for, holding by construction rather than by
discipline. Compliance can change between prepare and commit; a design that
carried the earlier answer forward would settle on a judgement the authority has
since revised, and no amount of care at the call site would prevent it. Here the
contract refuses, because `maxAttestationValidity` is an immutable in the
bytecode and the arithmetic does not permit it.

Two consequences worth stating.

**The runner is correct by construction, not by intention.** `run-dvp.mjs`
builds its commit proofs after the finality wait, immediately before
`issueCommit`. Had it built them earlier the run would fail on expiry rather
than settle on stale compliance — the safe direction, and the reason the ordering
is not merely a convention to remember.

**The failure-path demo needs no contrivance.** Eligible at prepare, frozen
before commit, fresh commit-time query refuses: that is the ordinary path with a
real state change in the middle, not a scenario built to fail.

Recorded because attempt 4 would otherwise have been debugged twice. Fixing the
signer without checking the lifetime would have produced an expired-attestation
revert that looks like a new defect and is the same twenty-five minute wait.

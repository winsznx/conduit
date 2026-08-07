# Runbook: emergency revocation

**Status:** skeleton — procedure fixed, commands added by the phase that creates each key
**Required by:** PRD 17.4
**Last drill:** never

## Trigger

Any of:

- a compliance signer key is suspected compromised (threat T-08);
- the Cleanverse API key or AES key is suspected disclosed (T-02, T-03);
- an unexpected emitter configuration change is observed (PRD 16.3 alert);
- an owner or deployer key is suspected compromised;
- a balance or accounting mismatch alert fires.

Suspicion is enough. Confirmation is not a precondition.

## What is and is not possible

The protocol is deliberately narrow here, and knowing the limits in advance prevents an
operator from attempting something the contracts will reject.

**Possible**

- pause new preparations;
- rotate the compliance signer set through the timelock;
- rotate the approved Wormhole remote emitter through the timelock;
- revoke the Cleanverse API credential upstream;
- stop the relayer.

**Not possible, by design**

- reversing an executed settlement (PRD 8.2);
- refunding after COMMIT — `refund()` always reverts (invariant I4, PRD FR-008);
- releasing value to a recipient who is not currently eligible (invariant I8);
- bypassing the Disposition Kernel for held value (invariant I9);
- seizing or rewriting settlement state.

A compromised key does not grant any of the second list. That is the point of the design, and
the first action during an incident is to say so out loud rather than search for an override.

## Procedure

1. **Contain.** Pause new preparations. Stop the relayer. Existing valid VAAs remain relayable
   by anyone, which is intended — invariant I12 means a stopped relayer cannot cause loss.
2. **Scope.** Identify every settlement in a non-terminal state and every open disposition case.
   Read from chain, not from the database.
3. **Revoke upstream first** for API credentials: a rotated key in the secrets manager is
   useless while the old one still authenticates at Cleanverse.
4. **Start the timelocked rotation** for on-chain roles. Do not attempt to shorten it; the delay
   is the control.
5. **Preserve evidence.** Snapshot the affected settlements, VAAs, and Cleanverse request IDs
   with response hashes before anything changes.
6. **Communicate** the trust-boundary impact plainly. If a compliance signer was compromised,
   attestations it produced within their validity window are suspect, and every settlement that
   consumed one must be listed.
7. **Resume** only after the public verifier agrees with on-chain state for every affected
   settlement.

## Never, during revocation

- Never release a held leg "to unblock the incident". Held value moves only through a signed
  disposition order (invariant I9).
- Never disable a security check to speed recovery. PRD 15.5 requires a written waiver in
  `docs/security-waivers/`, and an incident is not a waiver.
- Never accept a VAA from a newly configured emitter before the timelock elapses.
- Never log the compromised secret while proving it was compromised.

## Verification

- The revoked identity is rejected on-chain and at the Cleanverse API.
- No settlement changed terminal state during the incident window.
- Conservation invariants I1 and I2 hold for every affected settlement.
- The evidence snapshot hashes match what the indexer recorded.

## To be completed

Contact paths, the Cleanverse support channel and the exact question format from CLAUDE.md's
blocked-report requirements, pause transaction templates, and the staging drill result.

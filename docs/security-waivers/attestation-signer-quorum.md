# Waiver: the compliance attestation signer is 1-of-1

**Status:** Active
**Expires:** 2026-11-09
**Threats:** T-08 compromised compliance signer, T-09 signer collusion
**Invariant at risk:** I8 — no terminal destination is used without current eligibility
**Register status:** the two rows move to `ACCEPTED` on the strength of this file
**Real exit:** the first deployment that runs more than one independent attestor

## What is accepted

`SettlementCoordinator`, `CashEscrow` and `RWACVASettlementAdapter` each read
their own registered signer set and quorum from chain. On the canonical
generation-3 deployment those are:

```text
complianceSignerCount()  1
complianceQuorum()       1
isComplianceSigner(0xEC16Ead9832292fEfc95Bc94C3D536Eed98ED26c)  true
```

One key, operated by Conduit, decides eligibility for every settlement.

## Why it is accepted rather than mitigated

The contract verifies that an authorised signer asserted something. It cannot
verify that the signer asked Cleanverse or that Cleanverse answered that way; no
contract can, without a signature from Cleanverse itself. Raising the quorum
does not remove that property — it distributes it, which is a different and
better thing, and it requires a second independent operator this deployment does
not have.

Carrying the risk visibly is more honest than describing a one-signer
arrangement as a mitigation.

## Bound

The key cannot move a token, sign a settlement intent, create a settlement,
decide one without both parties' signatures and a canonical `READY` state, or
release a leg without a `COMMIT` already on chain. Its whole power is the
eligibility verdict.

## Compensating controls that are live

```text
the validity window is an immutable 900 seconds and cannot be widened
every attestation binds the settlement id and the intent hash
the evidence hash of the Cleanverse response is committed on chain
a refusal is signed as explicitly as an approval, so the record shows it
an outage is never signed at all — no attestation is minted when nobody answered
the browser asks the contract itself, through verifyEligible, before a wallet
  is prompted, so a proof the chain would reject never reaches a user
```

## Exit

`addComplianceSigner` and `setComplianceQuorum` are owner functions on the
deployed contracts and take effect immediately. The exit is operational, not a
redeployment: register a second independent attestor, raise the quorum, and this
waiver closes.

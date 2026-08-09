# ADR-0021: The web surface holds a compliance key, and nothing else

**Status:** Accepted
**Date:** 2026-08-09
**Phase:** 06, 07
**Supersedes:** —
**Superseded by:** —

## Context

The Worker at `apps/web` was built with a property stated in its own header:
"There is no signer in this Worker and no private key." That was true while the
surface was read-only, and it was the strongest version of the trust story —
a service that cannot sign cannot be made to sign.

Then the participant flow moved into the browser. A participant can now compose
an intent, be checked against Cleanverse, and sign EIP-712 with their own
wallet. Every one of those is correct with no key on the server: the settlement
id is a digest anybody can re-derive, and the signature comes from the user.

Preparation is the same. `reserveForSettlement`, `prepareAsset`, `approve` and
`prepareCash` are all sent by the participant's own wallet.

`issueCommit` is not. Nor is `releaseCash`, `releaseAsset`, or
`DispositionController.executeOrder`. Each of them takes a `ComplianceProof` and
each calls `ComplianceAuthority._requireEligible`, which recovers the signer of
every attestation and refuses any address the contract's registered signer set
does not contain:

```solidity
address signer = ECDSA.recover(digest, signature);
if (!_signers[signer]) revert AttestationSignerNotAuthorized(signer);
```

On the deployed generation-3 coordinator the signer set has one member and the
quorum is one. That member is the compliance authority. It is not the buyer, not
the seller, and not any relayer.

So the browser cannot produce a proof, and it should not be able to: an
attestation is an authority's statement that Cleanverse permitted a participant
at a particular moment, and a participant who could mint one could authorise
their own settlement. Every path to a commit from a browser therefore runs
through something that holds the authority key.

The options were:

1. **No commit from the browser.** The console prepares and a CLI finishes.
   Honest, and not a product — a participant who has just locked their cash is
   told to open a terminal.
2. **A separate attestation service.** Correct in a production topology, and a
   second deployment surface, a second set of secrets, and a second thing that
   can be stale, for a hackathon deployment that already has exactly one Worker.
3. **The Worker mints attestations.** One key, in Worker secrets, used for one
   purpose.

## Decision

**The Worker holds `COMPLIANCE_SIGNER_PRIVATE_KEY` and exposes
`POST /api/attestations`.** For each subject it queries Cleanverse live, with no
application cache, and signs a `ComplianceAttestation` bound to the settlement,
the intent hash, the subject, the issuing time and the hash of the answer.

**It is not a settlement key.** Precisely, it cannot:

- move a token, on either chain;
- sign a settlement intent, so it cannot create or agree to a trade;
- decide a settlement — `issueCommit` additionally requires `READY`, both
  parties' signatures, an open commit deadline and a caller paying gas;
- release a leg without a canonical `COMMIT` already on chain;
- file a disposition order, which requires an `AuthorityRegistry` class it does
  not hold.

What compromising it buys an attacker is the ability to lie about eligibility.
That is the compliance authority's entire power, which is why the registry, the
quorum and the 900-second validity window exist on chain rather than in
configuration. It buys no custody.

**A refusal is signed; an outage is not.** `validator/verify` answering
`valid:false` is a decision, and it is minted as an `eligible:false` attestation
so the audit package records the refusal rather than an absence. A transport or
gateway failure produces no attestation at all — nobody was asked, so there is
nothing to attest, and the endpoint returns `unavailable: true` with the
attestation list empty.

**The domain is read and recomputed before anything is signed.** The verifying
contract's `attestationDomainSeparator` is fetched and independently recomputed
from the deployment's name, version, chain id and address, and the two must
agree. This is the check that a failed live run did not have: a signature valid
over a domain nothing uses recovers to a stranger, and the revert says
`AttestationSignerNotAuthorized` either way.

**The browser then asks the contract.** Before a wallet is prompted, the client
calls `verifyEligible` on the verifying contract with the exact proof it intends
to submit, and simulates `issueCommit`. Only a proof the contract itself accepts
reaches a wallet.

## Consequences

- The Worker's own header no longer claims "no private key", and says what it
  does hold and what that key cannot do. A comment that is no longer true is
  worse than no comment.
- `attestationsAvailable` is rendered into the settlement workspace. A
  deployment with no key configured says so in the action panel, offers
  preparation, and does not pretend a commit is one click away.
- The threat register gains the compromise-of-attestor case, which was already
  modelled — the authority was always a distinct actor. What changed is where it
  runs.
- A production topology should separate this into its own service with its own
  key custody. Nothing above depends on it being in the same Worker; the
  endpoint contract is the boundary.

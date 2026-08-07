# ADR-0014: Compliance is attested, not asserted

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 05
**Supersedes:** —
**Superseded by:** —

## Context

Four booleans decided whether value moved, and every one of them came from
whoever happened to call the function:

```solidity
issueCommit(intent, settlementId, buyerSig, sellerSig, bool complianceFresh, uint8 level)
issueAbort(intent, settlementId, bool deadlineMissed, bool complianceFailed, bool bilateral, ...)
releaseCash(commitVaa, bool eligible)
releaseAsset(commitVaa, bool receiverEligible)
```

They were placed as explicit parameters rather than assumed `true`, which made
the blocked paths reachable and tested from the start. That was the right call
for the state machine and the wrong thing to ship. A boolean records that a
decision exists. It carries nothing about who made it, when, about whom, or on
what evidence, so any caller could assert eligibility and the contract had no
basis to disagree. CLAUDE.md states the rule the design was violating: application
database state never authorizes value movement.

`complianceFailed` was worse than the others and it is worth naming precisely.
Anyone could abort a healthy, in-window settlement that both parties wanted to
complete, by passing `true`. Not theft — griefing, which is the class that
survives review because nobody's balance changes.

## Decision

**A signed attestation from a quorum, bound to the settlement, the terms, the
subject, and a window the contract fixes.**

```solidity
struct ComplianceAttestation {
    bytes32 settlementId;   // does not carry to another settlement
    bytes32 intentHash;     // nor to the same settlement under renegotiated terms
    address subject;        // nor to a different party in it
    bool eligible;          // a refusal is signed as explicitly as an approval
    uint64 issuedAt;
    uint64 expiresAt;
    bytes32 evidenceHash;   // the Cleanverse response the decision came from
}
```

EIP-712, so the domain binds chain ID and verifying contract: an attestation for
the Monad coordinator is not valid at the Base adapter with the same signer,
subject, and settlement.

**Quorum, not a signature.** `quorum` distinct authorized signers must attest the
same subject. Duplicates from one signer count once, which is the check that
separates a quorum from a loop counter.

**A lifetime the signer does not choose.** `expiresAt` is inside the signed
struct, so a signer could set it a year out and hand a compromised key a year of
authority. `maxAttestationValidity` is an immutable, set at deployment to 900
seconds, and caps the window independently.

**Both parties, separately.** Attesting only the receiver lets an ineligible
payer fund a settlement; only the payer, and value reaches someone the authority
refused.

**An unconfigured authority refuses everything.** The quorum starts at zero and
`attesting >= 0` holds for an empty array, so the first version of this accepted
any commit with no evidence at all — worse than no check, because the check
appears to be there. The zero case is now rejected explicitly. Deployment and
configuration are two steps and the window between them is closed.

**Refusal and silence are different states.** `_isEligible` and `_isRefused` are
not negations of each other. "The authority said no" is grounds for an abort;
"the authority has not answered" is not. Collapsing them is what let the old
boolean abort a live settlement.

**Reverting before COMMIT, holding after it.** `issueCommit` reverts on a
shortfall, because a caller who could branch on the result would be free to
ignore it. The release paths do not revert: after COMMIT there is no refund, so a
release that cannot proceed must reach the held state rather than strand the
value. Malformed input still reverts in both, because a forged signature and an
authority saying no are different answers.

**Every abort ground now proves itself.** Three booleans became one enum, each
with its own proof: `DEADLINE` against the chain's clock, `COMPLIANCE` against a
signed refusal, `BILATERAL` against both parties' signatures over a cancellation
digest. The intent signature cannot stand in for the last one — signing to enter
a trade is not signing to abandon it.

**The service signs what Cleanverse answered, and nothing else.**
`packages/cleanverse/src/compliance.ts` calls `validator/verify` at commit time
with no application cache, per PRD 9.4. A `valid: false` becomes a signed
refusal, because PRD 2.2 makes that a legitimate non-eligibility decision. A
timeout, a 5xx, or a schema mismatch throws and never becomes `eligible: false`:
converting an outage into a decision would put a judgement nobody made into the
audit package. The signing key never enters the module — the caller supplies a
`signDigest` function, so a KMS, a hardware signer, and a local key are the same
shape and none can be logged from inside the package.

`evidenceHash` is the hash the client took over the raw bytes before redaction.
No raw response and no PII reaches the chain, and the audit package can still
prove the stored record is the one the decision came from.

## Evidence

The two implementations are written independently and pinned to each other by a
fixed vector, because one implementation agreeing with itself proves nothing:

```text
packages/domain/src/attestation.test.ts    0x4a31393a4953e7e12fa930c32075640385d3d73a7e1753962432db4c7ed32063
contracts/test/ComplianceAttestation.t.sol 0x4a31393a4953e7e12fa930c32075640385d3d73a7e1753962432db4c7ed32063
```

A 256-run fuzz asserts every field changes the digest. A field silently left out
of the preimage is a field an attacker chooses freely.

Adversarial cases, all passing:

```text
no attestations at all cannot commit
one signer cannot meet a two-signer quorum
one signer cannot reach quorum by attesting twice
an unauthorized signer is rejected outright
an attestation for another settlement does not transfer
an expired attestation is refused
a signer cannot grant itself a 365-day window
attesting one party is not attesting both
a freshly deployed coordinator refuses every commit
a freshly deployed escrow holds rather than releases
removing a signer cannot strand the quorum above the surviving set
anyone could once abort a live settlement by claiming compliance — now refused
an eligible attestation is not grounds for a compliance abort
bilateral cancellation needs both parties
a cancellation for another settlement does not transfer
```

## Consequences

- Committing needs a live compliance service. That is a real liveness dependency
  and the honest trade for not letting a caller assert its own eligibility.
- The signer set and quorum are operational state with a key-rotation runbook
  (PRD 17.4). `removeComplianceSigner` refuses to leave the quorum above the
  surviving set rather than discovering it at the next settlement.
- Deployment is two steps. A contract is live and refusing everything until its
  quorum is configured, which is visible in `complianceQuorum()` and is the safe
  direction to fail.
- The differential corpus supplies a full eligible quorum on every trace. It
  explores state-machine orderings, and mixing compliance in would leave a
  failing trace ambiguous between two subsystems.

## Alternatives rejected

**An oracle contract the coordinator calls.** Adds an external call on the
critical path and moves the evidence off the commit transaction. Passing the
attestations in calldata means the proof is in the transaction a verifier already
has to read.

**One attestation covering all parties.** Cheaper, and it makes a partial
refusal unrepresentable: the authority would have to approve everyone or nobody.

**Trusting `policy.canTransfer` alone.** It is authoritative at the moment of
transfer and says nothing at commit time, which is when the irreversible decision
is made. Both checks exist and they answer different questions.

## Assumptions touched

Advances ASM-005 and ASM-020. Opens ASM-036: the signer set is a single key on
testnet, so the quorum is 1-of-1 in the current deployment and must be stated as
such rather than presented as a threshold.

# ADR-0019: A negative proof must reach the layer it blames

**Status:** Accepted
**Date:** 2026-08-08
**Phase:** 07
**Supersedes:** —
**Superseded by:** —
**Related:** ADR-0015 (producer-originated messages), ADR-0018 (identity is a pair)

## Context

Two checks in this repository reported a passing safety property they had not
observed. They were written five days apart by the same process, and neither
looked wrong when it was written.

**The isolation check.** `scripts/prove-generation-isolation.mjs` proved that a
superseded contract could no longer call a privileged function on the current
generation. It ran, it passed, and the artifact recorded the separation as
holding. The reason it passed was:

```text
Function "recordCashPrepared" not found on ABI
```

viem refused to build the calldata. Nothing was sent. No node was asked. The
`catch` treated any thrown value as evidence of refusal, so the check would have
reported the same pass against a contract with no access control at all. The
function was genuinely restricted — that is not the point. The _check_ proved
nothing, and the artifact said it did.

**The verifier finding.** The settlement verifier asserted
`reservedBalanceOf(seller) == 0` to prove that a settled asset leg held no units.
`reservedBalanceOf` is an aggregate over every open reservation a wallet has. The
seller had another settlement legitimately held on generation 1, so a settlement
that had released perfectly was reported as incomplete.

**And the same shape inside a contract.** While writing the Disposition Kernel's
multi-settlement tests, `ConduitRWACVA._update` turned out to subtract the
releasing reservation from `_reservedOf` a second time, having already
decremented it. With one reservation the subtraction is unreachable, so ninety
tests and two live settlements never touched it. With a second, smaller
reservation open it underflows and the release reverts: held value that no
authority can free. Recorded as D-06.

All three are one error. A claim was keyed to something adjacent to the thing it
was about, and the adjacent thing answered.

## Decision

**A negative proof is valid only if the intended operation actually reached the
layer whose rejection is being claimed.**

These are not interchangeable and must never be collapsed:

```text
CLIENT_ENCODING_FAILURE   !=  CONTRACT_REVERT
TARGET_NOT_A_CONTRACT     !=  CONTRACT_REVERT
RPC_FAILURE               !=  POLICY_REFUSAL
TRANSPORT_TIMEOUT         !=  BUSINESS_REFUSAL
AGGREGATE_STATE           !=  SETTLEMENT_STATE
```

Every negative chain assertion records, and every artifact carries:

- the calldata, as proof the operation was expressible at all;
- that the target address holds code;
- that the call reached the target — `eth_call` or a simulation, not a local
  guard;
- the raw revert bytes, before anyone interpreted them;
- the decoded error, against the target's own ABI;
- the target address and the chain ID;
- settlement-scoped pre-state, keyed the way the claim is keyed.

A revert alone is not sufficient either. If the claim names a reason, the decoded
error must be that reason: "refused because the deployment is wrong" backed by a
revert that says the deadline expired is a true observation attached to a false
conclusion.

The rule is enforced rather than documented.
`packages/verifier/src/refusal.ts` exposes `proveContractRefusal`, which walks
the path step by step and returns evidence only for a genuine
`CONTRACT_REVERT`. Every other outcome throws `NotARefusalError` carrying the
same structure with `isProtocolRefusal: false`, so a caller cannot accidentally
treat a client-side failure as a protocol fact. Scripts making negative claims
use it; `prove-generation-isolation.mjs` is the first, and its artifact now
carries `refusalEvidence` alongside its verdicts.

The state half of the rule has no single helper because it is a question of
keying rather than of transport. It is enforced by regression instead:
`contracts/test/SettlementScopedAccounting.t.sol` holds one wallet with two
settlements and fails if anything in the system infers one settlement's state
from a wallet aggregate. The verifier's own check was rewritten to ask about the
settlement's own reservation and to report the aggregate as context.

## Consequences

**Some checks get slower and longer.** Proving a refusal is now four network
observations rather than one try/catch. That is the cost of the check meaning
what it says.

**Some existing negative claims may be worth less than they read.** The rule
applies going forward and to anything reworked; it is not a licence to assume
untouched checks are sound. Where a claim matters to a submission, it is proven
again through the helper rather than trusted.

**A revert with undecodable data is still recorded as a revert.** The bytes are
preserved and no error name is guessed. A selector the target's ABI does not
describe is a finding in itself, not a reason to discard the observation.

**The Cleanverse side gets the same treatment.** `scripts/probe-fiat-ramp.mjs`
separates `ROLE_NOT_GRANTED`, `ENDPOINT_NOT_PRESENT`, `BUSINESS_REFUSAL`,
`HTTP_ERROR` and `TRANSPORT_TIMEOUT`, because "the sandbox does not support this"
and "our credential lacks the role" and "the request timed out" are three
different findings and only one of them is a limitation worth recording in a
submission. That distinction is what let ASM-010 resolve precisely: the Fiat Ramp
role is granted and SELL quoting is live, and the hosted widget refuses with
`RM_003` because the subject has no A-Pass on the quoted chain.

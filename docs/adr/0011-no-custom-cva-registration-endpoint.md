# ADR-0011: Custom-CVA registration via /atoken/register_atoken

**Status:** Open
**Date:** 2026-08-07
**Phase:** 03
**Supersedes:** —
**Superseded by:** —

## Context

The v1.1 override section 6 fixes the workflow: deploy `ConduitRWACVA`, then _"call Register CVA
API"_ with an EIP-191 `owner_signature` over lowercase(chain + atoken_address). The CCP guide
calls this Method B, the custom contract template path, and contrasts it with Method A where
Cleanverse deploys its own template and pushes policy by API.

Method B is what the entire asset-leg architecture rests on. A Cleanverse-deployed template has
no reservation accounting, and reservation is the override's central innovation.

An earlier revision of this ADR recorded Method B as absent from the sandbox. **That conclusion
was wrong and is retracted.** It rested on ten guessed route names, none of which was the
documented one. API V5.6 documents `POST /atoken/register_atoken`, and the probes tried
`/atoken/register` and `/register_atoken` but never that exact combination.

Guessing at route names and then reporting the absence of a capability is a bad failure mode:
it manufactures a platform limitation out of an incomplete search, and escalating it would have
spent someone else's time on a problem that did not exist. The endpoint is now implemented from
the documented contract and the outcome is recorded below once exercised.

## Evidence

`ConduitRWACVA` is deployed and correct on Base Sepolia:

```text
ConduitRWACVA            0x244198CFA8660BE9B47961E3C061DFA90622d2B0
RWACVASettlementAdapter  0x5479a4ff288E1cC77B5E352BfD822a9ce269E93f
policy()              -> 0x36489bE45fa84f70a0c2BDB11D824Be608CB12Dd   (the live CCP policy)
SETTLEMENT_ROLE       -> held by the adapter
```

The live policy refuses it, correctly and for the right reason:

```text
canTransfer(ConduitRWACVA, …) -> revert TokenNotRegistered()   0x259ba1ad
```

Registration against the documented endpoint has not been submitted yet: it requires the owner's
EIP-191 signature, which is a human gate. What is prepared and verified locally:

```text
endpoint      POST /api/cooperate/atoken/register_atoken   (AES-encrypted body)
chain         base                                          (Cleanverse slug, not base-sepolia)
atoken        0xd018aAd670585519e0953310D29CC2F65011782C
owner()    -> 0x83C130ed9fb92830F09ea2b30E49009EF03065Bb    read from the contract
message       base0xd018aad670585519e0953310d29cc2f65011782c
```

A defect was caught while preparing it. The first deployment carried `AccessControl` alone, so
`owner()` reverted. The CCP guide's own templates both expose `Ownable`, and PRD 9.6 says
protocol contracts expose `owner()`; Cleanverse validates the registration signature against the
contract owner. Registration would have failed _after_ a human had already signed for it. The
contract now carries `Ownable2Step` alongside `AccessControl` and was redeployed:
`0x244198CF…d2B0` is superseded by `0xd018aAd6…782C`.

Ownership and rule administration are deliberately separate. `owner()` is the registration
identity; `DEFAULT_ADMIN_ROLE` manages RuleV2 and grants `MINTER_ROLE`. Transferring ownership
does not silently hand over rule management, and a test asserts it.

A second constraint surfaced alongside this. **A-Pass is scoped per chain.** The deployer holds
an ACTIVE A-Pass on monad and none on base, and the live Base Sepolia policy answers
`NoAPass(0x83C130ed…065Bb)` for a registered CVA. Eligibility on the cash leg does not carry to
the asset leg.

## Decision

**Use the documented endpoint and exercise it before drawing any conclusion about platform
capability.** `registerAToken` and `pollApplyStatus` are implemented in the typed client with
strict schemas and twenty tests.

Two semantics are enforced in code rather than left to a caller's care:

`ISSUED` is the only terminal success. `PENDING` and `APPROVED` are explicitly _not_ registered,
because an approved-but-not-issued CVA still fails `canTransfer`, and reporting it as done would
put a capability in the audit package that the chain disagrees with.

The signing string is `lowercase(chain + atoken_address)` with no separator, and the chain is
the Cleanverse slug. A checksummed address signs perfectly cleanly and recovers to a different
account, so a test signs over the checksummed form and asserts it does _not_ recover to the
owner.

`atoken_icon` is sent as required. The newer CCP PDF marks it optional and API V5.6 marks it
required; satisfying the stricter contract costs nothing.

**Only if this exact endpoint fails with the correct payload** does a platform limitation get
recorded, and then with the verbatim request and response rather than an inference.

## Consequences

Deferred. What already holds:

- `ConduitRWACVA` and the adapter stay deployed. They cost nothing to leave in place and are the
  concrete artefact option B needs.
- The reservation mechanics are proven in the suite regardless: 25 tests including R1 through R5,
  double-spend prevention, and cancel-after-commit refusal. What is unproven is the same
  mechanics against a _registered_ CVA under live CCP policy.
- Nothing is claimed as a registered CVA until it is one.

## Assumptions touched

Opens [ASM-031](../assumptions.md) and [ASM-032](../assumptions.md).

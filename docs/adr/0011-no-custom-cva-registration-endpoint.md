# ADR-0011: The sandbox exposes no custom-CVA registration endpoint

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

The sandbox API does not expose it.

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

Registration was attempted with a valid owner signature over `base0x244198cf…d2b0`, signed by the
contract owner. Every plausible path returns 404 while the Method A path exists:

```text
/atoken/register          404        /atoken/register_custom   404
/register_atoken          404        /atoken/bind              404
/atoken/apply             404        /atoken/add               404
/apply_atoken             404        /register_cva             404
/cva/register             404        /atoken/register_cva      404

/atoken/launch            200  {"code":"10002","message":"decimals it cannot be empty"}
```

`/atoken/launch` is live and validates a full schema: `chain`, `token_name`, `token_symbol`,
`decimals`, `admin_address`, `rule`, `icon`. So the CVA issuance surface exists on this API
version; only the custom-contract half of it is missing.

A second constraint surfaced alongside this. **A-Pass is scoped per chain.** The deployer holds
an ACTIVE A-Pass on monad and none on base, and the live Base Sepolia policy answers
`NoAPass(0x83C130ed…065Bb)` for a registered CVA. Eligibility on the cash leg does not carry to
the asset leg.

## Decision

**Not yet made.** This changes what the asset leg can be, so it is the project owner's call.

**A. Launch a CVA through Method A and escrow it.** Cleanverse deploys its template with us as
`admin_address`, giving a genuinely registered, RuleV2-gated CVA. The asset leg then uses escrow
custody through `AssetEscrow` rather than token-native reservation. Keeps "Cleanverse-native
compliant assets on both legs" and the whole cross-chain DvP claim. Loses the reservation model,
and reintroduces the question of whether a contract may hold a CVA — the asset-side twin of
ADR-0001, which the reservation design existed partly to sidestep.

**B. Ask Cleanverse to enable Method B, or to register `0x244198CF…d2B0` manually.** Preserves
the override exactly. The contract is deployed, verified, and pointed at their policy, so the
ask is narrow: one registration for one address. Depends on their response.

**C. Ship `ConduitRWACVA` unregistered.** Rejected. Its policy answers `TokenNotRegistered()`, so
no transfer would ever succeed, and override section 17 requires the final demo to use a real
registered CVA rather than a mock. An unregistered token is a mock wearing a better name.

**Recommendation: B first, A as the fallback.** B is a small, specific request against a
deployment that already exists and already points at their policy. A is available immediately if
the answer is no or slow, and costs the reservation model rather than the product.

Either way the Base A-Pass problem (ASM-031) has to be solved before an eligible transfer can be
demonstrated on the asset leg, and that is a Cleanverse action under both options.

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

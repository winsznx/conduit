# Threat model

| File                                         | Contents                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------- |
| [trust-boundaries.md](./trust-boundaries.md) | Where untrusted input enters, and what re-verifies it                   |
| [threat-register.md](./threat-register.md)   | 37 PRD 14.3 threats plus 11 from the v1.1 override, bound to invariants |

## How this is kept honest

`tests/docs.test.ts` parses PRD sections 14.3 and 14.4 directly and fails if a threat listed
upstream is missing from the register, or if a fundamental invariant has no threat bound to it.
The register cannot drift from the PRD without turning the build red.

The v1.1 supplement is held to the same standard: the suite requires reservation invariants
R1–R5 to each carry at least one threat, because the override's asset-leg guarantee rests
entirely on them.

## What phase 00 delivers

The skeleton: every threat enumerated, every invariant bound, every row assigned to the phase
whose gate must demonstrate its control. No analysis, no mitigations, no residual-risk
statements. Those are written in the phases the register names, and PRD 19 phase 09 requires
the model complete with no undisclosed critical issue.

## Assets at risk (PRD 14.1, as amended by the v1.1 override)

- CVA cash locked in `CashEscrow`, or reserved in the payer wallet under the override's
  `ConduitSettlementCVA` fallback
- RWA CVA units reserved in the seller wallet by `ConduitRWACVA`. The override removes
  `AssetEscrow` from this leg, so the asset at risk is a reservation record rather than an
  escrow balance
- settlement authority
- compliance signer keys
- Wormhole emitter configuration
- Cleanverse API key and AES key
- report artifacts
- user signatures
- operator authority

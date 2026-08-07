# Architecture decision records

CLAUDE.md ranks accepted ADRs fourth in the source-of-truth order, above code comments and
tests. It also requires an ADR before any deviation from the PRD architecture, and when sources
conflict: _"stop, document the conflict, and create an ADR. Do not silently choose."_

## Ranked sources

`CONDUIT_PRD_v1.1_OVERRIDE.md` section 1 amends the CLAUDE.md order for CVA issuance, transfer
policy, and RuleV2 semantics. The effective order is:

1. deployed contract state and verified transaction evidence
2. Cleanverse CCP CVA Integration Guide, supplied 2026-08-07
3. Cleanverse API V5.6
4. `CONDUIT_PRD_v1.1_OVERRIDE.md`
5. `CONDUIT_PRD_v1.0.md`
6. accepted ADRs
7. pinned Wormhole and chain registries
8. code comments, tests, README

## Index

| ADR                                                | Title                                            | Status   |
| -------------------------------------------------- | ------------------------------------------------ | -------- |
| [0000](./0000-template.md)                         | Template                                         | Template |
| [0001](./0001-cash-custody-mode.md)                | Cash custody mode for the Cleanverse A-Token leg | Open     |
| [0002](./0002-toolchain-and-dependency-pinning.md) | Toolchain and dependency pinning                 | Accepted |
| [0003](./0003-repository-gate-topology.md)         | Repository gate topology                         | Accepted |
| [0004](./0004-prd-v1-1-override-adoption.md)       | Adoption of the PRD v1.1 architecture override   | Accepted |

## Rules

1. Numbers are allocated in order and never reused. **0001 is reserved by PRD 2.5** for the cash
   custody seam result, so it exists as `Open` from phase 00 rather than being claimed by an
   unrelated decision.
2. Status is one of `Proposed`, `Accepted`, `Open`, `Superseded`, `Rejected`. `Open` means the
   decision cannot be made yet because it depends on evidence a later phase produces.
3. An ADR is never edited to change history. A reversal is a new ADR that supersedes the old
   one, and the old one's status becomes `Superseded` with a pointer.
4. `tests/docs.test.ts` fails if any ADR lacks a status or if 0001 goes missing.
5. PRD 23 answers land here and in the deployment manifest, per PRD section 23.

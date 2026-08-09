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

| ADR                                                                              | Title                                                                   | Status   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------- |
| [0000](./0000-template.md)                                                       | Template                                                                | Template |
| [0001](./0001-cash-custody-mode.md)                                              | A settlement contract can hold Cleanverse cash, once it has CVI         | Accepted |
| [0002](./0002-toolchain-and-dependency-pinning.md)                               | Toolchain and dependency pinning                                        | Accepted |
| [0003](./0003-repository-gate-topology.md)                                       | Repository gate topology                                                | Accepted |
| [0004](./0004-prd-v1-1-override-adoption.md)                                     | Adoption of the PRD v1.1 architecture override                          | Accepted |
| [0005](./0005-cli-package-and-runtime-dependencies.md)                           | CLI package and the first runtime dependencies                          | Accepted |
| [0006](./0006-wormhole-registry-pin-and-live-chain-identity.md)                  | Wormhole registry pin and live chain identity                           | Accepted |
| [0007](./0007-atoken-discovery-is-chain-blind.md)                                | A-Token discovery is chain-blind, so attribution comes from chain state | Accepted |
| [0008](./0008-encryption-is-per-endpoint.md)                                     | Cleanverse body encryption is per endpoint, not global                  | Accepted |
| [0009](./0009-asset-chain-has-no-ccp-deployment.md)                              | The specified asset chain has no CCP deployment                         | Accepted |
| [0010](./0010-rulev2-has-six-fields-on-chain.md)                                 | The deployed RuleV2 has six fields, not five                            | Accepted |
| [0011](./0011-no-custom-cva-registration-endpoint.md)                            | Custom-CVA registration via /atoken/register_atoken                     | Open     |
| [0012](./0012-wormhole-transport-proven-both-directions.md)                      | Wormhole transport proven in both directions                            | Accepted |
| [0013](./0013-finality-policy-for-economic-authorization.md)                     | An authentic VAA is not a sufficiently final VAA                        | Accepted |
| [0014](./0014-compliance-is-attested-not-asserted.md)                            | Compliance is attested, not asserted                                    | Accepted |
| [0015](./0015-seam-tests-use-producer-originated-messages.md)                    | A fixture may not invent a message no contract emits                    | Accepted |
| [0016](./0016-the-asset-seam-had-the-same-defects-and-two-worse-ones.md)         | The asset seam had the same defects, and two of them moved value        | Accepted |
| [0017](./0017-settled-is-on-chain-settled-final-is-derived.md)                   | SETTLED is on chain, SETTLED_FINAL is derived                           | Accepted |
| [0018](./0018-identity-is-a-pair-never-an-address.md)                            | Identity is a pair, never an address                                    | Accepted |
| [0019](./0019-a-negative-proof-must-reach-the-layer-it-blames.md)                | A negative proof must reach the layer it blames                         | Accepted |
| [0020](./0020-the-disposition-kernel-rests-orders-before-it-executes-them.md)    | The Disposition Kernel rests orders before it executes them             | Accepted |
| [0021](./0021-the-web-surface-holds-a-compliance-key-and-nothing-else.md)        | The web surface holds a compliance key, and nothing else                | Accepted |
| [0022](./0022-one-participant-session-owns-identity-and-nothing-owns-a-chain.md) | One participant session owns identity, and nothing owns a chain         | Accepted |

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

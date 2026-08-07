# Conduit

Compliance-preserved cross-chain delivery-versus-payment.

Conduit coordinates delivery-versus-payment between two Cleanverse-native assets on different
chains. CVA cash settles on Monad Testnet while a RuleV2-gated RWA CVA changes ownership on
Arbitrum Sepolia. Tokens never bridge; authenticated settlement state does.

> Two chains. Two regulated assets. One settlement commitment. Both legs reach a policy-valid
> terminal state, or neither party receives an unaccounted economic advantage.

Conduit does not claim simultaneous cross-chain block execution. It provides an atomic
settlement _decision_ with asynchronous, permissionless execution, and deterministic restricted
custody when a recipient becomes ineligible after commit.

## Status

**Phase 00 of 11 — repository and truth lock.** No product logic exists yet. Nothing here
contacts a chain, a Cleanverse endpoint, or a Wormhole guardian.

The architecture is `CONDUIT_PRD_v1.0.md` as amended by `CONDUIT_PRD_v1.1_OVERRIDE.md`, which
makes the Arbitrum leg a real Cleanverse CVA with a token-native reservation instead of an
ERC-3643-style fixture in escrow, and names Cloudflare Workers plus Supabase as the runtime. The
override is adopted in [ADR-0004](./docs/adr/0004-prd-v1-1-override-adoption.md); none of it is
implemented yet.

See [docs/implementation-status.md](./docs/implementation-status.md) for the phase table and
[docs/assumptions.md](./docs/assumptions.md) for everything still unresolved. Assumptions stay
visibly unresolved until live evidence settles them.

## Getting started

Requires the exact toolchain in [`toolchain.json`](./toolchain.json): Node 24.14.1,
pnpm 10.33.0, Foundry 1.7.1, plus Slither, gitleaks, and Docker for the security steps.

```bash
git clone <repo> conduit && cd conduit
pnpm bootstrap
```

`pnpm bootstrap` verifies your toolchain, installs from the frozen lockfile, restores Solidity
dependencies at locked revisions, builds contracts with warnings as errors, and runs the full
gate. A mismatched tool fails with the command that fixes it.

Afterwards, `pnpm verify` re-runs the gate. `pnpm verify --only=lint,unit` runs a subset.

## Layout

```text
apps/        web · api · worker · indexer
contracts/   Foundry project — src, test, script, deployments
packages/    domain · sdk · cleanverse · wormhole · verifier · db · config · observability · ui
docs/        adr · threat-model · runbooks · evidence · security-waivers
infra/       docker · terraform
scripts/     bootstrap, gate, and toolchain automation
```

Fixed by PRD 11.1 and asserted by `tests/repo-structure.test.ts`.

## Sources of truth

CLAUDE.md fixes the order and the v1.1 override amends it for CVA and RuleV2 semantics. The
effective ranking is deployed contract state and verified transactions, then the Cleanverse CCP
CVA Integration Guide, then Cleanverse API V5.6, then the v1.1 override, then v1.0, then
accepted ADRs. Code comments, tests, and this README rank last.

When sources conflict, work stops and an ADR records the conflict. Nothing is silently chosen.
[ADR-0004](./docs/adr/0004-prd-v1-1-override-adoption.md) is that record for the v1.1 override.

## Documentation

| Document                                                         | Contents                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| [CONDUIT_PRD_v1.0.md](./CONDUIT_PRD_v1.0.md)                     | The build-locked product requirements                 |
| [CONDUIT_PRD_v1.1_OVERRIDE.md](./CONDUIT_PRD_v1.1_OVERRIDE.md)   | Architecture override; wins where it conflicts        |
| [CLAUDE.md](./CLAUDE.md)                                         | Working rules, invariants, and stop conditions        |
| [CLAUDE_ONESHOT_CONDUIT.md](./CLAUDE_ONESHOT_CONDUIT.md)         | Execution mode and human gates                        |
| [docs/implementation-status.md](./docs/implementation-status.md) | Phase state and gate evidence                         |
| [docs/assumptions.md](./docs/assumptions.md)                     | Everything unresolved, and what will resolve it       |
| [docs/adr](./docs/adr/README.md)                                 | Architecture decisions                                |
| [docs/threat-model](./docs/threat-model/README.md)               | Trust boundaries, 37 PRD threats, 11 override threats |
| [docs/runbooks](./docs/runbooks/README.md)                       | Key rotation, emergency revocation, incident response |

## Honest limits

- Cleanverse V5.6 documents no generic cross-chain Travel Rule endpoint. Conduit generates its
  own compliance envelope and anchors Cleanverse response hashes. No part of this project may
  claim otherwise (PRD 2.3).
- A Cleanverse HTTP 200 is not business success, and `validator/verify` returning `valid:false`
  is a legitimate non-eligibility rather than an API failure.
- Whether a Validator-registered contract can hold the selected A-Token is unproven. It is a
  mandatory seam test recorded in [ADR-0001](./docs/adr/0001-cash-custody-mode.md).
- The Cleanverse CCP CVA Integration Guide that the override ranks second is not in this
  repository yet. RuleV2 country-bit positions come from it and must not be guessed
  (ASM-018, ASM-020).

## Licence

UNLICENSED. Not yet released for redistribution.

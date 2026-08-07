# ADR-0004: Adoption of the PRD v1.1 architecture override

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 00
**Supersedes:** —
**Superseded by:** —

## Context

`CONDUIT_PRD_v1.1_OVERRIDE.md` and `CLAUDE_ONESHOT_CONDUIT.md` were added to the repository
root during phase 00, after the monorepo, toolchain, gate, and documentation skeleton had been
built against `CONDUIT_PRD_v1.0.md` alone.

The override is marked `REQUIRED OVERRIDE` and states that it wins wherever it conflicts with
v1.0. CLAUDE.md requires that a conflict between sources is documented in an ADR rather than
silently resolved, which is what this record is for.

The override changes four things that reach phase 00.

**Source-of-truth order.** Override section 1 inserts the Cleanverse CCP CVA Integration Guide
above API V5.6 for CVA issuance, transfer policy, and RuleV2 semantics, and places the override
itself above v1.0. CLAUDE.md's order is otherwise unchanged.

**The Arbitrum leg.** The RWA stops being a generic ERC-3643-style fixture held by
`AssetEscrow` and becomes a real Cleanverse CVA (`ConduitRWACVA`) gated by RuleV2 and
`policy.canTransfer`, using a token-native reservation instead of escrow custody.
`AssetEscrow.sol` is no longer required for that leg. Cleanverse becomes load-bearing on both
economic legs rather than only the cash leg.

**The runtime target.** Override section 13 names Next.js App Router on
`@opennextjs/cloudflare`, Cloudflare Workers, Supabase Postgres, Hyperdrive, R2, and Queues.
Phase 00 had recorded the cloud target as undecided (ASM-014), which is no longer true.

**Working method.** Override section 16 and the one-shot prompt make development local-first:
commit milestones to the local branch, no PR per phase, no AI or co-author trailers, GitHub
Actions as reproducibility automation that mirrors locally proven commands rather than as the
development loop.

## Decision

**Adopt the override.** It ranks above v1.0 and its instruction is unambiguous.

Phase 00 remains a repository and truth lock, so adoption here is documentation, not
implementation. Concretely:

1. `CONDUIT_PRD_v1.1_OVERRIDE.md` and `CLAUDE_ONESHOT_CONDUIT.md` are ranked sources and are
   excluded from Prettier alongside `CONDUIT_PRD_v1.0.md` and `CLAUDE.md`.
2. The assumptions register records what the override answers and what it newly opens.
   ASM-014 moves to `RESOLVED`; ASM-018 through ASM-023 are opened.
3. The threat register gains a v1.1 supplement: five reservation invariants (R1–R5) and eight
   threats the reservation model and the Cloudflare/Supabase stack introduce, none of which
   exist in PRD 14.3.
4. Documentation stops describing the Arbitrum leg as an ERC-3643-style token, per override
   section 18.
5. The CI foundation stays, and stays subordinate. Override section 16 permits Actions that
   mirror locally proven commands and forbids using them as the debugging loop. Every job
   already calls `node scripts/verify.mjs --only=<steps>`, so the local gate is the gate and CI
   only re-runs it. That was already ADR-0003's design and needs no change.

**Not adopted in phase 00:** every architectural change above is a phase 01–10 deliverable. No
contract, no Cloudflare configuration, and no Supabase schema is written here. Phase 00 forbids
product logic, and the override does not change that.

**One-shot execution is not exercised in this run.** The override and the one-shot prompt call
for continuous execution across phases. The instruction that opened this session asked for
phase 00 only, with its status report. A more specific and more recent instruction wins over a
standing policy, so this run stops at the phase 00 gate. The conflict is recorded here rather
than resolved by assumption, and continuous execution resumes on request.

## Evidence

- `tests/repo-structure.test.ts` asserts both new documents exist and are formatter-excluded.
- `tests/docs.test.ts` asserts all twelve override acceptance additions appear in
  `docs/implementation-status.md`, and that the v1.1 threat supplement covers R1–R5.
- `tests/helpers/prd.ts` parses the override directly, so an acceptance item added upstream
  fails the build until it is tracked.

### Formatter incident

`prettier --write .` ran across the repository before these two documents were known to exist,
and rewrote both. The change was markdown normalization only — the override's hard-break
trailing spaces survive, and no prose, code block, or checklist item differs in meaning — but
byte-identity with the files as supplied cannot be proven, because they were untracked at the
time and no baseline exists.

`CONDUIT_PRD_v1.0.md` and `CLAUDE.md` were unaffected; their `.prettierignore` entries held.
All four documents plus a future `design.md` are now excluded, so this cannot recur.

## Consequences

- Cleanverse becomes load-bearing on both legs. A CCP outage or policy rejection now stops the
  asset leg as well as the cash leg, which strengthens the product claim and widens the blast
  radius. The threat register reflects both.
- `AssetEscrow` leaves the critical path for the RWA CVA, and with it the escrow-custody class
  of bugs. It is replaced by a reservation-accounting class: the token must guarantee that
  reserved units are unspendable through every ERC-20 path, which is a harder invariant to get
  right than "the escrow holds the balance."
- `IAssetSettlementAdapter` must stay a real boundary, per override section 10, so the
  settlement coordinator is not rewritten when another regulated asset arrives.
- Choosing Cloudflare Workers constrains the API and worker runtime. Node-only dependencies
  become a design constraint from phase 06 rather than a discovery.
- Supabase is a managed provider with plan-dependent backup and recovery. Override section 13
  forbids claiming paid recovery features the active plan does not provide, so PRD 21's
  "backups tested" criterion must cite the actual plan.

## Alternatives rejected

**Continue against v1.0 and reconcile later.** The override is marked required. Building phase
01 against a superseded architecture would waste the phase and, worse, would leave documentation
asserting a design nobody intends to ship — the exact failure CLAUDE.md's assumptions rule
exists to prevent.

**Adopt the architecture now, in phase 00.** Would violate the phase 00 constraint of no product
logic, and would write contracts against a CCP guide this repository has not yet been given. The
override cites a guide supplied 2026-08-07; the guide itself is not in the repository, which is
recorded as ASM-018.

**Treat the one-shot prompt as authority to continue past phase 00.** The session instruction was
explicit and narrower. Continuing would also hit HUMAN_GATE_DEPLOY and HUMAN_GATE_SIGN almost
immediately, since phase 01 needs live sandbox credentials and phase 03 needs an owner signature.

## Assumptions touched

Resolves [ASM-014](../assumptions.md) (cloud target). Opens [ASM-018](../assumptions.md) through
[ASM-023](../assumptions.md). Leaves ASM-001 through ASM-013 and ASM-015 through ASM-017
unchanged.

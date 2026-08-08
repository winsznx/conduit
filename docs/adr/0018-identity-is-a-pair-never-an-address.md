# ADR-0018: Identity is a pair, never an address

**Status:** Accepted
**Date:** 2026-08-08
**Phase:** 06
**Supersedes:** —
**Superseded by:** —

## Context

The live deployment contains this:

```text
Monad Testnet   SettlementCoordinator    0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE
Base Sepolia    RWACVASettlementAdapter  0xE4bA8F4D65F8c62393B47bf47eF6eea8F07F45BE
```

The same twenty bytes. Two chains, two contracts, two roles, two ABIs. It
happened because the deployer's nonce lined up across the two chains during a
redeployment, which is ordinary rather than exotic: anyone deploying the same
sequence from one key gets it eventually, and a project that redeploys both legs
together gets it sooner.

It is a gift. Held rather than deployed away from, it is a permanent adversarial
test vector for every surface that stores, caches, indexes, links to, or
deduplicates by contract identity — and the failure mode of getting it wrong is
the quiet kind. A verifier that read the coordinator's state under the adapter's
identity would report a settlement that never happened and every check
downstream of it would agree.

## Decision

**Identity is a pair, in every surface, always.**

```text
a contract or account   (chainId, address)          CAIP-10:  eip155:10143:0x…
a Wormhole emitter      (wormholeChainId, bytes32)  wormhole:10004:0x00…
```

The two key formats are deliberately not interchangeable. A Wormhole chain ID is
not an EVM chain ID — Monad Testnet is EVM 10143 and Wormhole 10009 — so a
function that wants one will not silently accept the other, and
`emitterToAddress` returns a bare address rather than a `ChainScopedAddress`
precisely so that converting a Wormhole identity into a contract identity has to
be done deliberately, with the EVM chain supplied by the caller.

**Keys are lowercased.** A key that differs by case is two keys, and the same
address arrives checksummed from one source and lowercased from another all day.
Checksums are for display.

**A registry has no lookup that takes an address alone.** `ContractRegistry` has
`get(identity)` and no overload, and it throws on a malformed chain ID rather
than defaulting to one. The type system is the real guard; the runtime check
exists so a loosened signature cannot quietly start accepting a bare address.

**A collision is reported, not rejected.** It is legitimate and it is deployed.
`ContractRegistry.collisions()` exists so a verification report can name it
explicitly, because a reader who sees the same string twice will otherwise
assume it is the same contract. The verifier prints it every run.

## Scope of the audit

Most of the surfaces this could affect do not exist yet. `packages/db`,
`packages/sdk`, `apps/api`, `apps/indexer`, `apps/worker`, and `apps/web` are
still phase-00 stubs that export their own name and target phase, so there is no
outbox, no claim ledger, no idempotency key, and no UI route to audit. Saying
"audited, clean" about a stub would be worthless.

What exists was audited and one real case was found: `aTokensDeployedOn`
deduplicated A-Tokens by bare address. Its map is safe — every candidate in one
call is attributed against one `readCode`, so it never spans two chains — but
its _result_ carried no chain, so two calls' results could be merged into a set
that conflates an address existing on both. It now takes the chain and returns
it on every entry.

The rest of the audit is preventative, and that is the honest framing: the
identity type, the registry, and the tests exist so the surfaces that arrive
later cannot be written the wrong way without deleting a test that names the
deployed collision.

## Evidence

`packages/domain/src/identity.test.ts`, fifteen cases, every one using the two
live addresses rather than invented ones:

```text
the two deployments are genuinely the same twenty bytes
their keys differ
sameContract is false
a lowercased address is the same key, so one contract is never two rows
a registry holds both as distinct entries and answers each with itself
it reports the collision rather than hiding it
it refuses a duplicate registration of the same chain and address
it has no lookup that takes an address alone
the same emitter bytes on two Wormhole chains are different emitters
an emitter key cannot collide with a contract key
emitterToAddress refuses anything that is not left-padded
it will not convert a Wormhole chain into an EVM chain on its own
explorer links send a reader to the right chain
and refuse to guess a chain they were not given
```

The verifier's own run over settlement `0x940f1c15…f658858` reads coordinator
state on Monad and adapter state on Base under the colliding address and keeps
them apart, and prints the collision in its report.

## Consequences

- Every future surface takes `ChainScopedAddress`. A function signature taking a
  bare address for a contract is a review finding.
- The colliding deployment is kept. Redeploying to avoid it would remove the
  only test vector that is not hypothetical.
- Explorer links, telemetry attributes, and idempotency keys derive from
  `contractKey`, so they inherit the pair without each surface remembering to.

## Alternatives rejected

**Redeploy so the addresses differ.** It removes the symptom, keeps the defect,
and throws away the one deployment that can prove the fix.

**Use the chain name as the key prefix.** `monadTestnet:0x…` reads well and is
ambiguous the moment a manifest renames a chain or two configs disagree about
which name means which network. The chain ID is the thing the RPC itself
reports and the thing `block.chainid` binds.

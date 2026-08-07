# ADR-0006: Wormhole registry pin and live chain identity

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 01
**Supersedes:** —
**Superseded by:** —

## Context

CLAUDE.md requires that Wormhole core contract addresses come from a pinned official registry
snapshot, and PRD 8.3 quotes chain IDs and states that testnet core contracts exist for both
networks without giving their addresses. ASM-016 recorded that nothing in this repository had
checked those claims.

Three distinct things were unproven, and conflating them is how a wrong address reaches
production:

1. what the official registry says;
2. whether this repository agrees with it;
3. whether a contract is actually deployed at that address on a live chain.

A snapshot answers the first two. Only an RPC answers the third.

## Decision

**Pin the registry as a committed snapshot with provenance.** `packages/wormhole/src/registry.snapshot.json`
carries the values plus the package, version, source files, network, and retrieval date they came
from. It is validated by a zod schema at module load, so a corrupted or hand-edited snapshot
fails at import rather than at the first VAA.

**Extract, never transcribe.** The values were read out of
`@wormhole-foundation/sdk-base@6.1.5` rather than copied from documentation:

| Chain           | Wormhole ID | Native ID | Core bridge                                  | Finality |
| --------------- | ----------- | --------- | -------------------------------------------- | -------- |
| MonadTestnet    | 10009       | 10143     | `0xaBf89de706B583424328B54dD05a8fC986750Da8` | 1 block  |
| ArbitrumSepolia | 10003       | 421614    | `0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35` | 4096     |

Both chain IDs match PRD 8.3 exactly. The two numbering systems never share a type in code:
confusing a Wormhole chain ID with a native one is threat T-12, and `registryByWormholeChainId`
deliberately returns nothing when handed a native ID.

**Verify deployment separately, at runtime.** `conduit doctor` reads `eth_chainId` and
`eth_getCode` against both RPCs. A registry entry is a claim; bytecode at the address is
evidence.

## Evidence

`conduit doctor` against public testnet RPCs, 2026-08-07:

```text
ok  wormhole.registry                @wormhole-foundation/sdk-base@6.1.5 (Testnet)
ok  wormhole.core.monadTestnet       0xaBf89de706B583424328B54dD05a8fC986750Da8 — wormhole 10009, native 10143
ok  wormhole.core.arbitrumSepolia    0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35 — wormhole 10003, native 421614
ok  rpc.monadTestnet                 chain ID 10143
ok  wormhole.bytecode.monadTestnet   680 bytes at 0xaBf89de706B583424328B54dD05a8fC986750Da8
ok  rpc.arbitrumSepolia              chain ID 421614
ok  wormhole.bytecode.arbitrumSepolia 680 bytes at 0x6b9C8671cdDC8dEab9c719bB87cBd3e782bA6a35
```

680 bytes at each address is consistent with a proxy, which is how Wormhole deploys its core
contract. The doctor asserts that code exists, not what it is; phase 02 proves behaviour by
publishing and verifying a real message.

`packages/wormhole/src/registry.test.ts` covers the pinned values, the PRD 8.3 agreement, the
cross-check against `@conduit-protocol/config`, and the native-versus-Wormhole ID separation.

## Consequences

- ASM-016 moves to `RESOLVED`. The addresses are pinned, cross-checked, and known to hold code.
- ASM-013 stays `OPEN` but narrows: native chain IDs are now confirmed live, while Cancun opcode
  execution is not. `foundry.toml` still pins `evm_version = "cancun"` on an unproven basis, and
  phase 02 closes it by executing TSTORE/TLOAD on both chains.
- Upgrading the pin becomes a deliberate act: bump the version in the snapshot's provenance,
  re-extract, and let `registry.test.ts` fail until the values are reviewed.

## Alternatives rejected

**Resolve addresses at runtime from the SDK.** Turns a supply-chain event into a silent runtime
change. CLAUDE.md requires a pinned snapshot precisely so a moved address is a reviewable diff.

**Take the SDK as a dependency for its constants.** Would pull a large chain-abstraction library
into the settlement path to read six numbers, and would still need pinning to be safe.

**Trust PRD 8.3 alone.** It quotes chain IDs but no addresses, so it cannot answer the question
that matters.

## Assumptions touched

Resolves [ASM-016](../assumptions.md). Narrows [ASM-013](../assumptions.md).

# ADR-0009: The specified asset chain has no CCP deployment

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 03
**Supersedes:** —
**Superseded by:** —

## Context

Both ranked sources fix the asset chain. PRD v1.0 section 8.3 names Arbitrum Sepolia and pins
Wormhole chain 10003 against native chain 421614. The v1.1 override section 2 keeps that chain
and raises the requirement: the RWA is no longer a generic fixture but a real Cleanverse CVA,
deployed on Arbitrum Sepolia, gated by RuleV2 through `policy.canTransfer`.

The CCP CVA Integration Guide states on page 1: _"Supported networks: EVM (Ethereum, Base, BSC,
Arbitrum, Polygon, etc.)"_, and requires a custom CVA to _"specify the `policy` contract address
during initialization"_.

Cleanverse has no CCP deployment on Arbitrum Sepolia.

## Evidence

`query_deposit_atoken_list`, per chain, against the live sandbox on 2026-08-07:

```text
monad              1 token    accesscore 0x8F118338a1fa41E7Fa86Be19A4e8B99Ed58A6EcC
arbitrum           0 tokens
arbitrum-sepolia   0 tokens
base              23 tokens   accesscore 0x8F118338a1fa41E7Fa86Be19A4e8B99Ed58A6EcC
ethereum           2 tokens   accesscore 0x8F118338a1fa41E7Fa86Be19A4e8B99Ed58A6EcC
polygon            2 tokens   accesscore 0x8F118338a1fa41E7Fa86Be19A4e8B99Ed58A6EcC
bsc                2 tokens   accesscore 0x8F118338a1fa41E7Fa86Be19A4e8B99Ed58A6EcC
```

An empty catalogue could mean "no tokens listed yet" rather than "no infrastructure", so the
contracts themselves were checked directly with `eth_getCode`:

```text
                     Monad Testnet    Arbitrum Sepolia
accesscore           DEPLOYED         absent
apass                DEPLOYED         absent
aUSDC                DEPLOYED         absent
```

The same `accesscore` address is deployed on Base Sepolia (84532), Base mainnet (8453),
Ethereum Sepolia (11155111), and BSC Testnet (97). It is a deterministic address present on
every chain CCP supports, and it is absent on Arbitrum Sepolia specifically.

Why this blocks rather than inconveniences: `ConduitRWACVA`'s constructor takes a `policy`
address and rejects the zero address, and every transfer routes through
`policy.canTransfer(...)`. With no policy contract on the chain there is no address to supply,
no registration to perform, and no compliance gate to enforce. Deploying anyway would produce a
token that reverts on its first transfer, or worse, one wired to an address that later becomes
somebody else's contract.

## Decision

**Option A: the asset leg moves to Base Sepolia.** Decided by the project owner on 2026-08-07,
on the reasoning that live evidence outranks a generic network statement — the guide says
Arbitrum is a supported EVM network, it does not promise an Arbitrum Sepolia deployment.

The thesis does not move with it. Base is an implementation network, not the moat. The claim
remains: Conduit coordinates DvP between two Cleanverse-native assets on different chains,
verified cash settling on Monad while a RuleV2-gated RWA CVA changes ownership on Base, with the
assets never bridging and authenticated settlement state doing the travelling.

Three options were considered.

**A. Move the asset leg to Base Sepolia.** CCP is deployed there with 23 catalogued CVAs, and
Wormhole Testnet covers BaseSepolia with a core contract carrying the same 680 bytes of
bytecode as the two already verified. Everything the product claims survives: two chains, two
Cleanverse-native assets, one settlement commitment, Wormhole transport, no bridging. What
changes is a chain name in the deployment manifest and the pinned registry snapshot. The PRD's
own thesis never depended on Arbitrum specifically — section 1.3 says the RWA "remains on its
issuance chain", and the issuance chain is wherever CCP can actually issue.

**B. Keep Arbitrum Sepolia and ask Cleanverse to deploy CCP there.** Preserves both documents
exactly. Depends entirely on a third party's timeline, and nothing downstream can proceed
meanwhile.

**C. Keep Arbitrum Sepolia with a non-CVA RWA.** This is PRD v1.0's original ERC-3643-style
fixture, and the v1.1 override exists specifically to replace it. It would forfeit the
override's central claim that Cleanverse is load-bearing on both economic legs, and section 18
forbids describing the asset as ERC-3643 once a real CVA is the target. Recorded for
completeness; not recommended.

## Consequences

- The asset chain is `baseSepolia`: native 84532, Wormhole 10004, core
  `0x79A1027a6A159502049F10906D333EC57E95F083`, verified live at 680 bytes. Finality is 512
  blocks at ~2s against Monad's 1 block at ~1s, so the two directions are strongly asymmetric
  and ASM-012 must measure each separately rather than assuming a single latency.
- The Wormhole snapshot was re-extracted from the pinned SDK rather than hand-edited, and the
  extractor now lives in `packages/wormhole/scripts` where the SDK actually resolves. It gained
  a `--check` mode so a drifted snapshot fails the gate.
- Extracting it exposed a provenance problem: the previous snapshot named
  `@wormhole-foundation/sdk-base@6.1.5` as its source while that package was never a dependency.
  It is now pinned in `packages/wormhole`, so the provenance is substantiable rather than
  asserted.
- `ChainKey` is `'monadTestnet' | 'baseSepolia'`, and the RPC variable is `BASE_SEPOLIA_RPC_URL`.
  The change is in the authoritative config, not scattered literals.
- `CONDUIT_PRD_v1.0.md`, `CONDUIT_PRD_v1.1_OVERRIDE.md`, and `CLAUDE.md` still read "Arbitrum
  Sepolia". They are byte-preserved ranked sources and are not edited; this ADR is the record of
  their supersession on this point.

## Assumptions touched

Opens [ASM-029](../assumptions.md). Blocks [ASM-020](../assumptions.md), because the RuleV2
country encoding can only be resolved empirically against a live policy contract, and there is
no policy contract on the specified chain to resolve it against.

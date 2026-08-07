# ADR-0009: The specified asset chain has no CCP deployment

**Status:** Open
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

**Not yet made.** The asset chain is fixed by two ranked sources, and CLAUDE.md requires that a
conflict between sources stop work and be documented rather than silently resolved. Changing it
is the project owner's decision.

Three options, with what each costs.

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

**Recommendation: A.** It is the only option that neither waits on a third party nor gives up
the thing that makes the product interesting.

## Consequences

Deferred until the decision is made. Two are already fixed:

- Nothing is deployed to either chain until the asset chain is settled. The coordinator's
  constructor binds `remoteWormholeChainId` and the peer emitter, so deploying the cash side
  first would bake in a chain that may change.
- The pinned Wormhole registry snapshot currently holds only Monad Testnet and Arbitrum
  Sepolia. Option A requires re-extracting it to include BaseSepolia from the same pinned SDK
  version, not hand-editing a value in.

## Assumptions touched

Opens [ASM-029](../assumptions.md). Blocks [ASM-020](../assumptions.md), because the RuleV2
country encoding can only be resolved empirically against a live policy contract, and there is
no policy contract on the specified chain to resolve it against.

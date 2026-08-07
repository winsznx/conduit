# ADR-0012: Wormhole transport proven in both directions

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 02
**Supersedes:** —
**Superseded by:** —

## Context

PRD 8.3 requires the transport to be proven before implementation proceeds past the spike, in
both directions, with replay rejected. Everything downstream rests on it: a settlement decision
that cannot cross a chain is not a settlement decision.

## Decision

Transport is proven, and the proof is structured to fail honestly.

**Published from an EOA, not through `CashEscrow`.** Mixing the transport proof with settlement
state means a failure could be either, and the question here is only whether a message crosses.
The settlement contracts consume the same core contract through the same `parseAndVerifyVM`
call, so what is proven is exactly what they depend on.

**Verified by `eth_call` against the destination core contract.** CLAUDE.md forbids trusting an
off-chain VAA parse, and an off-chain check would prove nothing about whether the destination
chain accepts the guardian set — which is the entire question.

## Evidence

```text
Monad Testnet → Base Sepolia
  publish   0x0de96ea098a7b7206c2451d145c7f23b35d788a5d75abe13c238f2a4faba81c8
  VAA       151 bytes, available after 3.5s
  verify    Base Sepolia core: valid=true, emitterChain 10009, payload intact

Base Sepolia → Monad Testnet
  publish   0x523aff0aed58dc41f5236f4b94e9dd324437bc9e99e60ba3f7139dc700c590be
  VAA       151 bytes, available after 2.6s
  verify    Monad Testnet core: valid=true, emitterChain 10004, payload intact
```

The emitter address in each VAA matches the publisher, and each payload round-trips byte for
byte through the guardian network.

**Replay rejection lives in Conduit, not in the core contract.** `parseAndVerifyVM` is a view
function and will happily verify the same VAA a hundred times; it is not a spend. Rejection is
`WormholeTransport`'s replay map, marked consumed before any external call, and it is proven in
`CashEscrow.t.sol` and `RWACVASettlementAdapter.t.sol` — the same VAA delivered twice moves
value exactly once. That division is deliberate: the core contract answers "is this message
authentic", and only Conduit can answer "has this message already been acted on".

## Consequences

- **ASM-012 is answered with a measurement rather than a preference.** At consistency level 200
  the VAA was available in 3.5s and 2.6s. That level is "instant": guardians sign on observation
  rather than on finality. Base Sepolia's finality threshold is 512 blocks at ~2s, so a
  finalized-level message from Base is roughly seventeen minutes from publish to availability,
  against Monad's single block. Settlement selects the level per chain and per message type from
  these numbers; a PREPARED that is cheap to re-derive is not a COMMIT that moves value.
- **The testnet guardian set has one signer.** Quorum is genuinely verified on chain, but a
  single signature is a testnet property and mainnet requires 13 of 19. ASM-033 keeps that
  visible so the final proof states the guardian count instead of implying a mainnet guarantee.
  The threat register's guardian-set-transition row (T-15) is unaffected and still open.
- The message fee is zero on both chains today. `WormholeTransport` reads `messageFee()` per call
  rather than caching it, so a fee introduced later does not silently start reverting publishes.

**The seam test proves connectivity, not the settlement path.** The emitter was an EOA, so what
is established is Wormhole network availability and destination core acceptance. It does not
exercise the locked peer-emitter path, the deployment ID, the protocol version, the settlement
ID, the intent hash, or replay consumption — all of which live in Conduit rather than in the
core contract. A full source-contract-to-destination-contract integration proof is part of the
DvP gate and is deliberately not claimed here.

## Alternatives rejected

**Prove it through the settlement contracts.** Would have coupled the oldest open assumption to
the newest code, and a failure would not have said which was wrong.

**Accept an off-chain VAA parse as proof.** Faster, and it would have demonstrated that the
guardian API returns bytes rather than that a destination chain accepts them. Those are
different claims and only the second one matters.

## Assumptions touched

Resolves [ASM-011](../assumptions.md) and [ASM-012](../assumptions.md). Opens
[ASM-033](../assumptions.md).

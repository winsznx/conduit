# ADR-0007: A-Token discovery is chain-blind, so attribution comes from chain state

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 01
**Supersedes:** —
**Superseded by:** —

## Context

PRD 2.4 requires that the cash token be discovered at runtime, never hardcoded, and that
"contract deployment must fail if the selected cash token is not returned by the sandbox API".
It describes the response as carrying "origin token address, symbol, decimals; A-Token address,
symbol, decimals; `accesscore_address`; `apass_address`".

The live sandbox differs from that description in three ways that matter, all observed on
2026-08-07 against `https://uatapi.cleanverse.com/api/cooperate`:

1. the payload is `data.tokens`, not `data.list`, and the token fields are nested under
   `origin_token` and `atoken` rather than flattened;
2. ~~the `chain` request argument is ignored~~ **— corrected, see ADR-0008.** The argument is
   honoured. It appeared to be ignored because the request body was being AES-encrypted for an
   endpoint that expects plaintext, so the server parsed no arguments at all and returned its
   full catalogue;
3. with a plaintext body, `chain: "monad"` returns exactly one token, `chain: "arbitrum"`
   returns zero, and `chain: "base"` returns twenty-two. Non-EVM entries appear only for the
   chains they belong to.

The response still carries no per-entry chain field, and the same A-Token address appears on
more than one chain: aUSDC is `0xaC0893567D43C3E7e6e35a72803df05416C1f20D` on both Monad and
Base. So a token must never be identified by address alone.

## Decision

**Ask the API for one chain, then confirm against chain state.** The chain argument narrows the
catalogue; `aTokensDeployedOn` then confirms each candidate carries bytecode on the chain we
actually configured. Both steps are kept even though the first now works, because they fail
independently: a mislabelled catalogue entry and a wrong RPC do not produce the same error.

`aTokensDeployedOn` deduplicates by A-Token address, because the sandbox maps several origin
tokens onto one A-Token and emits each mapping as its own entry.

This keeps PRD 2.4 satisfied: the address comes from the API and is never hardcoded.

Attribution fails closed. An unreachable RPC yields "not on this chain" rather than an
assumption, because an RPC that cannot answer is not evidence of presence.

**Schema fidelity over schema convenience.** Two corrections came out of this:

- `tokens` is required with no default. It was written `.default([])`, and a response with an
  entirely different shape validated cleanly as "zero tokens available". Schema drift reported
  as an empty result is the same failure mode as treating HTTP 200 as business success, and it
  is worse here because the caller's next step is to pick a token from an empty list.
- addresses in this response are permissive strings, not EVM-shaped. Requiring 20-byte hex
  rejected the entire response over two non-EVM entries, which is a schema asserting something
  about the API that is not true. EVM validation belongs downstream, after attribution.

## Evidence

`conduit doctor` against the live sandbox:

```text
ok  cleanverse.atokenList  (required)  [ASM-001]
    1 of 1 discovered entries are deployed on monadTestnet:
      ausdc 0xaC0893567D43C3E7e6e35a72803df05416C1f20D (6 decimals, 1 origin token(s))
```

Per-chain catalogue sizes: monad 1, arbitrum 0, base 22.

An earlier encrypted-body run returned all 34 entries and attributed two to Monad, including
aUSDT `0xB5f430eA34d743694A4BF12F8d5917d7668232B7`. aUSDT does carry bytecode on Monad but is
not offered in the Monad deposit catalogue, so it is not a valid cash token. That is precisely
the case bytecode alone would have got wrong, and it is why both checks are kept.

Supporting addresses for both Monad tokens: `accesscore_address`
`0x8F118338a1fa41E7Fa86Be19A4e8B99Ed58A6EcC`, `apass_address`
`0xbA82D189540CaC9DC6FF46B6837CaC1BFdEC58B9`.

## Consequences

- The deployment manifest records the A-Token address _and_ the chain it was attributed on, so a
  verifier can repeat the attribution rather than trusting the pipeline.
- A shared sandbox means the token list is not stable between runs. Selection must never depend
  on ordinal position; ADR-0001's custody choice names the token by address.
- `data.chain` is captured but not relied on. If Cleanverse later honours the `chain` argument,
  attribution becomes a cross-check rather than the sole mechanism, which is strictly better.

## Alternatives rejected

**Hardcode the Monad A-Token address.** Forbidden by CLAUDE.md and PRD 2.4, and it would break
silently when the sandbox is reset.

**Filter by address shape.** Distinguishes EVM from Solana, and nothing else. Twenty-four EVM
tokens on other chains would still pass.

**Trust the first entry.** The response is not chain-ordered, and the first entry happened to be
a Monad token by luck. That is the kind of accident that works until the day it does not.

## Assumptions touched

Resolves [ASM-001](../assumptions.md) and [ASM-024](../assumptions.md).

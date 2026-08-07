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
2. the `chain` request argument is ignored. Sending `monad`, `monadtestnet`, `monad_testnet`,
   `MONAD`, `Monad`, and `""` all return byte-identical responses, and the echoed `data.chain`
   is empty;
3. the response spans every chain the sandbox supports. Thirty-four entries came back, including
   two Solana-style base58 addresses, and no entry carries a chain field.

Point 3 is the problem. PRD 2.4 wants the cash token selected from the API response, and the
response cannot say which chain a token is on.

## Decision

**Attribute tokens to a chain by reading chain state.** A token is on a chain when that chain's
RPC reports bytecode at its address. `aTokensDeployedOn` filters the discovered list through an
injected code reader, deduplicating by A-Token address because the sandbox maps several origin
tokens onto one A-Token and emits each mapping as its own entry.

This keeps PRD 2.4 satisfied in substance: the address still comes from the API and is never
hardcoded. What the chain adds is the fact the API omits.

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
    2 of 34 discovered entries are deployed on monadTestnet:
      ausdc 0xaC0893567D43C3E7e6e35a72803df05416C1f20D (6 decimals, 5 origin token(s));
      ausdt 0xB5f430eA34d743694A4BF12F8d5917d7668232B7 (6 decimals, 3 origin token(s))
```

Twenty-six of the thirty-four entries are unique EVM A-Tokens. Twenty-four of those are deployed
on neither Monad Testnet nor Arbitrum Sepolia, which is consistent with a shared sandbox holding
other participants' test tokens.

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

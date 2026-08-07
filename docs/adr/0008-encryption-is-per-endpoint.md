# ADR-0008: Cleanverse body encryption is per endpoint, not global

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 01
**Supersedes:** —
**Superseded by:** —

## Context

PRD 9.2 opens with "For documented encrypted endpoints". The first implementation read that as
"every endpoint", and marked all twenty-nine entries in the endpoint map `encrypted: true`.

That is wrong, and it failed in the worst available way. Two distinct behaviours resulted, and
neither looked like a transport bug:

**Endpoints that need their arguments reported them as missing.** `verify_apass` returned
`Field validation for 'Chain' failed on the 'required' tag` for a request that plainly contained
`chain`. The natural reading is that the client is sending the wrong field names, and hours can
go into renaming fields that were never the problem.

**Endpoints that tolerate a missing body silently ignored it.** `query_deposit_atoken_list`
returned its entire multi-chain catalogue and echoed `data.chain` as `""`. That produced
ADR-0007's original conclusion that the `chain` argument is ignored, which was a real finding
about a fault of our own making.

A third symptom sent the investigation sideways: `generate_apass` answered `403 Forbidden. Data
decryption failed.` for some payloads and a well-formed `0002` envelope for others. Two
hypotheses were tested and both disproved. The base64 alphabet is not the cause — the working
payload contained more `+` characters than the failing ones. Throttling is not the cause either;
four requests spaced six seconds apart all failed identically.

## Decision

**Encryption is a per-endpoint property, set only from evidence.**

`read()` now produces a plaintext endpoint and `readEncrypted()` an encrypted one. Nine
endpoints are marked plaintext because a plaintext body was verified to work against the live
sandbox. Everything not yet exercised keeps the encrypted default, which is the conservative
direction: an unnecessary encryption attempt fails loudly, while an unnecessary plaintext body
would put a payload on the wire in the clear.

**Verified plaintext:** `query_deposit_atoken_list`, `query_apass`, `query_apass_list`,
`verify_apass`, `query_institution_white_list`, `validator/is_register`, `validator/is_paused`,
`validator/rules`, `validator/verify`.

**Field names, also read off the live sandbox** rather than from the PRD:

| Endpoint                                      | Body                                        |
| --------------------------------------------- | ------------------------------------------- |
| `query_apass`                                 | `{ chain, address }`                        |
| `verify_apass`                                | `{ chain, atoken, address }`                |
| `validator/is_register`, `is_paused`, `rules` | `{ chain, contract_address }`               |
| `validator/verify`                            | `{ chain, contract_address, user_address }` |
| `query_apass_list`                            | `{ chain, page, pageSize }`                 |

**`generate_apass` remains unresolved.** It answers 403 to both plaintext and encrypted bodies
once the payload is complete, and a parameter-validation envelope when it is not. The most
consistent explanation is that parameter validation runs ahead of the role check, so a
well-formed request is what reaches the authorization boundary our credential fails. It is not
needed: the identity matrix was built from wallets that already exist.

## Evidence

The decisive comparison, same endpoint and same payload, differing only in transport:

```text
verify_apass PLAINTEXT  → {"code":"0000","data":{"code":2,"message":"apass not exist", ...}}
verify_apass ENCRYPTED  → {"code":"0002","message":"Invalid request parameters:
                            Key: 'VerifyApassReq.Chain' Error:Field validation for 'Chain'
                            failed on the 'required' tag ..."}
```

Chain filtering, which ADR-0007 had recorded as broken:

```text
chain=monad     echoed="monad"     tokens=1   ausdc 0xaC0893567D43C3E7e6e35a72803df05416C1f20D
chain=arbitrum  echoed="arbitrum"  tokens=0
chain=base      echoed="base"      tokens=22
```

The resulting eligibility matrix, `conduit doctor`, all thirteen checks satisfied:

```text
ok  cleanverse.queryApass.0x9AE53a…512C2b    ACTIVE
ok  cleanverse.verifyApass.0x9AE53a…512C2b   code 4 — valid A-Pass and transfer is allowed
ok  cleanverse.queryApass.0x36bBb9…9392F5    MISSING (restricted)
ok  cleanverse.verifyApass.0x36bBb9…9392F5   code 2 — wallet has no A-Pass (not eligible)
```

## Consequences

- ADR-0007's conclusion that the `chain` argument is ignored is corrected there and here. The
  chain-attribution mechanism it introduced is kept, because it caught something the catalogue
  alone does not: aUSDT carries bytecode on Monad but is absent from Monad's deposit catalogue,
  so it is not a valid cash token. Catalogue and chain state now cross-check each other.
- A missing A-Pass arrives as business code `0002` with a `CN_001` message rather than an empty
  success. That is PRD 2.1's `MISSING` state, so the client returns it as data instead of
  throwing. Raising it would make a compliance answer look like an outage and invite a retry,
  which is threat T-06.
- `query_apass` returns `tier` as a string and `subTier` as a number, and `group`, `subGroup`,
  and `currentKycHash` may be null. The schema coerces rather than insisting on the PRD's
  description, because a schema that rejects a valid identity is worse than a loose one.
- The sandbox is shared. `query_apass_list` reports 251 identities on Monad belonging to other
  participants. None is mutated.

## Alternatives rejected

**Send every body encrypted and accept the failures.** This was the starting state. It produced
a client that appeared to work while its arguments were being discarded.

**Send every body in plaintext.** Would put payloads on the wire unencrypted for endpoints that
genuinely expect AES, and PRD 9.1 treats those payloads as sensitive.

**Infer encryption from whether a response parses.** Making the transport self-tuning at runtime
would hide exactly the drift this ADR exists to record.

## Assumptions touched

Refines [ASM-024](../assumptions.md): the `api-id` header is confirmed, and body encryption is
now known to be per endpoint rather than universal.

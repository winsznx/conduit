# ADR-0010: The deployed RuleV2 has six fields, not five

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 03
**Supersedes:** —
**Superseded by:** —

## Context

`IATokenPolicy.sol` was transcribed verbatim from the CCP CVA Integration Guide, which is the
highest-ranked source for RuleV2 semantics under the v1.1 override. The guide's
`IComplianceRule` listing declares five fields:

```solidity
struct RuleV2 {
    bytes2  allowedGroup;
    bytes2  allowedSubGroup;
    uint8   minTier;
    uint8   minSubTier;
    uint256 poolCountryBitmap;
}
```

Its API table describes `is_black_list` separately as _"Deprecated field; always pass false.
Replaced by poolCountryBitmap"_, and the on-chain listing omits it entirely. Read together,
that says the field is gone from the struct.

The deployed policy still carries it.

## Evidence

Read from the live Base Sepolia policy `0x36489be45fa84f70a0c2bdb11d824be608cb12dd`, discovered
by calling `policy()` on a catalogued CVA rather than by copying an address from another chain.

`getRulesV2` for `RT809094` (`0xf8cefc60…8a4c`) returns two rules. Decoding the same bytes under
each candidate layout:

```text
(bytes2,bytes2,uint8,uint8,bool,uint256)[]   decodes 2 rules
(bytes2,bytes2,uint8,uint8,uint8,uint256)[]  decodes 2 rules
(bytes2,bytes2,uint8,uint8,uint256)[]        fails
```

The five-field decode does not merely mis-parse, it throws: the 256-bit country bitmap lands in
the slot a `uint8` was expected in, producing
`30757273703662114409386042892932725523524839676810774822980920752101925060608`.

The decoded rules:

```text
rule 0   group 0x5700  subGroup 0x4e00  minTier 23  minSubTier 1  isBlackList true
         poolCountryBitmap 0x400000000000800000000000
rule 1   group 0x5700  subGroup 0x4400  minTier 13  minSubTier 1  isBlackList true
         poolCountryBitmap 0x400000000000800000000000
```

A five-field rule where six are expected is not a cosmetic mismatch. `setRuleV2FromToken` takes
the struct by calldata, so a short encoding either reverts on ABI decode or, if the trailing
word happens to be readable, writes a rule whose `poolCountryBitmap` is whatever occupied the
`isBlackList` slot. A silently wrong compliance rule is the worst outcome available in this
system: it looks configured, it looks enforced, and it admits the wrong holders.

## Decision

**Follow the deployed contract, not the guide, for the struct layout.** `IATokenPolicy.sol`
declares six fields with `bool isBlackList` between `minSubTier` and `poolCountryBitmap`.

This is a deliberate deviation from the highest-ranked document, justified by the only source
that outranks it: CLAUDE.md's source-of-truth order puts _"deployed contract state and verified
transaction evidence"_ first, above every specification. The guide describes an intended
interface; the chain holds the one that will actually execute.

`isBlackList` is always written `false`, per the guide's instruction. The field is carried for
ABI compatibility, not used as a feature.

The layout is pinned by a byte-level regression test rather than a type-level one, because once
both sides compile a field-count mismatch is invisible in Solidity. The test asserts
`abi.encode` of a rule against the exact six words observed on chain.

## Consequences

- Any future CCP upgrade that removes `isBlackList` breaks the encoding, and the regression test
  fails rather than the failure surfacing as a mysterious revert during rule configuration.
- The same check should be re-run against the Monad policy before the cash leg configures rules;
  the two chains run different `accesscore` implementations (11,613 bytes on Base Sepolia versus
  7,083 on Monad Testnet), so identical struct layouts cannot be assumed.
- This is the second place where the deployed API diverged from its documentation, after
  ADR-0008's per-endpoint encryption. Both were found by probing rather than reading. The
  pattern is now explicit: for anything Cleanverse, verify against chain or live API before
  writing code that depends on it.

## Alternatives rejected

**Follow the guide and treat the chain as wrong.** Inverts the source-of-truth order and would
ship a token whose rule configuration cannot work.

**Support both layouts by trying one then the other.** Makes a wrong guess indistinguishable
from a right one at runtime, and there is exactly one deployed policy per chain to target.

## Assumptions touched

Does not resolve [ASM-020](../assumptions.md). A live non-zero bitmap is now observed —
`0x400000000000800000000000`, bits 47 and 94 — but which countries those bits mean is still
undocumented, and inferring it from two data points would be exactly the guess the override
forbids. The empirical path stands: configure a country-constrained rule through the API and
read back what Cleanverse writes.

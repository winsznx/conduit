# ADR-0001: A settlement contract can hold Cleanverse cash, once it has CVI

**Status:** Accepted
**Date:** 2026-08-07
**Phase:** 01
**Supersedes:** —
**Superseded by:** —

## Context

The whole design rests on a settlement contract holding the cash leg. A CVA refuses
any holder without CVI, and `CashEscrow` is a contract that nobody had issued CVI to, so the
question was never rhetorical: if a contract cannot hold aUSDC, Conduit has no cash escrow and
the v1.1 override's fallback ladder starts — Cleanverse-native reservation, then an institutional
settlement wallet, each weaker than the last. An institutional wallet in particular is an EOA
that can move the cash unilaterally, which is the DvP guarantee gone.

The answer had to come from the contract that actually decides, not from a document. The Monad
A-Token's policy is at `0x36489bE45fa84f70a0c2BDB11D824Be608CB12Dd`, reached by calling
`policy()` on the catalogued CVA rather than by copying an address, and it answers directly:

```text
canTransfer(aUSDC, eligibleEOA, escrow,      1)  →  revert NoAPass(0x1645BA08…)
canTransfer(aUSDC, escrow,      eligibleEOA, 1)  →  revert NoAPass(0x1645BA08…)
canTransfer(aUSDC, eligibleEOA, eligibleEOA, 1)  →  true
```

The third line is the control, and it is what makes the first two mean something. The refusal
names the escrow in both directions. It is not the token, not the sender, not the sandbox.

## Decision

**Direct `CashEscrow` custody, unlocked by registering the escrow as a CVA vault.** No fallback
is needed.

The CCP Integration Guide for CVI Compliance V2 gives one on-chain remedy: `registerApass` on
`IAPassComplianceValidator`, callable only with `REGISTER_ROLE`, which Cleanverse grants through
`POST /validator/grant`. Three things had to be established to use it, and none of them was
written down anywhere.

**Where the validator is.** The guide prints no addresses and `query_deposit_atoken_list` returns
none. The A-Token's own policy is a different contract: probing it for `isRegistered`,
`complianceVerify`, `registerApass`, and `REGISTER_ROLE` returns an empty-data revert on every
one, which is a contract saying the selector does not exist. The address came from chain state
instead. A grant is a transaction, and that transaction's `to` is the validator:
`0xaC7e5179C2C7f03f209136886c172eb34F161792` on Monad Testnet, confirmed by `REGISTER_ROLE()`
returning `0xd1f21ec0…70fe` and by `hasRole` flipping true for the granted address.

**What the grant request looks like.** The guide names the endpoint and nothing else. The gateway
rejects unknown fields by name, so eliminating candidates one at a time left exactly
`chain`, `address`, `owner_signature` — `contract_address`, `factory_address`, `pool_address`,
`target_address`, `validator_address`, `grantee_address`, and `signature` are all refused. The
signature is an EIP-191 `personal_sign` over `lowercase(chain + address)`, the same rule as
`register_atoken`.

The instructive failure: granting to an EOA is refused with "Invalid contract owner signature"
even when the EOA signs for itself. The gateway reads `owner()` on the address, so the grantee
must be a contract. That is a real authorization property and it is why the registrar inherits
`Ownable2Step` rather than tracking an owner itself.

**That the ordering is enforced.** `registerApass` reverts `PoolNotRegistered()` (`0x739f4185`)
until `registerV2` has run. The guide states the order; the validator enforces it.

**`ConduitVaultRegistrar` is a separate contract.** The guide calls this role the Factory. Conduit
creates no pools, so calling it a factory would name a thing it never does. It holds
`REGISTER_ROLE` and nothing else: a compromise of its owner key can register a pool or change a
rule, and cannot reach a settlement, because no settlement contract grants it anything. Its
validator is immutable, because a repointable registrar lets an owner key mint eligibility from a
contract of its own choosing, which is the property CCP exists to provide.

## Evidence

Live on Monad Testnet, in order:

```text
POST /validator/grant   registrar 0x3FFd3944…       tx 0x8bd857a8c912e9ae5f4d98a90cd1a6eb86d86ecb…
  hasRole(REGISTER_ROLE, registrar)                    true
registerPool(escrow, unrestricted rule)              tx 0x568cea22d180be0d915bf535d37f75f45684…
registerVaultCvi(escrow, aUSDC, address(0))          tx 0x34088e6217d0568fcb8cc49c1d07c2f963b4…
  validator.isRegistered(escrow)                       true

canTransfer(aUSDC, eligibleEOA, escrow,      1)   before: NoAPass(escrow)   after: true
canTransfer(aUSDC, escrow,      eligibleEOA, 1)   before: NoAPass(escrow)   after: true
canTransfer(aUSDC, eligibleEOA, eligibleEOA, 1)   before: true              after: true
```

`docs/evidence/phase-01-monad-cva-custody.json`, produced by
`scripts/register-cash-vault.mjs`, which reads the same policy before and after.

The validator's RuleV2 has six fields, confirming [ADR-0010](./0010-rulev2-has-six-fields-on-chain.md)
on a second contract and a second chain. The proof is the selector rather than a decode that
happens to work:

```text
registerV2(address,(bytes2,bytes2,uint8,uint8,bool,uint256))  0x7b6c63cb  present
registerV2(address,(bytes2,bytes2,uint8,uint8,uint256))       0xba62f533  empty-data revert
```

Both CCP guides declare five fields. Both are wrong about the deployed contracts, and under the
source-of-truth order deployed state wins.

## Consequences

- The cash leg keeps contract custody. `CashEscrow` holds the cash, releases only against a
  canonical COMMIT, and no EOA can move it.
- Every future Conduit vault needs the same two-step registration. It lives in
  `ConduitVaultRegistrar` rather than in the settlement contracts, so an escrow cannot rewrite
  its own compliance rule mid-settlement.
- The escrow's pool rule is currently all-zero, which the guide defines as unrestricted. That is
  the pool's own `complianceVerify` policy and nothing in Conduit calls it, but it is a placeholder
  and is tracked as ASM-034 so it cannot quietly become the final policy. Phase 05 replaces it
  with the rule read back from `validator/rules`.
- The registrar's owner key is now a real key with real authority. It is in the threat model as a
  registration authority, not as a value authority.

## What is still blocked

Custody is proven. The **round trip is not**, because there is no aUSDC to move: the credential
cannot obtain any. Three paths, all closed on provisioning rather than on capability:

```text
/faucet          HTTP 200, code 0002: ERC20InsufficientBalance(0xc448042e…, balance 0)
                 the sandbox faucet's own source wallet is empty, so no amount succeeds
deposit          executed on chain, then refunded by Cleanverse ~40 blocks later.
                 query_txs classifies the pair "non_whitelist_transfer" / "non_whitelist_refund".
                 Reproduced twice at two different amounts, four ledger entries in total
/generate_apass  HTTP 403 on both chains
```

`query_institution_txs` answers `institution address is empty`, which is the same fact from a
third angle: this credential has no institution address bound to it. The deposit executing and
then being refunded by policy is the platform working correctly and refusing us, which is why
this is recorded as `SANDBOX_AUTHORIZATION_MISMATCH` rather than as a missing feature.

The phase 01 gate — "real A-Token enters and exits the selected custody mode with exact
conservation" — therefore stays open on the token, not on the design. `docs/evidence/phase-01-cash-funding.json`.

## Alternatives rejected

**Cleanverse-native reservation for the cash leg** (override section 8, fallback 2). aUSDC is
Cleanverse's contract, not ours, so there is nowhere to put reservation accounting. It works on
the asset leg only because `ConduitRWACVA` is ours.

**An institutional settlement wallet** (fallback 3). An EOA holding the cash can move it
unilaterally at any point before release, which is the failure the escrow exists to prevent.
Worth taking only if contract custody were impossible, and it is not.

**Registering `CashEscrow` itself as the role holder.** The grant succeeds — it was tried, and
`hasRole` returned true — but the escrow has no code to call `registerV2` or `registerApass`, and
adding it would put Cleanverse registration logic inside the contract that holds the money.

## Assumptions touched

Resolves ASM-001 and ASM-019. Resolves ASM-030: the Monad policy is at
`0x36489bE45fa84f70a0c2BDB11D824Be608CB12Dd`, the same address as Base Sepolia. Opens ASM-034
(placeholder pool rule) and ASM-035 (no route to real aUSDC for this credential).

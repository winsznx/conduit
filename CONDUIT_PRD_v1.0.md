# Conduit Product Requirements Document

**Version:** 1.0  
**Status:** Build-locked  
**Owner:** Tim / Conduit Labs  
**Primary track:** Cleanverse Build: Trusted Assets Hackathon — DeFi  
**Primary networks:** Monad Testnet and Arbitrum Sepolia  
**Primary transport:** Wormhole Core Messaging, subject to the mandatory live VAA seam test  
**Implementation mode:** Production-grade monorepo executed phase-by-phase with Claude Code  
**Source of truth date:** 2026-08-05

---

## 0. Executive decision

Conduit is a compliance-preserved cross-chain delivery-versus-payment protocol.

It coordinates a Cleanverse Verified Asset cash leg on Monad with delivery of a transfer-restricted real-world asset on Arbitrum. The two assets do not bridge. They settle against one another under one signed intent, one cross-chain commitment, one compliance evidence package, and one deterministic failure-resolution system.

The complete product includes:

- bilateral settlement intent signing;
- Cleanverse A-Pass and A-Token eligibility checks;
- Cleanverse Validator registration for protocol contracts;
- real CVA custody and release on Monad;
- a permissioned RWA security-token fixture and adapter on Arbitrum;
- Wormhole VAA transport between Monad Testnet and Arbitrum Sepolia;
- two-phase prepare/commit settlement;
- no unilateral refund after commit;
- settlement-level and leg-level conservation proofs;
- a Disposition Kernel for every post-lock compliance failure;
- indexed audit evidence, Cleanverse transaction reports, public verification, SDK, CLI, console, and production operations;
- a successful path and a deliberately induced compliance-failure path, both publicly reproducible.

The product claim is:

> Two chains. Two regulated assets. One settlement commitment. Both legs reach a policy-valid terminal state, or neither party receives an unaccounted economic advantage.

“Atomic” must not be used to describe simultaneous block execution across independent chains. Conduit provides an atomic settlement decision with asynchronous, permissionless execution and deterministic restricted custody if a recipient becomes ineligible after commit.

---

# 1. Product thesis

## 1.1 Problem

A regulated buyer may hold verified cash on Monad while the security, private-credit position, fund share, or other RWA it wants to acquire exists on Arbitrum.

Current workflows force at least one unacceptable compromise:

1. one party transfers first and accepts principal risk;
2. a centralized intermediary takes custody of both legs;
3. the cash or asset is bridged and loses its original compliance context;
4. compliance is checked only at onboarding and not immediately before settlement;
5. the trade is reconciled manually with fragmented records;
6. a mid-settlement identity change leaves one party paid and the other unable to receive;
7. a timeout refund can occur after the remote leg has already released.

Conduit removes those failure modes by coordinating both legs under a single settlement state machine.

## 1.2 Exact first user

An institutional treasury, RWA issuer, broker, transfer agent, or compliant DeFi desk that:

- holds a supported Cleanverse A-Token on Monad;
- trades a transfer-restricted RWA on Arbitrum;
- needs bilateral identity and jurisdiction checks;
- needs an independently verifiable settlement record;
- cannot accept partial settlement or a refund-after-release race.

## 1.3 Winning insight

CVA does not need to bridge to settle a cross-chain transaction.

The cash remains on the chain where Cleanverse supports it. The RWA remains on its issuance chain. Cross-chain messaging carries authenticated settlement state, not token supply.

This avoids:

- unauthorized A-Token minting;
- unverified wrapped cash;
- cross-chain reserve accounting;
- destination A-Token liquidity;
- bridge custody of CVA;
- supply inflation from failed source confirmation;
- the original Conduit double-payout window.

## 1.4 Why Cleanverse is load-bearing

Remove Cleanverse and Conduit loses:

- current wallet-bound identity state;
- tier, group, subgroup, country, expiry, and KYC commitments;
- A-Token-specific receive/transfer eligibility;
- clean settlement-asset discovery;
- protocol-specific Validator rules;
- Cleanverse-indexed transaction evidence;
- downloadable transaction or withdrawal reports;
- fiat-ramp eligibility and supervised exit support.

Without Cleanverse, Conduit becomes an ordinary cross-chain escrow with self-declared compliance.

---

# 2. Source-of-truth corrections from Cleanverse API v5.6

These are binding implementation facts.

## 2.1 Native A-Pass state is narrower than earlier assumptions

`POST /query_apass` returns:

- `status`: `1` active or `2` frozen;
- `expirationTime`: Unix seconds;
- `tier`;
- `subTier`;
- `group`;
- `subGroup`;
- `currentKycHash`;
- `countries`.

The documentation does not expose native `revoked`, `lapsed`, `grace`, or `restored` enum values.

Conduit normalizes:

```text
MISSING      no A-Pass record
ACTIVE       status == 1 and expirationTime > now
EXPIRING     ACTIVE and expirationTime <= now + warningWindow
EXPIRED      expirationTime <= now
FROZEN       status == 2
UNKNOWN      API, chain, or verification result unavailable
RESTORED     audit event produced when prior FROZEN/EXPIRED becomes ACTIVE
```

`RESTORED` is an event, not a persistent Cleanverse status.

The protocol-level restricted class is:

```text
RESTRICTED = MISSING | EXPIRED | FROZEN | UNKNOWN
```

A policy may treat `UNKNOWN` as fail-closed, which is the default.

## 2.2 Two different Cleanverse verification surfaces must be used

### `POST /verify_apass`

Verifies whether a wallet may receive or transfer a specific A-Token.

Result codes:

```text
1 A-Token not found
2 wallet has no A-Pass
3 A-Pass exists but transfer is disallowed because it is expired or frozen
4 valid A-Pass and transfer is allowed
```

Conduit uses this for every proposed CVA payer, recipient, return address, and substitute receiver.

### `POST /validator/verify`

Verifies whether a wallet satisfies the rules of a registered protocol contract.

A successful API call returns `code: "0000"` even when `data.valid` is `false`.

Conduit must never treat HTTP 200 or `code: "0000"` alone as eligibility.

Conduit registers:

- `CashEscrow` on Monad;
- `SettlementCoordinator` on Monad where required;
- `AssetEscrow` on Arbitrum;
- any contract that directly participates in restricted custody or settlement.

## 2.3 There is no documented generic cross-chain CCP preflight endpoint

The v5.6 guide documents:

- A-Pass queries;
- A-Token verification;
- Validator compliance;
- transaction indexing;
- report download;
- fiat ramp.

It does not document a generic endpoint that accepts an arbitrary cross-chain settlement and returns a Travel Rule decision.

Therefore:

- Conduit generates its own cross-chain `ComplianceEnvelope`;
- Conduit anchors Cleanverse query and verification response hashes;
- after an A-Token transfer, Conduit requests a Cleanverse Transaction Report using the transfer transaction hash;
- after a true withdrawal/off-ramp, Conduit may request a Travel Rule Report using the withdrawal transaction hash.

No UI, README, demo, or submission text may claim that Cleanverse generates a native cross-chain Travel Rule package unless a later official endpoint is demonstrated.

## 2.4 A-Token addresses are discovered, never hardcoded

At runtime, call:

```text
POST /query_deposit_atoken_list
```

The response provides:

- origin token address, symbol, decimals;
- A-Token address, symbol, decimals;
- `accesscore_address`;
- `apass_address`.

The deployment pipeline must persist a signed chain configuration snapshot. Contract deployment must fail if the selected cash token is not returned by the sandbox API.

## 2.5 Contract custody is a mandatory seam test

The documentation proves that Cleanverse supports Validator-registered contracts. It does not, by itself, prove that an arbitrary registered contract can receive and later transfer the selected A-Token.

Before production contracts are written, Conduit must demonstrate with the real sandbox token:

```text
verified buyer
→ approve CashEscrow
→ CashEscrow.transferFrom(actual A-Token)
→ CashEscrow holds exact amount
→ eligible receiver receives exact amount
```

The result is recorded in ADR-001.

Supported custody adapters:

```solidity
interface ICashCustodyAdapter {
    function lock(
        bytes32 settlementId,
        address payer,
        uint256 amount
    ) external returns (uint256 received);

    function release(
        bytes32 settlementId,
        address receiver,
        uint256 amount
    ) external;

    function refund(
        bytes32 settlementId,
        address receiver,
        uint256 amount
    ) external;

    function lockedBalance(bytes32 settlementId)
        external
        view
        returns (uint256);
}
```

Implementations:

1. `DirectATokenEscrowAdapter`  
   Used when the real sandbox A-Token can be held by `CashEscrow`.

2. `InstitutionalSettlementWalletAdapter`  
   Used only if Cleanverse requires an eligible institutional wallet rather than direct contract custody. This mode requires explicit operator custody, a segregated on-chain subledger, and independent proof of balance. It must not be disguised as trustless escrow.

3. `PermitPullAdapter`  
   Enabled only if the selected A-Token exposes a compatible permit or authorization mechanism. Never assume permit support.

The main demo must use one real, documented custody mode. Mock CVA is not an acceptable final proof.

---

# 3. Scope

## 3.1 Required v1.0 scope

Everything below is required for v1.0 and may not be moved into a README roadmap:

- Cleanverse capability doctor;
- Cleanverse encrypted and plain API client;
- A-Pass normalization;
- A-Token discovery;
- real sandbox A-Token custody proof;
- Validator registration and verification;
- permissioned RWA token fixture on Arbitrum;
- Wormhole Monad Testnet ↔ Arbitrum Sepolia VAA proof;
- signed settlement intents;
- cash and asset preparation;
- canonical commit and abort decisions;
- remote message verification;
- release and restricted-hold behavior;
- Disposition Kernel;
- Cleanverse transaction evidence ingestion;
- public proof page;
- CLI verifier;
- npm SDK;
- API, worker, indexer, database, web app;
- unit, integration, property, invariant, adversarial, end-to-end, and deployment tests;
- observability, runbooks, CI/CD, staging, and production configuration;
- successful settlement demo;
- compliance-change demo;
- generated audit package.

## 3.2 Explicit non-goals

These are outside the product definition, not deferred promises:

- bridging or wrapping CVA;
- minting A-Tokens on a destination chain;
- claiming legal ownership determinations;
- storing raw KYC or Travel Rule PII;
- acting as a licensed exchange, custodian, or transfer agent;
- generalized routing across every bridge;
- AI decision-making in settlement authority;
- an MCP interface;
- supporting arbitrary non-EVM chains in v1.0;
- claiming simultaneous cross-chain block execution.

---

# 4. Personas and permissions

## 4.1 Buyer

- signs settlement intent;
- supplies CVA on Monad;
- specifies verified RWA receiver;
- observes preparation, commit, delivery, and proof;
- may submit an allowed rebind request before or during a held case.

## 4.2 Seller

- signs settlement intent;
- supplies RWA on Arbitrum;
- specifies verified CVA receiver;
- receives cash only after canonical commit;
- may receive returned asset on pre-commit abort.

## 4.3 Issuer / transfer agent

- manages the RWA token identity registry and transfer policy;
- authorizes `AssetEscrow`;
- signs authorized-substitution disposition orders;
- cannot alter an already executed settlement.

## 4.4 Compliance operator

- operates or co-signs Cleanverse compliance attestations;
- reviews held cases;
- signs only order types allowed by an `AuthorityPolicy`;
- cannot release value without current recipient eligibility.

## 4.5 Relayer

- fetches and submits VAAs;
- has no authority to create settlement truth;
- may be operated by Conduit, the parties, or any third party;
- is safely retryable and permissionless where possible.

## 4.6 Auditor / judge / public verifier

- needs no private key;
- enters a settlement ID;
- independently verifies both chains, both legs, message proofs, compliance commitments, reports, and terminal state.

---

# 5. Product journeys

## 5.1 Happy path

1. Buyer and seller connect wallets.
2. Conduit discovers the active Monad A-Token configuration.
3. Conduit verifies:
   - buyer against `CashEscrow` Validator rules;
   - seller cash receiver against `CashEscrow` rules;
   - buyer and seller against the relevant A-Token using `verify_apass`;
   - seller against `AssetEscrow` rules;
   - buyer asset receiver against `AssetEscrow` rules.
4. Conduit creates a typed `SettlementIntent`.
5. Buyer and seller sign it.
6. Buyer approves and locks CVA in `CashEscrow`.
7. Seller locks the RWA in `AssetEscrow`.
8. Each escrow publishes a PREPARED message through Wormhole.
9. The Monad `SettlementCoordinator` consumes the remote asset PREPARED VAA.
10. Fresh commit-time Cleanverse attestations are produced.
11. Anyone submits `issueCommit`.
12. The coordinator validates:
    - both signatures;
    - both legs;
    - intent hash equality;
    - deadlines;
    - fresh compliance;
    - no prior abort or commit;
    - exact amounts.
13. The coordinator publishes a COMMIT message.
14. Each escrow consumes the same COMMIT VAA.
15. Cash is released to the verified seller receiver.
16. RWA is released to the verified buyer receiver.
17. Each release publishes a LEG_RELEASED message.
18. The coordinator consumes both release VAAs and marks `SETTLED`.
19. The evidence worker:
    - queries Cleanverse transaction indexing;
    - downloads the A-Token Transaction Report;
    - hashes the report;
    - creates a complete audit package.
20. The public verifier proves the complete lifecycle.

## 5.2 Pre-commit compliance failure

Example: buyer becomes frozen after cash lock but before commit.

1. Commit-time A-Pass or Validator result fails.
2. `issueCommit` reverts.
3. A valid party or operator calls `issueAbort` with the failed compliance attestation.
4. Coordinator publishes ABORT.
5. Both escrows consume ABORT.
6. Each leg attempts return to its original owner.
7. If a return recipient is currently ineligible, the leg remains in escrow and a disposition case opens.
8. Global state becomes `ABORTED` only when both legs are returned.
9. Global state becomes `HELD` if either leg remains restricted.

## 5.3 Post-commit compliance failure

Example: seller becomes frozen after COMMIT but before cash release.

1. Refunds are permanently disabled after COMMIT.
2. Cash release to the seller fails the final A-Token/attestation check.
3. CVA remains accounted for in `CashEscrow`.
4. The RWA release proceeds or is likewise held according to its final recipient status.
5. Coordinator state becomes `HELD`.
6. Disposition Kernel resolves the restricted leg.
7. Settlement reaches one of:
   - `SETTLED`;
   - `SETTLED_WITH_SUBSTITUTION`;
   - `SETTLED_TO_RESTRICTED_CUSTODY`;
   - `ABORTED`;
   - `CONTESTED`.

No path allows a party to receive one leg and then reclaim the leg it paid after COMMIT.

## 5.4 Wallet rebind

1. Original receiver is frozen, compromised, or no longer usable.
2. A replacement wallet obtains a valid A-Pass.
3. The same legal identity relationship is established by an authorized operator process.
4. A `REBIND_RECEIVER` disposition order is signed.
5. Current Cleanverse checks run on the replacement.
6. The order is executed once.
7. Original receiver and order nonce are permanently consumed.
8. Audit package records old commitment, new commitment, authority, evidence hash, and transfer.

## 5.5 Operator-assisted fiat exit

This route is only available when:

- the active Cleanverse API role includes Fiat Ramp;
- the selected market supports `SELL`;
- the wallet used by the hosted widget has an active A-Pass on the quoted chain;
- an authorized institution or replacement receiver is allowed by the disposition policy.

Flow:

1. create a SELL quote with `POST /query_ramp_quote`;
2. use the 15-minute, single-use `quoteToken`;
3. create the widget URL with `POST /create_ramp_widget_url`;
4. track `POST /query_ramp_order`;
5. record final status and withdrawal transaction;
6. request a Travel Rule Report for the withdrawal transaction.

A frozen wallet cannot directly use the ramp. Conduit must not claim automatic off-ramp for a frozen participant.

---

# 6. Functional requirements

## FR-001 Capability doctor

Command:

```bash
pnpm conduit doctor
```

Must:

- validate required environment variables without printing secrets;
- verify API base URL;
- call `query_deposit_atoken_list` for Monad;
- call `query_apass` on configured test wallets;
- call `verify_apass` for the selected A-Token;
- test `validator/is_register`, `validator/rules`, and `validator/is_paused`;
- test faucet availability;
- report role-gated capabilities;
- report Wormhole core addresses and chain IDs from pinned configuration;
- verify RPC chain IDs;
- verify contract bytecode at configured Wormhole core addresses;
- output a machine-readable capability matrix;
- exit non-zero when a required capability is missing.

## FR-002 Settlement intent

The system creates deterministic EIP-712 intents and supports EIP-1271 contract signatures.

```solidity
struct SettlementIntent {
    bytes32 settlementId;
    uint32 version;

    uint256 cashChainId;
    address cashEscrow;
    address cashAsset;
    uint256 cashAmount;
    address cashPayer;
    address cashReceiver;

    uint256 assetChainId;
    address assetEscrow;
    address assetToken;
    uint256 assetAmount;
    address assetSeller;
    address assetReceiver;

    bytes32 cashPolicyHash;
    bytes32 assetPolicyHash;

    uint64 prepareDeadline;
    uint64 commitDeadline;
    uint64 releaseDeadline;
    uint256 nonce;
}
```

`settlementId` is the EIP-712 digest or a domain-separated hash of the final intent. It must include both chain IDs and both escrow addresses.

## FR-003 Bilateral signatures

- Buyer and seller must sign the same intent hash.
- Signatures are checked on-chain before preparation or commit.
- EOA signatures use ECDSA.
- Contract wallets use EIP-1271.
- Malleable signatures are rejected.
- A signature from one chain cannot authorize a different chain or deployment.

## FR-004 Cash preparation

- Only the configured A-Token is accepted.
- `SafeERC20` is used.
- Balance delta must equal the requested amount.
- Fee-on-transfer or rebasing behavior is rejected.
- Cash may be prepared once.
- Prepared amount is immutable.
- Cash payer, receiver, token, amount, and intent hash are stored.
- PREPARED message is published after state persistence.
- Reentrancy is blocked.

## FR-005 Asset preparation

- v1 asset is an ERC-3643-style restricted ERC-20 security token.
- AssetEscrow must be authorized by the issuer/identity registry.
- Balance delta must equal requested amount.
- The same asset cannot be committed to two settlements.
- PREPARED message includes token, amount, seller, receiver, policy hash, and intent hash.

## FR-006 Fresh compliance attestations

Conduit produces EIP-712 attestations from real Cleanverse responses.

```solidity
enum CheckKind {
    QUERY_APASS,
    VERIFY_APASS,
    VALIDATOR_VERIFY
}

struct ComplianceAttestation {
    bytes32 attestationId;
    CheckKind kind;
    uint256 subjectChainId;
    address subject;
    address pool;
    address atoken;
    bool valid;
    uint8 normalizedStatus;
    uint16 tier;
    uint16 subTier;
    bytes32 groupHash;
    bytes32 subGroupHash;
    bytes32 countriesHash;
    bytes32 kycHash;
    uint64 expirationTime;
    uint64 checkedAt;
    uint64 validUntil;
    bytes32 requestIdHash;
    bytes32 responseHash;
    uint256 nonce;
}
```

Requirements:

- full Cleanverse responses are hashed before redaction;
- no raw PII enters the attestation;
- attestations expire;
- commit checks use no application cache;
- contracts verify an approved threshold signer set;
- signer-set changes are timelocked and audited;
- the same attestation cannot be replayed for another pool, token, user, chain, or settlement.

## FR-007 Canonical prepare and commit

The coordinator accepts local cash state and remote asset PREPARED VAA.

COMMIT may be issued only when:

- both legs are prepared;
- both intents match exactly;
- both party signatures are valid;
- all deadlines are valid;
- all required attestations are valid and fresh;
- neither leg is paused or cancelled;
- no commit or abort has already been issued;
- remote emitter and Wormhole chain ID are allowlisted;
- VAA verifies through the Wormhole core contract;
- VAA hash has not been consumed.

## FR-008 Abort

ABORT may occur only before COMMIT.

After COMMIT:

```solidity
refund(settlementId) => always revert SettlementCommitted();
```

Before COMMIT, ABORT requires:

- missed deadline;
- invalid compliance;
- explicit bilateral cancellation;
- unsupported or paused asset/pool;
- verified remote preparation failure.

A timeout alone cannot authorize refund when a remote release or commit may have occurred. The source contract must consume canonical coordinator state.

## FR-009 Permissionless release

Anyone may submit a valid COMMIT VAA to either escrow.

The relayer is not trusted for correctness.

Each escrow verifies:

- Wormhole guardian quorum;
- canonical emitter chain;
- canonical emitter address;
- message type;
- settlement ID;
- intent hash;
- commit sequence/version;
- non-consumption.

## FR-010 Final eligibility

Immediately before value moves:

- current A-Token-specific eligibility must be proven for a cash receiver;
- current AssetEscrow pool eligibility must be proven for an asset receiver;
- token-level transfer restrictions still apply.

If transfer is no longer permitted:

- the leg remains in escrow;
- the leg is marked held;
- no refund path reopens;
- a disposition case is created.

## FR-011 Completion

Coordinator is `SETTLED` only after it consumes final release proofs for both legs.

If one leg is held:

- coordinator becomes `HELD`;
- settlement proof shows the completed leg and restricted leg;
- conservation remains exact.

## FR-012 Disposition Kernel

Required order types:

```solidity
enum DispositionType {
    REVERIFY_AND_RESUME,
    REBIND_RECEIVER,
    RETURN_TO_ELIGIBLE_SENDER,
    AUTHORIZED_SUBSTITUTION,
    OPERATOR_ASSISTED_OFFRAMP,
    RESTRICTED_HOLD
}
```

Required authority types:

```solidity
enum AuthorityType {
    SUBJECT,
    COUNTERPARTY,
    ISSUER,
    TRANSFER_AGENT,
    COMPLIANCE_OPERATOR,
    GATEWAY_OPERATOR,
    MULTISIG
}
```

Each order binds:

- case ID;
- settlement ID;
- leg;
- source escrow;
- asset;
- amount;
- destination;
- destination identity commitment;
- authority type;
- authority policy ID;
- evidence commitment;
- compliance attestation IDs;
- not-before;
- expiry;
- nonce;
- host-state version.

Conflicting valid orders produce `CONTESTED`. No funds move until conflict resolution under the configured authority policy.

## FR-013 Evidence

Every settlement must produce:

- signed intent;
- party signatures;
- cash preparation transaction;
- asset preparation transaction;
- PREPARED VAAs;
- compliance attestations;
- COMMIT or ABORT VAA;
- release or hold transactions;
- final VAAs;
- Cleanverse indexed cash transaction;
- Cleanverse Transaction Report hash and stored artifact;
- Travel Rule Report when a withdrawal occurs;
- disposition evidence where applicable;
- verifier result;
- machine-readable claim ledger;
- PDF audit summary.

## FR-014 Public verifier

A verifier accepts only:

```text
settlement ID
optional RPC overrides
optional expected deployment manifest hash
```

It must independently fetch and verify:

- on-chain state;
- events;
- contract bytecode hashes;
- Wormhole VAAs;
- emitter allowlists;
- signatures;
- compliance attestation signatures;
- exact conservation;
- terminal state;
- report hashes;
- replay-consumption state.

The verifier must not trust the application database for protocol truth.

## FR-015 SDK and CLI

Package:

```text
@conduit-protocol/sdk
```

Functions:

```ts
discoverCleanverseAssets()
normalizeAPass()
createSettlementIntent()
hashSettlementIntent()
signSettlementIntent()
prepareCash()
prepareAsset()
fetchSettlement()
fetchVaa()
submitPreparedVaa()
issueCommit()
issueAbort()
releaseCash()
releaseAsset()
createDispositionOrder()
verifySettlement()
buildClaimLedger()
```

CLI:

```bash
conduit doctor
conduit create-intent
conduit inspect
conduit relay
conduit verify
conduit export-audit
```

---

# 7. Protocol state machine

## 7.1 Global states

```solidity
enum SettlementState {
    NONE,
    CASH_PREPARED,
    ASSET_PREPARED,
    READY,
    COMMIT_ISSUED,
    ABORT_ISSUED,
    SETTLED,
    ABORTED,
    HELD,
    CONTESTED
}
```

States are monotonic.

Allowed transitions:

```text
NONE
 ├─> CASH_PREPARED
 └─> ASSET_PREPARED

CASH_PREPARED + remote asset proof -> READY
ASSET_PREPARED + local cash proof -> READY

READY -> COMMIT_ISSUED
READY -> ABORT_ISSUED

COMMIT_ISSUED -> SETTLED
COMMIT_ISSUED -> HELD
COMMIT_ISSUED -> CONTESTED

ABORT_ISSUED -> ABORTED
ABORT_ISSUED -> HELD
ABORT_ISSUED -> CONTESTED

HELD -> SETTLED
HELD -> ABORTED
HELD -> CONTESTED

CONTESTED -> SETTLED
CONTESTED -> ABORTED
CONTESTED -> HELD
```

Forbidden transitions include:

```text
COMMIT_ISSUED -> ABORT_ISSUED
SETTLED -> any state
ABORTED -> any state
release -> refund
refund -> release
```

## 7.2 Leg states

```solidity
enum LegState {
    NONE,
    PREPARED,
    COMMITTED,
    RELEASED,
    RETURNED,
    HELD,
    DISPOSED
}
```

## 7.3 Message types

```solidity
enum MessageType {
    CASH_PREPARED,
    ASSET_PREPARED,
    COMMIT,
    ABORT,
    CASH_RELEASED,
    ASSET_RELEASED,
    CASH_HELD,
    ASSET_HELD,
    DISPOSITION_RESOLVED
}
```

All payloads start with:

```solidity
struct MessageHeader {
    uint32 protocolVersion;
    MessageType messageType;
    bytes32 deploymentId;
    bytes32 settlementId;
    bytes32 intentHash;
    uint256 sourceChainId;
    uint256 destinationChainId;
    uint64 stateVersion;
}
```

---

# 8. Smart-contract architecture

## 8.1 Contracts

```text
SettlementCoordinator.sol       canonical decision contract on Monad
CashEscrow.sol                  CVA leg on Monad
AssetEscrow.sol                 RWA leg on Arbitrum
WormholeTransport.sol           core-message publish and VAA verification
ComplianceAttestationVerifier.sol
AuthorityRegistry.sol
DispositionController.sol
SettlementFactory.sol           versioned deployment registry
RestrictedSecurityToken.sol     ERC-3643-style demo asset
DemoIdentityRegistry.sol        test RWA identity fixture only
```

## 8.2 Immutability and upgrades

Core settlement contracts are non-upgradeable.

Corrections deploy a new version through `SettlementFactory`. Every intent binds the exact contract addresses and `deploymentId`.

Admin powers:

- pause new preparations;
- rotate compliance signer set through timelock;
- rotate approved Wormhole remote emitter through timelock;
- update fee recipient through timelock;
- never seize, rewrite, or reverse executed settlements;
- never bypass eligibility.

Use:

- `Ownable2Step` or role-based equivalent;
- multisig owner in staging/production;
- separate deployer, owner, oracle signer, relayer, and evidence worker keys;
- no EOA with all roles.

## 8.3 Wormhole transport

Official current registries show:

- Wormhole Testnet chain `MonadTestnet`;
- Wormhole chain ID `10009`;
- native EVM chain ID `10143`;
- Wormhole Testnet chain `ArbitrumSepolia`;
- Wormhole chain ID `10003`;
- native EVM chain ID `421614`;
- testnet core contracts for both networks.

Conduit uses Wormhole Core Messaging:

```solidity
IWormhole.publishMessage(...)
IWormhole.parseAndVerifyVM(...)
```

The worker retrieves signed VAAs, but contracts verify guardian signatures.

Before implementation proceeds beyond the spike, prove:

```text
Monad Testnet publish
→ signed VAA available
→ Arbitrum Sepolia parseAndVerifyVM valid
→ authenticated payload consumed once

Arbitrum Sepolia publish
→ signed VAA available
→ Monad Testnet parseAndVerifyVM valid
→ authenticated payload consumed once
```

Hyperlane must not be used as the default transport because its current official registry marks `monadtestnet` disabled/deprecated.

## 8.4 Remote-emitter validation

For every VAA:

```solidity
require(valid);
require(vm.emitterChainId == expectedWormholeChainId);
require(vm.emitterAddress == expectedEmitter);
require(!consumed[vm.hash]);
require(header.deploymentId == DEPLOYMENT_ID);
require(header.protocolVersion == PROTOCOL_VERSION);
```

The VAA hash is marked consumed before external token calls.

## 8.5 Token handling

- `SafeERC20`;
- checks-effects-interactions;
- `nonReentrant`;
- exact balance-delta checks;
- reject fee-on-transfer and rebasing assets;
- zero address rejected;
- amount greater than zero;
- no arbitrary token rescue for assets backing active settlements;
- rescue only for unsupported tokens accidentally sent, under timelock, with settlement accounting proof.

## 8.6 Fees

- fee is part of signed intent;
- bounded by a hard maximum;
- charged only from a successfully settled cash leg;
- no fee on pre-commit abort;
- held settlement does not charge final fee until disposition;
- fee recipient cannot be changed for an existing intent.

---

# 9. Cleanverse integration specification

## 9.1 Server-only client

Package:

```text
packages/cleanverse
```

The browser must never receive:

- `api-key`;
- decrypted encrypted-body payloads;
- raw API responses containing sensitive material;
- webhook HMAC key material.

Environment:

```text
CLEANVERSE_BASE_URL
CLEANVERSE_API_ID
CLEANVERSE_API_KEY_BASE64
CLEANVERSE_REQUEST_TIMEOUT_MS
CLEANVERSE_MAX_READ_RETRIES
```

## 9.2 Encryption

For documented encrypted endpoints:

- Base64-decode API key;
- AES/CBC/PKCS5Padding;
- fixed 16-byte zero IV, exactly as required by Cleanverse;
- UTF-8 JSON plaintext;
- Base64 ciphertext;
- request body `{ "data": "<ciphertext>" }`.

Because the fixed IV is an upstream protocol requirement:

- do not reuse this encryption helper for internal cryptography;
- isolate it in `cleanverse/encryption.ts`;
- never describe it as authenticated encryption;
- rely on TLS;
- never log plaintext, key, or ciphertext;
- validate decrypted response schema before use.

## 9.3 Response handling

Cleanverse frequently uses HTTP 200 for business failures.

Every call:

1. checks HTTP status;
2. parses JSON;
3. validates the response schema;
4. checks `code`;
5. interprets endpoint-specific business data.

Rules:

```text
code == "0000"                         API operation completed
validator.verify data.valid == false   legitimate non-eligibility
verify_apass data.code != 4            not eligible
code == "0001"                         parameter/signature failure
code == "0002"                         business failure; inspect message
code == "12026"                        validator write failure
code == "12027"                        validator read failure/paused pool
```

No caller may use `response.ok` as the business-success condition.

## 9.4 Request IDs and retries

- generate UUID `X-Request-ID` for every request;
- persist request ID with response hash;
- read requests may retry network errors and 5xx with jitter;
- eligibility reads at commit use bounded immediate retries and fail closed;
- encrypted writes are not blindly retried;
- rule mutations wait for returned on-chain transaction confirmation before another mutation;
- webhook deliveries are idempotent by `X-Cleanverse-Delivery-Id`.

## 9.5 Required endpoint map

### Discovery and identity

```text
POST /query_deposit_atoken_list
POST /query_apass
POST /query_apass_list
POST /verify_apass
POST /query_deposit_address
POST /query_institution_white_list
```

### Validator

```text
POST /validator/grant
POST /validator/register
POST /validator/is_register
POST /validator/set_rule
POST /validator/add_rule
POST /validator/remove_rule
POST /validator/rules
POST /validator/verify
POST /validator/set_paused
POST /validator/is_paused
```

### Evidence

```text
POST /query_txs
POST /query_institution_txs
POST /download_travel_rule
```

### Sandbox

```text
POST /faucet
POST /update_status
```

`update_status` is allowed only in the isolated demo/admin harness and never exposed to ordinary users.

### Ramp

```text
POST /query_ramp_countries
POST /query_ramp_fiat_currencies
POST /query_ramp_crypto_currencies
POST /query_ramp_payment_methods
POST /query_ramp_quote
POST /create_ramp_widget_url
POST /query_ramp_order
```

## 9.6 Validator registration

Both escrow contracts expose `owner()`.

Registration procedure:

1. deploy contract;
2. owner signs lowercase `chain + contract_address` using EIP-191;
3. encrypt request;
4. call `POST /validator/register`;
5. wait for returned `tx_hash` confirmation;
6. call `validator/is_register`;
7. call `validator/rules`;
8. call `validator/verify` on positive and negative test wallets;
9. record policy hash and Cleanverse transaction.

Rules use:

- `allowed_group`;
- `allowed_sub_group`;
- `min_tier`;
- `min_sub_tier`;
- `is_black_list`;
- `countries`.

The application copies no hidden interpretation. The persisted policy is the normalized response returned by Cleanverse.

## 9.7 Evidence limits

`download_travel_rule` supports:

- Travel Rule Report from a withdrawal transaction hash;
- Transaction Report from an A-Token or Wrapped A-Token transfer hash.

The evidence service must label artifacts accurately:

```text
CLEANVERSE_TRANSACTION_REPORT
CLEANVERSE_TRAVEL_RULE_REPORT
CONDUIT_COMPLIANCE_ENVELOPE
CONDUIT_SETTLEMENT_AUDIT
```

Never label a Transaction Report as a Travel Rule Report.

## 9.8 Ramp rules

- quote tokens are single-use;
- quote tokens expire after 15 minutes;
- quoted network must match wallet chain;
- wallet must have active A-Pass;
- frozen wallets are rejected;
- amounts and fees come from the quote snapshot;
- query order until a terminal state;
- terminal states include completed, cancelled, failed, refunded, expired.

---

# 10. Restricted RWA asset

## 10.1 Demo token

Deploy an ERC-3643-style restricted security token on Arbitrum Sepolia.

Required behavior:

- issuer role;
- identity registry;
- transfer compliance hook;
- pause;
- freeze address;
- forced transfer reserved for issuer test cases but not used to bypass Conduit;
- mint and burn;
- transfer rejection reason;
- AssetEscrow whitelisting;
- buyer, seller, AssetEscrow, and approved substitute wallets represented in registry;
- events sufficient for independent verification.

The demo token is a fixture for the RWA leg. Conduit’s protocol interface is not allowed to depend on demo-only admin shortcuts.

## 10.2 Host interface

```solidity
interface IRestrictedAssetAdapter {
    function asset() external view returns (address);

    function canReceive(address receiver, uint256 amount)
        external
        view
        returns (bool);

    function lock(
        bytes32 settlementId,
        address from,
        uint256 amount
    ) external returns (uint256 received);

    function release(
        bytes32 settlementId,
        address to,
        uint256 amount
    ) external;

    function returnAsset(
        bytes32 settlementId,
        address to,
        uint256 amount
    ) external;
}
```

## 10.3 Production adapter rule

A new RWA adapter must pass the same conformance suite:

- exact conservation;
- restriction enforcement;
- no bypass through direct adapter call;
- held-state support;
- no release after return;
- no return after release;
- deterministic reason codes.

---

# 11. Off-chain architecture

## 11.1 Monorepo

```text
/
├── apps/
│   ├── web/
│   ├── api/
│   ├── worker/
│   └── indexer/
├── contracts/
│   ├── src/
│   ├── test/
│   ├── script/
│   └── deployments/
├── packages/
│   ├── domain/
│   ├── sdk/
│   ├── cleanverse/
│   ├── wormhole/
│   ├── verifier/
│   ├── db/
│   ├── config/
│   ├── observability/
│   └── ui/
├── docs/
│   ├── adr/
│   ├── threat-model/
│   ├── runbooks/
│   ├── evidence/
│   ├── implementation-status.md
│   └── assumptions.md
├── infra/
│   ├── docker/
│   └── terraform/
├── scripts/
├── CLAUDE.md
└── CONDUIT_PRD_v1.0.md
```

Use:

- strict TypeScript;
- pnpm workspaces;
- a pinned active-LTS Node runtime;
- Foundry for contracts;
- viem for EVM access;
- PostgreSQL;
- a database outbox and idempotent workers;
- OpenTelemetry;
- containerized local and staging environments.

All versions are exact-pinned in the lockfile and toolchain manifest. No floating Solidity compiler, npm dependency, Docker tag, GitHub Action, or Terraform provider.

## 11.2 API service

Responsibilities:

- create and retrieve intents;
- validate signatures;
- issue transaction-calldata payloads;
- request compliance checks;
- serve settlement state;
- create disposition-order drafts;
- serve public evidence metadata;
- receive verified Cleanverse webhooks where applicable.

The API never signs user settlement transactions.

## 11.3 Indexer

Responsibilities:

- finalized logs from both chains;
- chain cursor persistence;
- reorg rollback;
- Wormhole message sequence indexing;
- settlement projection;
- evidence triggers;
- database outbox creation.

Trust model:

- database is a projection;
- on-chain contracts remain protocol truth;
- verifier bypasses database when requested.

## 11.4 Worker

Responsibilities:

- Cleanverse API calls;
- compliance-attestation signing;
- VAA retrieval;
- VAA submission;
- retry and backoff;
- report download;
- audit generation;
- notification.

Workers are at-least-once. Every task is idempotent.

## 11.5 Compliance signer

Production target:

- 2-of-3 threshold signatures or equivalent quorum;
- keys stored in separate KMS/HSM-backed identities;
- signer-set registry on-chain;
- signed policy version;
- short attestation lifetime;
- emergency pause;
- rotation timelock.

Hackathon staging may use one signer only when the UI and docs clearly mark the trust boundary.

## 11.6 Database

Required tables:

```text
deployments
chain_configs
cleanverse_assets
validator_pools
settlement_intents
settlement_signatures
settlement_legs
settlement_events
compliance_checks
compliance_attestations
wormhole_messages
wormhole_deliveries
disposition_cases
disposition_orders
evidence_artifacts
claim_ledgers
chain_cursors
outbox_jobs
webhook_deliveries
audit_log
```

Key constraints:

- unique settlement ID;
- unique party signature per role;
- unique VAA hash;
- unique consumed remote sequence;
- unique Cleanverse request ID;
- unique disposition nonce;
- append-only audit records;
- check constraints for terminal states;
- no PII columns.

## 11.7 Outbox

Use a PostgreSQL transactional outbox.

- business state and job are written in one transaction;
- workers claim with `FOR UPDATE SKIP LOCKED`;
- retries are bounded and observable;
- poison jobs enter a dead-letter state;
- no in-memory-only critical queue.

---

# 12. Application API

## 12.1 Public endpoints

```text
GET  /v1/config
POST /v1/intents
GET  /v1/intents/:settlementId
POST /v1/intents/:settlementId/signatures
GET  /v1/settlements/:settlementId
GET  /v1/proofs/:settlementId
GET  /v1/proofs/:settlementId/claim-ledger
GET  /v1/proofs/:settlementId/audit.pdf
```

## 12.2 Authenticated endpoints

```text
POST /v1/settlements/:id/cash-calldata
POST /v1/settlements/:id/asset-calldata
POST /v1/settlements/:id/commit-attestations
POST /v1/settlements/:id/abort-attestations
POST /v1/dispositions
POST /v1/dispositions/:caseId/signatures
POST /v1/ramp/quote
POST /v1/ramp/widget
GET  /v1/ramp/orders/:orderId
```

## 12.3 Operational endpoints

```text
GET  /health/live
GET  /health/ready
GET  /metrics
POST /webhooks/cleanverse/atoken-apply
```

## 12.4 Idempotency

Mutation endpoints require:

```text
Idempotency-Key
```

The server stores:

- principal;
- endpoint;
- request hash;
- response;
- expiry.

A reused key with a different request hash is rejected.

---

# 13. Web application

## 13.1 Screens

1. Landing  
2. Create settlement  
3. Review and sign intent  
4. Participant and asset eligibility  
5. Cash lock  
6. Asset lock  
7. Live settlement timeline  
8. Held-case resolution  
9. Public proof  
10. Audit package  
11. Operator console  
12. Sandbox scenario runner  

## 13.2 Sound-off legibility

The main settlement view must show:

```text
MONAD CASH        ARBITRUM ASSET
LOCKED            LOCKED
      \          /
       ONE INTENT
       ONE COMMIT
      /          \
RELEASED          RELEASED
```

Failure path:

```text
BUYER CVI ACTIVE
        ↓
CASH LOCKED + ASSET LOCKED
        ↓
BUYER CVI FROZEN
        ↓
COMMIT BLOCKED
        ↓
ABORT / HELD
        ↓
0 PARTIAL SETTLEMENT
```

## 13.3 Accessibility

- keyboard navigation;
- semantic HTML;
- no status conveyed only by color;
- reduced-motion mode;
- readable transaction hashes;
- explicit UTC timestamps;
- copy buttons with feedback;
- mobile layout;
- no raw identity information.

---

# 14. Security model

## 14.1 Assets at risk

- CVA locked in CashEscrow;
- RWA locked in AssetEscrow;
- settlement authority;
- compliance signer keys;
- Wormhole emitter configuration;
- API key and AES key;
- report artifacts;
- user signatures;
- operator authority.

## 14.2 Trust assumptions

Explicit:

- Cleanverse API and on-chain infrastructure correctly report configured identity and token state;
- Wormhole guardians correctly attest messages;
- configured compliance signer quorum correctly transforms Cleanverse responses into bounded attestations;
- chain RPC providers may lie or fail, so critical reads use multiple providers and on-chain verification;
- issuer identity registry correctly represents RWA eligibility;
- operator-assisted off-ramp requires a legitimate institution and active A-Pass.

## 14.3 Threats

Required analysis and tests:

- forged Cleanverse response;
- stolen API key;
- AES key disclosure;
- webhook spoofing;
- webhook replay;
- response-code confusion;
- stale compliance attestation;
- compromised compliance signer;
- signer collusion;
- VAA replay;
- wrong emitter;
- wrong chain;
- wrong deployment;
- stale VAA;
- guardian-set transition;
- reorg;
- source release followed by refund;
- destination release followed by refund;
- duplicate settlement ID;
- signature replay;
- EIP-1271 malicious wallet;
- token callback reentrancy;
- fee-on-transfer token;
- paused A-Token;
- paused Validator pool;
- expired A-Pass between prepare and commit;
- frozen recipient after commit;
- operator griefing;
- relayer censorship;
- gas exhaustion;
- malicious substitute receiver;
- conflicting disposition orders;
- database projection divergence;
- report download URL expiry;
- PII leakage in logs;
- unauthorized admin upgrade;
- accidental token rescue.

## 14.4 Fundamental invariants

```text
I1  cash locked = cash released + cash returned + cash held + protocol fee
I2  asset locked = asset released + asset returned + asset held
I3  settlement receives at most one COMMIT or one ABORT
I4  no refund after COMMIT
I5  no release after terminal ABORT
I6  every accepted VAA is valid, expected, and consumed once
I7  both legs bind the same intent hash
I8  no terminal destination is used without current eligibility
I9  held value remains claimable only through Disposition Kernel
I10 state transitions are monotonic
I11 application database cannot authorize on-chain value movement
I12 relayer cannot forge remote state
I13 no evidence artifact is represented as a different report type
```

---

# 15. Testing strategy

## 15.1 Contract tests

- unit tests for every function and revert;
- Foundry fuzzing;
- stateful invariant tests;
- storage-layout snapshot even though contracts are non-upgradeable;
- gas snapshots;
- fork or live-testnet integration;
- Wormhole VAA fixture tests;
- malicious token fixtures;
- malicious EIP-1271 wallet;
- replay and wrong-emitter tests;
- concurrent preparation attempts;
- forced compliance changes.

## 15.2 Cleanverse client tests

- official examples as fixtures;
- AES round-trip;
- exact zero IV;
- malformed Base64;
- invalid key length;
- schema drift;
- HTTP 200 + business failure;
- validator `valid:false`;
- paused pool `12027`;
- verify_apass codes 1–4;
- expired timestamp;
- webhook HMAC raw-body verification;
- webhook replay;
- report URL expiry;
- quoteToken reuse and expiry.

## 15.3 Cross-chain tests

- publish and consume both directions;
- duplicate VAA;
- delayed VAA;
- out-of-order VAA;
- wrong sequence;
- wrong source emitter;
- wrong deployment ID;
- commit delivered to one chain first;
- release on one chain delayed;
- worker crash after one submission;
- no refund after commit;
- chain RPC disagreement;
- reorg before finality;
- guardian RPC outage.

## 15.4 End-to-end scenarios

Required:

1. full happy path;
2. buyer frozen before cash lock;
3. buyer frozen after cash lock, before asset lock;
4. buyer frozen after both locks, before commit;
5. seller frozen after commit, before cash release;
6. asset receiver expired before release;
7. cash receiver country becomes invalid;
8. relayer offline;
9. duplicate relay;
10. wrong VAA;
11. pre-commit bilateral cancellation;
12. post-commit attempted refund;
13. receiver rebind;
14. authorized substitution;
15. operator-assisted SELL ramp where supported;
16. Cleanverse API unavailable;
17. Validator pool paused;
18. A-Token paused;
19. database unavailable while contracts progress;
20. public verifier from empty local database.

## 15.5 Security tooling

CI requires:

- Solidity formatter and compiler warnings as errors;
- Slither;
- Foundry tests;
- invariant tests;
- secret scanning;
- dependency audit;
- static TypeScript analysis;
- lint;
- typecheck;
- unit and integration tests;
- container scan;
- Infrastructure-as-Code scan;
- Playwright E2E;
- reproducible deployment-manifest check.

No security tool result may be silenced without a documented waiver in `docs/security-waivers/`.

---

# 16. Observability

## 16.1 OpenTelemetry

Trace across:

```text
browser request
→ API
→ Cleanverse request
→ database transaction
→ outbox job
→ worker
→ RPC
→ VAA retrieval
→ VAA submission
→ evidence generation
```

## 16.2 Required metrics

```text
cleanverse_request_latency
cleanverse_business_failures
cleanverse_verify_invalid
cleanverse_verify_unknown
compliance_attestation_age
settlement_state_total
settlement_time_to_ready
settlement_time_to_commit
settlement_time_to_terminal
vaa_fetch_latency
vaa_submit_failures
vaa_replay_rejections
held_value_by_asset
disposition_case_age
rpc_provider_disagreement
indexer_lag_blocks
outbox_job_age
report_download_failures
```

## 16.3 Alerts

- value held above threshold;
- settlement stuck beyond SLA;
- compliance signer quorum unavailable;
- Cleanverse error-rate spike;
- Wormhole VAA unavailable;
- chain cursor lag;
- database outbox backlog;
- contract pause;
- signer-set change;
- emitter configuration change;
- balance/accounting mismatch;
- public verifier disagreement.

## 16.4 Logging

- structured JSON;
- settlement ID, request ID, chain ID, tx hash;
- no private keys;
- no API key;
- no raw PII;
- no raw bank details;
- no decrypted Cleanverse sensitive payload;
- wallet addresses may be logged only where operationally required and are classified as pseudonymous identifiers.

---

# 17. Infrastructure and deployment

## 17.1 Environments

```text
local
test
staging
production
```

Staging uses:

- Cleanverse sandbox;
- Monad Testnet;
- Arbitrum Sepolia;
- Wormhole Testnet.

Production configuration is present and deployable but disabled until production Cleanverse and chain approvals exist.

## 17.2 Infrastructure

Terraform provisions:

- container runtime;
- PostgreSQL;
- object storage for evidence;
- KMS/Secrets Manager;
- OpenTelemetry collector;
- metrics and alerting;
- private networking;
- WAF/rate limiting;
- encrypted backups;
- retention policies.

Local development uses Docker Compose.

## 17.3 Deployment manifests

Every deployment produces:

```json
{
  "deploymentId": "0x...",
  "protocolVersion": 1,
  "gitCommit": "...",
  "solcVersion": "...",
  "chainConfigs": {},
  "contracts": {},
  "bytecodeHashes": {},
  "wormhole": {},
  "cleanverseAssetSnapshotHash": "0x...",
  "validatorRuleHashes": {},
  "timestamp": "..."
}
```

Manifest is:

- committed under `contracts/deployments`;
- published to object storage;
- hashed on-chain or in release metadata;
- consumed by the verifier.

## 17.4 Key management

- no private keys in `.env` for production;
- deployer key separate from owner Safe;
- compliance signers in KMS/HSM;
- relayer key has gas only and no protocol authority;
- Cleanverse API key only in server secrets;
- key rotation runbook;
- emergency revocation runbook.

---

# 18. Performance and reliability

Targets for staging:

- API p95 under 500 ms excluding external compliance calls;
- compliance preflight p95 measured and displayed, not invented;
- commit attestations valid for a configurable short window;
- indexer lag under configured finality plus two blocks;
- relayer retry without duplicate execution;
- public verifier completes within 30 seconds under healthy RPCs;
- all critical services restart without losing work;
- database point-in-time recovery tested;
- evidence artifacts content-addressed.

Cross-chain settlement latency is reported as observed data from the final testnet proof.

---

# 19. Claude Code execution plan

All phases are mandatory parts of v1.0. A phase is an ordering and evidence gate, not a scope concession.

## Phase 00 — repository and truth lock

Deliver:

- monorepo;
- `CLAUDE.md`;
- PRD copied into repository;
- toolchain manifest;
- formatting, lint, typecheck, test skeleton;
- docs directories;
- threat-model skeleton;
- no product logic.

Gate:

```text
fresh clone → one bootstrap command → all empty-suite checks green
```

## Phase 01 — Cleanverse capability and seam proof

Deliver:

- typed Cleanverse client;
- encryption helper;
- response parser;
- doctor CLI;
- A-Token discovery;
- A-Pass normalization;
- faucet support;
- Validator reads;
- role/capability matrix;
- sandbox wallets;
- ADR-001 cash custody result.

Mandatory live evidence:

- actual Monad A-Token address;
- actual decimals;
- successful `query_apass`;
- successful and failed `verify_apass`;
- successful faucet;
- direct CashEscrow custody test or explicit institutional-wallet mode;
- no secrets in logs.

Gate:

```text
real A-Token enters and exits the selected custody mode with exact conservation
```

## Phase 02 — Wormhole transport proof

Deliver:

- pinned Wormhole config;
- `IWormhole` interface;
- message codec;
- transport contracts;
- VAA fetcher;
- VAA verifier tests;
- two-direction live test.

Gate:

```text
Monad Testnet message verifies on Arbitrum Sepolia
and
Arbitrum Sepolia message verifies on Monad Testnet
with replay rejected
```

## Phase 03 — restricted RWA fixture

Deliver:

- security token;
- identity registry;
- transfer restriction module;
- seller, buyer, escrow onboarding;
- AssetEscrow custody proof;
- adapter conformance suite.

Gate:

```text
eligible transfer succeeds
ineligible transfer fails
AssetEscrow locks and releases exact amount
```

## Phase 04 — settlement contracts and reference model

Deliver:

- pure TypeScript reference model;
- SettlementIntent;
- CashEscrow;
- AssetEscrow;
- SettlementCoordinator;
- state/message codecs;
- full unit, fuzz, and invariant suite.

Gate:

```text
reference model and contracts produce identical outcomes for generated traces
```

## Phase 05 — Cleanverse Validator integration

Deliver:

- Validator registration scripts;
- owner signatures;
- policy snapshots;
- compliance-attestation service;
- on-chain attestation verifier;
- positive/negative/paused cases.

Gate:

```text
real Cleanverse eligibility result changes commit outcome on-chain
```

## Phase 06 — full happy-path DvP

Deliver:

- API;
- indexer;
- worker;
- relayer;
- database;
- web flow;
- SDK;
- first complete testnet settlement.

Gate:

```text
CVA cash and restricted RWA settle under one intent
both chains publicly verifiable
no private team database required
```

## Phase 07 — Disposition Kernel

Deliver:

- AuthorityRegistry;
- DispositionController;
- held states;
- all six order types;
- conflict handling;
- rebind and substitution UX;
- property tests.

Gate:

```text
every generated held case reaches an allowed terminal state
or remains safely contested with exact conservation
```

## Phase 08 — evidence and verifier

Deliver:

- query_txs integration;
- Transaction Report download;
- withdrawal Travel Rule Report integration where applicable;
- artifact hashing;
- claim ledger;
- PDF audit;
- public proof page;
- CLI verifier.

Gate:

```text
new machine with only settlement ID independently verifies the complete proof
```

## Phase 09 — hardening

Deliver:

- threat model complete;
- Slither findings resolved;
- chaos tests;
- RPC failover;
- signer quorum;
- multisig/timelock;
- backup and recovery;
- load tests;
- operational runbooks;
- staging incident drill.

Gate:

```text
all security, recovery, and chaos gates pass with no undisclosed critical issue
```

## Phase 10 — presentation proof

Deliver:

- sound-off demo;
- successful case;
- mid-settlement freeze case;
- public links;
- architecture diagram;
- proof metrics;
- honest trust model;
- reproducible judge path.

Gate:

```text
judge verifies both cases in under two minutes without private credentials
```

---

# 20. Claude Code operating rules

Claude Code must:

1. read `CLAUDE.md`, this PRD, current phase, and relevant ADRs before editing;
2. implement one phase at a time;
3. create an ADR before deviating from architecture;
4. never convert an unresolved assumption into a fact;
5. never substitute mocks for a required final live integration;
6. keep mocks only as deterministic test fixtures;
7. run the complete phase gate before marking PASS;
8. preserve exact source terminology from Cleanverse;
9. never expose API secrets;
10. update `docs/implementation-status.md` after every phase;
11. provide commit SHA, tests, deployments, evidence, failures, and residual risks;
12. stop only on a documented external blocker, with the smallest reproducer and exact requested support question.

Required completion report:

```text
PHASE
STATUS
COMMIT
DEPLOYMENTS
TEST COUNTS
LIVE TRANSACTIONS
EVIDENCE
SECURITY FINDINGS
KNOWN LIMITATIONS
NEXT PHASE
```

---

# 21. Acceptance criteria

The product is complete only when all are true.

## Cleanverse

- [ ] Real sandbox API is used.
- [ ] No secret is exposed client-side.
- [ ] Actual Monad A-Token is discovered dynamically.
- [ ] Real A-Pass active, frozen, expired, and missing cases are handled.
- [ ] `verify_apass` code 4 is required for CVA receivers.
- [ ] Both protocol contracts are registered or the precise unavailable capability is documented and replaced with the approved attestation mode.
- [ ] Validator `valid:false` is correctly treated as non-eligible.
- [ ] Paused pool failure is handled.
- [ ] Actual A-Token transaction appears in Cleanverse indexing.
- [ ] Correct report type is downloaded and hashed.
- [ ] Ramp route follows quote-token and active-A-Pass rules.

## Protocol

- [ ] Both parties sign one intent.
- [ ] Cash and asset lock exactly.
- [ ] Both PREPARED messages cross chains.
- [ ] One canonical COMMIT or ABORT exists.
- [ ] No refund after COMMIT.
- [ ] No VAA replay.
- [ ] Wrong emitter and wrong chain fail.
- [ ] Both legs reach terminal accounting states.
- [ ] Every held case is disposition-controlled.
- [ ] Conservation invariants pass.

## Product

- [ ] End-to-end web journey works.
- [ ] SDK published.
- [ ] CLI published.
- [ ] Public verifier works from settlement ID.
- [ ] Audit PDF and claim ledger generated.
- [ ] Successful and failure demos public.
- [ ] Documentation contains no false cross-chain CCP claim.
- [ ] Trust assumptions are visible.

## Production

- [ ] CI green.
- [ ] Staging reproducible.
- [ ] Multisig/timelock configured.
- [ ] Secrets managed.
- [ ] Backups tested.
- [ ] Observability live.
- [ ] Runbooks tested.
- [ ] No critical or high unwaived security issue.
- [ ] Deployment manifest published.

---

# 22. Headline proof

The final public result must be expressed with real values:

```text
Cash chain: Monad Testnet
Asset chain: Arbitrum Sepolia
Cash asset: actual Cleanverse sandbox A-Token
RWA asset: restricted security token
Settlement ID: 0x...
Cash amount: N
RWA amount: M

Happy path:
- 2 valid party signatures
- 4 valid participant eligibility decisions
- 2 prepared legs
- 1 canonical commit
- 2 released legs
- 0 duplicate executions
- 0 value to ineligible receivers
- 1 independently verified terminal settlement

Failure path:
- receiver active at preparation
- receiver frozen before commit or release
- prohibited leg receives 0
- no post-commit refund
- exact held balance
- one authorized disposition
- terminal evidence complete
```

Demo line:

> Conduit does not bridge verified assets. It lets verified cash on one chain settle verified ownership on another, with both legs governed by one compliance-aware commitment.

---

# 23. Mandatory unresolved questions

These are answered by live seam tests, not speculation.

1. Which A-Token pair is available on Monad sandbox?
2. Can a Validator-registered contract hold that A-Token?
3. Does the contract require its own A-Pass?
4. Which API role was granted to the hackathon key?
5. Can both Monad and Arbitrum protocol contracts be registered through `/validator/register`?
6. What confirmation delay is observed for Validator writes?
7. Does `verify_apass` succeed for contract addresses where required?
8. Does Cleanverse indexing include escrow-to-user A-Token transfers promptly?
9. Can the sandbox generate the required Transaction Report for the cash-release transfer?
10. Is Fiat Ramp SELL enabled for the selected test market?
11. Does Wormhole produce live VAAs in both directions today?
12. What consistency level and finality yield reliable testnet messages?

Every answer is added to `docs/adr/` and the deployment manifest.

---

# 24. Source register

## Primary product source

- Cleanverse API V5.6, revision 2026-07-21, supplied directly for hackathon integration.

## Primary transport sources

- Wormhole Foundation `wormhole-sdk-ts` current chain, native-chain-ID, and core-contract registries.
- Wormhole Foundation `IWormhole.sol`.
- Hyperlane official registry entry for `monadtestnet`, currently disabled/deprecated.

## Development workflow source

- Anthropic official Claude Code repository and documentation entry point.

No secondary blog or unaudited community tutorial is an architectural source of truth.

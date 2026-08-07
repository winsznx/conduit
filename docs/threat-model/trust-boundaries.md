# Trust boundaries

PRD 14.2 states the trust assumptions. This file draws the lines those assumptions sit on, so
every later phase can say precisely which side of a boundary a given input arrived from.

A boundary here means: data crossing it is untrusted until something in Conduit re-derives or
re-verifies it. "Trusted" never means "assumed correct"; it means "correctness is assumed and
the assumption is written down, bounded, and visible to the auditor."

## Boundary map

```text
        ┌──────────────────────────── untrusted ────────────────────────────┐
        │                                                                   │
  browser / wallet          relayer            RPC providers        Cleanverse API
        │                      │                      │                     │
        ▼                      ▼                      ▼                     ▼
   signed intent          signed VAA            chain reads          identity state
        │                      │                      │                     │
        │                      │                      │                     ▼
        │                      │                      │           compliance signer quorum
        │                      │                      │                     │
        ▼                      ▼                      ▼                     ▼
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  on-chain contracts — the only authority over value                          │
  │  SettlementCoordinator · CashEscrow · AssetEscrow · DispositionController     │
  └──────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                       application database — projection only
```

## Boundaries

### Browser and wallet → API

Untrusted. The API validates every payload against a schema and never signs a user settlement
transaction (PRD 11.2). No API key, AES key, decrypted Cleanverse payload, or webhook HMAC
secret may cross toward the browser (PRD 9.1).

### Relayer → contracts

Untrusted for correctness, and deliberately permissionless (PRD FR-009). A relayer chooses
_when_ a message is delivered and can withhold delivery. It cannot forge one: guardian quorum,
emitter chain, emitter address, deployment ID, protocol version, message type, settlement ID,
and intent hash are all checked on-chain, and the VAA hash is marked consumed before any token
call. Censorship is a liveness threat (T-29), never a safety threat.

### Wormhole guardians → contracts

Trusted to attest messages correctly, per PRD 14.2. The trust is bounded: contracts verify
through the core contract rather than an off-chain parse, a guardian-set transition is an
explicit threat (T-15), and no VAA is accepted from an unexpected chain, emitter, deployment,
or version.

### Cleanverse API → compliance signer → contracts

Cleanverse is trusted to report configured identity and token state (PRD 14.2). The API
response itself never reaches a contract. A compliance signer quorum transforms a real response
into a bounded, expiring EIP-712 attestation whose full-response hash is anchored, and the
contracts verify only that attestation. Consequences:

- an HTTP 200 is not business success, and `validator/verify` returning `valid:false` is a
  legitimate non-eligibility rather than an API failure;
- a compromised or colluding signer set is a first-class threat (T-08, T-09), which is why the
  signer set is on-chain, quorum-based, and rotated through a timelock;
- commit-time checks bypass the application cache, because a cached eligibility read is a
  stale attestation (T-07) wearing a fresh timestamp.

### RPC providers → indexer, worker, verifier

Untrusted. PRD 14.2 states plainly that providers may lie or fail, so critical reads use more
than one provider and are reconciled against on-chain verification. Disagreement is a metric
(`rpc_provider_disagreement`) and an alert, not a silent tiebreak.

### Application database → everything

Never an authority. The database is a projection of chain state (PRD 11.3). Invariant I11 says
it cannot authorize on-chain value movement, and PRD FR-014 requires the public verifier to
reach a terminal answer from a settlement ID alone, with an empty local database.

### CCP RuleV2 policy → ConduitRWACVA

Trusted to decide RWA transfer eligibility. The v1.1 override moves this boundary: PRD 14.2
placed it at a generic issuer identity registry feeding `AssetEscrow`, and override sections 2
and 9 replace both with a real Cleanverse CVA whose `policy.canTransfer(token, from, to, amount)`
is the authoritative gate at the moment of transfer.

Three consequences follow, and they are the reason this is now the highest-traffic boundary in
the system:

- Cleanverse becomes load-bearing on the asset leg as well as the cash leg. A CCP rejection
  stops delivery, and that is correct behaviour rather than an outage.
- Validator registration does not substitute for it. Override section 9 is explicit that
  protocol-level Validator rules are additional, never a replacement for token-level
  `canTransfer`.
- The reservation model does not sit outside the boundary. Reservation bookkeeping is not an
  ERC-20 transfer and creates no holder, but every _actual_ transfer still crosses this line.
  A reservation that could release without `canTransfer` would be a policy bypass wearing
  settlement clothing (threat V-05).

### Operators and authorities → Disposition Kernel

Partially trusted, and constrained by an `AuthorityPolicy`. An operator may sign only order
types the policy allows, cannot release value without current recipient eligibility, and cannot
alter an executed settlement. Conflicting valid orders produce `CONTESTED` and move nothing
(PRD FR-012).

### Cloudflare and Supabase → application

Infrastructure, never authority. The v1.1 override names Cloudflare Workers as the API and web
runtime and Supabase as the managed Postgres provider. Neither changes invariant I11: the
database stays a projection, and the public verifier still reaches a terminal answer from a
settlement ID with an empty local database.

Two credentials now cross this boundary and must not cross back toward a browser: the Supabase
service-role key and the Cleanverse credentials held as Worker secrets. Cloudflare Queues are
at-least-once, so every consumer is idempotent and the Postgres transactional outbox remains
authoritative for critical job intent (threats V-09, V-10, V-11).

## Phase 00 state

This document fixes the boundaries. The per-boundary control tests live in
[threat-register.md](./threat-register.md) and are written in the phases named there.

The CCP policy and Cloudflare/Supabase boundaries arrived with the v1.1 override, adopted in
[ADR-0004](../adr/0004-prd-v1-1-override-adoption.md).

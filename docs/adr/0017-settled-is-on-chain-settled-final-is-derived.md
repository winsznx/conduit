# ADR-0017: SETTLED is on chain, SETTLED_FINAL is derived

**Status:** Accepted
**Date:** 2026-08-08
**Phase:** 06
**Supersedes:** —
**Superseded by:** —

## Context

The phase 06 report said "SETTLED_FINAL" as though it were a terminal state the
coordinator reached. It is not. `SettlementCoordinator.SettlementState` has ten
values and `SETTLED` is the terminal one; `SETTLED_FINAL` appears nowhere in
Solidity, in an event, or in storage.

The name came from the view states ADR-0013 introduced — `PREPARED_FAST`,
`FINALITY_PENDING`, `READY_FINAL`, `SETTLED_PENDING_FINALITY`, `SETTLED_FINAL` —
which are explicitly normalized application states rather than on-chain ones.
Using one of them as the headline of an on-chain result blurs exactly the line
this project exists to hold: what a contract enforces versus what an application
concludes.

The blur is not cosmetic. A reader who believes `SETTLED_FINAL` is stored on
chain believes the chain has attested to finality of the messages behind it. It
has not. The coordinator checks finality when it _consumes_ each message and
then stores an outcome; nothing in its storage afterwards records what
consistency level those messages carried. Reconstructing that requires going
back to the guardians, which is a verifier's job and not a contract's.

## Decision

**`SETTLED` is the canonical protocol terminal state.** It is a value of
`SettlementCoordinator.SettlementState`, stored on chain, reached when both legs
have reported an outcome and neither is held. It is the only one of the two a
contract knows about, and reports quote it verbatim from `settlementOf`.

**`SETTLED_FINAL` is a verifier classification.** It is derived, never stored,
and it holds only when every one of these is independently true:

```text
the coordinator's own state is SETTLED
both leg outcomes are terminal and neither is HELD
the cash escrow's local leg state agrees with the coordinator's cash outcome
the token's reservation agrees with the coordinator's asset outcome
every cross-chain message the decision rests on was carried at FINALIZED
every one of those VAAs is recorded consumed on its destination contract
every contract involved matches the code hash its manifest pins
every contract belongs to one deployment generation
conservation holds: the escrow's books equal its balance, nothing left reserved
every block range that could hold one of those messages was actually read
```

`SETTLED_FINAL` requires `SETTLED`. The reverse does not hold, and a settlement
that is `SETTLED` on chain but fails any check above is reported as
`SETTLED_PENDING_VERIFICATION` rather than promoted.

**The derivation takes no application database as an authority root.**
`packages/verifier` reads deployment manifests, two chain RPCs, and the Wormhole
guardian set. There is no database in its dependency graph and no interface
through which one could be supplied. CLAUDE.md's rule — application database
state never authorizes value movement — extends to the evidence: an application
database cannot authorize a _claim_ about value movement either.

**A gap in the search is a failure, not a silence.** A settlement ID carries no
timestamp, so the verifier is told where to start looking and reports the window
it searched. Public endpoints cap log ranges — Base Sepolia at roughly a
thousand blocks, Monad Testnet at roughly a hundred — and the first version of
this verifier logged those refusals as warnings and certified `SETTLED_FINAL`
having read one message of the three the settlement rests on. Now an unread
range is a failing finding, and a missing message names the window it was
looked for in, because "not published" and "not looked at" are different
answers and only one of them is about the settlement.

## Evidence

Settlement `0x940f1c15…f658858`, verified from its ID and two RPC URLs:

```text
canonical on-chain state   SETTLED
derived classification     SETTLED_FINAL

ASSET_PREPARED  seq 0  wormhole:10004:0x…f45be  FINALIZED  → coordinator  consumed
ASSET_RELEASED  seq 1  wormhole:10004:0x…f45be  FINALIZED  → coordinator  consumed
COMMIT          seq 0  wormhole:10009:0x…f45be  FINALIZED  → adapter      consumed
```

## Consequences

- Every report distinguishes the two, and the verifier prints them on separate
  lines. A single headline would reintroduce the conflation.
- The view states of ADR-0013 keep their names and their status as application
  states. `SETTLED_FINAL` is now the one of them with a defined derivation.
- A verifier run is slow against public endpoints, because honest scanning at a
  hundred blocks a request is slow. That is the cost of not skipping ranges.

## Alternatives rejected

**Storing a finality flag on chain.** The coordinator would have to record the
consistency level of every message it consumed, which is state it does not need
to enforce anything and which a verifier can derive from the guardians anyway.
Storing a claim does not make it checkable; it makes it quotable.

**Calling the on-chain state SETTLED_FINAL.** Renaming the enum would make the
report accurate and the contract wrong: the state machine reaches that state
without knowing anything about how final the messages behind it were.

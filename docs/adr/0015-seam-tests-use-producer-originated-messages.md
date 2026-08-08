# ADR-0015: A fixture may not invent a message no contract emits

**Status:** Accepted
**Date:** 2026-08-08
**Phase:** 04
**Supersedes:** —
**Superseded by:** —

## Context

`CashEscrow.releaseCash` consumed a COMMIT VAA for weeks of work and could never
have succeeded. `_consume` requires the emitter to be the remote peer on the
remote chain; the coordinator that issues COMMIT is on the same chain. The
message is also addressed to `intent.assetChainId`, so the destination check
refused it a second time. Two independent refusals, on the one path that pays
the receiver.

Every unit test passed. They passed because they built their own COMMIT VAAs —
well formed, carrying the escrow's own peer as emitter and this chain as the
destination. The fixture described a message nothing in the system produces, and
the contract was verified against the fixture rather than against the thing that
actually calls it.

Two more defects sat in the same seam and were invisible for the same reason:
`recordLocalCashResolved` was permissionless, so anyone could declare the cash
leg released while the cash sat in escrow; and restricting it made it
unreachable, because the escrow never called it. All three surfaced within
minutes of one test that drove real coordinator state into the real escrow.

The common shape: each contract was individually correct against an imagined
counterparty. Unit tests cannot see this class by construction, because the
fixture is written by the same person, at the same time, with the same wrong
belief about what the other side emits.

## Decision

**A test fixture may not invent a protocol message that no production contract
emits.**

For seam tests, the message must come from the real producer:

```text
production producer contract
  → its actual publishMessage payload, captured from the emitted event
  → transport wrapper (a Core harness, plumbing only)
  → production consumer contract
```

The Wormhole mock is permitted as transport plumbing and nothing else. It carries
the exact bytes the producer emitted; it does not author them.

**The exception is adversarial testing, and it must be explicit.** A test whose
subject is a malformed, replayed, wrong-emitter, or otherwise hostile message
constructs that message deliberately, and its name says so. The distinction is
whether the fixture is standing in for a legitimate counterparty (forbidden) or
playing an attacker (required).

**System tests use the production authorization graph.** The same public methods,
the same roles, the same bindings. A test that reaches a state through a
privileged shortcut proves the state is representable, not that it is reachable.

**Composition coverage is a standing requirement**, not a one-time exercise. At
minimum: cash prepare through coordinator to cash release; asset prepare to
coordinator; both prepared reaching READY; READY to COMMIT; COMMIT driving each
release; both releases reaching SETTLED; pre-commit ABORT returning both legs;
a post-COMMIT refund attempt rejected; a leg turning ineligible after COMMIT
reaching HELD; HELD reaching a terminal disposition; a duplicate remote message
rejected; a wrong peer emitter rejected; and a correctly signed VAA carrying a
message type the state machine cannot accept in its current state, rejected.

**Prerequisites in operational scripts are never best-effort.** Submit, await the
receipt, require success, read the resulting state, assert the delta, and only
then continue. Minting, registration, funding, approval, reservation,
preparation, commit, and release are all protocol steps. A `catch` around any of
them converts a failure that never landed into a confusing error one step later:
a swallowed mint surfaced as `InsufficientAvailableBalance`, which reads as a
balance problem and was a transaction that never happened.

## Consequences

- Seam tests are slower to write and need the producer wired up. That is the
  cost, and three bugs in one path is what the saving bought.
- `CashSettlementSeam.t.sol` is permanent. Its tests are regression tests for
  defects that reached deployed contracts, and they are not to be folded into
  the unit suites or simplified into fixtures.
- The asset leg has not had the equivalent scrutiny yet. It is assumed to have
  the same class of defect until a producer-originated test says otherwise.
- Local read-after-write needs the same discipline as the message path: Base
  Sepolia's public endpoint serves reads behind the head and is not archival, so
  scripts assert the state they are waiting for rather than sleeping and hoping.

## Alternatives rejected

**Shared fixture helpers.** A helper that builds a "valid COMMIT" is the same
invented message with fewer copies of it, and it makes the invention look
authoritative.

**Trusting the type system.** Both sides typed correctly against `bytes`. The
disagreement was about the contents, which no signature captures.

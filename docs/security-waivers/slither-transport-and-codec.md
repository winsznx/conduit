# Waiver: Slither `assembly` and `reentrancy-events` on the transport layer

**Status:** Active
**Opened:** 2026-08-07
**Expires:** 2026-11-07
**Scope:** two detectors at two sites — `assembly` on `MessageCodec.decode`, and
`reentrancy-events` on `WormholeTransport._publish`. Every other detector, contract, and
function stays unfiltered, and `fail_on` remains `low`.

## Finding

```text
Detector: assembly
MessageCodec.decode(bytes) uses assembly
  - INLINE ASM (contracts/src/libraries/MessageCodec.sol#79-89)

Detector: reentrancy-events
Reentrancy in WormholeTransport._publish(MessageCodec.Header,uint8):
  External calls:
  - sequence = wormhole.publishMessage{value: fee}(0, MessageCodec.encode(header), consistencyLevel)
  Event emitted after the call:
  - MessagePublished(sequence, header.messageType, header.settlementId)
```

## Why it does not apply

### `assembly` in `MessageCodec.decode`

The assembly _is_ the security property, not a shortcut around one.

The header is a fixed-width, positional encoding with no length prefix, no optional field, and
no dynamic type. Reading each field at a constant offset is what makes a truncated or extended
payload fail to decode rather than decode into something plausible. That matters because the
payload is attacker-influenced: anyone may relay a VAA (PRD FR-009).

The block is annotated `memory-safe`, reads only within a bounds-checked length, and writes
nothing. `MessageCodec.decode` rejects a payload shorter than 173 bytes before the block runs,
so every `mload` is inside allocated memory.

An `abi.decode` alternative would need the payload re-packed into a tuple encoding first, which
means trusting a length-prefixed structure supplied by the same untrusted caller. That is
strictly worse.

### `reentrancy-events` in `WormholeTransport._publish`

The event carries the Wormhole sequence number, and the sequence is only known _after_
`publishMessage` returns. Emitting before the call would mean emitting a value that does not
exist yet.

The callee is the Wormhole core contract at an address pinned from the official registry
snapshot (ADR-0006) and verified to hold bytecode on both chains. PRD 14.2 lists Wormhole
guardians among the explicit trust assumptions. If the core contract re-entered Conduit, event
ordering would be the least of the problems.

Nothing branches on the event. It is telemetry for the indexer, and the indexer reconciles
against on-chain state rather than trusting log order, because invariant I11 makes the database
a projection.

## Invariants checked

None at risk.

- The codec's decode path feeds the six checks in `_consume`, all of which run _after_ decoding
  and none of which depend on how the bytes were read. I6 is enforced by the replay map, the
  emitter checks, and the deployment ID, not by the decoder.
- `_publish` moves no value and changes no settlement state. It forwards the Wormhole message
  fee and nothing else.

## Compensating control

`contracts/test/Codecs.t.sol` covers the decoder directly: a truncated payload, an unknown
message type, an unsupported protocol version, trailing bytes beyond the header, and a
256-run fuzz round-trip over every field. It also asserts the encoding matches
`packages/domain` byte-for-byte, so an independently written TypeScript implementation agrees
with the assembly.

`contracts/test/CashEscrow.t.sol` covers the publish path end to end and asserts the emitted
payload decodes back to the expected header.

## Removal condition

Delete this waiver when either becomes true:

- the header gains a dynamic field, at which point positional assembly stops being the right
  tool and the decoder should be rewritten rather than waived;
- Wormhole exposes a way to learn the sequence before publishing, removing the need to emit
  after the call.

Re-check with `slither . --config-file slither.config.json`.

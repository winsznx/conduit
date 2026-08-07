# Waiver: Slither `timestamp` on ConduitRWACVA

**Status:** Active
**Opened:** 2026-08-07
**Expires:** 2026-11-07
**Scope:** the `timestamp` detector, on `ConduitRWACVA.reserveForSettlement` and
`ConduitRWACVA._update` only. Every other detector and every other contract stays unfiltered,
and `fail_on` remains `low`.

## Finding

```text
Detector: timestamp
ConduitRWACVA.reserveForSettlement(bytes32,uint256) uses timestamp for comparisons
  Dangerous comparisons:
  - _reservations[settlementId].owner != address(0)
ConduitRWACVA._update(address,address,uint256) uses timestamp for comparisons
  Dangerous comparisons:
  - reserved != 0
  - releasing != bytes32(0) && _reservations[releasing].owner == from
  - spendable < value
```

## Why it does not apply

The detector exists to catch logic whose _outcome depends on block time_, where a miner or
validator can influence a comparison by shifting the timestamp a few seconds.

None of the five flagged comparisons involve time. They compare an address against zero, a
balance against an amount, and a `bytes32` against zero. Slither attributes every comparison in
a function to the timestamp detector once the function reads `block.timestamp` anywhere.

`_update` is the clearer case: it does not read `block.timestamp` at all, so all three of its
flagged comparisons are attributed to a value the function never touches.

The single genuine read is `createdAt: uint64(block.timestamp)` in `reserveForSettlement`. It is
recorded as metadata and nothing branches on it. It exists because PRD 16.2 requires a
`disposition_case_age` metric, and a held case's age has to be measured from somewhere.

## Invariants checked

None at risk. Time influences no decision in this contract:

- R2 and R3 gate on the `committed` flag, set by the settlement adapter after it verifies a
  COMMIT VAA. There is no deadline evaluated here.
- R1's spendability check compares balances, not times.
- R5 delegates entirely to `policy.canTransfer`.

Settlement deadlines exist in `SettlementIntent` (`prepareDeadline`, `commitDeadline`,
`releaseDeadline`) and are evaluated by the coordinator. When that code lands, this waiver does
not extend to it and a fresh timestamp finding there must be assessed on its own merits.

## Compensating control

`contracts/test/ConduitRWACVA.t.sol` never manipulates `block.timestamp`, and every reservation
test passes without warping time. A behaviour that depended on the clock would have to show up
as a test that only passes at a particular time, and none exists.

`testFuzz_ReservedNeverExceedsBalance`, `testFuzz_AvailablePlusReservedEqualsBalance`, and
`testFuzz_ReleaseConservesSupply` each run 256 generated cases against the reservation
accounting without any time dependence.

## Removal condition

Delete this waiver when either becomes true:

- `createdAt` is moved out of the contract, for example to an indexer-derived field, so
  `reserveForSettlement` stops reading `block.timestamp`;
- Slither stops attributing unrelated comparisons within a function to the timestamp detector.

Re-check with `slither . --config-file slither.config.json`.
